/**
 * Live registry of running subagents.
 *
 * Each entry owns one persistent `pi --mode rpc` child and an activity log
 * built from that child's event stream. Both the inline tool renderer and the
 * full-screen viewer read from here, so what you see in the transcript and what
 * you see in the viewer can never drift apart.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentSource } from "./agents.ts";
import { RpcChild } from "./rpc-child.ts";

/** Keep the log bounded: a long-lived subagent can emit thousands of events. */
const MAX_ACTIVITY_ITEMS = 500;

export type ActivityItem =
	| { at: number; kind: "tool"; name: string; args: Record<string, unknown> }
	| { at: number; kind: "text"; text: string }
	| { at: number; kind: "status"; text: string; level: "info" | "error" };

export type SubagentStatus = "starting" | "running" | "idle" | "stopped" | "error";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentRecord {
	handle: string;
	agentName: string;
	source: AgentSource;
	task: string;
	cwd: string;
	model: string | undefined;
	status: SubagentStatus;
	activity: ActivityItem[];
	usage: UsageStats;
	/** Final assistant text from the most recent turn. */
	lastReply: string;
	error: string | undefined;
	startedAt: number;
}

export interface StartOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	/** Model and thinking level inherited when the agent file pins neither. */
	defaults: { model?: string; thinking?: string };
	signal: AbortSignal | undefined;
	/** Called once the record exists, before the opening task runs. */
	onCreate?: (record: SubagentRecord) => void;
}

interface Entry {
	record: SubagentRecord;
	child: RpcChild;
	promptFile: string | null;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function finalAssistantText(message: AgentMessage): string | null {
	if (message.role !== "assistant") return null;
	for (let i = message.content.length - 1; i >= 0; i--) {
		const part = message.content[i];
		if (part?.type === "text" && part.text.trim()) return part.text;
	}
	return null;
}

export class SubagentRegistry {
	private entries = new Map<string, Entry>();
	private listeners: Array<() => void> = [];
	private counter = 0;

