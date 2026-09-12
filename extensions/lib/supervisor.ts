/**
 * FleetSupervisor — the deep module of pi-agent-panel.
 *
 * A pool of long-lived rpc children (`pi --mode rpc`): spawn/prompt/steer/
 * abort/archive plus state aggregation and event fan-out. Zero TUI code,
 * zero pi-extension API usage; session creation goes through the injected
 * RpcSessionFactory seam so unit tests run against scripted fakes.
 *
 * State derivation is event-first (decision D-state): agent_start/agent_end
 * drive working ⇄ awaiting-input; one getState() after spawn aligns the
 * initial snapshot. A slow liveness probe (probeMs) exists only to notice a
 * child that died while idle — RpcClient surfaces no exit callback.
 *
 * Memory invariant ("disk is the full set, live is a suffix"): per child,
 * only the scalar aggregates in AgentHandle stay resident. Every onEvent
 * object is appended (re-serialized) to eventsFile; full history lives in
 * the child's own --session JSONL. Panels re-read the tail on demand.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realRpcSessionFactory } from "./rpc-session.ts";
import type {
	RosterSnapshot,
	AgentHandle,
	AgentSpec,
	AgentState,
	PromptOrigin,
	RpcAgentEvent,
	RpcSessionFactory,
	RpcSession,
	RpcSessionSnapshot,
	SupervisorEvent,
} from "./types.ts";

/** Long-lived children each hold a full agent runtime: keep the pool small. */
const DEFAULT_LIMIT = 4;
const DEFAULT_PROBE_MS = 5000;
/** Bytes read from the tail of eventsFile per tail() call; ample for maxLines. */
const TAIL_READ_BYTES = 64 * 1024;

export interface SupervisorDeps {
	sessionFactory?: RpcSessionFactory;
	/** Root directory for child artifacts. Default: ~/.pi/agent/agent-panel */
	rootDir?: string;
	limit?: number;
	now?: () => number;
	/** Idle-liveness probe interval; 0 disables (tests). */
	probeMs?: number;
}

interface ChildRecord {
	handle: AgentHandle;
	session: RpcSession;
	unsubscribeEvents: () => void;
	/** Append mirror stream; created lazily so discovered rows cost no fd. */
	eventsStream?: fs.WriteStream;
	probe: ReturnType<typeof setInterval> | undefined;
	/** Rebuilt from disk at startup (B6b): no live process behind it. */
	discovered?: boolean;
	/** Origin of the in-flight turn (reset to background at turn end). */
	currentOrigin: PromptOrigin;
	finalized: boolean;
}

function sanitizeSegment(value: string): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "agent";
}

function assistantText(message: NonNullable<RpcAgentEvent["message"]>): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

/** Event object → human-readable transcript lines; empty = skip. */
export function formatEventLines(evt: RpcAgentEvent): string[] {
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
	if (evt.type === "extension_ui_request") {
		return [`⚠ child ui request denied: ${evt.title ?? evt.method ?? "unknown"}`];
	}
	return [];
}

export class FleetSupervisor {
	private readonly sessionFactory: RpcSessionFactory;
	private readonly rootDir: string;
	private readonly limit: number;
	private readonly now: () => number;
	private readonly probeMs: number;
	private readonly children = new Map<string, ChildRecord>();
	private readonly listeners = new Set<(event: SupervisorEvent) => void>();
	/** Raw per-child rpc events, tapped for the panel's conversation view. */
	private readonly rawListeners = new Set<(id: string, event: RpcAgentEvent) => void>();
	private readonly archivedIds: Set<string>;
	private readonly pinnedIds: Set<string>;
	private disposed = false;
	/** Roster cache (plan A9): emit() is the single point of state change,
	 *  so it is the only invalidation trigger. */
	private rosterDirty = true;
	private rosterCache?: RosterSnapshot;

