/**
 * FleetSupervisor — the deep module of pi-agent-panel.
 *
 * Owns the full child lifecycle: headless spawn (`pi --mode json -p`), JSONL
 * event parsing, state aggregation, terminal-state detection, and event
 * fan-out. Zero TUI code, zero pi-extension API usage; process creation goes
 * through the injected ProcessRunner seam so tests run against fakes.
 *
 * Memory invariant ("disk is the full set, live is a suffix"): per child, only
 * the scalar aggregates in AgentHandle stay resident. Every stdout line is
 * appended to eventsFile; full history lives in the child's own --session
 * JSONL. Panels re-read the tail from disk on demand via tail().
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildArgs, getPiSpawnCommand, PROMPT_ARG_LIMIT, CHILD_ENV } from "./pi-spawn.ts";
import { realRunner } from "./runner.ts";
import type {
	AgentHandle,
	AgentSpec,
	AgentState,
	ChildProcessHandle,
	ProcessRunner,
	SupervisorEvent,
} from "./types.ts";

const DEFAULT_LIMIT = 8;
const DEFAULT_DRAIN_MS = 500;
const DEFAULT_STOP_GRACE_MS = 2000;
/** Bytes read from the tail of eventsFile per tail() call; ample for maxLines. */
const TAIL_READ_BYTES = 64 * 1024;

export interface SupervisorDeps {
	runner?: ProcessRunner;
	/** Root directory for child artifacts. Default: ~/.pi/agent/agent-panel */
	rootDir?: string;
	limit?: number;
	now?: () => number;
	/** Grace window after process exit for buffered stdout lines to land. */
	drainMs?: number;
	/** SIGINT → SIGKILL escalation window for stop(). */
	stopGraceMs?: number;
}

interface ChildRecord {
	handle: AgentHandle;
	proc: ChildProcessHandle;
	eventsStream: fs.WriteStream;
	outputDone: Promise<void>;
	stopRequested: boolean;
	finalized: boolean;
	finalEmitted: boolean;
	graceTimer: NodeJS.Timeout | undefined;
	finalizeTimer: NodeJS.Timeout | undefined;
}

interface ParsedEvent {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
		stopReason?: string;
		errorMessage?: string;
	};
	toolName?: string;
}

function sanitizeSegment(value: string): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "agent";
}

function assistantText(message: NonNullable<ParsedEvent["message"]>): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function hasToolCall(message: NonNullable<ParsedEvent["message"]>): boolean {
	return Array.isArray(message.content) && message.content.some((part) => part?.type === "toolCall");
}

/** JSON event line → human-readable transcript lines; empty = skip. */
export function formatEventLines(evt: ParsedEvent): string[] {
	if (evt.type === "message_end" && evt.message?.role === "user") {
		const text = assistantText(evt.message).split("\n").find((line) => line.trim());
		return text ? [`▶ ${text}`] : [];
	}
	if (evt.type === "message_end" && evt.message?.role === "assistant") {
		const text = assistantText(evt.message).trim();
		return text ? text.split("\n") : [];
	}
	if (evt.type === "tool_execution_start") {
		return [`⚙ ${evt.toolName ?? "tool"}`];
	}
	return [];
}

export class FleetSupervisor {
	private readonly runner: ProcessRunner;
	private readonly rootDir: string;
	private readonly limit: number;
	private readonly now: () => number;
	private readonly drainMs: number;
	private readonly stopGraceMs: number;
	private readonly children = new Map<string, ChildRecord>();
	private readonly listeners = new Set<(event: SupervisorEvent) => void>();
	private disposed = false;

	constructor(deps: SupervisorDeps = {}) {
		this.runner = deps.runner ?? realRunner;
		this.rootDir = deps.rootDir ?? path.join(os.homedir(), ".pi", "agent", "agent-panel");
		this.limit = deps.limit ?? DEFAULT_LIMIT;
		this.now = deps.now ?? Date.now;
		this.drainMs = deps.drainMs ?? DEFAULT_DRAIN_MS;
		this.stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
	}

