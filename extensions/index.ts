/**
 * pi-agent-panel extension entry.
 *
 * Assembly only: commands, shortcut, session lifecycle. Per the official
 * extensions contract, no long-lived resource starts in the factory.
 *
 * Lifecycle model (D12): the factory RE-RUNS on every session switch (pi
 * rebuilds its extension set per runtime), so fleet state lives in
 * globalThis ("core": supervisor + focus + takeover bookkeeping) and is
 * adopted across switches and /reload. Only session_shutdown with reason
 * quit/reload — real teardown — disposes it. Per-session bindings (bridge,
 * pill) are rebuilt on every session_start and are safe to recreate because
 * the supervisor they subscribe to survives.
 *
 * Commands:
 *   /agent-panel                        — open the fullscreen fleet panel
 *   /agent-panel spawn <name> <prompt...> — start a background task
 *   /agent-panel archive <name|id>      — archive (kill + hide, JSONL kept)
 *   /agent-panel stop <name|id>         — alias of archive (v0.1 compat)
 *   enter in the panel                  — takeover (main REPL adopts the session)
 *   d on an attached row                — detach (background supervision resumes)
 * Shortcut: alt+p toggles the panel (no command context → no takeover/detach).
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV } from "./lib/pi-spawn.ts";
import { FleetSupervisor } from "./lib/supervisor.ts";
import { openFleetPanel } from "./lib/panel.ts";
import { createNotificationBridge, type PanelFocus } from "./lib/bridge.ts";
import { createStatusPill } from "./lib/pill.ts";

const GLOBAL_CORE_KEY = "__piAgentPanelCore";
const GLOBAL_CLEANUP_KEY = "__piAgentPanelRuntimeCleanup";

/** Per-process state: the fleet pool and the takeover bookkeeping. */
interface Core {
	supervisor: FleetSupervisor;
	focus: PanelFocus;
	/** Where detach switches back to: the session the main REPL owned before
	 *  the most recent takeover/switch (chained via session_start events). */
	lastMainSessionFile?: string;
	/** Per-session bindings, rebuilt whenever the session runtime is. */
	session?: {
		bridge: { dispose: () => void };
		pill: { update: (ctx: ExtensionContext) => void; dispose: (ctx: ExtensionContext | null) => void };
		unsubscribePillEvents: () => void;
		lastCtx: ExtensionContext | null;
	};
}