	constructor(deps: SupervisorDeps = {}) {
		this.sessionFactory = deps.sessionFactory ?? realRpcSessionFactory;
		this.rootDir = deps.rootDir ?? path.join(os.homedir(), ".pi", "agent", "agent-panel");
		this.limit = deps.limit ?? DEFAULT_LIMIT;
		this.now = deps.now ?? Date.now;
		this.probeMs = deps.probeMs ?? DEFAULT_PROBE_MS;
		const state = this.loadState();
		this.archivedIds = state.archivedIds;
		this.pinnedIds = state.pinnedIds;
		this.discoverChildren();
	}

	/** Rebuild rows for child dirs on disk (plan B6b): the dir basename IS
	 *  the agent id (spawn derives it that way), so history keeps its ids
	 *  across restarts. Rows land as archived, no process, no probe, no fd.
	 *  Rows whose id is in the archived set stay hidden — removal survives
	 *  restarts. */
	private discoverChildren(): void {
		let entries: Array<fs.Dirent>;
		try {
			entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
		} catch {
			return; // no fleet dir yet
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const id = entry.name;
			if (this.children.has(id)) continue;
			const childDirPath = path.join(this.rootDir, id);
			const sessionFile = path.join(childDirPath, "session.jsonl");
			const eventsFile = path.join(childDirPath, "events.jsonl");
			try {
				if (!fs.existsSync(sessionFile) && !fs.existsSync(eventsFile)) continue;
			} catch {
				continue;
			}
			let startedAt = this.now();
			try {
				startedAt = Math.round(fs.statSync(childDirPath).mtimeMs);
			} catch {
				// best-effort
			}
			const handle: AgentHandle = {
				id,
				name: id,
				state: "archived",
				cwd: process.cwd(),
				startedAt,
				tokens: { input: 0, output: 0, cost: 0 },
				toolCount: 0,
				turnCount: 0,
				sessionFile,
				eventsFile,
				lastLine: "",
				lastActivityAt: startedAt,
				pendingCount: 0,
				pinned: this.pinnedIds.has(id),
			};
			this.children.set(id, {
				handle,
				session: inertSessionStub(),
				unsubscribeEvents: () => {},
				eventsStream: undefined,
				probe: undefined,
				currentOrigin: "background",
				finalized: false,
				discovered: true,
			});
		}
	}

