/**
 * FleetPanel — thin adapter #1 over FleetSupervisor.
 *
 * Nearly-fullscreen overlay: left roster, right transcript. The render()
 * contract is strict: it reads only cached plain data (supervisor snapshots +
 * tail lines fetched in refresh()) plus the live tui/theme handles handed to
 * the factory — no ctx, no IO, no throws. The stale-ExtensionContext trap
 * (research.md §1.1/§3) is structurally unreachable here.
 */
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentHandle } from "./types.ts";
import type { FleetSupervisor } from "./supervisor.ts";

type Theme = ExtensionContext["ui"]["theme"];
/** Panel only styles via fg/bold; accepting the narrower type keeps tests fake-able. */
type PanelTheme = Pick<Theme, "fg" | "bold">;

const REFRESH_MS = 750;
const TRANSCRIPT_LINES = 200;

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusGlyph(state: AgentHandle["state"], theme: PanelTheme): string {
	if (state === "running" || state === "starting") return theme.fg("accent", state === "running" ? "●" : "◐");
	if (state === "completed") return theme.fg("success", "✓");
	if (state === "stopped") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function formatTokens(input: number, output: number): string {
	const round = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}k` : `${value}`);
	return `${round(input)}↑ ${round(output)}↓`;
}

export class FleetPanelComponent {
	private items: AgentHandle[] = [];
	private transcript: string[] = [];
	private selected = 0;
	private selectedKey: string | undefined;
	private transcriptAutoFollow = true;
	private transcriptScroll = 0;
	private transcriptLineCount = 0;
	private bodyHeight = 8;
	private disposed = false;
	/** Stop confirmation: 'x' arms, second 'x' within the same selection fires. */
	private armedStopKey: string | undefined;
	private readonly timer: ReturnType<typeof setInterval>;

	private readonly tui: { requestRender(force?: boolean): void; terminal?: { rows?: number } };
	private readonly theme: PanelTheme;
	private readonly supervisor: FleetSupervisor;
	private readonly done: (result: undefined) => void;

	constructor(
		tui: { requestRender(force?: boolean): void; terminal?: { rows?: number } },
		theme: PanelTheme,
		supervisor: FleetSupervisor,
		done: (result: undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.supervisor = supervisor;
		this.done = done;
		this.refresh();
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.refresh();
			this.tui.requestRender();
		}, REFRESH_MS);
		this.timer.unref?.();
	}

	/** All IO and supervisor reads happen here (timer/key context), never in render. */
	private refresh(): void {
		const previousKey = this.items[this.selected]?.id ?? this.selectedKey;
		this.items = this.supervisor.list();
		const preserved = previousKey ? this.items.findIndex((item) => item.id === previousKey) : -1;
		this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.items.length - 1));
		this.selectedKey = this.items[this.selected]?.id;
		const selectedId = this.items[this.selected]?.id;
		this.transcript = selectedId ? this.supervisor.tail(selectedId, TRANSCRIPT_LINES) : [];
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
		this.selectedKey = this.items[this.selected]?.id;
		this.transcriptAutoFollow = true;
		this.armedStopKey = undefined;
		this.tui.requestRender();
	}

	private stopSelected(): void {
		const item = this.items[this.selected];
		if (!item || item.endedAt) return;
		if (this.armedStopKey !== item.id) {
			this.armedStopKey = item.id;
			this.tui.requestRender();
			return;
		}
		this.armedStopKey = undefined;
		this.supervisor.stop(item.id);
		this.refresh();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.moveSelection(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.moveSelection(1);
		if (matchesKey(data, "home")) return this.moveSelection(-this.items.length);
		if (matchesKey(data, "end")) return this.moveSelection(this.items.length);
		if (matchesKey(data, "enter")) {
			this.transcriptAutoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.transcriptAutoFollow = false;
			this.transcriptScroll = Math.max(0, Math.min(this.transcriptScroll, Math.max(0, this.transcriptLineCount - this.bodyHeight)) - this.bodyHeight);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.transcriptLineCount - this.bodyHeight);
			this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + this.bodyHeight);
			this.transcriptAutoFollow = this.transcriptScroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		const key = data.toLowerCase();
		if (key === "x") return this.stopSelected();
		if (key === "i") {
			const item = this.items[this.selected];
			if (item && !item.endedAt) this.supervisor.interrupt(item.id);
			return;
		}
		if (key === "r") {
			this.refresh();
			this.tui.requestRender();
		}
	}

	private rosterLines(width: number): string[] {
		if (this.items.length === 0) {
			return [this.theme.fg("dim", "No agents — spawn via /agent-panel spawn <name> <prompt>")];
		}
		const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.items.length - this.bodyHeight)));
		return this.items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const marker = index === this.selected ? this.theme.fg("accent", "›") : " ";
			const preview = item.lastLine ? ` ${this.theme.fg("dim", truncateToWidth(item.lastLine, Math.max(0, width - visibleWidth(item.name) - 14)))}` : "";
			const left = `${marker} ${statusGlyph(item.state, this.theme)} ${item.name}${preview}`;
			return `${fit(truncateToWidth(left, width - 10), Math.max(0, width - 10))}${fit(this.theme.fg("dim", formatTokens(item.tokens.input, item.tokens.output)), 10)}`;
		});
	}

	private wrappedTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const line of this.transcript) {
			const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
			lines.push(...(wrapped.length ? wrapped : [""]));
		}
		if (lines.length === 0) lines.push(this.theme.fg("dim", "(waiting for child output…)"));
		return lines;
	}

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth("agent-panel needs at least 36 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(2, Math.min(30, Math.floor(rows * 0.85) - 6));
		const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
		const transcriptWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const details = this.wrappedTranscript(transcriptWidth);
		this.transcriptLineCount = details.length;
		const maxScroll = Math.max(0, details.length - this.bodyHeight);
		if (this.transcriptAutoFollow) this.transcriptScroll = maxScroll;
		else if (this.transcriptScroll > maxScroll) this.transcriptScroll = maxScroll;
		const visible = details.slice(this.transcriptScroll, this.transcriptScroll + this.bodyHeight);

		const live = this.items.filter((item) => !item.endedAt).length;
		const header = ` ${this.theme.bold("agent-panel")} ${this.theme.fg("dim", `· ${live} live · ${this.items.length} total`)}`;
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		lines.push(this.theme.fg("border", "│") + fit(header, innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(transcriptWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index++) {
			lines.push(
				this.theme.fg("border", "│")
				+ fit(roster[index] ?? "", rosterWidth)
				+ this.theme.fg("border", "│")
				+ fit(visible[index] ?? "", transcriptWidth)
				+ this.theme.fg("border", "│"),
			);
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(transcriptWidth)}┤`));
		const item = this.items[this.selected];
		const stopHint = item && !item.endedAt
			? (this.armedStopKey === item.id ? this.theme.fg("error", "x! confirm-stop") : "x stop")
			: "";
		const position = this.items.length ? `${this.selected + 1}/${this.items.length}` : "0/0";
		const footer = ` jk select · enter follow · PgUp/PgDn scroll · i interrupt · ${stopHint} · r refresh · Esc close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

export async function openFleetPanel(
	ctx: ExtensionContext,
	supervisor: FleetSupervisor,
): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => new FleetPanelComponent(tui, theme, supervisor, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
		},
	);
}
