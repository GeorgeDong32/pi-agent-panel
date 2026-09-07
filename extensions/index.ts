/**
 * pi-agent-panel extension entry.
 *
 * Assembly only: commands, shortcut, session lifecycle. Per the official
 * extensions contract, no long-lived resource starts in the factory — the
 * supervisor is created on session_start and disposed (idempotently) on
 * session_shutdown; a globalStore cleanup guard covers /reload edge cases
 * (pattern proven in pi-subagents, research.md §1.1).
 *
 * Commands:
 *   /agent-panel                        — open/close the fullscreen fleet panel
 *   /agent-panel spawn <name> <prompt...> — start a background task
 *   /agent-panel archive <name|id>      — archive (kill + hide, JSONL kept)
 *   /agent-panel stop <name|id>         — alias of archive (v0.1 compat)
 * Shortcut: alt+p toggles the panel.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./lib/pi-spawn.ts";
import { FleetSupervisor } from "./lib/supervisor.ts";
import { openFleetPanel } from "./lib/panel.ts";
import { createNotificationBridge, type PanelFocus } from "./lib/bridge.ts";
import { createStatusPill } from "./lib/pill.ts";

const GLOBAL_CLEANUP_KEY = "__piAgentPanelRuntimeCleanup";

interface Runtime {
	supervisor: FleetSupervisor;
	bridge: { dispose: () => void };
	pill: { update: (ctx: ExtensionContext) => void; dispose: (ctx: ExtensionContext | null) => void };
	/** Shared view-focus channel: panel writes, bridge reads (suppression). */
	focus: PanelFocus;
	lastCtx: ExtensionContext | null;
	unsubscribePillEvents: () => void;
}

export default function registerAgentPanel(pi: ExtensionAPI): void {
	// Headless children are spawned with CHILD_ENV=1 and must not load us again.
	if (process.env[CHILD_ENV] === "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const previousCleanup = globalStore[GLOBAL_CLEANUP_KEY];
	if (typeof previousCleanup === "function") {
		try {
			previousCleanup();
		} catch {
			// Best-effort cleanup of stale runtime from an older reload.
		}
	}

	let runtime: Runtime | null = null;
	let panelOpen = false;

	const shutdownRuntime = () => {
		if (!runtime) return;
		const current = runtime;
		runtime = null;
		current.unsubscribePillEvents();
		current.bridge.dispose();
		current.pill.dispose(current.lastCtx);
		current.supervisor.dispose();
	};
	globalStore[GLOBAL_CLEANUP_KEY] = shutdownRuntime;

	const ensureRuntime = (): Runtime => {
		if (!runtime) throw new Error("agent-panel runtime unavailable (session not started?)");
		return runtime;
	};

	const rememberCtx = (ctx: ExtensionContext) => {
		if (ctx.hasUI && runtime) runtime.lastCtx = ctx;
	};

	pi.registerCommand("agent-panel", {
		description: "Fleet panel: fullscreen manager for background pi agent sessions",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "spawn") {
				const name = parts[1];
				if (!name || parts.length < 3) {
					ctx.ui.notify("Usage: /agent-panel spawn <name> <prompt...>", "warning");
					return;
				}
				const prompt = args.trim().split(/\s+/).slice(2).join(" ");
				const model = ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				try {
					const handle = await ensureRuntime().supervisor.spawn({
						name,
						cwd: ctx.cwd,
						prompt,
						...(model ? { model } : {}),
					});
					ctx.ui.notify(`agent-panel: started '${handle.name}' (${handle.id}) — turn ends quietly notify you`, "info");
				} catch (error) {
					ctx.ui.notify(`agent-panel: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (parts[0] === "archive" || parts[0] === "stop") {
				const target = parts[1];
				if (!target) {
					ctx.ui.notify("Usage: /agent-panel archive <name|id>", "warning");
					return;
				}
				const supervisor = ensureRuntime().supervisor;
				const item = supervisor.list().find(
					(handle) => handle.id === target || handle.name === target,
				);
				if (!item || item.state === "archived") {
					ctx.ui.notify(`agent-panel: no live agent matches '${target}'`, "warning");
					return;
				}
				await supervisor.archive(item.id);
				ctx.ui.notify(`agent-panel: archived '${item.name}' (session file kept: ${item.sessionFile})`, "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /agent-panel [spawn <name> <prompt...> | archive <name|id>]", "warning");
				return;
			}
			if (panelOpen) return;
			panelOpen = true;
			try {
				await openFleetPanel(ctx, ensureRuntime().supervisor, ensureRuntime().focus);
			} finally {
				panelOpen = false;
			}
		},
	});

	pi.registerShortcut("alt+p", {
		description: "Toggle the agent fleet panel",
		handler: async (ctx: ExtensionContext) => {
			if (panelOpen) return;
			panelOpen = true;
			try {
				await openFleetPanel(ctx, ensureRuntime().supervisor, ensureRuntime().focus);
			} catch {
				// e.g. runtime missing in odd modes; the command path reports details.
			} finally {
				panelOpen = false;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (runtime) return; // idempotent across reload re-fires
		const supervisor = new FleetSupervisor();
		const focus: PanelFocus = { current: null };
		const bridge = createNotificationBridge(pi, supervisor, { focus });
		const pill = createStatusPill(pi, supervisor);
		runtime = { supervisor, bridge, pill, focus, lastCtx: ctx.hasUI ? ctx : null, unsubscribePillEvents: () => {} };
		rememberCtx(ctx);
		pill.update(ctx);
		// Pill freshness on child activity, not just main-session tool results.
		runtime.unsubscribePillEvents = supervisor.onEvent(() => {
			if (!runtime) return;
			runtime.pill.update(runtime.lastCtx ?? ctx);
		});
	});

	pi.on("session_shutdown", () => {
		shutdownRuntime();
		if (globalStore[GLOBAL_CLEANUP_KEY] === shutdownRuntime) {
			delete globalStore[GLOBAL_CLEANUP_KEY];
		}
	});

	// Pill freshness: update on every tool result while the session is live.
	pi.on("tool_result", (_event, ctx) => {
		if (!runtime) return;
		rememberCtx(ctx);
		runtime.pill.update(ctx);
	});
}
