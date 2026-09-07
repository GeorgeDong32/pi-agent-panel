/**
 * Shared unit-test harness: a scripted FakeRpcSession standing in for the
 * real RpcClient-backed adapter. No real processes, no network — the factory
 * seam keeps the supervisor fully testable offline.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import type { RpcAgentEvent, RpcSession, RpcSessionFactory, RpcSessionSnapshot } from "../../extensions/lib/types.ts";

export interface RecordedSend {
	text: string;
	kind: "prompt" | "steer";
}

export class FakeRpcSession implements RpcSession {
	sends: RecordedSend[] = [];
	aborts = 0;
	stopCalls = 0;
	state: RpcSessionSnapshot = { isStreaming: false, sessionId: "fake-session", pendingMessageCount: 0 };
	/** Next command/getState throws this (crash simulation). */
	failNext: Error | undefined;
	readonly createdOptions: { cwd: string; sessionFile: string; model?: string };
	private readonly listeners = new Set<(event: RpcAgentEvent) => void>();

	constructor(createdOptions: { cwd: string; sessionFile: string; model?: string }) {
		this.createdOptions = createdOptions;
	}

	emit(event: RpcAgentEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	prompt(text: string): Promise<void> {
		return this.record({ text, kind: "prompt" });
	}

	steer(text: string): Promise<void> {
		return this.record({ text, kind: "steer" });
	}

	abort(): Promise<void> {
		this.aborts += 1;
		return this.maybeFail();
	}

	getState(): Promise<RpcSessionSnapshot> {
		if (this.failNext) {
			const error = this.failNext;
			this.failNext = undefined;
			return Promise.reject(error);
		}
		return Promise.resolve({ ...this.state });
	}

	stop(): Promise<void> {
		this.stopCalls += 1;
		return Promise.resolve();
	}

	onEvent(listener: (event: RpcAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private record(send: RecordedSend): Promise<void> {
		this.sends.push(send);
		return this.maybeFail();
	}

	private maybeFail(): Promise<void> {
		if (this.failNext) {
			const error = this.failNext;
			this.failNext = undefined;
			return Promise.reject(error);
		}
		return Promise.resolve();
	}
}

export interface Harness {
	supervisor: FleetSupervisor;
	sessions: FakeRpcSession[];
	rootDir: string;
	factory: RpcSessionFactory;
}

export function createHarness(options: { limit?: number; probeMs?: number; rootDir?: string } = {}): Harness {
	const sessions: FakeRpcSession[] = [];
	const factory: RpcSessionFactory = async (sessionOptions) => {
		const session = new FakeRpcSession(sessionOptions);
		sessions.push(session);
		return session;
	};
	const rootDir = options.rootDir ?? mkdtempSync(path.join(tmpdir(), "agent-panel-test-"));
	const supervisor = new FleetSupervisor({
		sessionFactory: factory,
		rootDir,
		probeMs: options.probeMs ?? 0,
		...(options.limit !== undefined ? { limit: options.limit } : {}),
	});
	return { supervisor, sessions, rootDir, factory };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timeout waiting for ${message}`);
}

/** A complete conversation turn on the fake session (spec-shaped events). */
export function emitTurn(
	session: FakeRpcSession,
	userText: string,
	assistantText: string,
	usage: { input: number; output: number } = { input: 10, output: 5 },
): void {
	session.emit({ type: "agent_start" });
	session.emit({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: userText }] },
	});
	session.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: assistantText }],
			usage: { ...usage, cost: { total: 0.01 } },
			stopReason: "stop",
		},
	});
	session.emit({ type: "agent_end", willRetry: false });
}
