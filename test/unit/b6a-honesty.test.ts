/**
 * B6a honesty tests: exact dropped counts across the whole events file,
 * atomic state.json writes, and archived-row hygiene.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { createHarness, emitTurn, waitFor } from "./fake-rpc.ts";

test("tailEvents counts dropped across the whole file, not just the 64KB window (B6a)", async () => {
	const h = createHarness();
	const handle = await h.supervisor.spawn({ name: "big", cwd: process.cwd(), prompt: "go" });
	const session = h.sessions[0]!;
	emitTurn(session, "go", "ok");
	// ~600 events x ~280B ≈ 170KB of mirror — well past the 64KB tail window.
	const totalTurns = 600;
	for (let i = 0; i < totalTurns; i++) {
		session.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: `turn ${i} ${"z".repeat(200)}` }] },
		});
	}
	// The events mirror is a WriteStream — wait until it is fully flushed.
	await waitFor(() => statSync(handle.eventsFile).size > 64 * 1024);
	const { events, dropped } = h.supervisor.tailEvents(handle.id, 50);
	assert.equal(events.length, 50);
	// emitTurn writes 4 events (agent_start, user, assistant, agent_end).
	assert.equal(dropped, totalTurns + 4 - 50, "dropped must count events older than the window");
});

test("state.json is written atomically: no tmp residue, 0600 mode, valid JSON (B6a)", async () => {
	const h = createHarness();
	const handle = await h.supervisor.spawn({ name: "w", cwd: process.cwd(), prompt: "go" });
	emitTurn(h.sessions[0]!, "go", "ok");
	await h.supervisor.archive(handle.id);

	const statePath = join(h.rootDir, "state.json");
	assert.ok(existsSync(statePath), "state.json exists");
	assert.ok(!existsSync(`${statePath}.tmp`), "no tmp residue");
	assert.equal(statSync(statePath).mode & 0o777, 0o600, "0600 permissions");
	const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { archivedIds: string[] };
	assert.ok(parsed.archivedIds.includes(handle.id));
});

test("stop keeps the crashed row and releases the session reference (B6a/B6b)", async () => {
	const h = createHarness();
	const handle = await h.supervisor.spawn({ name: "w", cwd: process.cwd(), prompt: "go" });
	emitTurn(h.sessions[0]!, "go", "ok");
	assert.equal(await h.supervisor.stop(handle.id), true);
	const row = h.supervisor.list().find((r) => r.id === handle.id);
	assert.ok(row, "stopped row stays listed");
	assert.equal(row!.state, "crashed");
});
