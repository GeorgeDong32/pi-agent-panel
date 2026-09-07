/**
 * FleetPanel tests: real Editor composer against a stub tui/theme, fake
 * supervisor sessions via the shared harness. Pins the list⇄view state
 * machine, key routing and the composer pipeline without a terminal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FleetPanelComponent } from "../../extensions/lib/panel.ts";
import { createHarness, emitTurn, type FakeRpcSession } from "./fake-rpc.ts";
import type { AgentHandle } from "../../extensions/lib/types.ts";
import type { TUI } from "@earendil-works/pi-tui";

const fakeTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function createPanelHarness() {
	const { supervisor, sessions } = createHarness();
	const renders: number[] = [];
	const focus = { current: null as string | null };
	let doneCalled = false;
	const panel = new FleetPanelComponent(
		{ requestRender: () => renders.push(1), terminal: { rows: 30 } } as unknown as TUI,
		fakeTheme,
		supervisor,
		() => {
			doneCalled = true;
		},
		{ cwd: "/tmp", focus },
	);
	return { panel, supervisor, sessions, focus, isDone: () => doneCalled, renderCount: () => renders.length };
}

async function spawnAgent(h: ReturnType<typeof createPanelHarness>, name: string): Promise<{ handle: AgentHandle; session: FakeRpcSession }> {
	const handle = await h.supervisor.spawn({ name, cwd: "/tmp" });
	const session = h.sessions[h.sessions.length - 1] as FakeRpcSession;
	return { handle, session };
}

const WIDTH = 100;

test("empty roster renders guidance, groups header and footer hints", () => {
	const { panel } = createPanelHarness();
	const text = panel.render(WIDTH).join("\n");
	assert.ok(text.includes("agent-panel"), "header present");
	assert.ok(text.includes("No agents"), "empty-roster guidance present");
	assert.ok(text.includes("n new task"), "footer hints present");
	assert.ok(text.includes("esc close"), "esc hint present");
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
	await h.supervisor.archive((h.supervisor.list().find((a) => a.name === "gone") as AgentHandle).id);
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
	h.panel.handleInput("\r"); // enter → view mode
	h.panel.invalidate();
	const viewText = h.panel.render(WIDTH).join("\n");
	assert.ok(viewText.includes("b"), "view opened for second agent");
	assert.ok(viewText.includes("back to list"), "view footer");
	h.panel.handleInput("\x1b[D"); // left arrow
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("jk select"), "back in list mode");
	// And again into view, this time leaving via esc.
	h.panel.handleInput("\r");
	h.panel.handleInput("\x1b");
	h.panel.invalidate();
	assert.ok(h.panel.render(WIDTH).join("\n").includes("jk select"), "esc returns to list from view");
});

test("view focus channel tracks the viewed agent for suppression", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "a");
	h.panel.invalidate();
	h.panel.handleInput("\r");
	assert.equal(h.focus.current, handle.id);
	h.panel.handleInput("\x1b[D");
	assert.equal(h.focus.current, null);
});

test("composer: n → CJK task → enter spawns with derived name and jumps to view", async () => {
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
	// After spawn the panel jumps into the view with the composer still live.
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("调查缓存问题"), "view header shows new agent");
	assert.ok(text.includes("enter send"), "reply composer active");
	assert.equal(h.focus.current, spawned.id);
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

test("x aborts the selected working agent; X archives it", async () => {
	const h = createPanelHarness();
	const { handle } = await spawnAgent(h, "busy");
	const session = h.sessions[0] as FakeRpcSession;
	session.emit({ type: "agent_start" });
	h.panel.invalidate();
	h.panel.handleInput("x");
	assert.equal(session.aborts, 1);
	h.panel.handleInput("X");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.supervisor.list()[0]?.state, "archived");
	assert.equal(session.stopCalls, 1);
	void handle;
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
	// Simulate crash through the supervisor's public surface.
	await h.supervisor.archive(handle.id);
	const crashed = h.supervisor.list().find((a) => a.id === handle.id) as AgentHandle;
	crashed.state = "crashed";
	h.panel.invalidate();
	h.panel.handleInput("\r"); // open view (archived/crashed group row)
	h.panel.handleInput(" "); // try to focus composer
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("not running"), "composer disabled hint");
	const session = h.sessions[0] as FakeRpcSession;
	assert.equal(session.sends.length, 0, "nothing sent to a dead agent");
});

test("transcript pane mirrors tail output in view mode", async () => {
	const h = createPanelHarness();
	const { session, handle } = await spawnAgent(h, "talker");
	emitTurn(session, "task text", "第一行回答\n第二行回答");
	// The events mirror flushes asynchronously; wait for it before reading.
	await new Promise((resolve) => setTimeout(resolve, 60));
	h.panel.invalidate();
	h.panel.handleInput("\r");
	h.panel.invalidate();
	const text = h.panel.render(WIDTH).join("\n");
	assert.ok(text.includes("▶ task text"), "user line");
	assert.ok(text.includes("第一行回答"), "assistant line 1");
	assert.ok(text.includes("第二行回答"), "assistant line 2");
});