	/** Create a live rpc child. Resolves once the session is started and its
	 *  initial state aligned; the optional first prompt is sent as background.
	 *  `spec.resume` re-adopts an existing child session file (detach flow):
	 *  the child directory and events mirror are the original ones. */
	async spawn(spec: AgentSpec & { prompt?: string }): Promise<AgentHandle> {
		if (this.disposed) throw new Error("FleetSupervisor is disposed");
		if (!spec.name.trim()) throw new Error("Agent name must be non-empty");
		const liveCount = [...this.children.values()].filter((record) => isLive(record.handle)).length;
		if (liveCount >= this.limit) {
			throw new Error(`Agent limit reached (${this.limit} live children)`);
		}
		const nameTaken = [...this.children.values()].some(
			(record) => record.handle.name === spec.name && isLive(record.handle),
		);
		if (nameTaken) throw new Error(`A live agent named '${spec.name}' already exists`);

		const resumedDir = spec.resume ? path.dirname(spec.resume) : undefined;
		const id = resumedDir ? path.basename(resumedDir) : `${sanitizeSegment(spec.name)}-${this.now().toString(36)}-${createHash("sha1")
			.update(`${spec.name}:${this.now()}:${Math.random()}`)
			.digest("hex")
			.slice(0, 6)}`;
		if (this.children.has(id)) throw new Error(`Agent '${id}' is already supervised`);
		const childDir = resumedDir ?? path.join(this.rootDir, id);
		fs.mkdirSync(childDir, { recursive: true });
		const sessionFile = spec.resume ?? path.join(childDir, "session.jsonl");
		const eventsFile = path.join(childDir, "events.jsonl");
		// createWriteStream opens lazily: touch the file so takeover/detach on
		// a never-emitting child still leaves a readable mirror behind.
		fs.closeSync(fs.openSync(eventsFile, "a"));

		const handle: AgentHandle = {
			id,
			name: spec.name,
			state: "starting",
			cwd: spec.cwd,
			startedAt: this.now(),
			tokens: { input: 0, output: 0, cost: 0 },
			toolCount: 0,
			turnCount: 0,
			sessionFile,
			eventsFile,
			lastLine: "",
			lastActivityAt: this.now(),
			pendingCount: 0,
			pinned: false,
		};
		this.emit({ type: "agent-added", handle: this.snapshot(handle) });

		let session;
		try {
			session = await this.sessionFactory({
				cwd: spec.cwd,
				sessionFile,
				...(spec.model ? { model: spec.model } : {}),
			});
		} catch (error) {
			this.markCrashed(handle, undefined, error instanceof Error ? error.message : String(error));
			throw new Error(`Failed to start rpc child '${spec.name}': ${error instanceof Error ? error.message : String(error)}`);
		}

		let record: ChildRecord;
		try {
			const recordRef: ChildRecord = {
				handle,
				session,
				unsubscribeEvents: () => {},
				eventsStream: fs.createWriteStream(eventsFile, { flags: "a" }),
				probe: undefined,
				currentOrigin: "background",
				finalized: false,
			};
			record = recordRef;
			this.children.set(id, recordRef);
			recordRef.unsubscribeEvents = session.onEvent((event) => this.applyEvent(recordRef, event));
			recordRef.probe = this.startProbe(recordRef);
		} catch (error) {
			void session.stop().catch(() => {});
			this.markCrashed(handle, undefined, error instanceof Error ? error.message : String(error));
			throw new Error(`Failed to wire rpc child '${spec.name}': ${error instanceof Error ? error.message : String(error)}`);
		}

		// One-shot initial alignment (decision D-state): trust events after this.
		try {
			const state = await session.getState();
			this.alignState(record, state);
		} catch {
			// Alignment is best-effort; events and the probe cover the rest.
		}
		this.emit({ type: "agent-updated", handle: this.snapshot(handle) });

		if (spec.prompt?.trim()) await this.prompt(id, spec.prompt, "background");
		return this.snapshot(handle);
	}

	/**
	 * Send user text to an agent. Idle → new turn (prompt); working → native
	 * steer semantics — the same composer input is correct in both phases.
	 */
	async prompt(id: string, text: string, origin: PromptOrigin = "background"): Promise<boolean> {
		const record = this.children.get(id);
		if (!record || !isLive(record.handle) || !text.trim()) return false;
		record.currentOrigin = origin;
		record.handle.lastActivityAt = this.now();
		try {
			if (record.handle.state === "working") await record.session.steer(text);
			else await record.session.prompt(text);
			return true;
		} catch {
			this.markCrashed(record.handle, undefined, "send failed");
			return false;
		}
	}

