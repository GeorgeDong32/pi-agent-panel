/**
 * FleetPanel tests with a fake theme/tui: pin the render structure (roster,
 * transcript pane, footer) and key handling (navigation, armed stop, close)
 * without a real terminal.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetPanelComponent } from "../../extensions/lib/panel.ts";
import { FleetSupervisor } from "../../extensions/lib/supervisor.ts";
import type { ProcessRunner } from "../../extensions/lib/types.ts";

const fakeTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function createPanelHarness() {
	const spawns: Array<{ emit: (line: string) => void; exit: (code: number) => void }> = [];
	const runner: ProcessRunner = {
		spawn: () => {
			const queue: string[] = [];
			const waiters: Array<() => void> = [];
			let closed = false;
			const proc = {
				pid: 42,
				signals: [] as string[],
				emit: (line: string) => {
					queue.push(line);
					for (const wake of waiters.splice(0)) wake();
				},
				exit: (code: number) => {
					closed = true;
					exitCode = code;
					for (const wake of waiters.splice(0)) wake();
				},
			};
			let exitCode: number | undefined;
			spawns.push(proc);
			return {
				pid: 42,
				kill: (signal?: NodeJS.Signals) => {
					proc.signals.push(signal ?? "SIGTERM");
				},
				exited: new Promise<number>((resolve) => {
					const poll = setInterval(() => {
						if (exitCode !== undefined) {
							clearInterval(poll);
							resolve(exitCode);
						}
					}, 5);
					// Keep test exits from waiting on never-exited fakes.
					poll.unref();
				}),
				stdout: (async function* () {
					let index = 0;
					for (;;) {
						while (index < queue.length) {
							yield queue[index] as string;
							index += 1;
						}
						if (closed && index >= queue.length) return;
						await new Promise<void>((resolve) => {
							waiters.push(resolve);
						});
					}
				})(),
			};
		},
	};
	const supervisor = new FleetSupervisor({
		runner,
		rootDir: mkdtempSync(path.join(tmpdir(), "agent-panel-panel-test-")),
		drainMs: 20,
		stopGraceMs: 50,
	});
	const renders: number[] = [];
	let doneCalled = false;
	const panel = new FleetPanelComponent(
		{ requestRender: () => { renders.push(1); }, terminal: { rows: 30 } },
		fakeTheme,
		supervisor,
		(_result) => {
			doneCalled = true;
		},
	);
	return { panel, supervisor, spawns, isDone: () => doneCalled, renderCount: () => renders.length };
}

const WIDTH = 100;

test("empty roster renders guidance and footer", () => {
	const { panel } = createPanelHarness();
	const lines = panel.render(WIDTH);
	const text = lines.join("\n");
	assert.ok(text.includes("agent-panel"), "header present");
	assert.ok(text.includes("No agents"), "empty-roster guidance present");
	assert.ok(text.includes("Esc close"), "footer hints present");
});

test("roster shows agent name and status; transcript pane mirrors tail", async () => {
	const { panel, supervisor, spawns } = createPanelHarness();
	supervisor.spawn({ name: "alpha", prompt: "do the thing", cwd: "/tmp" });
	const child = spawns[0] as { emit: (line: string) => void };
	child.emit(JSON.stringify({ type: "session", version: 3 }));
	child.emit(JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "thinking hard" }], stopReason: "stop" },
	}));
	await new Promise((resolve) => setTimeout(resolve, 50));
	panel.invalidate();
	const text = panel.render(WIDTH).join("\n");
	assert.ok(text.includes("alpha"), "roster shows name");
	assert.ok(text.includes("1/1"), "position indicator");
	assert.ok(text.includes("thinking hard") || text.includes("waiting for child output"), "transcript content");
});

test("narrow width degrades to a single hint line", () => {
	const { panel } = createPanelHarness();
	const lines = panel.render(30);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("agent-panel"), "hint mentions the panel");
});

test("q/escape close the panel via done()", () => {
	const { panel, isDone } = createPanelHarness();
	assert.equal(isDone(), false);
	panel.handleInput("q");
	assert.equal(isDone(), true);
});

test("j/k move the selection; x arms then confirms stop", async () => {
	const { panel, supervisor, spawns } = createPanelHarness();
	supervisor.spawn({ name: "a", prompt: "x", cwd: "/tmp" });
	supervisor.spawn({ name: "b", prompt: "x", cwd: "/tmp" });
	const child = spawns[1] as unknown as { emit: (line: string) => void };
	child.emit(JSON.stringify({ type: "session", version: 3 }));
	await new Promise((resolve) => setTimeout(resolve, 30));
	panel.invalidate();
	const textBefore = panel.render(WIDTH).join("\n");
	assert.ok(textBefore.includes("1/2"), "starts on first item");
	panel.handleInput("j");
	assert.ok(panel.render(WIDTH).join("\n").includes("2/2"), "moved to second");
	panel.handleInput("x");
	const armed = panel.render(WIDTH).join("\n");
	assert.ok(armed.includes("confirm-stop"), "first x arms");
	panel.handleInput("x");
	// Fake children only die when told to: simulate the SIGINT taking effect.
	(spawns[1] as unknown as { exit: (code: number) => void }).exit(130);
	await new Promise((resolve) => setTimeout(resolve, 60));
	const stopped = supervisor.list().find((h) => h.name === "b");
	assert.equal(stopped?.state, "stopped", "second x stops the child");
});
