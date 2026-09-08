/**
 * FleetSupervisor unit tests against the scripted FakeRpcSession. No real
 * processes, no network — everything below drives the seam.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHarness, emitTurn, FakeRpcSession, waitFor } from "./fake-rpc.ts";
import { groupOf } from "../../extensions/lib/supervisor.ts";
import type { SupervisorEvent } from "../../extensions/lib/types.ts";

test("spawn starts a session, aligns to awaiting-input, emits agent-added", async () => {
	const { supervisor, sessions } = createHarness();
	const events: string[] = [];
	supervisor.onEvent((event) => events.push(event.type));
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	assert.equal(handle.state, "awaiting-input");
	assert.ok(handle.sessionFile.endsWith("session.jsonl"));
	assert.ok(handle.eventsFile.endsWith("events.jsonl"));
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.createdOptions.cwd, "/tmp");
	assert.equal(sessions[0]?.createdOptions.sessionFile, handle.sessionFile);
	assert.deepEqual(events, ["agent-added", "agent-updated"]);
});

test("spawn forwards model to the session factory", async () => {
	const { supervisor, sessions } = createHarness();
	await supervisor.spawn({ name: "m", cwd: "/tmp", model: "prov/model-x" });
	assert.equal(sessions[0]?.createdOptions.model, "prov/model-x");
});

test("spawn with prompt sends the first message as background", async () => {
	const { supervisor, sessions } = createHarness();
	await supervisor.spawn({ name: "alpha", cwd: "/tmp", prompt: "do stuff" });
	assert.deepEqual(sessions[0]?.sends, [{ text: "do stuff", kind: "prompt" }]);
	// The turn events then flip the handle to working.
	sessions[0]?.emit({ type: "agent_start" });
	await waitFor(() => supervisor.list()[0]?.state === "working", 1000, "working");
});

test("agent_start/agent_end drive working ⇄ awaiting-input and emit turn-ended", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const turns: SupervisorEvent[] = [];
	supervisor.onEvent((event) => {
		if (event.type === "turn-ended") turns.push(event);
	});
	const session = sessions[0] as FakeRpcSession;
	emitTurn(session, "hi", "hello world");
	await waitFor(() => supervisor.list()[0]?.state === "awaiting-input", 1000, "back to awaiting");
	const after = supervisor.list()[0];
	assert.equal(after?.turnCount, 1);
	assert.equal(after?.lastLine, "hello world");
	assert.equal(after?.tokens.input, 10);
	assert.equal(after?.tokens.output, 5);
	assert.equal(after?.tokens.cost, 0.01);
	assert.equal(turns.length, 1);
	assert.equal(turns[0]?.type === "turn-ended" && turns[0].origin, "background");
	assert.equal(turns[0]?.type === "turn-ended" && turns[0].handle.id, handle.id);
});

test("agent_end with willRetry does not end the turn", async () => {
	const { supervisor, sessions } = createHarness();
	await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const turns: SupervisorEvent[] = [];
	supervisor.onEvent((event) => {
		if (event.type === "turn-ended") turns.push(event);
	});
	const session = sessions[0] as FakeRpcSession;
	session.emit({ type: "agent_start" });
	session.emit({ type: "agent_end", willRetry: true });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(turns.length, 0);
	assert.equal(supervisor.list()[0]?.state, "working");
});

test("tool events update toolCount and currentTool", async () => {
	const { supervisor, sessions } = createHarness();
	await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	session.emit({ type: "tool_execution_start", toolName: "bash" });
	await waitFor(() => supervisor.list()[0]?.currentTool === "bash", 1000, "currentTool");
	session.emit({ type: "tool_execution_end" });
	await waitFor(() => supervisor.list()[0]?.currentTool === undefined, 1000, "currentTool cleared");
	assert.equal(supervisor.list()[0]?.toolCount, 1);
});

test("prompt while idle sends prompt; while working auto-degrades to steer and tags origin", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	assert.equal(await supervisor.prompt(handle.id, "first question", "panel"), true);
	assert.deepEqual(session.sends, [{ text: "first question", kind: "prompt" }]);
	session.emit({ type: "agent_start" });
	await waitFor(() => supervisor.list()[0]?.state === "working", 1000, "working");
	assert.equal(await supervisor.prompt(handle.id, "mid-turn nudge", "panel"), true);
	assert.deepEqual(session.sends[1], { text: "mid-turn nudge", kind: "steer" });
	// The turn that started from the panel carries origin "panel".
	const origins: string[] = [];
	supervisor.onEvent((event) => {
		if (event.type === "turn-ended") origins.push(event.origin);
	});
	emitTurn(session, "first question", "answer");
	assert.deepEqual(origins, ["panel"]);
	// prompt on unknown/dead agents is a clean false, not a throw.
	assert.equal(await supervisor.prompt("missing", "x"), false);
});

test("abort forwards to the session only while live", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	assert.equal(await supervisor.abort(handle.id), true);
	assert.equal(session.aborts, 1);
	await supervisor.archive(handle.id);
	assert.equal(await supervisor.abort(handle.id), false);
	assert.equal(session.aborts, 1);
});

test("archive hides from live groups, stops the process, keeps the record, persists state.json", async () => {
	const { supervisor, sessions, rootDir } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	assert.equal(await supervisor.archive(handle.id), true);
	const after = supervisor.list().find((h) => h.id === handle.id);
	assert.equal(after?.state, "archived");
	assert.ok(after?.endedAt);
	assert.equal(groupOf(after.state), "archived");
	const session = sessions[0] as FakeRpcSession;
	assert.equal(session.stopCalls, 1);
	// Archived ids persist for cross-restart hiding (revive-ready).
	const state = JSON.parse(readFileSync(`${rootDir}/state.json`, "utf-8")) as { archivedIds: string[] };
	assert.deepEqual(state.archivedIds, [handle.id]);
	// Second archive is a no-op.
	assert.equal(await supervisor.archive(handle.id), false);
	// Events from a dying archived child are ignored.
	session.emit({ type: "agent_start" });
	assert.equal(supervisor.list()[0]?.state, "archived");
});

test("events are mirrored to events.jsonl and tail formats them", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	emitTurn(session, "do the thing", "working on it\nsecond line");
	session.emit({ type: "tool_execution_start", toolName: "read" });
	session.emit({ type: "extension_ui_request", method: "confirm", title: "Allow write?" });
	await waitFor(() => supervisor.tail(handle.id, 50).length >= 4, 2000, "mirror flush");
	const lines = supervisor.tail(handle.id, 3);
	assert.deepEqual(lines, ["second line", "⚙ read", "⚠ child ui request denied: Allow write?"]);
	const all = supervisor.tail(handle.id, 50);
	assert.ok(all.includes("▶ do the thing"), "user turn line");
	assert.ok(all.some((line) => line.includes("ui request denied")), "denied ui request surfaced");
	// Unknown id: IO-safe empty result.
	assert.deepEqual(supervisor.tail("nope", 10), []);
});

test("tailEvents returns parsed events with a dropped count; onChildEvent taps raw stream", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	const tapped: Array<[string, string]> = [];
	const unsubscribe = supervisor.onChildEvent((id, evt) => tapped.push([id, String(evt.type)]));
	emitTurn(session, "do the thing", "working on it");
	await waitFor(() => supervisor.tailEvents(handle.id, 50).events.length >= 3, 2000, "mirror flush");
	const all = supervisor.tailEvents(handle.id, 50);
	assert.equal(all.dropped, 0);
	assert.deepEqual(all.events.map((e) => e.type), ["agent_start", "message_end", "message_end", "agent_end"]);
	const sliced = supervisor.tailEvents(handle.id, 2);
	assert.equal(sliced.events.length, 2);
	assert.equal(sliced.dropped, 2, "older entries counted as dropped");
	assert.deepEqual(
		supervisor.tailEvents("nope", 10),
		{ events: [], dropped: 0 },
	);
	// Raw tap saw every mirrored event with the child id; unsubscribe stops it.
	assert.ok(tapped.every(([id]) => id === handle.id));
	assert.ok(tapped.some(([, type]) => type === "message_end"));
	unsubscribe();
	session.emit({ type: "agent_start" });
	assert.equal(tapped.filter(([, type]) => type === "agent_start").length, 1, "tap detached after unsubscribe");
});

test("crash via failed probe flips state, emits agent-final exactly once", async () => {
	const { supervisor, sessions } = createHarness({ probeMs: 15 });
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const finals: string[] = [];
	supervisor.onEvent((event) => {
		if (event.type === "agent-final") finals.push(event.handle.id);
	});
	const session = sessions[0] as FakeRpcSession;
	session.failNext = new Error("Agent process exited (code=1)");
	await waitFor(() => supervisor.list()[0]?.state === "crashed", 2000, "crashed");
	assert.equal(supervisor.list()[0]?.endedAt !== undefined, true);
	assert.deepEqual(finals, [handle.id]);
	// A crashed agent frees its limit slot and the name is reusable.
	const second = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	assert.notEqual(second.id, handle.id);
});

test("send failure marks the child crashed", async () => {
	const { supervisor, sessions } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	const session = sessions[0] as FakeRpcSession;
	session.failNext = new Error("Agent process stdin is not writable");
	assert.equal(await supervisor.prompt(handle.id, "hello"), false);
	assert.equal(supervisor.list()[0]?.state, "crashed");
});

test("factory failure throws a clear error and emits terminal events", async () => {
	const { supervisor } = createHarness();
	const failing = async () => {
		throw new Error("spawn ENOENT");
	};
	const patched = supervisor as unknown as { sessionFactory: unknown };
	patched.sessionFactory = failing;
	const events: string[] = [];
	supervisor.onEvent((event) => events.push(event.type));
	await assert.rejects(() => supervisor.spawn({ name: "bad", cwd: "/tmp" }), /Failed to start rpc child/);
	assert.ok(events.includes("agent-final"), "terminal event emitted for the failed spawn");
});

test("limit defaults to 4 live children and frees slots on archive", async () => {
	const { supervisor } = createHarness();
	const ids = [];
	for (const name of ["a", "b", "c", "d"]) {
		ids.push((await supervisor.spawn({ name, cwd: "/tmp" })).id);
	}
	await assert.rejects(() => supervisor.spawn({ name: "e", cwd: "/tmp" }), /limit reached/);
	await supervisor.archive(ids[0] as string);
	const fifth = await supervisor.spawn({ name: "e", cwd: "/tmp" });
	assert.ok(fifth.id);
});

test("duplicate live name rejected; reusable after archive", async () => {
	const { supervisor } = createHarness();
	const first = await supervisor.spawn({ name: "dup", cwd: "/tmp" });
	await assert.rejects(() => supervisor.spawn({ name: "dup", cwd: "/tmp" }), /already exists/);
	await supervisor.archive(first.id);
	const second = await supervisor.spawn({ name: "dup", cwd: "/tmp" });
	assert.notEqual(second.id, first.id);
});

test("pin toggles and the pinned flag surfaces in snapshots", async () => {
	const { supervisor } = createHarness();
	const handle = await supervisor.spawn({ name: "alpha", cwd: "/tmp" });
	assert.equal(supervisor.pin(handle.id), true);
	assert.equal(supervisor.list()[0]?.pinned, true);
	supervisor.pin(handle.id, false);
	assert.equal(supervisor.list()[0]?.pinned, false);
});

test("dispose stops live sessions and is idempotent", async () => {
	const { supervisor, sessions } = createHarness();
	await supervisor.spawn({ name: "a", cwd: "/tmp" });
	await supervisor.spawn({ name: "b", cwd: "/tmp" });
	supervisor.dispose();
	for (const session of sessions) {
		assert.equal(session.stopCalls, 1);
	}
	assert.doesNotThrow(() => supervisor.dispose());
	await assert.rejects(() => supervisor.spawn({ name: "c", cwd: "/tmp" }), /disposed/);
});

test("groupOf maps states to the three roster groups", () => {
	assert.equal(groupOf("working"), "working");
	assert.equal(groupOf("starting"), "working");
	assert.equal(groupOf("awaiting-input"), "awaiting-input");
	assert.equal(groupOf("archived"), "archived");
	assert.equal(groupOf("crashed"), "archived");
});
