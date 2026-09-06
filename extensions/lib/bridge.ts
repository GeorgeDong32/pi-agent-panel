/**
 * NotificationBridge — thin adapter #2: child terminal states are injected
 * back into the main session as followUp messages (CC's <task-notification>
 * pattern). At-most-once per child via notifiedIds; quota caps notification
 * storms; all failures are swallowed — notifications are best-effort and must
 * never kill the host.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FleetSupervisor } from "./supervisor.ts";

export const NOTIFICATION_CUSTOM_TYPE = "agent-panel-notification";
const DEFAULT_QUOTA = 50;

export interface BridgeDeps {
	quota?: number;
}

export function createNotificationBridge(
	pi: ExtensionAPI,
	supervisor: FleetSupervisor,
	deps: BridgeDeps = {},
): { dispose: () => void } {
	const quota = deps.quota ?? DEFAULT_QUOTA;
	const notified = new Set<string>();
	let dropped = 0;

	const unsubscribe = supervisor.onEvent((event) => {
		if (event.type !== "agent-final") return;
		const handle = event.handle;
		if (notified.has(handle.id)) return;
		notified.add(handle.id);
		if (notified.size > quota) {
			dropped += 1;
			return;
		}
		const durationMs = handle.endedAt !== undefined ? handle.endedAt - handle.startedAt : 0;
		const durationLabel = durationMs >= 1000 ? `${Math.round(durationMs / 1000)}s` : `${durationMs}ms`;
		const content = [
			`[agent-panel] ${handle.name} ${handle.state}`,
			`tokens: ${handle.tokens.input}in/${handle.tokens.output}out · tools: ${handle.toolCount} · ${durationLabel}`,
			handle.lastLine ? `last: ${handle.lastLine.slice(0, 200)}` : "last: (no output)",
			`events: ${handle.eventsFile}`,
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
						exitCode: handle.exitCode,
						tokens: handle.tokens,
						sessionFile: handle.sessionFile,
						eventsFile: handle.eventsFile,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// Stale-host or send failures are non-fatal by design.
		}
	});

	return {
		dispose: () => {
			unsubscribe();
		},
	};
}
