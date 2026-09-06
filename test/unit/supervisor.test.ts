/**
 * Fake ProcessRunner + supervisor unit tests. No real processes, no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import type { ChildProcessHandle, ProcessRunner } from "../../extensions/lib/types.ts";

class FakeProc implements ChildProcessHandle {
	pid: number;
	signals: string[] = [];
	exited: Promise<number>;
	/** Single long-lived iterator, mirroring a real child's stdout stream. */
	readonly stdout: AsyncGenerator<string>;
	private exitResolve!: (code: number) => void;
	private queue: string[] = [];
	private wake: (() => void) | undefined;
	private closed = false;

	static nextPid = 41000;

	constructor(pid: number) {
		this.pid = pid;
		this.exited = new Promise((resolve) => {
			this.exitResolve = resolve;
		});
		this.stdout = this.streamLines();
	}

	emit(line: string): void {
		this.queue.push(line);
		this.wake?.();
	}

	exit(code: number): void {
		this.closed = true;
		this.exitResolve(code);
		this.wake?.();
	}

	kill(signal?: NodeJS.Signals): void {
		this.signals.push(signal ?? "SIGTERM");
	}

	private async *streamLines(): AsyncGenerator<string> {
		let index = 0;
		for (;;) {
			while (index < this.queue.length) {
				yield this.queue[index] as string;
				index += 1;
			}
			if (this.closed && index >= this.queue.length) return;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = undefined;
		}
	}
}

