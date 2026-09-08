/**
 * FleetPanel — thin adapter #1 over FleetSupervisor.
 *
 * Fullscreen overlay (100% / margin 0) with an internal list ⇄ view state
 * machine and a resident composer built on the pi-tui Editor (CJK, paste,
 * cursor movement for free — probe-verified). The render() contract is
 * strict: it reads only cached plain data (supervisor snapshots + tail lines
 * fetched in refresh()) plus the live tui/theme handles handed to the
 * factory — no ctx, no IO, no throws. The stale-ExtensionContext trap is
 * structurally unreachable here.
 */
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, Editor } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentHandle } from "./types.ts";
import type { FleetSupervisor } from "./supervisor.ts";
import { ConversationView } from "./conversation.ts";

type Theme = import("@earendil-works/pi-coding-agent").ExtensionContext["ui"]["theme"];
/** Panel only styles via fg/bold; accepting the narrower type keeps tests fake-able. */
type PanelTheme = Pick<Theme, "fg" | "bold">;

const REFRESH_MS = 750;
const BOOTSTRAP_EVENTS = 400;
const NEW_TASK_NAME_LIMIT = 24;

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Glyph + color per state (spec §2.1: archived shows ✗, crashed red ✗). */
function statusGlyph(handle: AgentHandle, theme: PanelTheme): string {
	switch (handle.state) {
		case "working":
			return theme.fg("accent", "●");
		case "starting":
			return theme.fg("accent", "◐");
		case "awaiting-input":
			return theme.fg("success", "✓");
		case "archived":
			return handle.attached ? theme.fg("accent", "⇄") : theme.fg("dim", "✗");
		default:
			return theme.fg("error", "✗");
	}
}

