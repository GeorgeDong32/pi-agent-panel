/**
 * Real RpcSession adapter: wraps the host package's RpcClient.
 *
 * The RpcClient runs inside the host process (the package IS the running pi),
 * so there is no version drift by construction. Children are isolated via
 * --no-extensions --no-skills + CHILD_ENV; extension_ui_request dialogs are
 * actively denied (cancelled) instead of hanging for a timeout.
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { CHILD_ENV, resolvePiCliPath } from "./pi-spawn.ts";
import type { RpcAgentEvent, RpcSession, RpcSessionFactory, RpcSessionOptions } from "./types.ts";

/** Dialog methods that block waiting for an extension_ui_response. */
const WAITING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Write a raw JSONL line to the child's stdin. RpcClient has no public API
 * for extension_ui_response (its send() always overwrites the request id and
 * expects a reply), so this reaches the private process handle — stable at
 * runtime within the same host package, contained here.
 */
function writeRawLine(client: RpcClient, line: string): void {
	const stdin = (client as unknown as {
		process?: { stdin?: { write(data: string): boolean } | null };
	}).process?.stdin;
	try {
		stdin?.write(`${line}\n`);
	} catch {
		// Denying a dead child's dialog is pointless; the crash path owns it.
	}
}

export const realRpcSessionFactory: RpcSessionFactory = async (
	options: RpcSessionOptions,
): Promise<RpcSession> => {
	const client = new RpcClient({
		cliPath: resolvePiCliPath(),
		cwd: options.cwd,
		env: { [CHILD_ENV]: "1" },
		...(options.model ? { model: options.model } : {}),
		args: ["--no-extensions", "--no-skills", "--session", options.sessionFile],
	});
	await client.start();

	// Defense-in-depth: --no-extensions children should never raise dialogs,
	// but if one does, cancel it immediately instead of stalling the turn.
	const unsubscribeDeny = client.onEvent((rawEvent) => {
		// JsonAgentSessionEvent is structurally wider than our RpcAgentEvent
		// subset; the cast is the seam's contract (same CLI-facing stream).
		const event = rawEvent as unknown as RpcAgentEvent & { id?: string };
		if (event.type === "extension_ui_request" && event.method && WAITING_UI_METHODS.has(event.method)) {
			writeRawLine(client, JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }));
		}
	});

	return {
		prompt: (text) => client.prompt(text),
		steer: (text) => client.steer(text),
		abort: () => client.abort(),
		getState: () => client.getState(),
		stop: async () => {
			unsubscribeDeny();
			await client.stop();
		},
		onEvent: (listener) => client.onEvent((rawEvent) => listener(rawEvent as unknown as RpcAgentEvent)),
	};
};