	spawn(spec: AgentSpec): AgentHandle {
		if (this.disposed) throw new Error("FleetSupervisor is disposed");
		if (!spec.name.trim()) throw new Error("Agent name must be non-empty");
		const liveCount = [...this.children.values()].filter((record) => !record.handle.endedAt).length;
		if (liveCount >= this.limit) {
			throw new Error(`Agent limit reached (${this.limit} live children)`);
		}
		const nameTaken = [...this.children.values()].some(
			(record) => record.handle.name === spec.name && !record.handle.endedAt,
		);
		if (nameTaken) throw new Error(`A live agent named '${spec.name}' already exists`);

		const id = `${sanitizeSegment(spec.name)}-${this.now().toString(36)}-${createHash("sha1")
			.update(`${spec.name}:${this.now()}:${Math.random()}`)
			.digest("hex")
			.slice(0, 6)}`;
		const childDir = path.join(this.rootDir, id);
		fs.mkdirSync(childDir, { recursive: true });

		const sessionFile = path.join(childDir, "session.jsonl");
		const eventsFile = path.join(childDir, "events.jsonl");
		let promptFile: string | undefined;
		if (spec.prompt.length > PROMPT_ARG_LIMIT) {
			promptFile = path.join(childDir, "task.md");
			fs.writeFileSync(promptFile, `Task: ${spec.prompt}`);
		}

		const args = buildChildArgs({
			sessionFile,
			...(spec.model ? { model: spec.model } : {}),
			...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
			prompt: spec.prompt,
			...(promptFile ? { promptFile } : {}),
		});
		const spawnSpec = getPiSpawnCommand(args);
		const proc = this.runner.spawn(spawnSpec.command, spawnSpec.args, {
			cwd: spec.cwd,
			env: { ...process.env, [CHILD_ENV]: "1" },
		});

		const handle: AgentHandle = {
			id,
			name: spec.name,
			state: "starting",
			startedAt: this.now(),
			tokens: { input: 0, output: 0, cost: 0 },
			toolCount: 0,
			sessionFile,
			eventsFile,
			lastLine: "",
		};
		const eventsStream = fs.createWriteStream(eventsFile, { flags: "a" });
		const record: ChildRecord = {
			handle,
			proc,
			eventsStream,
			outputDone: Promise.resolve(),
			stopRequested: false,
			finalized: false,
			finalEmitted: false,
			graceTimer: undefined,
			finalizeTimer: undefined,
		};
		this.children.set(id, record);
		record.outputDone = this.consumeOutput(record);
		void this.awaitExit(record);
		this.emit({ type: "agent-added", handle: this.snapshot(handle) });
		return this.snapshot(handle);
	}

	/** D5: seam placeholder so the interface stays stable for phase 2. */
	steer(_id: string, _text: string): "not-implemented" {
		return "not-implemented";
	}

	/** Send SIGINT for a graceful abort; the child may still complete. */
	interrupt(id: string): boolean {
		const record = this.children.get(id);
		if (!record || record.handle.endedAt) return false;
		record.proc.kill("SIGINT");
		return true;
	}

	/** Request termination: SIGINT, then SIGKILL after the grace window. */
	stop(id: string): boolean {
		const record = this.children.get(id);
		if (!record || record.handle.endedAt) return false;
		record.stopRequested = true;
		record.proc.kill("SIGINT");
		record.graceTimer = setTimeout(() => {
			if (!record.finalized) record.proc.kill("SIGKILL");
		}, this.stopGraceMs);
		record.graceTimer.unref?.();
		return true;
	}

	list(): AgentHandle[] {
		return [...this.children.values()].map((record) => this.snapshot(record.handle));
	}

	/**
	 * Read the readable tail of a child's transcript (formatted lines, oldest
	 * first). IO-safe: any failure yields an empty array, never a throw —
	 * render paths depend on this.
	 */
	tail(id: string, maxLines: number): string[] {
		const record = this.children.get(id);
		if (!record || maxLines <= 0) return [];
		try {
			const stat = fs.statSync(record.handle.eventsFile);
			const length = Math.min(stat.size, TAIL_READ_BYTES);
			const buffer = Buffer.alloc(length);
			const fd = fs.openSync(record.handle.eventsFile, "r");
			try {
				fs.readSync(fd, buffer, 0, length, stat.size - length);
			} finally {
				fs.closeSync(fd);
			}
			const raw = buffer.toString("utf-8");
			// Drop the potentially-truncated first line of the window.
			const window = stat.size > length ? raw.slice(raw.indexOf("\n") + 1) : raw;
			const lines: string[] = [];
			for (const line of window.split("\n")) {
				if (!line.trim()) continue;
				try {
					lines.push(...formatEventLines(JSON.parse(line) as ParsedEvent));
				} catch {
					lines.push(line);
				}
			}
			return lines.slice(-maxLines);
		} catch {
			return [];
		}
	}

	onEvent(callback: (event: SupervisorEvent) => void): () => void {
		this.listeners.add(callback);
		return () => {
			this.listeners.delete(callback);
		};
	}