function formatTokens(input: number, output: number): string {
	const round = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}k` : `${value}`);
	return `${round(input)}↑ ${round(output)}↓`;
}

function formatRelative(ms: number): string {
	if (ms < 60_000) return "now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

/** Display name for a new task typed straight into the composer (CJK kept). */
export function deriveTaskName(task: string): string {
	const firstLine = task.split("\n").map((l) => l.trim()).find(Boolean) ?? "task";
	const collapsed = firstLine.replace(/\s+/g, " ");
	return collapsed.length > NEW_TASK_NAME_LIMIT ? `${collapsed.slice(0, NEW_TASK_NAME_LIMIT)}…` : collapsed;
}

/** What the panel asks the command layer to do (ctx-dependent, so the
 *  component itself never touches ctx). */
export interface PanelAction {
	/** Hand this agent's session to the main REPL (switchSession). */
	takeover?: string;
	/** Give an attached conversation back to background supervision. */
	detach?: string;
}

export interface PanelDeps {
	/** Working directory + model captured at open time for new tasks. */
	cwd: string;
	model?: string;
	now?: () => number;
	/** Notification-suppression focus channel shared with the bridge. */
	focus?: { current: string | null };
}

export class FleetPanelComponent {
	private mode: "list" | "view" = "list";
	private viewId: string | undefined;
	private items: AgentHandle[] = [];
	private rows: Array<{ handle: AgentHandle; group: string }> = [];
	private selected = 0;
	private selectedKey: string | undefined;
	private conversation: ConversationView | undefined;
	private droppedBootstrap = 0;
	private transcriptAutoFollow = true;
	private transcriptScroll = 0;
	private transcriptLineCount = 0;
	private composerActive = false;
	private composerRole: "new-task" | "reply" = "reply";
	private statusMessage = "";
	private disposed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly editor: Editor;
	private readonly unsubscribeChild: () => void;

	private readonly tui: { requestRender(force?: boolean): void; terminal?: { rows?: number } };
	private readonly theme: PanelTheme;
	private readonly supervisor: FleetSupervisor;
	private readonly deps: PanelDeps;
	private readonly done: (result: PanelAction | undefined) => void;

	constructor(
		tui: TUI | { requestRender(force?: boolean): void; terminal?: { rows?: number } },
		theme: PanelTheme,
		supervisor: FleetSupervisor,
		done: (result: PanelAction | undefined) => void,
		deps: PanelDeps,
	) {
		this.tui = tui;
		this.theme = theme;
		this.supervisor = supervisor;
		this.done = done;
		this.deps = deps;
		// Autocomplete is never wired up, so identity functions suffice for
		// the select-list theme slice; this keeps the panel pi-tui-only.
		const identity = (text: string) => text;
		this.editor = new Editor(
			tui as TUI,
			{
				borderColor: (text: string) => theme.fg("border", text),
				selectList: {
					selectedPrefix: identity,
					selectedText: identity,
					description: identity,
					scrollInfo: identity,
					noMatch: identity,
				},
			},
			{ paddingX: 1 },
		);
		this.editor.onSubmit = (text) => this.submitComposer(text);
		// Live conversation growth: raw child events for the viewed agent are
		// applied to the view as they arrive (same tick bootstrap+subscribe in
		// enterView() means no gap and no duplicates).
		this.unsubscribeChild = supervisor.onChildEvent((id, evt) => {
			if (this.disposed || !this.conversation || this.viewId !== id) return;
			this.conversation.apply(evt);
			this.tui.requestRender();
		});
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
		this.items = this.supervisor.list();
		if (this.mode === "view") {
			const handle = this.items.find((item) => item.id === this.viewId);
			if (!handle) {
				// Archived-away or otherwise gone: fall back to the list.
				this.backToList();
			}
		}
		this.rebuildRows();
		if (this.mode === "list") {
			const previousKey = this.rows[this.selected]?.handle.id ?? this.selectedKey;
			const preserved = previousKey ? this.rows.findIndex((row) => row.handle.id === previousKey) : -1;
			this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.rows.length - 1));
			this.selectedKey = this.rows[this.selected]?.handle.id;
		}
	}

	/** Flattened, ordered roster: Attached (owned by main REPL) first, then
	 *  Pinned / Working / Awaiting / Archived. */
	private rebuildRows(): void {
		const rows: Array<{ handle: AgentHandle; group: "attached" | "pinned" | "working" | "awaiting-input" | "archived" }> = [];
		const attached = this.items.filter((h) => h.attached);
		const pinned = this.items.filter((h) => h.pinned && !h.attached && h.state !== "archived" && h.state !== "crashed");
		const working = this.items.filter((h) => !h.pinned && !h.attached && (h.state === "working" || h.state === "starting"));
		const awaiting = this.items.filter((h) => !h.pinned && !h.attached && h.state === "awaiting-input");
		const archived = this.items.filter((h) => !h.attached && (h.state === "archived" || h.state === "crashed"));
		for (const handle of attached) rows.push({ handle, group: "attached" });
		for (const handle of pinned) rows.push({ handle, group: "pinned" });
		for (const handle of working) rows.push({ handle, group: "working" });
		for (const handle of awaiting) rows.push({ handle, group: "awaiting-input" });
		for (const handle of archived) rows.push({ handle, group: "archived" });
		this.rows = rows;
	}

	// =========================================================================
	// Input routing
	// =========================================================================

	handleInput(data: string): void {
		if (this.disposed) return;
		// Kitty protocol (flag 2) delivers key-release events too; without a
		// filter every press would be processed twice.
		if (isKeyRelease(data)) return;
		this.statusMessage = ""; // transient hints live until the next key
		if (this.composerActive) {
			if (matchesKey(data, "escape")) {
				this.cancelComposer();
				return;
			}
			// On an empty draft, ← means "leave the view", not "move the cursor".
			if (this.mode === "view" && this.editor.getText().length === 0 && matchesKey(data, "left")) {
				this.backToList();
				return;
			}
			this.editor.handleInput(data); // enter submits via editor.onSubmit
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || (this.mode === "list" && matchesKey(data, "q"))) {
			if (this.mode === "view") this.backToList();
			else this.done(undefined);
			return;
		}
		if (this.mode === "view") {
			this.handleViewInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.moveSelection(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.moveSelection(1);
		if (matchesKey(data, "home")) return this.moveSelection(-this.rows.length);
		if (matchesKey(data, "end")) return this.moveSelection(this.rows.length);
		// enter = takeover: the main REPL adopts the agent's session (a real,
		// full-skin pi). space = quick look inside the panel instead.
		if (matchesKey(data, "enter")) return this.requestTakeover();
		if (matchesKey(data, "space")) return this.openSelected();
		if (matchesKey(data, "n")) return this.activateComposer("new-task");
		if (matchesKey(data, "x")) return this.abortSelected();
		if (matchesKey(data, "shift+x") || matchesKey(data, "ctrl+x")) return this.archiveSelected();
		if (matchesKey(data, "d")) return this.requestDetach();
		if (matchesKey(data, "p")) {
			const handle = this.rows[this.selected]?.handle;
			if (handle) this.supervisor.pin(handle.id);
			this.refresh();
			this.tui.requestRender();
			return;
		}
		// Any other printable input starts a new task directly (type-to-talk);
		// kitty CSI-u sequences and legacy bytes (incl. IME CJK) both count.
		// '/' is excluded: it starts slash commands, which belong to the main
		// REPL — swallowing it here would spawn literal "/..." task names.
		if (data !== "/" && (decodeKittyPrintable(data) !== undefined || (data.length > 0 && !isControlSequence(data)))) {
			this.activateComposer("new-task");
			this.editor.handleInput(data);
		}
	}

	private handleViewInput(data: string): void {
		if (matchesKey(data, "left")) return this.backToList();
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.scrollTranscript(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.scrollTranscript(1);
		if (matchesKey(data, "pageUp")) {
			this.transcriptAutoFollow = false;
			this.transcriptScroll = Math.max(0, this.transcriptScroll - this.viewBodyHeight());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.transcriptLineCount - this.viewBodyHeight());
			this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + this.viewBodyHeight());
			this.transcriptAutoFollow = this.transcriptScroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "space")) return this.activateComposer("reply");
		if (matchesKey(data, "x")) {
			if (this.viewId) void this.supervisor.abort(this.viewId);
			this.statusMessage = "abort sent — agent stays alive";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+r")) {
			this.statusMessage = "revive from session file is planned for a later phase";
			this.tui.requestRender();
			return;
		}
		// Any other printable input starts composing (type-to-talk). Kitty
		// CSI-u encodes plain keys as escape sequences, so accept either a
		// decodable kitty sequence or a legacy printable byte (incl. CJK text).
		// '/' is reserved for slash commands (see handleListInput).
		if (data !== "/" && (decodeKittyPrintable(data) !== undefined || (data.length > 0 && !isControlSequence(data)))) {
			this.activateComposer("reply");
			this.editor.handleInput(data);
		}
	}

	// =========================================================================
	// Actions
	// =========================================================================

	private moveSelection(delta: number): void {
		if (this.rows.length === 0) return;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
		this.selectedKey = this.rows[this.selected]?.handle.id;
		this.tui.requestRender();
	}

	private openSelected(): void {
		const handle = this.rows[this.selected]?.handle;
		if (!handle) return;
		this.enterView(handle.id);
		this.refresh();
		this.tui.requestRender();
	}

	/** Swap to view mode over `id`: bootstrap the conversation from the
	 *  mirrored event tail, then (same tick) subscribe for live events. */
	private enterView(id: string): void {
		this.mode = "view";
		this.viewId = id;
		if (this.deps.focus) this.deps.focus.current = id;
		this.transcriptAutoFollow = true;
		this.transcriptScroll = 0;
		this.transcriptLineCount = 0;
		this.statusMessage = "";
		// Components read pi's global theme (same palette as the main REPL).
		this.conversation = new ConversationView({ ui: this.tui, cwd: this.deps.cwd });
		const boot = this.supervisor.tailEvents(id, BOOTSTRAP_EVENTS);
		this.droppedBootstrap = boot.dropped;
		for (const evt of boot.events) this.conversation.apply(evt);
	}

	private backToList(): void {
		this.mode = "list";
		this.viewId = undefined;
		this.conversation = undefined;
		this.droppedBootstrap = 0;
		if (this.deps.focus) this.deps.focus.current = null;
		this.composerActive = false;
		this.editor.setText("");
		this.refresh();
		this.tui.requestRender();
	}

	private scrollTranscript(delta: number): void {
		this.transcriptAutoFollow = false;
		this.transcriptScroll = Math.max(0, this.transcriptScroll + delta);
		this.tui.requestRender();
	}

	private activateComposer(role: "new-task" | "reply"): void {
		const handle = this.mode === "view" ? this.items.find((item) => item.id === this.viewId) : undefined;
		if (role === "reply" && handle && (handle.state === "crashed" || handle.state === "archived")) {
			this.statusMessage = "agent is not running — revive (R) is a later-phase feature";
			this.tui.requestRender();
			return;
		}
		this.composerRole = role;
		this.composerActive = true;
		this.editor.focused = true;
		this.statusMessage = "";
		this.tui.requestRender();
	}

	private cancelComposer(): void {
		this.composerActive = false;
		this.editor.setText("");
		this.editor.focused = false;
		this.tui.requestRender();
	}

	private submitComposer(text: string): void {
		const trimmed = text.trim();
		this.editor.setText("");
		if (!trimmed) {
			this.tui.requestRender();
			return;
		}
		if (this.composerRole === "new-task") {
			this.composerActive = false;
			this.editor.focused = false;
			this.statusMessage = "spawning…";
			this.supervisor
				.spawn({ name: deriveTaskName(trimmed), cwd: this.deps.cwd, prompt: trimmed, ...(this.deps.model ? { model: this.deps.model } : {}) })
				.then((handle) => {
					// Stay in the list (user revision): select the new agent
					// and hint the way in, instead of jumping to its view.
					this.statusMessage = `started '${handle.name}' — enter to open, ← esc stays here`;
					this.selectedKey = handle.id;
					this.refresh();
					this.tui.requestRender();
				})
				.catch((error: unknown) => {
					this.statusMessage = error instanceof Error ? error.message : String(error);
					this.refresh();
					this.tui.requestRender();
				});
			this.tui.requestRender();
			return;
		}
		// Reply in view mode: idle → new turn, working → steer (same input box).
		if (this.viewId) {
			void this.supervisor.prompt(this.viewId, trimmed, "panel").then((ok) => {
				if (!ok) this.statusMessage = "send failed — agent no longer running?";
				this.refresh();
				this.tui.requestRender();
			});
		}
	}

	private abortSelected(): void {
		const handle = this.rows[this.selected]?.handle;
		if (!handle || handle.state !== "working") return;
		void this.supervisor.abort(handle.id);
		this.statusMessage = `abort sent to '${handle.name}'`;
		this.tui.requestRender();
	}

	/** enter on a live agent: close the panel and let the command layer stop
	 *  the rpc child and switch the main REPL onto its session file. */
	private requestTakeover(): void {
		const handle = this.rows[this.selected]?.handle;
		if (!handle || !isLiveHandle(handle)) return;
		this.done({ takeover: handle.id });
	}

	/** d on an attached agent: respawn an rpc child on its session file and
	 *  let the command layer switch the main REPL back to its own session. */
	private requestDetach(): void {
		const handle = this.rows[this.selected]?.handle;
		if (!handle?.attached) return;
		this.done({ detach: handle.id });
	}

	private archiveSelected(): void {
		const handle = this.rows[this.selected]?.handle;
		if (!handle || handle.state === "archived") return;
		void this.supervisor.archive(handle.id).then(() => {
			this.refresh();
			this.tui.requestRender();
		});
		this.statusMessage = `archiving '${handle.name}' (session file kept)`;
		this.tui.requestRender();
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	private viewBodyHeight(): number {
		// Refreshed during render; callers clamp before use.
		return Math.max(1, this.transcriptWindowHeight ?? 10);
	}
	private transcriptWindowHeight = 10;

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth("agent-panel needs at least 36 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 24;
		const editorLines = this.editor.render(innerWidth);

		const lines: string[] = [];
		lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
		lines.push(this.theme.fg("border", "│") + fit(this.headerLine(), innerWidth) + this.theme.fg("border", "│"));

		const reserved = 2 /* top+bottom border */ + 1 /* header */ + 1 /* sep */ + editorLines.length + 1 /* sep */ + 1 /* footer */;
		const bodyHeight = Math.max(1, rows - reserved);
		const body = this.mode === "view" ? this.viewBody(innerWidth, bodyHeight) : this.listBody(innerWidth, bodyHeight);

		for (const line of body) {
			lines.push(this.theme.fg("border", "│") + fit(line, innerWidth) + this.theme.fg("border", "│"));
		}

		lines.push(this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
		for (const line of editorLines) {
			lines.push(this.theme.fg("border", "│") + line + this.theme.fg("border", "│"));
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", this.footerLine()), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private headerLine(): string {
		const working = this.items.filter((h) => h.state === "working" || h.state === "starting").length;
		const awaiting = this.items.filter((h) => h.state === "awaiting-input").length;
		const archived = this.items.filter((h) => h.state === "archived" || h.state === "crashed").length;
		const counts = this.theme.fg("dim", `· ${working} working · ${awaiting} awaiting input · ${archived} archived`);
		if (this.mode === "view") {
			const handle = this.items.find((item) => item.id === this.viewId);
			if (handle) {
				const detail = [
					handle.state,
					formatTokens(handle.tokens.input, handle.tokens.output),
					`${handle.toolCount} tools`,
					`turn ${handle.turnCount}`,
					handle.pendingCount > 0 ? `${handle.pendingCount} queued` : "",
				].filter(Boolean).join(" · ");
				return ` ${this.theme.bold("agent-panel")} ${statusGlyph(handle, this.theme)} ${this.theme.bold(handle.name)} ${this.theme.fg("dim", detail)}`;
			}
		}
		return ` ${this.theme.bold("agent-panel")} ${counts}`;
	}

	private listBody(width: number, height: number): string[] {
		const lines: string[] = [];
		if (this.statusMessage) lines.push(this.theme.fg("warning", this.statusMessage));
		if (this.rows.length === 0) {
			lines.push(this.theme.fg("dim", "No agents — press n to start a new task, or /agent-panel spawn <name> <prompt>"));
		} else {
			const start = Math.max(0, Math.min(this.selected - height + 1, Math.max(0, this.rows.length - height)));
			const window = this.rows.slice(start, start + height);
			let lastGroup = "";
			for (let offset = 0; offset < window.length; offset++) {
				const row = window[offset];
				if (!row) break;
				if (row.group !== lastGroup) {
					lastGroup = row.group;
					lines.push(this.groupLabel(row.group));
				}
				lines.push(this.rosterLine(row.handle, start + offset === this.selected, width));
			}
		}
		// Pad to full height: the overlay is as tall as the component's output,
		// so short content would leave the host UI visible below the panel.
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	private groupLabel(group: string): string {
		const labels: Record<string, string> = {
			attached: "Attached (in main REPL — d to detach)",
			pinned: "Pinned",
			working: "Working",
			"awaiting-input": "Awaiting input",
			// Crashed agents land here too, marked by a red glyph (spec §2.1).
			archived: "Archived",
		};
		return this.theme.fg("dim", labels[group] ?? group);
	}

	private rosterLine(handle: AgentHandle, isSelected: boolean, width: number): string {
		const marker = isSelected ? this.theme.fg("accent", "›") : " ";
		const right = this.theme.fg(
			"dim",
			`#${handle.id.slice(-4)} ${formatRelative(Math.max(0, (this.deps.now ?? Date.now)() - handle.lastActivityAt))}`,
		);
		const rightWidth = visibleWidth(`#abcd 99d`) + 2;
		const leftWidth = Math.max(1, width - rightWidth);
		let left = `${marker} ${statusGlyph(handle, this.theme)} ${handle.name}`;
		if (handle.state === "working" || handle.state === "awaiting-input") {
			left += this.theme.fg("dim", ` ${formatTokens(handle.tokens.input, handle.tokens.output)}`);
		}
		const previewWidth = leftWidth - visibleWidth(left) - 1;
		if (handle.lastLine && previewWidth > 4) {
			left += this.theme.fg("dim", ` ${truncateToWidth(handle.lastLine, previewWidth)}`);
		}
		return `${truncateToWidth(left, leftWidth)}${" ".repeat(Math.max(0, leftWidth - visibleWidth(left)))}${right}`;
	}

	private viewBody(width: number, height: number): string[] {
		const handle = this.items.find((item) => item.id === this.viewId);
		const lines: string[] = [];
		if (handle?.attached) {
			lines.push(this.theme.fg("accent", "attached — this conversation is driven by the main REPL right now (d in the list to detach)"));
		} else if (handle && (handle.state === "crashed" || handle.state === "archived")) {
			lines.push(this.theme.fg("error", `agent ${handle.state === "crashed" ? "crashed" : "archived"} — composer disabled, session file: ${handle.sessionFile}`));
		}
		if (this.statusMessage) lines.push(this.theme.fg("warning", this.statusMessage));
		// Conversation lines come from pi's own message components, already
		// wrapped to `width`; one blank line between messages is built in.
		const detailLines: string[] = [];
		if (this.droppedBootstrap > 0) {
			detailLines.push(this.theme.fg("dim", `… ${this.droppedBootstrap} older events not shown (full history: session file)`));
		}
		if (this.conversation) detailLines.push(...this.conversation.render(width));
		if (detailLines.length === (this.droppedBootstrap > 0 ? 1 : 0)) {
			detailLines.push(this.theme.fg("dim", handle?.state === "starting" ? "(starting rpc child…)" : "(no output yet — send the first message)"));
		}
		this.transcriptLineCount = detailLines.length;
		this.transcriptWindowHeight = Math.max(1, height - lines.length);
		const maxScroll = Math.max(0, detailLines.length - this.transcriptWindowHeight);
		if (this.transcriptAutoFollow) this.transcriptScroll = maxScroll;
		else if (this.transcriptScroll > maxScroll) this.transcriptScroll = maxScroll;
		const visible = detailLines.slice(this.transcriptScroll, this.transcriptScroll + this.transcriptWindowHeight);
		lines.push(...visible);
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	private footerLine(): string {
		if (this.composerActive) {
			return this.composerRole === "new-task"
				? "new task: enter spawn+open · esc cancel"
				: "enter send · esc cancel composer · (agent working → sends as steer)";
		}
		if (this.mode === "view") {
			return "space/enter reply · jk scroll · PgUp/PgDn page · x abort turn · ←/esc back to list";
		}
		return "enter takeover · space look · jk · n new · x abort · X archive · d detach · p pin · esc close";
	}

	invalidate(): void {
		this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeChild();
		if (this.deps.focus) this.deps.focus.current = null;
		clearInterval(this.timer);
	}
}

