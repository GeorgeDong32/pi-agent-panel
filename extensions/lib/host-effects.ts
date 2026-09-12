/**
 * Host effects seam (plan C4).
 *
 * The takeover/detach flows' irreversible host calls (switchSession,
 * notify) used to live inline in the extension factory, making the
 * rollback and ordering paths manual-test-only. performTakeover /
 * performDetach in extensions/index.ts now take a HostEffects and are
 * unit-testable with a recording fake plus the fake-rpc supervisor harness.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface HostEffects {
	switchSession(sessionPath: string): Promise<void>;
	/** Current session file of the main REPL (undefined in odd modes). */
	getSessionFile(): string | undefined;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Production adapter over a fresh command context (switchSession lives there). */
export function commandContextEffects(ctx: ExtensionCommandContext): HostEffects {
	return {
		switchSession: (sessionPath) => ctx.switchSession(sessionPath),
		getSessionFile: () => ctx.sessionManager.getSessionFile(),
		notify: (message, level) => {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// The captured ctx may be stale right after a switch it just
				// performed; the notify is cosmetic, the switch is the outcome.
			}
		},
	};
}

/** Recording fake for unit tests: every call lands in `calls`, in order. */
export interface RecordedHostCall {
	kind: "switchSession" | "notify";
	sessionPath?: string;
	message?: string;
	level?: "info" | "warning" | "error";
}

export function fakeHostEffects(options: {
	currentSessionFile?: string;
	switchError?: (sessionPath: string) => Error | undefined;
} = {}): HostEffects & { calls: RecordedHostCall[] } {
	const calls: RecordedHostCall[] = [];
	return {
		calls,
		switchSession: async (sessionPath) => {
			calls.push({ kind: "switchSession", sessionPath });
			const error = options.switchError?.(sessionPath);
			if (error) throw error;
		},
		getSessionFile: () => options.currentSessionFile,
		notify: (message, level) => {
			calls.push({ kind: "notify", message, level });
		},
	};
}
