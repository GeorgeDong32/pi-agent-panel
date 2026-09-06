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
	/** Task prompt forwarded to the headless child. */
	prompt: string;
	/** Working directory for the child process. */
	cwd: string;
	/** Forwarded as --model (e.g. "anthropic/claude-...:high"). */
	model?: string;
	/**
	 * Forwarded as --permission-mode. That flag is extension-registered (not
	 * builtin), so children launched with --no-extensions reject it — only set
	 * this when the child is spawned with permission extension support.
	 */
	permissionMode?: string;
}

export type AgentState = "starting" | "running" | "completed" | "failed" | "stopped";

export interface AgentTokens {
	input: number;
	output: number;
	cost: number;
}

export interface AgentHandle {
	id: string;
	name: string;
	state: AgentState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	tokens: AgentTokens;
	toolCount: number;
	/** Child's own --session JSONL: the full-history source of truth. */
	sessionFile: string;
	/** Raw stdout event-line mirror written by the supervisor. */
	eventsFile: string;
	/** Latest assistant text line, for roster preview. */
	lastLine: string;
	currentTool?: string;
}

export type SupervisorEvent =
	| { type: "agent-added"; handle: AgentHandle }
	| { type: "agent-updated"; handle: AgentHandle }
	| { type: "agent-final"; handle: AgentHandle };

/** Internal seam: the supervisor never spawns processes directly. */
export interface ChildProcessHandle {
	pid: number;
	kill(signal?: NodeJS.Signals): void;
	/** Line-split stdout; iteration ends when the stream closes. */
	stdout: AsyncIterable<string>;
	/** Resolves with the exit code once the process (and stdio) has closed. */
	exited: Promise<number>;
	/** Optional: recent stderr for post-mortem diagnostics (ring buffer). */
	stderrTail?(): string;
}

export interface SpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
}

export interface ProcessRunner {
	spawn(command: string, args: string[], options: SpawnOptions): ChildProcessHandle;
}
