/**
 * ConversationView — replays a child's mirrored rpc event stream into pi's
 * own message components (the same classes interactive-mode renders the main
 * chat with), so the panel's view mode shows a real conversation: markdown
 * user/assistant bubbles plus live tool cards, not hand-rolled text.
 *
 * Replay rules mirror interactive-mode's rebuild path:
 *   message_end(user)     → UserMessageComponent
 *   message_end(assistant)→ AssistantMessageComponent + one card per toolCall
 *   tool_execution_start  → ToolExecutionComponent (appears while running)
 *   tool_execution_end    → updateResult on the card (or remembered for a
 *                            card that only materializes at message_end)
 *
 * pi exports no built-in tool renderers (blocked by the package exports
 * map), so cards without an injected renderer fall back to the component's
 * own "tool name + output preview" style. Render is cached per width and
 * invalidated only when the tree changes.
 */
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { RpcAgentEvent } from "./types.ts";

/** Minimal component slice consumed here (keeps tests fake-able). */
interface Renderable {
	render(width: number): string[];
}

interface ToolResultShape {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError: boolean;
}

export interface ConversationDeps {
	ui: unknown; // TUI handle for ToolExecutionComponent; never typed to avoid host coupling
	cwd: string;
}

interface Entry {
	component: Renderable;
}

function textOf(message: NonNullable<RpcAgentEvent["message"]>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function normalizeResult(raw: unknown, isError: boolean): ToolResultShape {
	if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
		return { ...(raw as ToolResultShape), isError };
	}
	const text = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
	return { content: text ? [{ type: "text", text }] : [], isError };
}

export class ConversationView {
	private readonly deps: ConversationDeps;
	private readonly entries: Entry[] = [];
	/** toolCallId → card created at tool_execution_start, awaiting result. */
	private readonly pendingCards = new Map<string, Renderable>();
	/** toolCallId → finished result, for cards created after their end. */
	private readonly finishedResults = new Map<string, ToolResultShape>();
	/** Every call id a card was already built for (dedup across replays). */
	private readonly cardIds = new Set<string>();
	private dirty = true;
	private cacheWidth = -1;
	private cacheLines: string[] = [];

	constructor(deps: ConversationDeps) {
		this.deps = deps;
	}

	/** Feed one mirrored rpc event; unknown shapes are ignored, never thrown. */
	apply(evt: RpcAgentEvent): void {
		try {
			if (evt.type === "message_end" && evt.message?.role === "user") {
				const text = textOf(evt.message);
				if (text.trim()) this.push(new UserMessageComponent(text, getMarkdownTheme()));
				return;
			}
			if (evt.type === "message_end" && evt.message?.role === "assistant") {
				this.push(new AssistantMessageComponent(evt.message as never, false, getMarkdownTheme()));
				// Cards for calls whose start event was never mirrored (e.g. the
				// tool already finished before our tap began).
				const content = Array.isArray(evt.message.content) ? evt.message.content : [];
				for (const part of content) {
					if (part?.type !== "toolCall") continue;
					const call = part as { id?: string; name?: string; arguments?: unknown };
					if (!call.id || this.cardIds.has(call.id)) continue;
					const card = this.createCard(call.name ?? "tool", call.id, call.arguments);
					const result = this.finishedResults.get(call.id);
					if (result) this.applyResult(card, result);
					this.attachCard(call.id, card);
				}
				return;
			}
			if (evt.type === "tool_execution_start") {
				const callId = evt.toolCallId;
				if (!callId || this.cardIds.has(callId)) return;
				const card = this.createCard(evt.toolName ?? "tool", callId, evt.args);
				const result = this.finishedResults.get(callId);
				if (result) this.applyResult(card, result);
				this.attachCard(callId, card);
				return;
			}
			if (evt.type === "tool_execution_end") {
				const callId = evt.toolCallId;
				if (!callId) return;
				const result = normalizeResult(evt.result, Boolean(evt.isError));
				this.finishedResults.set(callId, result);
				const card = this.pendingCards.get(callId);
				if (card) {
					this.applyResult(card, result);
					this.pendingCards.delete(callId);
				}
				return;
			}
		} catch {
			// A single bad event never kills the view.
		}
	}

	/** Rendered conversation lines, oldest first. Cached per width. */
	render(width: number): string[] {
		if (this.dirty || width !== this.cacheWidth) {
			const lines: string[] = [];
			for (const entry of this.entries) {
				if (lines.length > 0) lines.push(""); // blank line between messages
				lines.push(...entry.component.render(width));
			}
			this.cacheLines = lines;
			this.cacheWidth = width;
			this.dirty = false;
		}
		return this.cacheLines;
	}

	get lineCount(): number {
		return this.render(this.cacheWidth < 0 ? 80 : this.cacheWidth).length;
	}

	private push(component: Renderable): void {
		this.entries.push({ component });
		this.dirty = true;
	}

	private createCard(toolName: string, toolCallId: string, args: unknown): Renderable {
		// No injected renderers: pi's exports map blocks the built-in renderer
		// set, so cards use the component's own name+output fallback style.
		return new ToolExecutionComponent(toolName, toolCallId, args, undefined, undefined, this.deps.ui as never, this.deps.cwd);
	}

	private attachCard(toolCallId: string, card: Renderable): void {
		this.cardIds.add(toolCallId);
		this.pendingCards.set(toolCallId, card);
		this.push(card);
	}

	private applyResult(card: Renderable, result: ToolResultShape): void {
		(card as ToolExecutionComponent).updateResult(result as never, false);
		this.dirty = true;
	}
}
