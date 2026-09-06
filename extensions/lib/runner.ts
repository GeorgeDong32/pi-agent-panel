/**
 * Real ProcessRunner backed by node:child_process. The supervisor receives
 * this via dependency injection; tests inject a fake instead.
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { ChildProcessHandle, ProcessRunner, SpawnOptions } from "./types.ts";

export const realRunner: ProcessRunner = {
	spawn(command: string, args: string[], options: SpawnOptions): ChildProcessHandle {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		// "close" (not "exit"): stdio streams are drained before it fires.
		const exited = new Promise<number>((resolve, reject) => {
			child.once("close", (code) => resolve(code ?? -1));
			child.once("error", (error) => reject(error));
		});
		const lines = readline.createInterface({ input: child.stdout });
		// Keep stderr flowing (a full pipe would block the child) and retain
		// its tail for post-mortem diagnostics.
		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;
		child.stdout?.on("error", () => {});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			stderrBytes += chunk.length;
			while (stderrBytes > 4096 && stderrChunks.length > 1) {
				stderrBytes -= (stderrChunks[0] as Buffer).length;
				stderrChunks.shift();
			}
		});
		child.stderr?.on("error", () => {});
		return {
			pid: child.pid ?? -1,
			kill: (signal) => {
				try {
					child.kill(signal);
				} catch {
					// Already-dead children throw on kill; exit handling covers it.
				}
			},
			stdout: lines,
			exited,
			stderrTail: () => Buffer.concat(stderrChunks).toString("utf-8"),
		};
	},
};
