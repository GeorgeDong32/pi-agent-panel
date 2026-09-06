/**
 * Integration test: FleetSupervisor against a real headless pi child
 * (real ProcessRunner, real CLI, real model call). Slower and network-bound —
 * run via `pnpm test:integration`.
 */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";

const LONG_TASK = "Count slowly from 1 to 1000, printing one number per line. Take your time and do not stop early.";

function createSupervisor(): { supervisor: FleetSupervisor; rootDir: string } {
	const rootDir = mkdtempSync(path.join(tmpdir(), "agent-panel-it-"));
	const supervisor = new FleetSupervisor({ rootDir, stopGraceMs: 5000 });
	return { supervisor, rootDir };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timeout waiting for ${message}`);
}

test("supervisor drives a real child to completion", async () => {
	const { supervisor } = createSupervisor();
	try {
		const finals: string[] = [];
		supervisor.onEvent((event) => {
			if (event.type === "agent-final") finals.push(event.handle.state);
		});
		const handle = supervisor.spawn({
			name: "it-echo",
			prompt: "Reply with exactly the word: pong",
			cwd: tmpdir(),
		});
		await waitFor(() => supervisor.list()[0]?.state === "completed", 120_000, "completion");
		assert.deepEqual(finals, ["completed"]);
		const finalHandle = supervisor.list()[0];
		assert.equal(finalHandle?.exitCode, 0);
		assert.ok((finalHandle?.tokens.output ?? 0) > 0, "output tokens should be aggregated");
		assert.ok(existsSync(handle.sessionFile) && statSync(handle.sessionFile).size > 0, "session file written");
		assert.ok(existsSync(handle.eventsFile) && statSync(handle.eventsFile).size > 0, "events mirror written");
		await waitFor(() => supervisor.tail(handle.id, 50).some((line) => line.includes("pong")), 10_000, "transcript tail");
	} finally {
		supervisor.dispose();
	}
});

test("supervisor stops a real long-running child", async () => {
	const { supervisor } = createSupervisor();
	try {
		const handle = supervisor.spawn({ name: "it-long", prompt: LONG_TASK, cwd: tmpdir() });
		await waitFor(() => supervisor.list()[0]?.state === "running", 120_000, "child to start");
		supervisor.stop(handle.id);
		await waitFor(() => supervisor.list()[0]?.state === "stopped", 30_000, "stopped state");
		assert.ok(supervisor.list()[0]?.endedAt, "endedAt recorded");
	} finally {
		supervisor.dispose();
	}
});

test("supervisor interrupt reaches a real child and it reaches a terminal state", async () => {
	const { supervisor } = createSupervisor();
	try {
		const handle = supervisor.spawn({ name: "it-interrupt", prompt: LONG_TASK, cwd: tmpdir() });
		await waitFor(() => supervisor.list()[0]?.state === "running", 120_000, "child to start");
		assert.equal(supervisor.interrupt(handle.id), true);
		await waitFor(() => (supervisor.list()[0]?.endedAt ?? 0) > 0, 30_000, "terminal state after SIGINT");
		const state = supervisor.list()[0]?.state;
		assert.ok(
			state === "stopped" || state === "failed" || state === "completed",
			`unexpected state ${state}`,
		);
	} finally {
		supervisor.dispose();
	}
});
