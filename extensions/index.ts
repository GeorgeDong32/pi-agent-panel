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
 *   /agent-panel                    — open/close the fleet overlay
 *   /agent-panel spawn <name> <prompt...> — spawn a headless child
 *   /agent-panel stop <name|id>     — stop a live child
 * Shortcut: alt+p toggles the panel.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./lib/pi-spawn.ts";
import { FleetSupervisor } from "./lib/supervisor.ts";
import { openFleetPanel } from "./lib/panel.ts";
import { createNotificationBridge } from "./lib/bridge.ts";
import { createStatusPill } from "./lib/pill.ts";

const GLOBAL_CLEANUP_KEY = "__piAgentPanelRuntimeCleanup";

interface Runtime {
	supervisor: FleetSupervisor;
	bridge: { dispose: () => void };
	pill: { update: (ctx: ExtensionContext) => void; dispose: (ctx: ExtensionContext | null) => void };
	lastCtx: ExtensionContext | null;
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
		description: "Fleet panel: manage headless child pi sessions",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "spawn") {
				const name = parts[1];
				if (!name || parts.length < 3) {
					ctx.ui.notify("Usage: /agent-panel spawn <name> <prompt...>", "warning");
					return;
				}
				const prompt = args.trim().split(/\s+/).slice(2).join(" ");
				try {
					const handle = ensureRuntime().supervisor.spawn({ name, prompt, cwd: ctx.cwd });
					ctx.ui.notify(`agent-panel: spawned '${handle.name}' (${handle.id})`, "info");
				} catch (error) {
					ctx.ui.notify(`agent-panel: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (parts[0] === "stop") {
				const target = parts[1];
				if (!target) {
					ctx.ui.notify("Usage: /agent-panel stop <name|id>", "warning");
					return;
				}
				const supervisor = ensureRuntime().supervisor;
				const item = supervisor.list().find(
					(handle) => (handle.id === target || handle.name === target) && handle.endedAt === undefined,
				);
				if (!item) {
					ctx.ui.notify(`agent-panel: no live agent matches '${target}'`, "warning");
					return;
				}
				supervisor.stop(item.id);
				ctx.ui.notify(`agent-panel: stopping '${item.name}'`, "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /agent-panel [spawn <name> <prompt...> | stop <name|id>]", "warning");
				return;
			}
			if (panelOpen) return;
			panelOpen = true;
			try {
				await openFleetPanel(ctx, ensureRuntime().supervisor);
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
				await openFleetPanel(ctx, ensureRuntime().supervisor);
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
		const bridge = createNotificationBridge(pi, supervisor);
		const pill = createStatusPill(pi, supervisor);
		runtime = { supervisor, bridge, pill, lastCtx: ctx.hasUI ? ctx : null };
		rememberCtx(ctx);
		pill.update(ctx);
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