function createHarness(options: { limit?: number; stopGraceMs?: number } = {}) {
	const procs: FakeProc[] = [];
	const runner: ProcessRunner = {
		spawn: (_command, _args, _opts) => {
			const proc = new FakeProc(FakeProc.nextPid++);
			procs.push(proc);
			return proc;
		},
	};
	const rootDir = mkdtempSync(path.join(tmpdir(), "agent-panel-test-"));
	const supervisor = new FleetSupervisor({
		runner,
		rootDir,
		drainMs: 20,
		stopGraceMs: options.stopGraceMs ?? 50,
		...(options.limit !== undefined ? { limit: options.limit } : {}),
	});
	return { supervisor, procs, rootDir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timeout waiting for ${message}`);
}

function sessionLine(): string {
	return JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" });
}

function assistantEnd(text: string, usage: { input: number; output: number }, stopReason = "stop"): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: usage.input, output: usage.output, cost: { total: 0.01 } },
			stopReason,
		},
	});
}

test("spawn creates child artifacts and emits agent-added in starting state", () => {
	const { supervisor } = createHarness();
	const events: string[] = [];
	supervisor.onEvent((event) => events.push(event.type));
	const handle = supervisor.spawn({ name: "alpha", prompt: "do stuff", cwd: "/tmp" });
	assert.equal(handle.state, "starting");
	assert.equal(handle.name, "alpha");
	assert.ok(handle.sessionFile.endsWith("session.jsonl"));
	assert.ok(handle.eventsFile.endsWith("events.jsonl"));
	assert.deepEqual(events, ["agent-added"]);
});

test("first parsed event transitions starting → running", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	procs[0]?.emit(sessionLine());
	await waitFor(() => supervisor.list()[0]?.state === "running", 1000, "running");
});

test("assistant message_end aggregates tokens and lastLine", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	proc.emit(assistantEnd("hello world", { input: 100, output: 20 }));
	await waitFor(() => (supervisor.list()[0]?.lastLine ?? "") === "hello world", 1000, "lastLine");
	const handle = supervisor.list()[0];
	assert.equal(handle?.tokens.input, 100);
	assert.equal(handle?.tokens.output, 20);
	assert.equal(handle?.tokens.cost, 0.01);
	assert.equal(handle?.state, "running");
});

test("tool events update toolCount and currentTool", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	proc.emit(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }));
	await waitFor(() => supervisor.list()[0]?.currentTool === "bash", 1000, "currentTool");
	proc.emit(JSON.stringify({ type: "tool_execution_end" }));
	await waitFor(() => supervisor.list()[0]?.currentTool === undefined, 1000, "currentTool cleared");
	assert.equal(supervisor.list()[0]?.toolCount, 1);
});

test("exit 0 → completed with exactly one agent-final", async () => {
	const { supervisor, procs } = createHarness();
	const finals: string[] = [];
	supervisor.onEvent((event) => {
		if (event.type === "agent-final") finals.push(event.handle.id);
	});
	const handle = supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	proc.emit(assistantEnd("done", { input: 10, output: 5 }));
	proc.exit(0);
	await waitFor(() => supervisor.list()[0]?.state === "completed", 1000, "completed");
	assert.equal(finals.length, 1);
	assert.equal(finals[0], handle.id);
	assert.equal(supervisor.list()[0]?.exitCode, 0);
	assert.ok(supervisor.list()[0]?.endedAt);
});

test("exit non-zero → failed", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	(procs[0] as FakeProc).exit(1);
	await waitFor(() => supervisor.list()[0]?.state === "failed", 1000, "failed");
});

test("stop marks stopped even when the process dies from the signal", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	assert.equal(supervisor.stop(supervisor.list()[0]?.id as string), true);
	assert.deepEqual(proc.signals, ["SIGINT"]);
	proc.exit(130);
	await waitFor(() => supervisor.list()[0]?.state === "stopped", 1000, "stopped");
});

test("stop escalates to SIGKILL after the grace window", async () => {
	const { supervisor, procs } = createHarness({ stopGraceMs: 30 });
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	supervisor.stop(supervisor.list()[0]?.id as string);
	await waitFor(() => proc.signals.includes("SIGKILL"), 1000, "SIGKILL");
	proc.exit(null as unknown as number);
	await waitFor(() => supervisor.list()[0]?.state === "stopped", 1000, "stopped after SIGKILL");
});

test("interrupt sends SIGINT but a graceful exit still completes", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	assert.equal(supervisor.interrupt(supervisor.list()[0]?.id as string), true);
	assert.deepEqual(proc.signals, ["SIGINT"]);
	proc.emit(assistantEnd("wrapped up", { input: 1, output: 1 }));
	proc.exit(0);
	await waitFor(() => supervisor.list()[0]?.state === "completed", 1000, "completed after interrupt");
});

test("non-JSON stdout lines are tolerated", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit("this is not json at all");
	proc.emit(sessionLine());
	await waitFor(() => supervisor.list()[0]?.state === "running", 1000, "running despite noise");
});

test("limit rejects further spawns", () => {
	const { supervisor } = createHarness({ limit: 1 });
	supervisor.spawn({ name: "a", prompt: "x", cwd: "/tmp" });
	assert.throws(() => supervisor.spawn({ name: "b", prompt: "x", cwd: "/tmp" }), /limit reached/);
});

test("duplicate live name rejected; reusable after terminal state", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "dup", prompt: "x", cwd: "/tmp" });
	assert.throws(() => supervisor.spawn({ name: "dup", prompt: "x", cwd: "/tmp" }), /already exists/);
	(procs[0] as FakeProc).exit(0);
	await waitFor(() => (supervisor.list()[0]?.endedAt ?? 0) > 0, 1000, "terminal");
	const firstId = supervisor.list().find((h) => h.name === "dup")?.id;
	const second = supervisor.spawn({ name: "dup", prompt: "x", cwd: "/tmp" });
	assert.notEqual(second.id, firstId);
});

test("dispose kills live children with SIGKILL and is idempotent", async () => {
	const { supervisor, procs } = createHarness();
	supervisor.spawn({ name: "a", prompt: "x", cwd: "/tmp" });
	supervisor.spawn({ name: "b", prompt: "x", cwd: "/tmp" });
	supervisor.dispose();
	for (const proc of procs) {
		assert.ok(proc.signals.includes("SIGKILL"));
	}
	assert.doesNotThrow(() => supervisor.dispose());
	assert.throws(() => supervisor.spawn({ name: "c", prompt: "x", cwd: "/tmp" }), /disposed/);
});

test("tail returns formatted readable lines and tolerates missing files", async () => {
	const { supervisor, procs } = createHarness();
	const handle = supervisor.spawn({ name: "alpha", prompt: "do the thing", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	proc.emit(sessionLine());
	proc.emit(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: do the thing" }] } }));
	proc.emit(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
	proc.emit(assistantEnd("working on it\nsecond line", { input: 1, output: 1 }));
	await waitFor(() => supervisor.tail(handle.id, 50).length >= 3, 2000, "tail lines flushed");
	const lines = supervisor.tail(handle.id, 2);
	assert.deepEqual(lines, ["working on it", "second line"]);
	// Unknown id: IO-safe empty result.
	assert.deepEqual(supervisor.tail("nope", 10), []);
});

test("steer is a documented not-implemented placeholder", () => {
	const { supervisor } = createHarness();
	assert.equal(supervisor.steer("any", "text"), "not-implemented");
});

test("raw event lines are mirrored verbatim to events.jsonl", async () => {
	const { supervisor, procs } = createHarness();
	const handle = supervisor.spawn({ name: "alpha", prompt: "x", cwd: "/tmp" });
	const proc = procs[0] as FakeProc;
	const rawLine = sessionLine();
	proc.emit(rawLine);
	await waitFor(() => supervisor.tail(handle.id, 10).length >= 0 && rawLine.length > 0, 1000, "emit");
	const { readFileSync } = await import("node:fs");
	await waitFor(() => {
		try {
			return readFileSync(handle.eventsFile, "utf-8").includes(rawLine);
		} catch {
			return false;
		}
	}, 2000, "events file flush");
});

test("stop on unknown or finished child returns false", async () => {
	const { supervisor, procs } = createHarness();
	assert.equal(supervisor.stop("missing"), false);
	const handle = supervisor.spawn({ name: "a", prompt: "x", cwd: "/tmp" });
	(procs[0] as FakeProc).exit(0);
	await waitFor(() => (supervisor.list()[0]?.endedAt ?? 0) > 0, 1000, "terminal");
	assert.equal(supervisor.stop(handle.id), false);
});
