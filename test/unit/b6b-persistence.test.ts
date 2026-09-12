/**
 * B6b cross-restart persistence: startup discovery, archivedIds consumption
 * (hiding survives restarts), stable ids (dir basename), resume that keeps
 * the id, the two-stage x (stop then remove, disk untouched), and pinnedIds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import { FakeRpcSession, createHarness, emitTurn, waitFor } from "./fake-rpc.ts";
import type { RpcSessionFactory } from "../../extensions/lib/types.ts";

function childDir(root: string, id: string): string {
	const dir = join(root, id);
	mkdirSync(join(dir), { recursive: true });
	writeFileSync(join(dir, "session.jsonl"), `{"type":"session","id":"${id}"}\n`);
	writeFileSync(join(dir, "events.jsonl"), "");
	return dir;
}

function makeSupervisor(root: string, factory?: RpcSessionFactory): FleetSupervisor {
	return new FleetSupervisor({
		rootDir: root,
		probeMs: 0,
		...(factory ? { sessionFactory: factory } : {}),
	});
}

test("startup discovery rebuilds archived rows for child dirs (id = dir basename)", async () => {
	const root = mkdtempSync(join(tmpdir(), "b6b-disc-"));
	childDir(root, "worker-a-111-aaaaaa");
	childDir(root, "worker-b-222-bbbbbb");
	mkdirSync(join(root, "not-a-child"), { recursive: true }); // no session/events files
	mkdirSync(join(root, "empty-dir"), { recursive: true });

	const supervisor = makeSupervisor(root);
	const rows = supervisor.list();
	const ids = rows.map((r) => r.id);
	assert.deepEqual(ids.sort(), ["worker-a-111-aaaaaa", "worker-b-222-bbbbbb"]);
	for (const row of rows) {
		assert.equal(row.state, "archived");
		assert.ok(!row.attached);
	}
});

test("archivedIds are consumed: hidden rows stay hidden after a restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "b6b-hide-"));
	childDir(root, "hidden-1-aaa");
	childDir(root, "visible-2-bbb");
	writeFileSync(
		join(root, "state.json"),
		JSON.stringify({ archivedIds: ["hidden-1-aaa"] }),
	);

	const supervisor = makeSupervisor(root);
	const ids = supervisor.list().map((r) => r.id);
	assert.deepEqual(ids, ["visible-2-bbb"]);
});

test("discovered rows resume on the same dir and id", async () => {
	const root = mkdtempSync(join(tmpdir(), "b6b-resume-"));
	childDir(root, "solo-1-abc123");
	const sessions: FakeRpcSession[] = [];
	const factory: RpcSessionFactory = async (opts) => {
		const s = new FakeRpcSession(opts);
		sessions.push(s);
		return s;
	};
	const supervisor = makeSupervisor(root, factory);

	const handle = await supervisor.resume("solo-1-abc123");
	assert.equal(handle.id, "solo-1-abc123", "id survives the resume");
	assert.equal(handle.state === "crashed" || handle.state === "starting" || handle.state === "awaiting-input", true, `live-ish state, got ${handle.state}`);
	// Same child dir reused (no duplicate directory created).
	const rows = supervisor.list().filter((r) => r.id === "solo-1-abc123");
	assert.equal(rows.length, 1);
	assert.ok(existsSync(join(root, "solo-1-abc123", "session.jsonl")));
});

test("stop keeps the row; archive removes it from the panel and keeps every file", async () => {
	const h = createHarness();
	const handle = await h.supervisor.spawn({ name: "w", cwd: process.cwd(), prompt: "go" });
	emitTurn(h.sessions[0]!, "go", "ok");

	// Stage 1: stop the background process; the row stays listed as crashed.
	assert.equal(await h.supervisor.stop(handle.id), true);
	const afterStop = h.supervisor.list().find((r) => r.id === handle.id);
	assert.ok(afterStop, "row kept after stop");
	assert.equal(afterStop!.state, "crashed");

	// Stage 2: archive removes the row from the panel, disk untouched.
	assert.equal(await h.supervisor.archive(handle.id), true);
	assert.equal(h.supervisor.list().find((r) => r.id === handle.id), undefined);
	assert.ok(existsSync(handle.eventsFile), "events file untouched");
	assert.ok(existsSync(join(h.rootDir, handle.id)), "child dir untouched");
	const state = JSON.parse(readFileSync(join(h.rootDir, "state.json"), "utf-8")) as { archivedIds: string[] };
	assert.ok(state.archivedIds.includes(handle.id), "removal persisted for the next restart");
});

test("archived (removed) agents stay hidden after a restart via discovery", async () => {
	const h = createHarness();
	const handle = await h.supervisor.spawn({ name: "w", cwd: process.cwd(), prompt: "go" });
	emitTurn(h.sessions[0]!, "go", "ok");
	await h.supervisor.archive(handle.id);
	await waitFor(() => existsSync(join(h.rootDir, "state.json")));

	// New host process, same rootDir: the removed agent must not reappear.
	const next = makeSupervisor(h.rootDir);
	assert.equal(next.list().find((r) => r.id === handle.id), undefined, "stays hidden after restart");
});

test("pinned survives restarts for discovered rows", async () => {
	const root = mkdtempSync(join(tmpdir(), "b6b-pin-"));
	childDir(root, "pinned-1-xyz");
	writeFileSync(
		join(root, "state.json"),
		JSON.stringify({ archivedIds: [], pinnedIds: ["pinned-1-xyz"] }),
	);
	const supervisor = makeSupervisor(root);
	const row = supervisor.list().find((r) => r.id === "pinned-1-xyz");
	assert.ok(row);
	assert.equal(row!.pinned, true);
});
