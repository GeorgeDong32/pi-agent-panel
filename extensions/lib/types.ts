/**
 * Shared types for pi-agent-panel.
 *
 * AgentHandle is the render-safe snapshot contract: plain data only, no
 * process handles, no ctx references. FleetPanel renders exclusively from
 * these snapshots + tail() output, never touching live pi objects.
 */

export interface AgentSpec {
	/** Panel display name; also used as the child directory stem. */
	name: string;
	/** Working directory for the child process. */
	cwd: string;
	/** Forwarded as --model (e.g. "anthropic/claude-..."). */
	model?: string;
	/** Resume an existing child session file instead of creating a new one
	 *  (detach: hand an attached conversation back to background supervision). */
	resume?: string;
}

/**
 * rpc session-pool lifecycle. "working" = isStreaming (turn running);
 * "awaiting-input" = alive and idle; "crashed" = process died on its own;
 * "archived" = user archived (killed, JSONL kept, hidden from live groups).
 */
export type AgentState = "starting" | "working" | "awaiting-input" | "crashed" | "archived";

/** Who initiated the current turn — drives notification suppression (D-suppress). */
export type PromptOrigin = "panel" | "background";

export interface AgentTokens {
	input: number;
	output: number;
	cost: number;
}

export interface AgentHandle {
	id: string;
	name: string;
	state: AgentState;
	/** Child's working directory (spawn/resume anchor). */
	cwd: string;
	startedAt: number;
	/** Set when the process left the pool (crash or archive). */
	endedAt?: number;
	/** Process exit code, when observed (crash). */
	exitCode?: number;
	tokens: AgentTokens;
	toolCount: number;
	/** Completed conversation turns (agent_end without willRetry). */
	turnCount: number;
	/** Child's own --session JSONL: the full-history source of truth. */
	sessionFile: string;
	/** Serialized event mirror written by the supervisor (disk full set). */
	eventsFile: string;
	/** Latest assistant text line, for roster preview. */
	lastLine: string;
	currentTool?: string;
	/** Wall-clock of the last observed child event. */
	lastActivityAt: number;
	/** Queued steer/follow-up messages inside the child (from getState). */
	pendingCount: number;
	pinned: boolean;
	/** Session currently owned by the main REPL (takeover); child is stopped. */
	attached?: boolean;
}

export type SupervisorEvent =
	| { type: "agent-added"; handle: AgentHandle }
	| { type: "agent-updated"; handle: AgentHandle }
	/** A conversation turn finished (agent_end, no retry pending). */
	| { type: "turn-ended"; handle: AgentHandle; origin: PromptOrigin }
	/** The process left the pool unexpectedly (crash). Exactly once per child. */
	| { type: "agent-final"; handle: AgentHandle };

/**
 * Structural subset of the rpc/json event stream the supervisor consumes.
 * Kept structural (not imported from the host package) so the fake session
 * and contract tests pin the same CLI-facing shape.
 */
export interface RpcAgentEvent {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
		stopReason?: string;
	};
	toolName?: string;
	/** tool_execution_* fields (conversation view replays these into cards). */
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	/** agent_end: another attempt follows (auto-retry) — not a turn boundary. */
	willRetry?: boolean;
	/** extension_ui_request fields (actively denied by the adapter). */
	method?: string;
	title?: string;
}

/** getState() subset the supervisor relies on. */
export interface RpcSessionSnapshot {
	isStreaming: boolean;
	sessionFile?: string;
	sessionId?: string;
	messageCount?: number;
	pendingMessageCount?: number;
}

/**
 * Seam: one long-lived `pi --mode rpc` child per agent. The supervisor talks
 * only to this interface — production wraps the host RpcClient, tests use a
 * scripted fake. Two adapters make the seam real.
 */
export interface RpcSession {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<RpcSessionSnapshot>;
	/** SIGTERM → grace → SIGKILL inside the client; safe to call once. */
	stop(): Promise<void>;
	onEvent(listener: (event: RpcAgentEvent) => void): () => void;
}

export interface RpcSessionOptions {
	cwd: string;
	sessionFile: string;
	model?: string;
}

export type RpcSessionFactory = (options: RpcSessionOptions) => Promise<RpcSession>;