	/** Notified on every state change so the viewer can re-render live. */
	subscribe(listener: () => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	list(): SubagentRecord[] {
		return Array.from(this.entries.values(), (entry) => entry.record);
	}

	get(handle: string): SubagentRecord | undefined {
		return this.entries.get(handle)?.record;
	}

	hasActive(): boolean {
		return this.list().some((record) => record.status === "running" || record.status === "starting");
	}

	/**
	 * Spawn a subagent and run its opening task.
	 *
	 * Returns as soon as the first turn settles; the child stays alive for
	 * `send()`.
	 */
	async start(options: StartOptions): Promise<SubagentRecord> {
		const { agent, task, cwd, defaults, signal } = options;
		const handle = `${agent.name}#${++this.counter}`;

		// An agent that pins no model inherits the dispatching session's model and
		// thinking level, so switching the parent model moves its subagents too.
		const inheritsDispatchConfig = !agent.model;
		const model = agent.model ?? defaults.model;
		const thinking = agent.thinking ?? (inheritsDispatchConfig ? defaults.thinking : undefined);

		const args: string[] = ["--no-session"];
		if (model) args.push("--model", model);
		if (thinking) args.push("--thinking", thinking);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		let promptFile: string | null = null;
		if (agent.systemPrompt.trim()) {
			promptFile = await writePromptFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", promptFile);
		}

		const record: SubagentRecord = {
			handle,
			agentName: agent.name,
			source: agent.source,
			task,
			cwd,
			model,
			status: "starting",
			activity: [],
			usage: emptyUsage(),
			lastReply: "",
			error: undefined,
			startedAt: Date.now(),
		};

		const child = new RpcChild(args, cwd);
		const entry: Entry = { record, child, promptFile };
		this.entries.set(handle, entry);
		// Hand the caller its handle before the first turn runs, so a tool can
		// stream this subagent's progress while it is still working.
		options.onCreate?.(record);

		child.onEvent((event) => this.applyEvent(entry, event));

		try {
			child.start();
		} catch (error) {
			this.markError(entry, error);
			this.notify();
			return record;
		}

		this.notify();
		await this.runTurn(entry, task, signal);
		return record;
	}

	/** Send a follow-up message to a running subagent and wait for its reply. */
	async send(handle: string, message: string, signal: AbortSignal | undefined): Promise<SubagentRecord> {
		const entry = this.entries.get(handle);
		if (!entry) throw new Error(`Unknown subagent handle "${handle}".`);
		if (!entry.child.running) {
			throw new Error(`Subagent "${handle}" is no longer running (status: ${entry.record.status}).`);
		}
		await this.runTurn(entry, message, signal);
		return entry.record;
	}

	async stop(handle: string): Promise<void> {
		const entry = this.entries.get(handle);
		if (!entry) return;
		await entry.child.stop();
		if (entry.record.status !== "error") entry.record.status = "stopped";
		this.pushActivity(entry, { at: Date.now(), kind: "status", text: "stopped", level: "info" });
		this.cleanupPromptFile(entry);
		this.notify();
	}

	async stopAll(): Promise<void> {
		await Promise.all(Array.from(this.entries.keys(), (handle) => this.stop(handle)));
	}

	private async runTurn(entry: Entry, message: string, signal: AbortSignal | undefined): Promise<void> {
		entry.record.status = "running";
		entry.record.error = undefined;
		entry.record.lastReply = "";
		this.pushActivity(entry, { at: Date.now(), kind: "status", text: `task: ${message}`, level: "info" });
		this.notify();

		try {
			await entry.child.runTurn(message, signal);
			// A child that died mid-turn releases the waiter without settling.
			if (!entry.child.running) {
				this.markError(entry, new Error(entry.child.stderr.trim() || "subagent exited during the turn"));
			} else if (entry.record.status === "running") {
				entry.record.status = "idle";
			}
		} catch (error) {
			this.markError(entry, error);
		}
		this.notify();
	}

	private applyEvent(entry: Entry, event: JsonAgentSessionEvent): void {
		const record = entry.record;

		if (event.type === "tool_execution_start") {
			const args = (event.args ?? {}) as Record<string, unknown>;
			this.pushActivity(entry, { at: Date.now(), kind: "tool", name: event.toolName, args });
			this.notify();
			return;
		}

		if (event.type === "message_end") {
			const message = event.message;
			const text = finalAssistantText(message);
			if (text) {
				record.lastReply = text;
				this.pushActivity(entry, { at: Date.now(), kind: "text", text });
			}

			if (message.role === "assistant") {
				record.usage.turns++;
				const usage = message.usage;
				if (usage) {
					record.usage.input += usage.input ?? 0;
					record.usage.output += usage.output ?? 0;
					record.usage.cacheRead += usage.cacheRead ?? 0;
					record.usage.cacheWrite += usage.cacheWrite ?? 0;
					record.usage.cost += usage.cost?.total ?? 0;
					record.usage.contextTokens = usage.totalTokens ?? record.usage.contextTokens;
				}
				if (!record.model && message.model) record.model = message.model;
				if (message.errorMessage) {
					record.error = message.errorMessage;
					record.status = "error";
					this.pushActivity(entry, { at: Date.now(), kind: "status", text: message.errorMessage, level: "error" });
				}
			}
			this.notify();
		}
	}

	private markError(entry: Entry, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		entry.record.status = "error";
		entry.record.error = message;
		this.pushActivity(entry, { at: Date.now(), kind: "status", text: message, level: "error" });
	}

	private pushActivity(entry: Entry, item: ActivityItem): void {
		entry.record.activity.push(item);
		if (entry.record.activity.length > MAX_ACTIVITY_ITEMS) {
			entry.record.activity.splice(0, entry.record.activity.length - MAX_ACTIVITY_ITEMS);
		}
	}

	private cleanupPromptFile(entry: Entry): void {
		if (!entry.promptFile) return;
		const file = entry.promptFile;
		entry.promptFile = null;
		try {
			fs.rmSync(path.dirname(file), { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort.
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

async function writePromptFile(agentName: string, prompt: string): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}
