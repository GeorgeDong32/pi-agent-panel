/**
 * Probe 4 (handoff §6): fullscreen overlay (100%/margin 0) with an embedded
 * pi-tui Editor composer. Loaded via `pi -e ./probes/extension`.
 *
 * Verifies: render sizing, keyboard focus, CJK byte input, paste, submit.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, type TUI } from "@earendil-works/pi-tui";

class ProbeOverlay {
	private editor: Editor;
	private submitted = "";
	private events: string[] = [];
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		private readonly done: (result: undefined) => void,
	) {
		this.editor = new Editor(tui, {
			borderColor: (s: string) => theme.fg("border", s),
			selectList: getSelectListTheme(),
		}, { paddingX: 1 });
		this.editor.onSubmit = (text) => {
			this.submitted = text;
			this.editor.setText("");
			this.tui.requestRender();
		};
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		this.timer.unref?.();
	}

	handleInput(data: string): void {
		this.events.push(data);
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const rows = this.tui.terminal?.rows ?? 24;
		const inner = Math.max(1, width - 2);
		const lines: string[] = [];
		const push = (text: string) => lines.push(`│${text.padEnd(inner).slice(0, inner)}│`);
		lines.push(`╭${"─".repeat(inner)}╮`);
		push(` probe4 · term=${width}x${rows} · focus=editor · esc=close`);
		push("");
		push(` submitted: ${this.submitted || "(none)"}`);
		push(` editor text: ${JSON.stringify(this.editor.getText())}`);
		push(` inputs seen: ${this.events.length}`);
		push("");
		// Editor occupies the bottom rows; pad between so the box is fullscreen.
		const editorLines = this.editor.render(inner);
		const pad = Math.max(1, rows - 2 - lines.length - editorLines.length - 1);
		for (let i = 0; i < pad; i++) push("");
		for (const line of editorLines) push(line.length > inner ? line.slice(0, inner) : line);
		lines.push(`╰${"─".repeat(inner)}╯`);
		return lines;
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}

export default function registerProbe(pi: ExtensionAPI): void {
	pi.registerCommand("probe4", {
		description: "Probe: fullscreen overlay with embedded Editor",
		handler: async (_args: string, ctx: ExtensionContext) => {
			await ctx.ui.custom<undefined>(
				(tui, theme, _kb, done) => new ProbeOverlay(tui, theme, done),
				{
					overlay: true,
					overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
				},
			);
		},
	});
}
