/**
 * A persistent `pi --mode rpc` child process.
 *
 * The child stays alive between turns, which is what makes a subagent something
 * you can talk to rather than a one-shot dispatch: `runTurn()` sends a prompt
 * and resolves when the child reports it has settled, and the same child can
 * take another prompt after that with its context intact.
 *
 * Framing is strict JSONL over stdin/stdout (LF only, tolerating a trailing
 * CR). No sockets, so this behaves the same on Linux, macOS and Windows.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type RpcChildEventListener = (event: JsonAgentSessionEvent) => void;

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * Work out how to re-invoke pi itself.
 *
 * Three shapes have to work: pi running from source under node/bun (re-run the
 * same script with the same runtime), pi running as a compiled standalone
 * binary (re-run the binary), and pi installed on PATH. The bundled RpcClient
 * always spawns `node`, which breaks the standalone-binary case, so this does
 * its own resolution.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export class RpcChild {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stderrText = "";
	private nextRequestId = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners: RpcChildEventListener[] = [];
	private settledWaiters: Array<() => void> = [];
	private exitError: Error | null = null;
	private readonly args: string[];
	private readonly cwd: string;

	constructor(args: string[], cwd: string) {
		this.args = args;
		this.cwd = cwd;
	}

	get stderr(): string {
		return this.stderrText;
	}

	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	start(): void {
		if (this.proc) throw new Error("RpcChild already started");

		const invocation = getPiInvocation(["--mode", "rpc", ...this.args]);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;

		proc.stdout?.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) this.handleLine(line);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			this.stderrText += data.toString();
		});

		proc.once("exit", (code, signal) => {
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			this.fail(new Error(`Subagent process ended (${reason}). ${this.stderrText.trim()}`.trim()));
		});

		proc.once("error", (error: Error) => {
			this.fail(new Error(`Subagent process error: ${error.message}`));
		});

		proc.stdin?.on("error", () => {
			// stdin closes as part of shutdown; exit/error already report the cause.
		});
	}

	onEvent(listener: RpcChildEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	/** Send a prompt and resolve once the child reports the run has settled. */
	async runTurn(message: string, signal?: AbortSignal): Promise<void> {
		// Arm the waiter before sending, so a fast child cannot settle in the gap.
		const settled = this.waitForSettled(signal);

		try {
			await this.request("prompt", { message });
		} catch (error) {
			// Nothing will settle now. Release the waiter and observe it, or its
			// later resolution becomes an unhandled rejection.
			this.releaseSettledWaiters();
			await settled;
			throw error;
		}

		if ((await settled) === "aborted") {
			throw new Error("Subagent turn aborted");
		}
	}

	async abort(): Promise<void> {
		if (!this.running) return;
		try {
			await this.request("abort", {});
		} catch {
			// The child may already be gone; stop() still cleans up.
		}
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;

		this.fail(new Error("Subagent stopped"));

		try {
			proc.stdin?.end();
		} catch {
			// Already closed.
		}

		if (proc.exitCode !== null) return;

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
				resolve();
			}, 3000);
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			proc.kill("SIGTERM");
		});
	}

	private request(command: string, body: Record<string, unknown>): Promise<unknown> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) {
			return Promise.reject(this.exitError ?? new Error("Subagent is not running"));
		}

		const id = `req-${this.nextRequestId++}`;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			// JSON.stringify never emits a raw LF, so one record is one line.
			proc.stdin?.write(`${JSON.stringify({ id, type: command, ...body })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(new Error(`Failed to send "${command}" to subagent: ${error.message}`));
			});
		});
	}

	/**
	 * Resolve on the child's next `agent_settled`, or on abort.
	 *
	 * This never rejects: the caller decides what an abort means, and a promise
	 * that only ever resolves cannot strand an unhandled rejection when a turn
	 * fails before the child ever runs.
	 */
	private waitForSettled(signal?: AbortSignal): Promise<"settled" | "aborted"> {
		return new Promise<"settled" | "aborted">((resolve) => {
			const waiter = () => {
				cleanup();
				resolve("settled");
			};
			const onAbort = () => {
				cleanup();
				void this.abort();
				resolve("aborted");
			};
			const cleanup = () => {
				const index = this.settledWaiters.indexOf(waiter);
				if (index >= 0) this.settledWaiters.splice(index, 1);
				signal?.removeEventListener("abort", onAbort);
			};

			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.settledWaiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Release every turn waiter; used when nothing is going to settle. */
	private releaseSettledWaiters(): void {
		const waiters = this.settledWaiters;
		this.settledWaiters = [];
		for (const waiter of waiters) waiter();
	}

	private handleLine(rawLine: string): void {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.trim()) return;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (parsed.type === "response") {
			const id = typeof parsed.id === "string" ? parsed.id : undefined;
			const request = id ? this.pending.get(id) : undefined;
			if (!id || !request) return;
			this.pending.delete(id);
			if (parsed.success === true) {
				request.resolve(parsed.data);
			} else {
				const error = typeof parsed.error === "string" ? parsed.error : "subagent command failed";
				request.reject(new Error(error));
			}
			return;
		}

		const event = parsed as unknown as JsonAgentSessionEvent;
		for (const listener of [...this.listeners]) listener(event);

		if (parsed.type === "agent_settled") {
			const waiters = this.settledWaiters;
			this.settledWaiters = [];
			for (const waiter of waiters) waiter();
		}
	}

	private fail(error: Error): void {
		this.exitError = error;
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) request.reject(error);

		// A dead child never settles; release turn waiters so callers see the error.
		this.releaseSettledWaiters();
	}
}
