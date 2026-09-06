/**
 * Contract test: pin the real `pi --mode json` event-stream shape that
 * FleetSupervisor depends on (research.md §3.1). Runs the actual pi CLI —
 * if these assertions break after a pi upgrade, the supervisor's parser
 * needs revisiting before anything else.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface JsonEvent {
	type?: string;
	version?: number;
	message?: {
		role?: string;
		content?: Array<{ type?: string }>;
		usage?: Record<string, unknown>;
		stopReason?: string;
	};
}

function runPiJson(): { stdout: string; status: number } {
	const result = spawnSync(
		"pi",
		["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "Reply with exactly the word: pong"],
		{ encoding: "utf-8", timeout: 120_000 },
	);
	return { stdout: result.stdout ?? "", status: result.status ?? -1 };
}

test("pi --mode json emits the documented event stream shape", () => {
	const { stdout, status } = runPiJson();
	assert.equal(status, 0, `pi exited with ${status}: ${stdout.slice(0, 200)}`);
	const lines = stdout.split("\n").filter((line) => line.trim());
	assert.ok(lines.length >= 5, `expected a multi-line event stream, got ${lines.length} lines`);

	const events: JsonEvent[] = [];
	let unparsedLines = 0;
	for (const line of lines) {
		try {
			events.push(JSON.parse(line) as JsonEvent);
		} catch {
			unparsedLines += 1; // Tolerated by contract, but counted.
		}
	}
	assert.equal(unparsedLines, 0, "every stdout line should be parseable JSON in json mode");

	// First line: session header with schema version.
	const header = events[0] as { type?: string; version?: number };
	assert.equal(header.type, "session");
	assert.equal(typeof header.version, "number");

	// Core lifecycle events present.
	const types = events.map((event) => event.type);
	for (const expected of ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]) {
		assert.ok(types.includes(expected), `expected ${expected} in stream, got: ${types.join(",")}`);
	}

	// Assistant terminal message carries authoritative content + usage.
	const assistantEnd = events.find(
		(event) => event.type === "message_end" && event.message?.role === "assistant",
	);
	assert.ok(assistantEnd, "assistant message_end missing");
	assert.equal(assistantEnd.message?.stopReason, "stop");
	assert.ok(assistantEnd.message?.usage, "assistant message_end must carry usage");
	assert.ok(
		Array.isArray(assistantEnd.message?.content) && assistantEnd.message.content.some((part) => part.type === "text"),
		"assistant message_end must carry text content",
	);

	// agent_settled: present in the real stream (empirically verified), though
	// absent from the official json docs — pinned here as an early-warning tripwire.
	assert.ok(types.includes("agent_settled"), "agent_settled missing from stream tail");
});