export default function registerAgentPanel(pi: ExtensionAPI): void {
	// Headless children are spawned with CHILD_ENV=1 and must not load us again.
	if (process.env[CHILD_ENV] === "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const core = ((globalStore[GLOBAL_CORE_KEY] as Core | undefined) ?? {
		supervisor: new FleetSupervisor(),
		focus: { current: null as string | null },
	});
	globalStore[GLOBAL_CORE_KEY] = core;

	let panelOpen = false;

	const teardown = () => {
		core.supervisor.dispose();
		core.session?.bridge.dispose();
		core.session?.pill.dispose(core.session.lastCtx);
		core.session = undefined;
		delete globalStore[GLOBAL_CORE_KEY];
	};
	globalStore[GLOBAL_CLEANUP_KEY] = teardown;

	const ensureCore = (): Core => core;
	const ensureSession = (): NonNullable<Core["session"]> => {
		if (!core.session) throw new Error("agent-panel runtime unavailable (session not started?)");
		return core.session;
	};

	pi.registerCommand("agent-panel", {
		description: "Fleet panel: fullscreen manager for background pi agent sessions",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
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
					const handle = await ensureCore().supervisor.spawn({
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
				const supervisor = ensureCore().supervisor;
				const item = supervisor.list().find(
					(handle) => handle.id === target || handle.name === target,
				);
				if (!item || (item.state === "archived" && !item.attached)) {
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
				const action = await openFleetPanel(ctx, ensureCore().supervisor, ensureCore().focus);
				if (action?.takeover) await performTakeover(ctx, action.takeover);
				else if (action?.detach) await performDetach(ctx, action.detach);
			} finally {
				panelOpen = false;
			}
		},
	});

	/** Stop the child's rpc process and switch the main REPL onto its session
	 *  file — from here the conversation IS a normal, full-skin pi session. */
	const performTakeover = async (ctx: ExtensionCommandContext, id: string): Promise<void> => {
		const supervisor = ensureCore().supervisor;
		const taken = await supervisor.takeover(id);
		if (!taken) return;
		try {
			await ctx.switchSession(taken.sessionFile);
			// The captured ctx may be flagged stale after the switch it just
			// performed; the notify is cosmetic, the switch is the outcome.
			try { ctx.ui.notify(`agent-panel: '${taken.name}' attached to the main REPL — /agent-panel, d to detach`, "info"); } catch {}
		} catch (error) {
			// Switch failed: give the session back to background supervision so
			// the conversation isn't stranded in attached limbo.
			await supervisor.detach(id);
			ctx.ui.notify(`agent-panel: takeover failed (${error instanceof Error ? error.message : String(error)}) — agent detached back`, "error");
		}
	};

	/** Respawn background supervision on an attached conversation and switch
	 *  the main REPL back to the session it came from (chain: last switch). */
	const performDetach = async (ctx: ExtensionCommandContext, id: string): Promise<void> => {
		const home = ensureCore().lastMainSessionFile;
		if (!home) {
			ctx.ui.notify("agent-panel: no previous session to return to (detach unavailable)", "warning");
			return;
		}
		const handle = await ensureCore().supervisor.detach(id);
		if (!handle) return;
		try {
			await ctx.switchSession(home);
			try { ctx.ui.notify(`agent-panel: '${handle.name}' detached — running in background again`, "info"); } catch {}
		} catch (error) {
			ctx.ui.notify(`agent-panel: detach switch failed (${error instanceof Error ? error.message : String(error)}) — agent still detached`, "error");
		}
	};

	/** Shared panel entry for shortcut contexts (alt+p, shift+left). switchSession
	 *  lives on the command context only, so takeover/detach selected here ask
	 *  the user to rerun /agent-panel — every other panel action works. */
	const openPanelViaShortcut = async (ctx: ExtensionContext): Promise<void> => {
		if (panelOpen) return;
		panelOpen = true;
		try {
			const action = await openFleetPanel(
				ctx as ExtensionCommandContext,
				ensureCore().supervisor,
				ensureCore().focus,
			);
			if (action?.takeover || action?.detach) {
				ctx.ui.notify("agent-panel: takeover/detach needs the command context — run /agent-panel and press enter/d there", "warning");
			}
		} catch {
			// e.g. runtime missing in odd modes; the command path reports details.
		} finally {
			panelOpen = false;
		}
	};

	pi.registerShortcut("alt+p", {
		description: "Toggle the agent fleet panel",
		handler: openPanelViaShortcut,
	});

	pi.registerShortcut("shift+left", {
		description: "Open the agent fleet panel (CC's ← for agents)",
		handler: openPanelViaShortcut,
	});

	pi.on("session_start", (event, ctx) => {
		// Rebuild per-session bindings; the fleet (core) persists across this.
		core.session?.unsubscribePillEvents();
		core.session?.bridge.dispose();
		core.session?.pill.dispose(core.session.lastCtx);
		const bridge = createNotificationBridge(pi, core.supervisor, { focus: core.focus });
		const pill = createStatusPill(pi, core.supervisor);
		const session = {
			bridge,
			pill,
			unsubscribePillEvents: () => {},
			lastCtx: ctx.hasUI ? ctx : null,
		};
		core.session = session;
		if (ctx.hasUI) session.lastCtx = ctx;
		pill.update(ctx);
		// Pill freshness on child activity, not just main-session tool results.
		session.unsubscribePillEvents = core.supervisor.onEvent(() => {
			pill.update(session.lastCtx ?? ctx);
		});
		// Takeover bookkeeping: remember where "back" is. On the very first
		// start there is no previous file — the current session is home.
		if (event.previousSessionFile) {
			core.lastMainSessionFile = event.previousSessionFile;
		} else if (!core.lastMainSessionFile) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) core.lastMainSessionFile = sessionFile;
		}
	});

	pi.on("session_shutdown", (event) => {
		// Session replacement (new/resume/fork) must NOT kill the fleet — the
		// children are supervised by this process, not by one session file,
		// and the factory re-runs for the replacement runtime. Only real
		// teardown (quit, extension reload) disposes everything.
		if (event.reason !== "quit" && event.reason !== "reload") return;
		teardown();
		if (globalStore[GLOBAL_CLEANUP_KEY] === teardown) {
			delete globalStore[GLOBAL_CLEANUP_KEY];
		}
	});

	// Pill freshness: update on every tool result while the session is live.
	pi.on("tool_result", (_event, ctx) => {
		const session = core.session;
		if (!session) return;
		if (ctx.hasUI) session.lastCtx = ctx;
		session.pill.update(ctx);
	});
}
