/**
 * StatusPill — thin adapter #3: a one-line widget with live-agent count.
 *
 * Slot coordination (design D7): pi docks have shared slots; auto-yield checks
 * whether pi-claude-code-tui is present (via tool sourceInfo metadata, the
 * only officially documented attribution surface) and defers to it. Detection
 * is best-effort — the config file is the authoritative override:
 *   ~/.pi/agent/agent-panel/config.json  { "pill": "auto" | "on" | "off" }
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FleetSupervisor } from "./supervisor.ts";

export const PILL_WIDGET_KEY = "agent-panel-status";
export const PANEL_SHORTCUT_HINT = "alt+p";

type PillMode = "auto" | "on" | "off";

export function loadPillMode(): PillMode {
	try {
		const configPath = path.join(os.homedir(), ".pi", "agent", "agent-panel", "config.json");
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { pill?: unknown };
		if (raw.pill === "auto" || raw.pill === "on" || raw.pill === "off") return raw.pill;
	} catch {
		// Missing/invalid config falls through to the default.
	}
	return "auto";
}

/** True when a known footer/widget-heavy TUI package is present in the host. */
export function shouldYieldPill(pi: ExtensionAPI): boolean {
	try {
		const tools = pi.getAllTools();
		for (const tool of tools) {
			const sourceInfo = (tool as { sourceInfo?: unknown }).sourceInfo;
			if (sourceInfo && JSON.stringify(sourceInfo).includes("claude-code-tui")) return true;
		}
	} catch {
		// Attribution unavailable: fall through to the settings-based check.
	}
	// Fallback: the package list names the TUI skin even when its tools carry
	// no sourceInfo (observed with the git-installed pi-claude-code-tui fork).
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
		if (
			Array.isArray(raw.packages) &&
			raw.packages.some((entry) => typeof entry === "string" && entry.includes("claude-code-tui"))
		) {
			return true;
		}
	} catch {
		// Settings unreadable: do not yield on speculation.
	}
	return false;
}

export function pillLine(working: number, awaiting: number, theme: ExtensionContext["ui"]["theme"]): string[] {
	if (working > 0 || awaiting > 0) {
		const parts: string[] = [];
		if (working > 0) parts.push(theme.fg("accent", `${working} working`));
		if (awaiting > 0) parts.push(theme.fg("success", `${awaiting} awaiting`));
		return [theme.bold("⏵ agent-panel:") + ` ${parts.join(theme.fg("dim", " · "))}` + theme.fg("dim", ` · ${PANEL_SHORTCUT_HINT}`)];
	}
	return [theme.fg("dim", `⏵ agent-panel idle · ${PANEL_SHORTCUT_HINT}`)];
}

export function createStatusPill(
	pi: ExtensionAPI,
	supervisor: FleetSupervisor,
): { update: (ctx: ExtensionContext) => void; dispose: (ctx: ExtensionContext | null) => void } {
	const mode = loadPillMode();
	if (mode === "off") {
		return { update: () => {}, dispose: () => {} };
	}
	const yielded = mode === "auto" && shouldYieldPill(pi);
	if (yielded) {
		return { update: () => {}, dispose: () => {} };
	}
	return {
		update: (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			// One change-derived snapshot per event (plan A9) — the two full
			// list() scans this used to do re-walked the fleet twice per event.
			const roster = supervisor.roster();
			try {
				ctx.ui.setWidget(PILL_WIDGET_KEY, pillLine(roster.working, roster.awaiting, ctx.ui.theme));
			} catch {
				// Widget slots are best-effort; never break the caller.
			}
		},
		dispose: (ctx: ExtensionContext | null) => {
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.setWidget(PILL_WIDGET_KEY, undefined);
			} catch {
				// Stale-context errors are expected during shutdown.
			}
		},
	};
}
