/**
 * Takeover/detach flow unit tests (plan C4).
 *
 * The flows run against a real FleetSupervisor driven by the fake-rpc
 * harness, with host calls (switchSession/notify) recorded by the fake
 * HostEffects — the rollback and ordering paths were manual-test-only
 * before the seam existed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDetach, runTakeover } from "../../extensions/index.ts";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import { fakeHostEffects } from "../../extensions/lib/host-effects.ts";
import { createHarness, emitTurn, FakeRpcSession } from "./fake-rpc.ts";

async function spawnedAgent(h: Harness, name = "worker"): Promise<{ id: string; sessionFile: string }> {
	const handle = await h.supervisor.spawn({ name, cwd: process.cwd(), prompt: "do work" });
	emitTurn(h.sessions[0]!, "do work", "done");
	return { id: handle.id, sessionFile: handle.sessionFile };
}

test("runTakeover switches the host onto the agent session and marks it attached", async () => {
	const h = createHarness();
	const { id, sessionFile } = await spawnedAgent(h);
	const host = fakeHostEffects();

	await runTakeover({ supervisor: h.supervisor, host }, id);

	assert.deepEqual(
		host.calls.filter((c) => c.kind === "switchSession").map((c) => c.sessionPath),
		[sessionFile],
	);
	const row = h.supervisor.list().find((r) => r.id === id)!;
	assert.equal(row.attached, true);
	assert.ok(host.calls.some((c) => c.message?.includes("attached to the main REPL")));
});

test("runTakeover on an already-attached agent only switches (no second takeover)", async () => {
	const h = createHarness();
	const { id, sessionFile } = await spawnedAgent(h);
	const host = fakeHostEffects();
	await runTakeover({ supervisor: h.supervisor, host }, id);

	// Second takeover on the attached row: a plain switch, no rollback machinery.
	const host2 = fakeHostEffects();
	await runTakeover({ supervisor: h.supervisor, host: host2 }, id);
	assert.deepEqual(
		host2.calls.filter((c) => c.kind === "switchSession").map((c) => c.sessionPath),
		[sessionFile],
	);
	assert.ok(!host2.calls.some((c) => c.message?.includes("cannot take over")));
});

test("runTakeover rolls back to background supervision when the switch fails", async () => {
	const h = createHarness();
	const { id } = await spawnedAgent(h);
	const host = fakeHostEffects({ switchError: () => new Error("stale ctx") });

	await runTakeover({ supervisor: h.supervisor, host }, id);

	// Rollback: supervisor.detach respawned a driver; the row is live again.
	const row = h.supervisor.list().find((r) => r.id === id)!;
	assert.ok(!row.attached, `attached flag cleared, got ${row.attached}`);
	assert.notEqual(row.state, "archived");
	assert.ok(host.calls.some((c) => c.message?.includes("takeover failed")));
	// A fresh driver session exists for the same session file.
	assert.ok(h.sessions.some((s) => s !== h.sessions[0] && s.createdOptions.sessionFile === row.sessionFile));
});

test("runTakeover on a non-running agent warns and does not switch", async () => {
	const h = createHarness();
	const host = fakeHostEffects();
	await runTakeover({ supervisor: h.supervisor, host }, "missing-id");
	assert.equal(host.calls.filter((c) => c.kind === "switchSession").length, 0);
	assert.ok(host.calls.some((c) => c.message?.includes("cannot take over")));
});

test("runDetach switches home BEFORE respawning the driver (no two-writer window, plan B5)", async () => {
	const h = createHarness();
	const { id } = await spawnedAgent(h);
	await runTakeover({ supervisor: h.supervisor, host: fakeHostEffects() }, id);

	const order: string[] = [];
	const host: import("../../extensions/lib/host-effects.ts").HostEffects = {
		switchSession: async (sessionPath) => {
			// Record how many driver sessions existed when the REPL moved.
			order.push(`switch:${sessionPath}(sessions=${h.sessions.length})`);
		},
		getSessionFile: () => undefined,
		notify: (message) => order.push(`notify:${message.slice(0, 24)}`),
	};
	await runDetach({ supervisor: h.supervisor, host, homeSessionFile: "/home.jsonl" }, id);

	// The switch happened while no replacement driver existed yet.
	assert.match(order[0]!, /^switch:\/home\.jsonl\(sessions=1\)$/);
	assert.ok(h.sessions.length >= 2, "background driver respawned after the switch");
	const row = h.supervisor.list().find((r) => r.id === id)!;
	assert.ok(!row.attached, `attached flag cleared, got ${row.attached}`);
	assert.notEqual(row.state, "archived");
});

test("runDetach without a home session warns and does nothing", async () => {
	const h = createHarness();
	const { id } = await spawnedAgent(h);
	await runTakeover({ supervisor: h.supervisor, host: fakeHostEffects() }, id);
	const before = h.sessions.length;

	const host = fakeHostEffects();
	await runDetach({ supervisor: h.supervisor, host }, id);

	assert.equal(host.calls.filter((c) => c.kind === "switchSession").length, 0);
	assert.equal(h.sessions.length, before, "no respawn happened");
	assert.ok(host.calls.some((c) => c.message?.includes("no previous session")));
});

test("runDetach with a failed home switch keeps the agent attached (no second writer, plan B5)", async () => {
	const h = createHarness();
	const { id } = await spawnedAgent(h);
	await runTakeover({ supervisor: h.supervisor, host: fakeHostEffects() }, id);
	const sessionsBefore = h.sessions.length;

	const host = fakeHostEffects({ switchError: () => new Error("switch rejected") });
	await runDetach({ supervisor: h.supervisor, host, homeSessionFile: "/home.jsonl" }, id);

	// The REPL never left the session: no respawn may exist (the old behavior
	// spawned a second writer and reported it as detached).
	assert.equal(h.sessions.length, sessionsBefore, "no respawn happened");
	const row = h.supervisor.list().find((r) => r.id === id)!;
	assert.ok(row.attached, "agent stays attached for a later retry");
	assert.ok(host.calls.some((c) => c.message?.includes("stays attached")));
});

test("a failed detach respawn surfaces as a crashed row instead of vanishing (plan B5)", async () => {
	const sessions: FakeRpcSession[] = [];
	let calls = 0;
	const factory: Parameters<FleetSupervisor["spawn"]> extends never ? never : (opts: { cwd: string; sessionFile: string; model?: string }) => Promise<FakeRpcSession> = async (opts) => {
		calls += 1;
		if (calls === 2) throw new Error("rpc spawn failed");
		const session = new FakeRpcSession(opts);
		sessions.push(session);
		return session;
	};
	const supervisor = new FleetSupervisor({
		sessionFactory: factory,
		rootDir: mkdtempSync(join(tmpdir(), "agent-panel-strand-")),
		probeMs: 0,
	});
	const handle = await supervisor.spawn({ name: "worker", cwd: process.cwd(), prompt: "go" });
	emitTurn(sessions[0]!, "go", "ok");
	await supervisor.takeover(handle.id);

	await runDetach({ supervisor, host: fakeHostEffects(), homeSessionFile: "/home.jsonl" }, handle.id);

	const row = supervisor.list().find((r) => r.id === handle.id);
	assert.ok(row, "the agent is still listed");
	assert.equal(row!.state, "crashed", `state=${row!.state}`);
});
