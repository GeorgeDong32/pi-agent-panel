/**
 * Risk-gate probes 1-3 (handoff §6): value-import RpcClient from the host
 * package, pass isolation args, and observe the event stream shape.
 *
 * Run: node probes/rpc-probe-123.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";

function fail(n, msg) {
	console.error(`PROBE ${n} FAIL: ${msg}`);
	process.exit(1);
}

// --- Probe 1: value import worked (we got a class) + cliPath resolution ------
console.log("probe1: RpcClient imported:", typeof RpcClient);
if (typeof RpcClient !== "function") fail(1, "RpcClient is not a value import");

function findPiPackageRootFromEntry(entryPoint) {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
			} catch {}
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

function resolvePiCliPath() {
	const override = process.env.PI_AGENT_PANEL_PI_BINARY?.trim();
	if (override) return override;
	// Only accept argv[1] when it actually belongs to the pi package (probe
	// scripts and unrelated entries must not qualify).
	const argv1 = process.argv[1];
	if (argv1) {
		try {
			const real = fs.realpathSync(path.resolve(argv1));
			if (/\.(mjs|cjs|js)$/i.test(real) && findPiPackageRootFromEntry(real)) return real;
		} catch {}
	}
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent").replace(/file:\/\//, "");
	const root = findPiPackageRootFromEntry(entry);
	if (!root) throw new Error("cannot locate pi package root");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	return path.resolve(root, bin);
}

const cliPath = resolvePiCliPath();
console.log("probe1: cliPath =", cliPath);
if (!fs.existsSync(cliPath)) fail(1, `cliPath does not exist: ${cliPath}`);

// --- Probe 2: args passthrough (--no-extensions --no-skills --session) ------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-panel-probe-"));
const sessionFile = path.join(tmpRoot, "session.jsonl");
const client = new RpcClient({
	cliPath,
	cwd: os.tmpdir(),
	env: { PI_AGENT_PANEL_CHILD: "1" },
	args: ["--no-extensions", "--no-skills", "--session", sessionFile],
});

const types = [];
const unsubscribe = client.onEvent((event) => {
	types.push(event.type);
	if (process.env.PROBE_VERBOSE || event.type === "agent_settled") {
		console.log(`  [${Date.now() % 100000}] evt: ${event.type}`);
	}
	// Print the shape of the state-derivation events.
	if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
		console.log(`probe3: ${event.type} keys:`, Object.keys(event).join(","));
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		const usage = event.message.usage ?? {};
		console.log(
			"probe3: assistant message_end usage keys:",
			Object.keys(usage).join(","),
			"stopReason:",
			event.message.stopReason,
		);
	}
});

try {
	await client.start();
	console.log("probe2: rpc child started");
	const state = await client.getState();
	console.log("probe2: getState →", JSON.stringify({
		isStreaming: state.isStreaming,
		sessionFile: state.sessionFile,
		sessionId: state.sessionId,
		messageCount: state.messageCount,
		pendingMessageCount: state.pendingMessageCount,
		model: state.model ? { provider: state.model.provider ?? "?", id: state.model.id ?? "?" } : undefined,
	}, null, 0));
	if (state.sessionFile !== sessionFile) fail(2, `sessionFile mismatch: ${state.sessionFile}`);
	if (typeof state.isStreaming !== "boolean") fail(2, "isStreaming missing");

	// --- Probe 3: event stream during a real prompt turn ----------------------
	await client.prompt("Reply with exactly the word: pong");
	await client.waitForIdle(120_000);
	for (const expected of ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end", "agent_settled"]) {
		if (!types.includes(expected)) fail(3, `missing event ${expected}; got: ${types.join(",")}`);
	}
	console.log("probe3: event types observed:", types.join(","));

	// Second turn on the same child — the "real conversation" core requirement.
	types.length = 0;
	await client.prompt("Now reply with exactly the word: ping");
	await client.waitForIdle(120_000);
	if (!types.includes("agent_start") || !types.includes("agent_end")) {
		fail(3, `second turn event stream incomplete: ${types.join(",")}`);
	}
	console.log("probe3: second turn ok, messageCount now:", (await client.getState()).messageCount);

	// Abort path: keep the turn deterministically busy with a long bash sleep,
	// subscribe BEFORE aborting, then expect a settle.
	console.log("MARK: long task prompt sent");
	await client.prompt("Use the bash tool to run exactly: sleep 45. Wait for it to finish.");
	await new Promise((r) => setTimeout(r, 6000));
	const busyState = await client.getState();
	console.log("MARK: pre-abort isStreaming =", busyState.isStreaming);
	console.log("MARK: subscribing + aborting");
	const settleAfterAbort = client.waitForIdle(60_000);
	await client.abort();
	await settleAfterAbort;
	const afterAbort = await client.getState();
	console.log("probe3: after abort isStreaming =", afterAbort.isStreaming);
	if (afterAbort.isStreaming) fail(3, "still streaming after abort");

	if (!fs.existsSync(sessionFile) || fs.statSync(sessionFile).size === 0) {
		fail(2, `session file not written: ${sessionFile}`);
	}
} finally {
	unsubscribe();
	await client.stop();
}
console.log("probes 1-3 PASS");
