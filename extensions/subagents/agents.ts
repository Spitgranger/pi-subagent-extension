/**
 * Agent definition discovery.
 *
 * Agents are markdown files with YAML frontmatter:
 *
 *     ---
 *     name: reviewer
 *     description: Reviews a diff for correctness bugs
 *     tools: read, grep, find, ls
 *     model: claude-sonnet-5
 *     thinking: medium
 *     ---
 *     You are a code reviewer. ...
 *
 * Three sources, in increasing order of precedence:
 *
 *   bundled  agents/ inside this package - the samples you get from an install
 *   user     ~/.agents/agents (override with PI_AGENTS_DIR) - yours
 *   project  <repo>/.pi/agents - repo-controlled, opt-in only
 *
 * A later source overrides an earlier one by name, so copying a bundled agent
 * into ~/.agents/agents and editing it is the supported way to customize a
 * sample without losing it on the next package update.
 *
 * Project agents load only when the caller asks for them, because a
 * repo-controlled prompt can tell the model to run anything.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	bundledAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

/**
 * Raw frontmatter values are `unknown`: `parseFrontmatter` runs a real YAML
 * parser, so any scalar or collection can appear. A type alias rather than an
 * interface, because only an alias picks up the implicit index signature that
 * `parseFrontmatter`'s `Record<string, unknown>` constraint wants.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/**
 * Sample agents shipped inside this package.
 *
 * Resolved from this module's own location (extensions/subagents/agents.ts ->
 * package root), so it works the same whether the package was installed from
 * git, from npm, or is being run straight out of a checkout.
 */
export function getBundledAgentsDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

/** Directory holding user-level agent definitions. */
export function getUserAgentsDir(): string {
	const override = process.env.PI_AGENTS_DIR;
	if (override) {
		return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : path.resolve(override);
	}
	return path.join(os.homedir(), ".agents", "agents");
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both show up in hand-written agent files:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Anything else yields no tools rather than throwing: this runs inside
 * discovery, where one bad file must not hide every other agent in the
 * directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch {
			continue;
		}

		// Fall back to the filename so an agent file only has to declare a description.
		const name = typeof frontmatter.name === "string" ? frontmatter.name : path.basename(entry.name, ".md");
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
			continue;
		}

		agents.push({
			name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const bundledAgentsDir = getBundledAgentsDir();
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const includeUserScope = scope !== "project";
	const bundledAgents = includeUserScope ? loadAgentsFromDir(bundledAgentsDir, "bundled") : [];
	const userAgents = includeUserScope ? loadAgentsFromDir(userAgentsDir, "user") : [];
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Last writer wins: your agents shadow the bundled samples, and a repo can
	// specialize either when project scope is requested.
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), bundledAgentsDir, userAgentsDir, projectAgentsDir };
}

/** One-line roster used in the system prompt and tool description. */
export function formatAgentRoster(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n");
}
