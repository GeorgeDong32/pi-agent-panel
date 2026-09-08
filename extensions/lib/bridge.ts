/**
 * NotificationBridge — thin adapter #2: finished background turns and crashes
 * are injected back into the main session as display-only custom messages
 * (CC's task-notification pattern: visible, but the main loop is left alone).
 *
 * Suppression rules (proposal §3.7 — the anti-notification-storm core):
 *   (a) turn initiated from the panel composer (origin "panel") → silent,
 *       the user is driving it;
 *   (b) agent currently being viewed in the panel → silent, it's on screen;
 *   (c) otherwise → notify. At-most-once per turn via notifiedTurns; a quota
 *       caps storms; every failure is swallowed — notifications are
 *       best-effort and must never kill the host.
 * Crashes always notify unless currently viewed (the user asked for the
 * agent; silence would hide the failure). Archives never notify (user action).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHandle, SupervisorEvent } from "./types.ts";

/** Structural dependency: anything that can stream supervisor events. */
type EventSource = { onEvent(callback: (event: SupervisorEvent) => void): () => void };

export const NOTIFICATION_CUSTOM_TYPE = "agent-panel-notification";
const DEFAULT_QUOTA = 50;

/** View-focus channel shared with FleetPanel (index.ts wires both ends). */
export interface PanelFocus {
	current: string | null;
}

export interface BridgeDeps {
	quota?: number;
	focus?: PanelFocus;
}

export function createNotificationBridge(
	pi: Pick<ExtensionAPI, "sendMessage">,
	supervisor: EventSource,
	deps: BridgeDeps = {},
): { dispose: () => void } {
	const quota = deps.quota ?? DEFAULT_QUOTA;
	const focus = deps.focus ?? { current: null };
	const notifiedTurns = new Set<string>();
	let dropped = 0;

	const viewed = (id: string): boolean => focus.current === id;

	const deliver = (handle: AgentHandle, headline: string): void => {
		const content = [
			`[agent-panel] ${headline}`,
			`tokens: ${handle.tokens.input}in/${handle.tokens.output}out · tools: ${handle.toolCount} · turns: ${handle.turnCount}`,
			handle.lastLine ? `last: ${handle.lastLine.slice(0, 200)}` : "last: (no output)",
			`session: ${handle.sessionFile}`,
		].join("\n");
		try {
			pi.sendMessage(
				{
					customType: NOTIFICATION_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						agentId: handle.id,
						name: handle.name,
						state: handle.state,
						tokens: handle.tokens,
						sessionFile: handle.sessionFile,
						eventsFile: handle.eventsFile,
					},
				},
				// Silent injection (CC's task-notification leaves the main loop
				// alone too): triggerTurn:false appends the card to the transcript
				// without driving an LLM turn — verified against sendCustomMessage's
				// delivery matrix; with triggerTurn:true the main session burned a
				// real model round reacting to every notification (pty-observed),
				// which read as "duplicate notification cards" in practice.
				{ triggerTurn: false },
			);
		} catch {
			// Stale-host or send failures are non-fatal by design.
		}
	};

	const unsubscribe = supervisor.onEvent((event) => {
		if (event.type === "turn-ended") {
			const handle = event.handle;
			if (event.origin === "panel") return; // (a) user-initiated in panel
			if (viewed(handle.id)) return; // (b) on screen right now
			const key = `${handle.id}:${handle.turnCount}`;
			if (notifiedTurns.has(key)) return;
			notifiedTurns.add(key);
			if (notifiedTurns.size > quota) {
				dropped += 1;
				return;
			}
			deliver(handle, `${handle.name} finished a turn (awaiting input)`);
			return;
		}
		if (event.type === "agent-final") {
			const handle = event.handle;
			if (handle.state === "archived") return; // user action, not news
			if (viewed(handle.id)) return; // crash visible on screen
			const key = `${handle.id}:final`;
			if (notifiedTurns.has(key)) return;
			notifiedTurns.add(key);
			if (notifiedTurns.size > quota) {
				dropped += 1;
				return;
			}
			deliver(handle, `${handle.name} crashed — session file kept on disk`);
		}
	});

	return {
		dispose: () => {
			unsubscribe();
		},
	};
}
