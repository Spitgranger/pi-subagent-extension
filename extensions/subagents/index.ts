/**
 * Subagents: persistent, addressable delegates.
 *
 * Each subagent is a long-lived `pi --mode rpc` child process with its own
 * context window and its own system prompt, loaded from a markdown file in
 * ~/.agents/agents. Because the child stays alive, the main agent can hold a
 * conversation with it (subagent_send) instead of firing a single task and
 * losing the context.
 *
 * Three surfaces:
 *   - tools      subagent_start / _send / _list / _stop, for the main agent
 *   - @name      completion in the editor, so you can name an agent in a prompt
 *   - viewer     ctrl+g or /subagents, a live full-screen view of every child
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentRoster, getUserAgentsDir } from "./agents.ts";
import { createAgentAutocompleteProvider } from "./autocomplete.ts";
import { formatActivityItem, formatRecordHeader, formatUsage, statusIcon } from "./format.ts";
import { type SubagentRecord, SubagentRegistry } from "./registry.ts";
import { SubagentViewer } from "./viewer.ts";

const COLLAPSED_ITEM_COUNT = 10;
const VIEWER_SHORTCUT = "alt+s";

interface SubagentDetails {
	records: SubagentRecord[];
	/** Set when the call failed before any subagent was created. */
	message?: string;
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Leave this unset unless the user explicitly asks for a repo-local agent. Default "user" loads your own agents from ~/.agents/agents. "project" loads ONLY repo-controlled agents from .pi/agents, which most repositories do not have; "both" loads user agents plus repo ones.',
	default: "user",
});

function detailsOf(records: SubagentRecord[], message?: string): SubagentDetails {
	return message === undefined ? { records } : { records, message };
}

function summarize(record: SubagentRecord): string {
	const lines = [`handle: ${record.handle}`, `status: ${record.status}`];
	if (record.error) lines.push(`error: ${record.error}`);
	lines.push("", record.lastReply || "(no output)");
	return lines.join("\n");
}

/** Render a record's activity plus usage, shared by every tool's result view. */
function renderRecord(record: SubagentRecord, theme: Theme, expanded: boolean): Container {
	const container = new Container();
	container.addChild(new Text(formatRecordHeader(record, theme), 0, 0));

	if (expanded) {
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", record.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
		for (const item of record.activity) {
			container.addChild(new Text(formatActivityItem(item, theme, 0), 0, 0));
		}
		if (record.lastReply) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(record.lastReply.trim(), 0, 0, getMarkdownTheme()));
		}
	} else {
		const shown = record.activity.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = record.activity.length - shown.length;
		if (skipped > 0) container.addChild(new Text(theme.fg("muted", `… ${skipped} earlier items`), 0, 0));
		for (const item of shown) {
			container.addChild(new Text(formatActivityItem(item, theme, 3), 0, 0));
		}
		if (record.activity.length > COLLAPSED_ITEM_COUNT) {
			container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
		}
	}

	const usage = formatUsage(record.usage, record.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	return container;
}

function renderDetails(details: SubagentDetails | undefined, theme: Theme, expanded: boolean): Container {
	const container = new Container();
	if (!details || details.records.length === 0) {
		container.addChild(new Text(theme.fg("muted", details?.message ?? "(no subagents)"), 0, 0));
		return container;
	}
	if (details.message) container.addChild(new Text(theme.fg("muted", details.message), 0, 0));
	for (let i = 0; i < details.records.length; i++) {
		if (i > 0) container.addChild(new Spacer(1));
		container.addChild(renderRecord(details.records[i]!, theme, expanded));
	}
	return container;
}