	/** Interrupt the current turn (rpc abort); the agent itself stays alive. */
	async abort(id: string): Promise<boolean> {
		const record = this.children.get(id);
		if (!record || !isLive(record.handle)) return false;
		try {
			await record.session.abort();
			record.handle.lastActivityAt = this.now();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Archive: hide from the live groups, kill the process (SIGTERM→SIGKILL
	 * inside the client), keep session/events JSONL on disk. The archived set
	 * is persisted to state.json so the hiding survives restarts (revive is
	 * phase 2).
	 */
	/** Archive = remove from the panel (plan B6b semantics): stop the
	 *  process, persist the id so the removal survives restarts, drop the
	 *  row. Disk files are never touched — the session stays resumable by
	 *  pi itself. */
	async archive(id: string): Promise<boolean> {
		const record = this.children.get(id);
		if (!record) return false;
		if (record.discovered) {
			// Discovered history row: nothing to stop, just hide it.
			this.children.delete(id);
			this.archivedIds.add(id);
			this.persistState();
			return true;
		}
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.handle.state = "archived";
		record.handle.endedAt = this.now();
		record.handle.currentTool = undefined;
		this.archivedIds.add(id);
		this.persistState();
		record.eventsStream?.end();
		this.emit({ type: "agent-updated", handle: this.snapshot(record.handle) });
		this.emit({ type: "agent-final", handle: this.snapshot(record.handle) });
		try {
			await record.session.stop();
		} catch {
			// The kill chain escalates internally; a rejected stop still killed.
		}
		// Release the stopped client/process reference (plan B6a) and drop
		// the row: "removed from the panel" means list() no longer shows it.
		record.session = inertSessionStub();
		this.children.delete(id);
		return true;
	}

	/** Stage 1 of the two-stage x (plan B6b): stop the background process
	 *  but keep the row listed (crashed) — x again removes it. */
	async stop(id: string): Promise<boolean> {
		const record = this.children.get(id);
		if (!record || !isLive(record.handle)) return false;
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.handle.state = "crashed";
		record.handle.endedAt = this.now();
		record.handle.currentTool = undefined;
		record.eventsStream?.end();
		try {
			await record.session.stop();
		} catch {
			// The kill chain escalates internally; a rejected stop still killed.
		}
		record.session = inertSessionStub();
		this.emit({ type: "agent-updated", handle: this.snapshot(record.handle) });
		return true;
	}

	/** Revive a non-live row (discovered history, crashed, or stopped):
	 *  respawn a background driver on the same session file — the child dir
	 *  basename keeps the id stable across the round trip (plan B6b). */
	async resume(id: string): Promise<AgentHandle> {
		const record = this.children.get(id);
		if (!record) throw new Error(`agent-panel: no agent matches '${id}'`);
		if (isLive(record.handle)) return this.snapshot(record.handle);
		const { name, cwd, sessionFile } = record.handle;
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.eventsStream?.end();
		this.children.delete(id);
		this.archivedIds.delete(id);
		this.persistState();
		return this.spawn({ name, cwd, resume: sessionFile });
	}

	pin(id: string, pinned?: boolean): boolean {
		const record = this.children.get(id);
		if (!record) return false;
		record.handle.pinned = pinned ?? !record.handle.pinned;
		if (record.handle.pinned) this.pinnedIds.add(id);
		else this.pinnedIds.delete(id);
		this.persistState();
		this.emit({ type: "agent-updated", handle: this.snapshot(record.handle) });
		return true;
	}

	/**
	 * Takeover: stop the child's rpc process and hand its session file to the
	 * main REPL (ctx.switchSession in the command layer). The record stays in
	 * the pool flagged `attached` so the panel can list it and detach later.
	 * Unlike archive this does not emit agent-final — nothing crashed; the
	 * conversation moved to a driver the user is looking at.
	 */
	async takeover(id: string): Promise<AgentHandle | null> {
		const record = this.children.get(id);
		if (!record || !isLive(record.handle)) return null;
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.handle.state = "archived";
		record.handle.attached = true;
		record.handle.endedAt = this.now();
		record.handle.currentTool = undefined;
		this.archivedIds.add(id);
		this.persistState();
		record.eventsStream?.end();
		try {
			await record.session.stop();
		} catch {
			// The kill chain escalates internally; a rejected stop still killed.
		}
		// Release the stopped client/process reference (plan B6a): archived
		// rows otherwise pin dead RpcSession objects for the host's lifetime.
		record.session = inertSessionStub();
		this.emit({ type: "agent-updated", handle: this.snapshot(record.handle) });
		return this.snapshot(record.handle);
	}

	/**
	 * Detach: hand an attached conversation back to background supervision by
	 * respawning an rpc child on the same session file (events mirror is
	 * appended in place, so the view's history stays continuous).
	 */
	async detach(id: string): Promise<AgentHandle | null> {
		const record = this.children.get(id);
		if (!record || !record.handle.attached) return null;
		const { name, cwd, sessionFile } = record.handle;
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.eventsStream?.end();
		this.children.delete(id);
		this.archivedIds.delete(id);
		this.persistState();
		return this.spawn({ name, cwd, resume: sessionFile });
	}

	list(): AgentHandle[] {
		return [...this.children.values()]
			.filter((record) => !(record.discovered && this.archivedIds.has(record.handle.id)))
			.map((record) => this.snapshot(record.handle));
	}

	/** Change-derived roster counts (plan A9): computed once per state
	 *  change, served from cache otherwise — pill/panel share the snapshot
	 *  instead of re-scanning the fleet per event. */
	roster(): RosterSnapshot {
		if (!this.rosterDirty && this.rosterCache) return this.rosterCache;
		let working = 0;
		let awaiting = 0;
		let archived = 0;
		for (const record of this.children.values()) {
			if (record.discovered && this.archivedIds.has(record.handle.id)) continue;
			const state = record.handle.state;
			if (state === "working" || state === "starting") working += 1;
			else if (state === "awaiting-input") awaiting += 1;
			else archived += 1;
		}
		this.rosterCache = { working, awaiting, archived };
		this.rosterDirty = false;
		return this.rosterCache;
	}

	/**
	 * Read the readable tail of a child's transcript (formatted lines, oldest
	 * first). IO-safe: any failure yields an empty array, never a throw —
	 * render paths depend on this.
	 */
	tail(id: string, maxLines: number): string[] {
		const lines = this.readEventWindow(id).flatMap((evt) => {
			if (typeof evt === "string") return [evt];
			return formatEventLines(evt);
		});
		return lines.slice(-Math.max(0, maxLines));
	}

	/**
	 * Read the raw event tail for the conversation view: parsed rpc events,
	 * oldest first, at most `maxEvents` of them, plus how many older entries
	 * exist in the window but were dropped (the view shows a truncation hint).
	 * IO-safe like tail(): failures yield an empty result, never a throw.
	 */
	tailEvents(id: string, maxEvents: number): { events: RpcAgentEvent[]; dropped: number } {
		const record = this.children.get(id);
		if (!record) return { events: [], dropped: 0 };
		const window = this.readEventWindow(id);
		const events = window.filter((evt): evt is RpcAgentEvent => typeof evt !== "string");
		const sliced = events.slice(-Math.max(0, maxEvents));
		// Honest dropped count (plan B6a): count every non-empty line in the
		// WHOLE file — previously only lines inside the 64KB window counted, so
		// everything older than the window was silently under-reported.
		const totalLines = countNonEmptyLines(record.handle.eventsFile);
		return { events: sliced, dropped: Math.max(0, totalLines - sliced.length) };
	}

	/** Every event in the trailing TAIL_READ_BYTES window (parsed; unparsable
	 *  lines pass through as strings), oldest first, untruncated. */
	private readEventWindow(id: string): Array<RpcAgentEvent | string> {
		const out: Array<RpcAgentEvent | string> = [];
		try {
			const record = this.children.get(id);
			if (!record) return out;
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
			for (const line of window.split("\n")) {
				if (!line.trim()) continue;
				try {
					out.push(JSON.parse(line) as RpcAgentEvent);
				} catch {
					out.push(line);
				}
			}
		} catch {
			// Fall through with whatever was parsed.
		}
		return out;
	}

	/** Subscribe to raw per-child rpc events (id, event). Panel view uses
	 *  this to grow the conversation live; unsubscribe stops the tap. */
	onChildEvent(listener: (id: string, event: RpcAgentEvent) => void): () => void {
		this.rawListeners.add(listener);
		return () => {
			this.rawListeners.delete(listener);
		};
	}

	onEvent(callback: (event: SupervisorEvent) => void): () => void {
		this.listeners.add(callback);
		return () => {
			this.listeners.delete(callback);
		};
	}

	/** Stop every child and clear timers. Idempotent; supervisor is dead after. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const record of this.children.values()) {
			this.clearProbe(record);
			record.unsubscribeEvents();
			record.eventsStream?.end();
			if (isLive(record.handle)) {
				record.handle.state = "archived";
				record.handle.endedAt = this.now();
				void record.session.stop().catch(() => {});
			}
		}
		this.listeners.clear();
		this.rawListeners.clear();
	}

	private applyEvent(record: ChildRecord, evt: RpcAgentEvent): void {
		const handle = record.handle;
		if (handle.state === "archived") return;
		// Mirror first: the disk copy is the full set even if aggregation below
		// changes nothing visible.
		try {
			record.eventsStream ??= fs.createWriteStream(record.handle.eventsFile, { flags: "a" });
			record.eventsStream.write(`${JSON.stringify(evt)}\n`);
		} catch {
			// Mirroring is best-effort; supervision continues.
		}
		for (const listener of this.rawListeners) listener(handle.id, evt);
		handle.lastActivityAt = this.now();
		let changed = true;

		switch (evt.type) {
			case "agent_start":
				if (isLive(handle)) handle.state = "working";
				break;
			case "agent_end":
				handle.currentTool = undefined;
				if (!evt.willRetry && isLive(handle)) {
					handle.state = "awaiting-input";
					handle.turnCount += 1;
					const origin = record.currentOrigin;
					record.currentOrigin = "background";
					this.emit({ type: "turn-ended", handle: this.snapshot(handle), origin });
				}
				break;
			case "tool_execution_start":
				if (typeof evt.toolName === "string") {
					handle.toolCount += 1;
					handle.currentTool = evt.toolName;
				}
				break;
			case "tool_execution_end":
				handle.currentTool = undefined;
				break;
			case "message_end":
				if (evt.message?.role === "assistant") {
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
				}
				break;
			default:
				changed = false;
		}

		if (handle.state === "starting" && typeof evt.type === "string" && evt.type !== "session") {
			handle.state = "awaiting-input";
		}
		if (changed) this.emit({ type: "agent-updated", handle: this.snapshot(handle) });
	}

	private alignState(record: ChildRecord, state: RpcSessionSnapshot): void {
		const handle = record.handle;
		if (handle.state === "starting") handle.state = state.isStreaming ? "working" : "awaiting-input";
		handle.pendingCount = state.pendingMessageCount ?? handle.pendingCount;
	}

	/** Idle-death detector: RpcClient exposes no exit callback, so a slow
	 *  getState() probe is the only crash signal while no command is flying. */
	private startProbe(record: ChildRecord): ReturnType<typeof setInterval> | undefined {
		if (this.probeMs <= 0) return undefined;
		const probe = setInterval(() => {
			if (record.handle.state === "archived") return;
			record.session
				.getState()
				.then((state) => {
					if (record.handle.state === "archived") return;
					record.handle.pendingCount = state.pendingMessageCount ?? record.handle.pendingCount;
				})
				.catch(() => {
					if (!record.finalized && isLive(record.handle)) {
						this.markCrashed(record.handle, undefined, "liveness probe failed");
					}
				});
		}, this.probeMs);
		probe.unref?.();
		return probe;
	}

	private markCrashed(handle: AgentHandle, exitCode: number | undefined, reason: string): void {
		let record = this.children.get(handle.id);
		if (!record) {
			// Spawn failed before the record was wired: keep the crashed row
			// listed (plan B5) — otherwise agent-final fires for a handle
			// list() never returns and the agent silently vanishes.
			record = {
				handle,
				session: inertSessionStub(),
				unsubscribeEvents: () => {},
				eventsStream: undefined,
				probe: undefined,
				currentOrigin: "background",
				finalized: false,
			};
			this.children.set(handle.id, record);
		}
		if (record.finalized) return;
		record.finalized = true;
		this.clearProbe(record);
		record.unsubscribeEvents();
		record.eventsStream?.end();
		handle.state = "crashed";
		handle.endedAt = this.now();
		handle.currentTool = undefined;
		handle.exitCode = exitCode;
		if (reason) {
			try {
				fs.writeFileSync(path.join(path.dirname(handle.eventsFile), "crash.log"), `${new Date().toISOString()} ${reason}\n`);
			} catch {
				// Diagnostics are best-effort.
			}
		}
		this.emit({ type: "agent-updated", handle: this.snapshot(handle) });
		this.emit({ type: "agent-final", handle: this.snapshot(handle) });
	}

	private persistState(): void {
		try {
			fs.mkdirSync(this.rootDir, { recursive: true });
			// Atomic write (tmp+rename, 0600 — plan B6a): a torn write must
			// never leave a half-written state.json for the next startup.
			const target = path.join(this.rootDir, "state.json");
			const tmp = `${target}.tmp`;
			const fd = fs.openSync(tmp, "w", 0o600);
			try {
				fs.writeFileSync(
					fd,
					`${JSON.stringify({ archivedIds: [...this.archivedIds], pinnedIds: [...this.pinnedIds] }, null, "\t")}\n`,
				);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, target);
		} catch {
			// Persistence is best-effort; in-memory state still applies.
		}
	}

	private loadState(): { archivedIds: Set<string>; pinnedIds: Set<string> } {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(this.rootDir, "state.json"), "utf-8")) as {
				archivedIds?: unknown;
				pinnedIds?: unknown;
			};
			const archived = Array.isArray(raw.archivedIds)
				? raw.archivedIds.filter((v): v is string => typeof v === "string")
				: [];
			const pinned = Array.isArray(raw.pinnedIds)
				? raw.pinnedIds.filter((v): v is string => typeof v === "string")
				: [];
			return { archivedIds: new Set(archived), pinnedIds: new Set(pinned) };
		} catch {
			// Missing/invalid state file starts with empty sets.
			return { archivedIds: new Set(), pinnedIds: new Set() };
		}
	}

	private clearProbe(record: ChildRecord): void {
		if (record.probe) {
			clearInterval(record.probe);
			record.probe = undefined;
		}
	}

	private snapshot(handle: AgentHandle): AgentHandle {
		return {
			...handle,
			tokens: { ...handle.tokens },
		};
	}

	private emit(event: SupervisorEvent): void {
		this.rosterDirty = true;
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener errors must not break supervision.
			}
		}
	}
}

