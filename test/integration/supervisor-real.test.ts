/**
 * Integration tests: FleetSupervisor against real `pi --mode rpc` children
 * (real RpcClient adapter, real model calls). Slow and network-bound — run
 * via `pnpm test:integration`.
 *
 * Covers the acceptance set: second-turn conversation on the same child,
 * mid-run abort (agent survives), archive leaves no matching process, and
 * rpc-mode stdin-EOF self-heal for orphans.
 */
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePiCliPath } from "../../extensions/lib/pi-spawn.ts";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import type { AgentHandle } from "../../extensions/lib/types.ts";

const TURN_TIMEOUT = 300_000;

function stateOf(supervisor: FleetSupervisor, id: string): string {
	const handle = supervisor.list().find((h) => h.id === id);
	return handle ? `${handle.state} (turns=${handle.turnCount}, last=${handle.lastLine.slice(0, 60)})` : "gone";
}

function createSupervisor(): { supervisor: FleetSupervisor; rootDir: string } {
	const rootDir = mkdtempSync(path.join(tmpdir(), "agent-panel-it-"));
	const supervisor = new FleetSupervisor({ rootDir });
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

function listProcessesMatching(pattern: string): string {
	try {
		return execSync(`pgrep -f ${JSON.stringify(pattern)} || true`, { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

test("real child: two turns on the same session is a real conversation", async () => {
	const { supervisor } = createSupervisor();
	try {
		const turns: string[] = [];
		supervisor.onEvent((event) => {
			if (event.type === "turn-ended") turns.push(event.origin);
		});
		const handle = await supervisor.spawn({
			name: "it-echo",
			cwd: tmpdir(),
			prompt: "Reply with exactly the word: pong",
		});
		// NB: "awaiting-input" is briefly true before the first turn starts
		// (the prompt goes out right after state alignment) — wait for the
		// finished turn itself, or the "second" message lands as a steer.
		await waitFor(
			() => {
				const h = supervisor.list().find((x) => x.id === handle.id);
				return h !== undefined && h.turnCount >= 1 && h.state === "awaiting-input";
			},
			TURN_TIMEOUT,
			`first turn to finish (state: ${stateOf(supervisor, handle.id)})`,
		);
		// Second turn on the SAME child — the core "jump in and keep talking" property.
		assert.equal(await supervisor.prompt(handle.id, "Now reply with exactly the word: ping", "panel"), true);
		await waitFor(
			() => (supervisor.list().find((h) => h.id === handle.id)?.turnCount ?? 0) >= 2,
			TURN_TIMEOUT,
			`second turn to finish (state: ${stateOf(supervisor, handle.id)})`,
		);
		const finalHandle = supervisor.list().find((h) => h.id === handle.id) as AgentHandle;
		assert.equal(finalHandle.turnCount, 2);
		assert.ok((finalHandle.tokens.output ?? 0) > 0, "output tokens aggregated");
		assert.ok(existsSync(handle.sessionFile) && statSync(handle.sessionFile).size > 0, "session file written");
		const tail = supervisor.tail(handle.id, 200);
		assert.ok(tail.some((line) => line.includes("pong")), `transcript has pong: ${tail.join(" / ")}`);
		assert.ok(tail.some((line) => line.includes("ping")), `transcript has ping: ${tail.join(" / ")}`);
		assert.deepEqual(turns, ["background", "panel"]);
	} finally {
		supervisor.dispose();
	}
});

test("real child: abort interrupts the running turn and the agent survives", async () => {
	const { supervisor } = createSupervisor();
	try {
		const handle = await supervisor.spawn({
			name: "it-abort",
			cwd: tmpdir(),
			prompt: "Use the bash tool to run exactly: sleep 60. Wait for it to finish.",
		});
		await waitFor(
			() => supervisor.list().find((h) => h.id === handle.id)?.state === "working",
			TURN_TIMEOUT,
			"turn to start streaming",
		);
		assert.equal(await supervisor.abort(handle.id), true);
		await waitFor(
			() => supervisor.list().find((h) => h.id === handle.id)?.state === "awaiting-input",
			TURN_TIMEOUT,
			"turn to settle after abort",
		);
		// The agent survived: another prompt opens a new turn.
		assert.equal(await supervisor.prompt(handle.id, "Reply with exactly: alive", "panel"), true);
		await waitFor(
			() => supervisor.tail(handle.id, 50).some((line) => line.includes("alive")),
			TURN_TIMEOUT,
			"post-abort turn to finish",
		);
	} finally {
		supervisor.dispose();
	}
});

test("archive kills the child and no matching process survives", async () => {
	const { supervisor, rootDir } = createSupervisor();
	try {
		const handle = await supervisor.spawn({ name: "it-archive", cwd: tmpdir(), prompt: "Reply with exactly: bye" });
		// NB: "awaiting-input" is briefly true BEFORE the first turn starts (the
		// prompt is sent right after state alignment) — wait for the finished
		// turn instead, so the session file exists by the time we archive.
		await waitFor(
			() => (supervisor.list().find((h) => h.id === handle.id)?.turnCount ?? 0) >= 1,
			TURN_TIMEOUT,
			"turn to finish",
		);
		assert.equal(await supervisor.archive(handle.id), true);
		await waitFor(() => listProcessesMatching(rootDir) === "", 15_000, "rpc child process to exit");
		// B6b removal semantics: archive drops the row from list(); the
		// session file stays on disk for pi itself to resume.
		assert.equal(supervisor.list().find((h) => h.id === handle.id), undefined);
		assert.ok(existsSync(handle.sessionFile), "session file kept after archive");
	} finally {
		supervisor.dispose();
	}
});

test("rpc-mode self-heal: closing stdin takes the orphan down", async () => {
	const sessionFile = path.join(mkdtempSync(path.join(tmpdir(), "agent-panel-orphan-")), "session.jsonl");
	const child = spawn(
		process.execPath,
		[resolvePiCliPath(), "--mode", "rpc", "--no-extensions", "--no-skills", "--session", sessionFile],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	assert.ok(child.pid && child.pid > 0, "orphan rpc child started");
	// Give the rpc loop time to attach its stdin-end listener, then sever the pipe.
	await new Promise((resolve) => setTimeout(resolve, 1500));
	child.stdin?.end();
	const exited = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});
	const code = await Promise.race([
		exited,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("orphan did not exit within 15s of stdin EOF")), 15_000);
		}),
	]);
	assert.ok(code !== null || child.exitCode !== null || child.signalCode !== null, "child exited after stdin EOF");
});