export default function subagents(pi: ExtensionAPI) {
	const registry = new SubagentRegistry();
	/** Refreshed on every discovery so `@` completion tracks files edited mid-session. */
	let knownAgents: AgentConfig[] = [];

	const discover = (cwd: string, scope: AgentScope) => {
		const result = discoverAgents(cwd, scope);
		if (scope !== "project") knownAgents = result.agents;
		return result;
	};

	// Seed the roster before the first turn so `@` completion works immediately.
	discover(process.cwd(), "user");

	const openViewer = async (ctx: ExtensionCommandContext | ExtensionContext): Promise<void> => {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) =>
				new SubagentViewer(tui, theme, registry, (handle) => void registry.stop(handle), done),
			{
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
			},
		);
	};

	// ── Delegation tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_start",
		label: "Subagent",
		description: [
			"Start a subagent and give it an opening task. The subagent runs in its own process with its own",
			"context window and system prompt, and stays alive afterwards: use subagent_send with the returned",
			"handle to ask follow-up questions instead of starting a new one.",
			"Call this tool several times in one message to run subagents in parallel.",
			`Your own agent definitions live in ${getUserAgentsDir()}; this package also ships sample agents.`,
		].join(" "),
		promptSnippet: "subagent_start: delegate a task to a named subagent with its own context window",
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent definition to run" }),
			task: Type.String({ description: "Opening task for the subagent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
			agentScope: Type.Optional(AgentScopeSchema),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const scope: AgentScope = params.agentScope ?? "user";
			const discovery = discover(ctx.cwd, scope);
			const agent = discovery.agents.find((candidate) => candidate.name === params.agent);

			if (!agent) {
				const available = discovery.agents.map((a) => a.name).join(", ") || "none";
				const hint =
					scope === "project"
						? ` Scope "project" only reads ${CONFIG_DIR_NAME}/agents; omit agentScope to use your own agents.`
						: "";
				throw new Error(`Unknown agent "${params.agent}". Available in scope "${scope}": ${available}.${hint}`);
			}

			// A repo-controlled prompt can tell the model to run anything, so ask
			// before running one from an untrusted checkout.
			if (agent.source === "project" && ctx.hasUI && !ctx.isProjectTrusted()) {
				const approved = await ctx.ui.confirm(
					"Run a project-local agent?",
					`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for repositories you trust.`,
				);
				if (!approved) {
					throw new Error(`Canceled: the user did not approve running project-local agent "${agent.name}".`);
				}
			}

			let live: SubagentRecord | undefined;
			const unsubscribe = registry.subscribe(() => {
				if (!live || !onUpdate) return;
				onUpdate({
					content: [{ type: "text", text: live.lastReply || `${live.handle}: ${live.status}…` }],
					details: detailsOf([live]),
				});
			});

			try {
				const record = await registry.start({
					agent,
					task: params.task,
					cwd: params.cwd ?? ctx.cwd,
					defaults: {
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						thinking: ctx.thinkingLevel,
					},
					signal,
					onCreate: (created) => {
						live = created;
					},
				});

				if (record.status === "error") {
					// Throwing is how the runtime marks a tool result as failed; the
					// full activity log stays inspectable in the viewer (alt+s).
					throw new Error(`Subagent ${record.handle} failed: ${record.error ?? "unknown error"}`);
				}

				return {
					content: [{ type: "text", text: summarize(record) }],
					details: detailsOf([record]),
				};
			} finally {
				unsubscribe();
			}
		},

		renderCall(args, theme) {
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "...")}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as SubagentDetails | undefined, theme, expanded);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent",
		description:
			"Send a follow-up message to a subagent started earlier with subagent_start, and wait for its reply. " +
			"The subagent keeps everything from its previous turns, so refer back to them freely.",
		promptSnippet: "subagent_send: continue the conversation with a running subagent",
		parameters: Type.Object({
			handle: Type.String({ description: 'Handle returned by subagent_start, e.g. "scout#1"' }),
			message: Type.String({ description: "Message to send to the subagent" }),
		}),
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, onUpdate) {
			const existing = registry.get(params.handle);
			if (!existing) {
				const handles = registry
					.list()
					.map((record) => record.handle)
					.join(", ");
				throw new Error(`Unknown handle "${params.handle}". Started this session: ${handles || "none"}.`);
			}

			const unsubscribe = registry.subscribe(() => {
				if (!onUpdate) return;
				onUpdate({
					content: [{ type: "text", text: existing.lastReply || `${existing.handle}: ${existing.status}…` }],
					details: detailsOf([existing]),
				});
			});

			try {
				const record = await registry.send(params.handle, params.message, signal);
				if (record.status === "error") {
					throw new Error(`Subagent ${record.handle} failed: ${record.error ?? "unknown error"}`);
				}
				return {
					content: [{ type: "text", text: summarize(record) }],
					details: detailsOf([record]),
				};
			} finally {
				unsubscribe();
			}
		},

		renderCall(args, theme) {
			const preview = args.message
				? args.message.length > 60
					? `${args.message.slice(0, 60)}...`
					: args.message
				: "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent → "))}${theme.fg("accent", args.handle ?? "...")}\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			return renderDetails(result.details as SubagentDetails | undefined, theme, expanded);
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent",
		description:
			"List subagents started in this session with their handles, status and usage, plus the agent definitions available to start.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const records = registry.list();
			const discovery = discover(ctx.cwd, "user");

			const runningText =
				records.length === 0
					? "No subagents running."
					: records.map((r) => `${r.handle} — ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Running subagents:\n${runningText}\n\nAvailable agent definitions:\n${formatAgentRoster(discovery.agents)}`,
					},
				],
				details: detailsOf(records, records.length === 0 ? "no subagents running" : undefined),
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent list")), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.records.length === 0) {
				return new Text(theme.fg("muted", "no subagents running"), 0, 0);
			}
			if (!expanded) {
				const lines = details.records.map(
					(record) =>
						`${statusIcon(record.status, theme)} ${theme.fg("toolTitle", record.handle)} ${theme.fg("muted", record.status)}`,
				);
				return new Text(lines.join("\n"), 0, 0);
			}
			return renderDetails(details, theme, true);
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent",
		description: "Stop a running subagent and release its process. Its transcript stays visible in the viewer.",
		parameters: Type.Object({
			handle: Type.String({ description: 'Handle of the subagent to stop, e.g. "scout#1"' }),
		}),

		async execute(_toolCallId, params) {
			const record = registry.get(params.handle);
			if (!record) {
				throw new Error(`Unknown handle "${params.handle}".`);
			}
			await registry.stop(params.handle);
			return {
				content: [{ type: "text", text: `Stopped ${params.handle}.` }],
				details: detailsOf([record]),
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent stop "))}${theme.fg("accent", args.handle ?? "...")}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : "stopped"), 0, 0);
		},
	});

	// ── Editor surface ──────────────────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "Watch running subagents",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openViewer(ctx);
		},
	});

	pi.registerShortcut(VIEWER_SHORTCUT, {
		description: "Watch running subagents",
		handler: async (ctx: ExtensionContext) => {
			await openViewer(ctx);
		},
	});

	// ── Session wiring ──────────────────────────────────────────────────────

	pi.on("before_agent_start", (event, ctx) => {
		const discovery = discover(ctx.cwd, "user");
		if (discovery.agents.length === 0) return undefined;

		const roster = [
			"",
			"## Subagents",
			"",
			"You can delegate to subagents. Each runs in a separate process with its own context window",
			"and its own system prompt, and stays alive after its first task, so prefer sending a follow-up",
			"to a subagent you already started (subagent_send) over starting another one.",
			"",
			"When the user writes @name in a message they are referring to one of these agents. Treat it as",
			"a suggestion to delegate to that agent, not an instruction you must follow: if the work is",
			"quicker done directly, say so and do it.",
			"",
			"Available agents:",
			...discovery.agents.map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`),
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}\n${roster}` };
	});

	pi.on("session_start", (_event, ctx) => {
		discover(ctx.cwd, "user");
		// Stack `@name` on top of the built-in provider rather than replacing it,
		// so file completion keeps working on the same trigger character.
		ctx.ui.addAutocompleteProvider((current) => createAgentAutocompleteProvider(current, () => knownAgents));
	});

	pi.on("session_shutdown", async () => {
		await registry.stopAll();
	});
}