	/** Kill everything and clear timers. Idempotent; supervisor is dead after. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const record of this.children.values()) {
			this.clearTimers(record);
			if (!record.handle.endedAt) {
				try {
					record.proc.kill("SIGKILL");
				} catch {
					// Best effort.
				}
			}
			record.eventsStream.end();
		}
		this.listeners.clear();
	}

	private snapshot(handle: AgentHandle): AgentHandle {
		return {
			...handle,
			tokens: { ...handle.tokens },
		};
	}

	private emit(event: SupervisorEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener errors must not break supervision.
			}
		}
	}

	private async consumeOutput(record: ChildRecord): Promise<void> {
		try {
			for await (const line of record.proc.stdout) {
				if (!line.trim()) continue;
				record.eventsStream.write(`${line}\n`);
				this.applyEvent(record, line);
			}
		} catch {
			// Stream errors surface through the exit path instead.
		}
	}

	private applyEvent(record: ChildRecord, line: string): void {
		let evt: ParsedEvent;
		try {
			evt = JSON.parse(line) as ParsedEvent;
		} catch {
			return; // Non-JSON stdout lines are tolerated by contract.
		}
		const handle = record.handle;
		let changed = false;

		if (handle.state === "starting" && typeof evt.type === "string") {
			handle.state = "running";
			changed = true;
		}

		if (evt.type === "tool_execution_start" && typeof evt.toolName === "string") {
			handle.toolCount += 1;
			handle.currentTool = evt.toolName;
			changed = true;
		}
		if (evt.type === "tool_execution_end" && handle.currentTool !== undefined) {
			handle.currentTool = undefined;
			changed = true;
		}

		if (evt.type === "message_end" && evt.message?.role === "assistant") {
			const usage = evt.message.usage;
			if (usage) {
				handle.tokens.input += usage.input ?? 0;
				handle.tokens.output += usage.output ?? 0;
				handle.tokens.input += usage.cacheRead ?? 0;
				handle.tokens.input += usage.cacheWrite ?? 0;
				handle.tokens.cost += usage.cost?.total ?? 0;
			}
			const text = assistantText(evt.message).trim();
			if (text) {
				const last = text.split("\n").filter((l) => l.trim()).pop();
				if (last) handle.lastLine = last;
			}
			changed = true;
		}

		if (changed && !handle.endedAt) {
			this.emit({ type: "agent-updated", handle: this.snapshot(handle) });
		}
	}

	private async awaitExit(record: ChildRecord): Promise<void> {
		let exitCode: number;
		try {
			exitCode = await record.proc.exited;
		} catch {
			exitCode = -1;
		}
		// Give buffered stdout lines a bounded window to land before freezing state.
		await Promise.race([
			record.outputDone,
			new Promise<void>((resolve) => {
				record.finalizeTimer = setTimeout(resolve, this.drainMs);
				record.finalizeTimer.unref?.();
			}),
		]);
		this.finalize(record, exitCode);
	}

	private finalize(record: ChildRecord, exitCode: number): void {
		if (record.finalized) return;
		record.finalized = true;
		this.clearTimers(record);
		const handle = record.handle;
		handle.exitCode = exitCode;
		handle.endedAt = this.now();
		handle.currentTool = undefined;
		handle.state = this.terminalState(record, exitCode);
		record.eventsStream.end();
		this.dumpStderr(record);
		this.emit({ type: "agent-updated", handle: this.snapshot(handle) });
		if (!record.finalEmitted) {
			record.finalEmitted = true;
			this.emit({ type: "agent-final", handle: this.snapshot(handle) });
		}
	}

	/** Persist the child's stderr tail next to its artifacts for debugging. */
	private dumpStderr(record: ChildRecord): void {
		try {
			const tail = record.proc.stderrTail?.();
			if (tail && tail.trim()) {
				fs.writeFileSync(path.join(path.dirname(record.handle.eventsFile), "stderr.log"), tail);
			}
		} catch {
			// Diagnostics are best-effort.
		}
	}

	private terminalState(record: ChildRecord, exitCode: number): AgentState {
		if (record.stopRequested) return "stopped";
		return exitCode === 0 ? "completed" : "failed";
	}

	private clearTimer(record: ChildRecord, key: "graceTimer" | "finalizeTimer"): void {
		const timer = record[key];
		if (timer) {
			clearTimeout(timer);
			record[key] = undefined;
		}
	}

	private clearTimers(record: ChildRecord): void {
		this.clearTimer(record, "graceTimer");
		this.clearTimer(record, "finalizeTimer");
	}
}
