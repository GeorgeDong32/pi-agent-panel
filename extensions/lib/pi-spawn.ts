/**
 * Resolve the pi CLI entry script for rpc children.
 *
 * RpcClient spawns `node <cliPath> --mode rpc ...`, so the resolution target
 * is a node-runnable CLI script (not a wrapper binary on PATH).
 *
 * Resolution order (mirrors pi-subagents' proven pattern):
 *   1. env PI_AGENT_PANEL_PI_BINARY — explicit override (must be the CLI
 *      entry script, not a wrapper)
 *   2. process.argv[1] inside the running pi host (verified to belong to the
 *      pi package, so probe scripts and unrelated entries don't qualify)
 *   3. the installed @earendil-works/pi-coding-agent package's bin entry
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

/** Absolute path to the pi CLI entry script; throws when unresolvable. */
export function resolvePiCliPath(): string {
	const override = process.env[PI_BINARY_ENV]?.trim();
	if (override) return override;

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
		if (root) {
			const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
				bin?: string | Record<string, string>;
			};
			const binPath = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0]);
			const candidate = binPath ? path.resolve(root, binPath) : undefined;
			if (candidate && isRunnableScript(candidate)) return candidate;
		}
	} catch {
		// Fall through to the explicit error below.
	}
	throw new Error(
		`Cannot locate the pi CLI entry script for rpc children. Set ${PI_BINARY_ENV} to the pi CLI script path.`,
	);
}
