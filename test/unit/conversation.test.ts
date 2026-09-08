/**
 * ConversationView tests: mirrored rpc events replayed into pi's native
 * message components. Pins the replay rules (bubbles, tool cards, out-of-
 * order results) and the per-width render cache, all offline via initTheme.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ConversationView } from "../../extensions/lib/conversation.ts";

initTheme(undefined, false);

const noopUi = { requestRender() {} };

function userEnd(text: string) {
	return { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEnd(text: string, toolCalls: Array<{ id: string; name: string }> = []) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				...toolCalls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
			],
			stopReason: "stop",
		},
	};
}

test("user + assistant message_end produce rendered bubbles", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply(userEnd("你好任务"));
	view.apply(assistantEnd("回答正文"));
	const lines = view.render(80).join("\n");
	assert.ok(lines.includes("你好任务"), "user bubble");
	assert.ok(lines.includes("回答正文"), "assistant bubble");
	assert.ok(view.lineCount > 2, "spacer between messages");
});

test("tool card: start → live card, end → result attached", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
	let text = view.render(80).join("\n");
	assert.ok(text.includes("read"), "card appears at start");
	assert.ok(!text.includes("file body"), "no result yet");
	view.apply({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "file body" }] }, isError: false });
	text = view.render(80).join("\n");
	assert.ok(text.includes("file body"), "result attached on end");
});

test("tool result arriving before its card is remembered (replay order)", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: "early result" }] }, isError: false });
	view.apply(assistantEnd("done", [{ id: "t2", name: "bash" }]));
	const text = view.render(80).join("\n");
	assert.ok(text.includes("early result"), "remembered result applied to late card");
	const second = view.render(80).join("\n");
	assert.equal(second, text, "no duplicate card for the same call id");
});

test("a call id gets exactly one card even across duplicate message_end", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply({ type: "tool_execution_start", toolCallId: "t3", toolName: "grep", args: {} });
	view.apply(assistantEnd("text", [{ id: "t3", name: "grep" }]));
	view.apply(assistantEnd("text", [{ id: "t3", name: "grep" }]));
	const count = view.render(80).join("\n").split("grep").length - 1;
	assert.equal(count, 1, "card title appears once; no card duplicated");
});

test("render cache: same width reuses lines, width change re-renders", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply(userEnd("hello"));
	const a = view.render(80);
	assert.equal(view.render(80), a, "cached per width");
	const b = view.render(40);
	assert.notEqual(b, a, "width change invalidates");
});

test("malformed events are swallowed, never thrown", () => {
	const view = new ConversationView({ ui: noopUi, cwd: "/tmp" });
	view.apply({ type: "message_end" } as never);
	view.apply({ type: "tool_execution_start" } as never);
	view.apply({ type: "unknown_event" } as never);
	assert.equal(view.lineCount, 0, "nothing rendered, no throw");
});
