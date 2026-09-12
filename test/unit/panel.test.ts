/**
 * FleetPanel tests: real Editor composer against a stub tui/theme, fake
 * supervisor sessions via the shared harness. Pins the list⇄view state
 * machine, key routing and the composer pipeline without a terminal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { FleetPanelComponent } from "../../extensions/lib/panel.ts";
import { createHarness, emitTurn, type FakeRpcSession } from "./fake-rpc.ts";
import type { AgentHandle } from "../../extensions/lib/types.ts";
import type { TUI } from "@earendil-works/pi-tui";

// Conversation components read pi's global theme at render time.
initTheme(undefined, false);

const fakeTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function createPanelHarness() {
	const { supervisor, sessions } = createHarness();
	const renders: number[] = [];
	const focus = { current: null as string | null };
	let doneCalled = false;
	let action: { takeover?: string; detach?: string } | undefined;
	const panel = new FleetPanelComponent(
		{ requestRender: () => renders.push(1), terminal: { rows: 30 } } as unknown as TUI,
		fakeTheme,
		supervisor,
		(result) => {
			doneCalled = true;
			action = result;
		},
		{ cwd: "/tmp", focus },
	);
	return { panel, supervisor, sessions, focus, isDone: () => doneCalled, action: () => action, renderCount: () => renders.length };
}

async function spawnAgent(h: ReturnType<typeof createPanelHarness>, name: string): Promise<{ handle: AgentHandle; session: FakeRpcSession }> {
	const handle = await h.supervisor.spawn({ name, cwd: "/tmp" });
	const session = h.sessions[h.sessions.length - 1] as FakeRpcSession;
	return { handle, session };
}

const WIDTH = 100;

test("empty roster renders guidance, groups header and footer hints", () => {
	const { panel } = createPanelHarness();
	const lines = panel.render(WIDTH);
	const text = lines.join("\n");
	assert.ok(text.includes("agent-panel"), "header present");
	assert.ok(text.includes("No agents"), "empty-roster guidance present");
	assert.ok(text.includes("n new"), "footer hints present");
	assert.ok(text.includes("enter takeover"), "takeover hint present");
	assert.ok(text.includes("d detach"), "detach hint present");
	assert.ok(text.includes("esc close"), "esc hint present");
	// Fullscreen contract: output spans the full terminal height (rows=30 in
	// the stub) — short output would leave the host UI visible below.
	assert.equal(lines.length, 30);
});

test("narrow width degrades to a single hint line", () => {
	const { panel } = createPanelHarness();
	const lines = panel.render(30);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("agent-panel"));
});

test("q/escape close the panel via done()", () => {
	const { panel, isDone } = createPanelHarness();
	assert.equal(isDone(), false);
	panel.handleInput("q");
	assert.equal(isDone(), true);
	const { panel: panel2, isDone: isDone2 } = createPanelHarness();
	panel2.handleInput("\x1b");
	assert.equal(isDone2(), true);
});

test("roster groups: working/awaiting/archived with live counts in header", async () => {
	const h = createPanelHarness();
	await spawnAgent(h, "worker");
	await spawnAgent(h, "idler");
	await spawnAgent(h, "gone");
	const workerSession = h.sessions[0] as FakeRpcSession;
	workerSession.emit({ type: "agent_start" });
	// B6b: archive removes rows; stop() leaves a crashed row in the archived group.
	await h.supervisor.stop((h.supervisor.list().find((a) => a.name === "gone") as AgentHandle).id);
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("1 working · 1 awaiting input · 1 archived"), "three-segment counts");
	assert.ok(text.includes("Working"));
	assert.ok(text.includes("Awaiting input"));
	assert.ok(text.includes("Archived"));
	assert.ok(text.includes("worker"));
	assert.ok(text.includes("idler"));
});

test("j/k move selection; enter opens view; ← and esc return to list", async () => {
	const h = createPanelHarness();
	await spawnAgent(h, "a");
	await spawnAgent(h, "b");
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("a"), "roster shows agents");
	h.panel.handleInput("j");
	h.panel.handleInput(" "); // space → quick-look view mode
	h.panel.invalidate();
	const viewText = h.panel.render(WIDTH).join("\n");
	assert.ok(viewText.includes("b"), "view opened for second agent");
	assert.ok(viewText.includes("back to list"), "view footer");
	h.panel.handleInput("\x1b[D"); // left arrow
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("enter takeover"), "back in list mode");
	// And again into view, this time leaving via esc.
	h.panel.handleInput(" ");
	h.panel.handleInput("\x1b");
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("enter takeover"), "esc returns to list from view");
});

test("view focus channel tracks the viewed agent for suppression", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput(" ");
	assert.equal(h.focus.current, handle.id);
	h.panel.handleInput("\x1b[D");
	assert.equal(h.focus.current, null);
});

test("composer: n → CJK task → enter spawns with derived name, stays in list", async () => {
	const h = createPanelHarness();
	h.panel.handleInput("n");
	assert.ok(h.panel.render(WIDTH).join("\n").includes("new task:"), "composer hint");
	h.panel.handleInput("调"); // CJK codepoint goes through the real Editor
	h.panel.handleInput("查缓存问题");
	h.panel.handleInput("\r"); // submit
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.supervisor.list().length, 1);
	const spawned = h.supervisor.list()[0] as AgentHandle;
	assert.equal(spawned.name, "调查缓存问题");
	assert.deepEqual((h.sessions[0] as FakeRpcSession).sends.map((s) => s.text), ["调查缓存问题"]);
	// User revision: no auto-jump — stay in the list, select the new agent.
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("started '调查缓存问题'"), "started hint");
	assert.ok(text.includes("enter takeover"), "still in list mode");
	assert.equal(h.focus.current, null);
});

test("list mode: typing a printable character opens the new-task composer directly", async () => {
	const h = createPanelHarness();
	h.panel.handleInput("重"); // type-to-talk straight into a new task
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("new task:"), "composer opened by typing");
	h.panel.handleInput("构问题");
	h.panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.supervisor.list()[0]?.name, "重构问题");
});

test("view mode: ← on an empty composer returns to the list without esc", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput(" "); // space → quick-look view
	assert.equal(h.focus.current, handle.id);
	h.panel.handleInput("\x1b[D"); // ← with an empty draft → back to list
	h.panel.invalidate();
	assert.equal(h.focus.current, null);
	assert.ok(h.panel.render(WIDTH).join("\n").includes("enter takeover"), "back in list");
	// With text in the draft, ← moves the cursor instead of leaving.
	h.panel.handleInput(" "); // space → view again
	h.panel.handleInput("d");
	h.panel.handleInput("r");
	h.panel.handleInput("\x1b[D"); // ← over a non-empty draft
	h.panel.invalidate();
	const still = h.panel.render(WIDTH).join("\n");
	assert.ok(still.includes("enter send"), "still composing in view");
	assert.ok(!still.includes("enter takeover"), "did not leave the view");
});

test("composer reply in view: submit prompts with panel origin; esc cancels draft", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput(" "); // space → view + focus composer
	h.panel.handleInput("追问一下");
	h.panel.handleInput("\x1b"); // esc cancels the draft
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("reply · jk scroll"), "composer cancelled, nav keys back");
	// Type-to-talk: printable input in view-inactive mode starts composing.
	h.panel.handleInput("你");
	h.panel.handleInput("好");
	h.panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 50));
	const session = h.sessions[0] as FakeRpcSession;
	assert.deepEqual(session.sends.map((s) => s.text), ["你好"]);
	assert.deepEqual(session.sends.map((s) => s.kind), ["prompt"]);
	assert.ok(h.focus.current === handle.id);
});

test("composer reply while working auto-steers", async () => {
	const h = createPanelHarness();
	const { session } = await spawnAgent(h, "a");
	session.emit({ type: "agent_start" });
	h.panel.invalidate();
	h.panel.handleInput(" ");
	h.panel.handleInput("改一下方向");
	h.panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual((h.sessions[0] as FakeRpcSession).sends[0], { text: "改一下方向", kind: "steer" });
});

test("two-stage x: first x stops the process, second x removes the row (B6b)", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "busy");
	const session = h.sessions[0] as FakeRpcSession;
	session.emit({ type: "agent_start" });
	h.panel.invalidate();

	// Stage 1: stop — the row stays, the process is stopped.
	h.panel.handleInput("x");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(session.stopCalls, 1);
	const row = h.supervisor.list().find((r) => r.id === handle.id);
	assert.ok(row, "row kept after stage 1");
	assert.equal(row!.state, "crashed");

	// Stage 2: remove — the row disappears, files stay on disk.
	h.panel.invalidate();
	h.panel.handleInput("x");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.supervisor.list().find((r) => r.id === handle.id), undefined);
	assert.ok(existsSync(handle.eventsFile), "disk untouched");
});

test("p pins the selected agent into the Pinned group", async () => {
	const h = createPanelHarness();
	await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput("p");
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("Pinned"), "pinned group appears");
	assert.equal(h.supervisor.list()[0]?.pinned, true);
});

test("view of a crashed agent: composer refuses with a hint", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "dead");
	// Stop the agent through the public surface: crashed row, no process.
	await h.supervisor.stop(handle.id);
	h.panel.invalidate();
	h.panel.handleInput(" "); // open view (archived/crashed group row)
	h.panel.handleInput("r"); // try to compose via type-to-talk
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("press R to revive"), "composer disabled hint");
	const session = h.sessions[0] as FakeRpcSession;
	assert.equal(session.sends.length, 0, "nothing sent to a dead agent");
});

test("view mode renders a native conversation (bubbles + tool card)", async () => {
	const h = createPanelHarness();
	const { session } = await spawnAgent(h, "talker");
	emitTurn(session, "task text", "第一行回答\n第二行回答");
	session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
	session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "file body" }] }, isError: false });
	// The events mirror flushes asynchronously; wait for it before reading.
	await new Promise((resolve) => setTimeout(resolve, 60));
	h.panel.invalidate();
	h.panel.handleInput(" ");
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("task text"), "user bubble text");
	assert.ok(text.includes("第一行回答"), "assistant line 1");
	assert.ok(text.includes("第二行回答"), "assistant line 2");
	assert.ok(text.includes("read"), "tool card title");
	assert.ok(text.includes("file body"), "tool card result");
});

test("kitty keyboard protocol sequences drive the same actions; releases ignored", async () => {
	const h = createPanelHarness();
	// kitty n (CSI-u) opens the new-task composer
	h.panel.handleInput("\x1b[110;1u");
	assert.ok(h.panel.render(WIDTH).join("\n").includes("new task:"), "kitty n activates composer");
	// key-release of the same key must not double-fire anything
	h.panel.handleInput("\x1b[110;1:3u");
	// legacy esc still cancels
	h.panel.handleInput("\x1b");
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("n new"), "composer cancelled");
	// kitty space opens the quick-look view
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput("\x1b[32;1u");
	assert.equal(h.focus.current, handle.id);
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("back to list"), "kitty space opens view");
	// kitty printable character flows into the editor (type-to-talk path)
	h.panel.handleInput("\x1b[104;1u"); // h
	h.panel.handleInput("\x1b[105;1u"); // i
	h.panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual((h.sessions[0] as FakeRpcSession).sends.map((x) => x.text), ["hi"]);
});


test("enter on a crashed/discovered row requests resume (B6b)", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "dead");
	await h.supervisor.stop(handle.id);
	h.panel.invalidate();
	h.panel.handleInput("\r");
	assert.equal(h.isDone(), true, "panel closed for resume");
	assert.deepEqual(h.action(), { resume: handle.id });
});

test("enter on a live agent requests takeover; d on an attached agent requests detach", async () => {
	// takeover: enter closes the panel and reports the agent id upward.
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput("\r");
	assert.equal(h.isDone(), true, "panel closed for takeover");
	assert.deepEqual(h.action(), { takeover: handle.id });

	// detach: takeover first, then d on the attached row.
	const h2 = createPanelHarness();
	const { handle: b } = await spawnAgent(h2, "b");
	await h2.supervisor.takeover(b.id);
	h2.panel.invalidate();
	const text = h2.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("Attached"), "attached group appears");
	assert.ok(text.includes("⇄"), "attached glyph");
	h2.panel.handleInput("d");
	assert.deepEqual(h2.action(), { detach: b.id });
});

test("enter on an attached agent still requests takeover (re-open its session)", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	await h.supervisor.takeover(handle.id);
	h.panel.invalidate();
	h.panel.handleInput("\r");
	assert.equal(h.isDone(), true, "attached row enter closes the panel");
	assert.deepEqual(h.action(), { takeover: handle.id });
});