/** Escape/CSI sequences and control bytes never seed the type-to-talk path. */
function isControlSequence(data: string): boolean {
	return data.charCodeAt(0) === 0x1b || data.charCodeAt(0) < 0x20 || data.charCodeAt(0) === 0x7f;
}

/** Live = has a running rpc child behind it (takeover-eligible). */
function isLiveHandle(handle: AgentHandle): boolean {
	return handle.state !== "archived" && handle.state !== "crashed";
}

export async function openFleetPanel(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
	supervisor: FleetSupervisor,
	focus: { current: string | null },
	deps: { cwd?: string; model?: string } = {},
): Promise<PanelAction | undefined> {
	// Model forwarding (proposal §4.5): the child starts on whatever the main
	// session currently uses; one-shot at spawn, later switches are the child's own.
	const model = ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const action = await ctx.ui.custom<PanelAction | undefined>(
		(tui, theme, _keybindings, done) =>
			new FleetPanelComponent(tui, theme, supervisor, done, {
				cwd: deps.cwd ?? ctx.cwd,
				model: deps.model ?? model,
				focus,
			}),
		{
			overlay: true,
			// Fullscreen: cover the whole terminal including the pi dock.
			overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
		},
	);
	// Panel closed: nothing is being viewed anymore.
	focus.current = null;
	return action;
}
