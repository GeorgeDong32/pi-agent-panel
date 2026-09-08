/**
 * NotificationBridge unit tests: turn-end delivery and the suppression
 * matrix (origin panel / view focus / background), dedupe, quota, crash and
 * archive handling. Uses a hand-fed event source — no supervisor needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationBridge, NOTIFICATION_CUSTOM_TYPE, type PanelFocus } from "../../extensions/lib/bridge.ts";
import type { AgentHandle, SupervisorEvent } from "../../extensions/lib/types.ts";

function baseHandle(overrides: Partial<AgentHandle> = {}): AgentHandle {
	return {
		id: "agent-1",
		name: "alpha",
		state: "awaiting-input",
		cwd: "/tmp",
		startedAt: 1_000,
		tokens: { input: 12, output: 6, cost: 0.01 },
		toolCount: 2,
		turnCount: 1,
		sessionFile: "/tmp/s.jsonl",
		eventsFile: "/tmp/e.jsonl",
		lastLine: "all done",
		lastActivityAt: 2_000,
		pendingCount: 0,
		pinned: false,
		...overrides,
	};
}

interface Harness {
	sent: Array<{ message: unknown; options: unknown }>;
	focus: PanelFocus;
	emit: (event: SupervisorEvent) => void;
	dispose: () => void;
}

function createBridgeHarness(deps: { quota?: number } = {}): Harness {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	let listener: ((event: SupervisorEvent) => void) | undefined;
	const source = {
		onEvent(callback: (event: SupervisorEvent) => void) {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
	};
	const fakePi = {
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
	};
	const focus: PanelFocus = { current: null };
	const bridge = createNotificationBridge(fakePi, source, { focus, ...(deps.quota !== undefined ? { quota: deps.quota } : {}) });
	return {
		sent,
		focus,
		emit: (event) => listener?.(event),
		dispose: () => bridge.dispose(),
	};
}

test("background turn end notifies once with session file in the payload", () => {
	const h = createBridgeHarness();
	h.emit({ type: "turn-ended", handle: baseHandle(), origin: "background" });
	assert.equal(h.sent.length, 1);
	const { message, options } = h.sent[0] as { message: { content: string; customType: string; details: { sessionFile: string } }; options: { triggerTurn: boolean } };
	assert.equal(message.customType, NOTIFICATION_CUSTOM_TYPE);
	assert.ok(message.content.includes("alpha finished a turn"));
	assert.ok(message.content.includes("session: /tmp/s.jsonl"));
	assert.equal(message.details.sessionFile, "/tmp/s.jsonl");
	// Silent injection: the card must NOT drive a main-session LLM turn.
	assert.equal(options.triggerTurn, false);
});

test("panel-origin turns are suppressed (the user is driving them)", () => {
	const h = createBridgeHarness();
	h.emit({ type: "turn-ended", handle: baseHandle(), origin: "panel" });
	assert.equal(h.sent.length, 0);
});

test("turns of the agent currently being viewed are suppressed", () => {
	const h = createBridgeHarness();
	h.focus.current = "agent-1";
	h.emit({ type: "turn-ended", handle: baseHandle(), origin: "background" });
	assert.equal(h.sent.length, 0);
	// Another agent's background turn still notifies.
	h.emit({ type: "turn-ended", handle: baseHandle({ id: "agent-2", name: "beta" }), origin: "background" });
	assert.equal(h.sent.length, 1);
});

test("each turn notifies at most once (dedupe by turn number)", () => {
	const h = createBridgeHarness();
	h.emit({ type: "turn-ended", handle: baseHandle({ turnCount: 1 }), origin: "background" });
	h.emit({ type: "turn-ended", handle: baseHandle({ turnCount: 1 }), origin: "background" });
	assert.equal(h.sent.length, 1);
	h.emit({ type: "turn-ended", handle: baseHandle({ turnCount: 2 }), origin: "background" });
	assert.equal(h.sent.length, 2);
});

test("crash notifies unless viewed; archive never notifies", () => {
	const h = createBridgeHarness();
	h.emit({ type: "agent-final", handle: baseHandle({ state: "crashed" }) });
	assert.equal(h.sent.length, 1);
	assert.ok((h.sent[0] as { message: { content: string } }).message.content.includes("crashed"));
	// Viewing the same crash → silent.
	h.focus.current = "agent-2";
	h.emit({ type: "agent-final", handle: baseHandle({ id: "agent-2", state: "crashed" }) });
	assert.equal(h.sent.length, 1);
	// Archived (user action) → never.
	h.emit({ type: "agent-final", handle: baseHandle({ id: "agent-3", state: "archived" }) });
	assert.equal(h.sent.length, 1);
});

test("quota caps the storm and excess turns are dropped silently", () => {
	const h = createBridgeHarness({ quota: 2 });
	for (let turn = 1; turn <= 5; turn++) {
		h.emit({ type: "turn-ended", handle: baseHandle({ id: `a${turn}`, turnCount: turn }), origin: "background" });
	}
	assert.equal(h.sent.length, 2);
});

test("sendMessage failures never propagate", () => {
	const listenerBox: { listener?: (event: SupervisorEvent) => void } = {};
	const source = { onEvent(cb: (event: SupervisorEvent) => void) { listenerBox.listener = cb; return () => {}; } };
	const bridge = createNotificationBridge(
		{
			sendMessage: () => {
				throw new Error("Extension context no longer active");
			},
		},
		source,
	);
	assert.doesNotThrow(() => {
		listenerBox.listener?.({ type: "turn-ended", handle: baseHandle(), origin: "background" });
	});
	bridge.dispose();
});

test("dispose unsubscribes", () => {
	const h = createBridgeHarness();
	h.dispose();
	h.emit({ type: "turn-ended", handle: baseHandle(), origin: "background" });
	assert.equal(h.sent.length, 0);
});