function isLive(handle: AgentHandle): boolean {
	return handle.state === "starting" || handle.state === "working" || handle.state === "awaiting-input";
}

/** Inert RpcSession stand-in for crashed rows that never wired a session. */
function inertSessionStub(): import("./types.ts").RpcSession {
	return {
		prompt: async () => {},
		steer: async () => {},
		abort: async () => {},
		getState: async () => {
			throw new Error("agent crashed");
		},
		stop: async () => {},
		onEvent: () => () => {},
	};
}

/** Count non-empty lines in a file without loading it (chunked byte scan). */
function countNonEmptyLines(file: string): number {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const chunk = Buffer.alloc(64 * 1024);
			let count = 0;
			let inLine = false;
			for (;;) {
				const read = fs.readSync(fd, chunk, 0, chunk.length, null);
				if (read === 0) break;
				for (let i = 0; i < read; i++) {
					const byte = chunk[i];
					if (byte === 0x0a) {
						if (inLine) count += 1;
						inLine = false;
					} else if (byte !== 0x0d && byte !== 0x20 && byte !== 0x09) {
						inLine = true;
					}
				}
			}
			if (inLine) count += 1;
			return count;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return 0;
	}
}

export function groupOf(state: AgentState): "working" | "awaiting-input" | "archived" {
	if (state === "working" || state === "starting") return "working";
	if (state === "crashed" || state === "archived") return "archived";
	return "awaiting-input";
}
