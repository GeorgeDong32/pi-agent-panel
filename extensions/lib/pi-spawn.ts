/**
 * Resolve the pi CLI command for spawning headless children.
 *
 * Resolution order (mirrors pi-subagents' proven pattern):
 *   1. env PI_AGENT_PANEL_PI_BINARY — explicit override
 *   2. process.execPath + pi CLI script located via the running host
 *      (process.argv[1] inside pi, or the installed @earendil-works package)
 *   3. bare "pi" from PATH
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_BINARY_ENV = "PI_AGENT_PANEL_PI_BINARY";
export const CHILD_ENV = "PI_AGENT_PANEL_CHILD";

function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
				if (pkg.name === PI_PACKAGE) return dir;
			} catch {
				// Unreadable package metadata; keep walking up.
			}
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

function isRunnableScript(filePath: string): boolean {
	return fs.existsSync(filePath) && /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function resolvePiCliScript(): string | undefined {
	// Inside the pi host, process.argv[1] is the running CLI script itself.
	const argv1 = process.argv[1];
	if (argv1) {
		try {
			const real = fs.realpathSync(path.resolve(argv1));
			if (isRunnableScript(real) && findPiPackageRootFromEntry(real)) return real;
		} catch {
			// Best effort only.
		}
	}
	try {
		const root = findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
		if (!root) return undefined;
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binPath = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0]);
		if (!binPath) return undefined;
		const candidate = path.resolve(root, binPath);
		if (isRunnableScript(candidate)) return candidate;
	} catch {
		// Fall through to PATH resolution.
	}
	return undefined;
}

export function getPiSpawnCommand(args: string[]): { command: string; args: string[] } {
	const override = process.env[PI_BINARY_ENV]?.trim();
	if (override) return { command: override, args };
	const cliScript = resolvePiCliScript();
	if (cliScript) return { command: process.execPath, args: [cliScript, ...args] };
	return { command: "pi", args };
}

/** CLI flags for a headless child. Kept deliberately minimal for v1. */
export function buildChildArgs(input: {
	sessionFile: string;
	model?: string;
	permissionMode?: string;
	prompt: string;
	promptFile?: string;
}): string[] {
	const args = [
		"--mode", "json",
		"-p",
		// Children run fully headless: no extensions/skills to load, no UI to serve.
		"--no-extensions",
		"--no-skills",
		"--session", input.sessionFile,
	];
	// NB: --permission-mode is NOT a builtin pi flag — it is registered by
	// permission extensions (e.g. pi-permission-modes) and therefore rejected
	// under --no-extensions. Only forward it when explicitly requested.
	if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
	if (input.model) args.push("--model", input.model);
	args.push(input.promptFile ? `@${input.promptFile}` : `Task: ${input.prompt}`);
	return args;
}

/** Prompts beyond this length go through a temp file to dodge argv limits. */
export const PROMPT_ARG_LIMIT = 8000;
