/**
 * StatusPill unit tests: yield detection (tool sourceInfo + settings.json
 * packages fallback) and the pill line rendering.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pillLine, shouldYieldPill } from "../../extensions/lib/pill.ts";

const fakeTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
} as unknown as Parameters<typeof pillLine>[2];

/** Run shouldYieldPill with a sandboxed HOME and a fake pi tool list. */
function yieldWith(tools: unknown[], packages: unknown[] | undefined): boolean {
	const home = mkdtempHome();
	if (packages !== undefined) {
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages }));
	}
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		return shouldYieldPill({ getAllTools: () => tools } as never);
	} finally {
		process.env.HOME = realHome;
	}
}

function mkdtempHome(): string {
	const dir = path.join(tmpdir(), `pill-home-${Math.random().toString(36).slice(2)}-`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("yields when a tool's sourceInfo names claude-code-tui", () => {
	const tools = [{ sourceInfo: { source: "extension", extensionName: "pi-claude-code-tui" } }];
	assert.equal(yieldWith(tools, undefined), true);
});

test("yields via settings.json packages even without tool attribution", () => {
	assert.equal(yieldWith([], ["git:github.com/GeorgeDong32/pi-claude-code-tui"]), true);
	assert.equal(yieldWith([], ["npm:pi-subagents", "npm:pi-goal"]), false);
	assert.equal(yieldWith([], undefined), false);
});

test("pillLine shows working/awaiting counts; idle stays dim", () => {
	const busy = pillLine(2, 1, fakeTheme);
	assert.ok(busy[0]?.includes("2 working"));
	assert.ok(busy[0]?.includes("1 awaiting"));
	assert.ok(busy[0]?.includes("agent-panel"));
	const idle = pillLine(0, 0, fakeTheme);
	assert.ok(idle[0]?.includes("idle"));
});
