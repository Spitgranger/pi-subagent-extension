/**
 * `@agent-name` completion.
 *
 * pi already uses `@` for file attachments, so this wraps the built-in provider
 * rather than replacing it: agent matches are listed first, file matches still
 * follow underneath, and anything that is not an agent is handed straight back
 * to the built-in behavior.
 *
 * Completing a name only inserts the text `@name`. The main agent sees that
 * reference in your message and decides whether to delegate, which keeps it in
 * control of when a subagent actually starts.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";

const MAX_AGENT_SUGGESTIONS = 10;

/** Agent names are lowercase words; stop at whitespace so `@` inside a path is left alone. */
function extractAgentPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[\s(])@([A-Za-z0-9_-]*)$/);
	return match ? (match[1] ?? "") : null;
}

export function createAgentAutocompleteProvider(
	base: AutocompleteProvider,
	getAgents: () => AgentConfig[],
): AutocompleteProvider {
	return {
		triggerCharacters: [...(base.triggerCharacters ?? []), "@"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const baseSuggestions = await base.getSuggestions(lines, cursorLine, cursorCol, options);

			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const prefix = extractAgentPrefix(textBeforeCursor);
			if (prefix === null) return baseSuggestions;

			const agents = getAgents();
			if (agents.length === 0) return baseSuggestions;

			const matches = fuzzyFilter(agents, prefix, (agent) => agent.name).slice(0, MAX_AGENT_SUGGESTIONS);
			if (matches.length === 0) return baseSuggestions;

			const agentItems: AutocompleteItem[] = matches.map((agent) => ({
				value: `@${agent.name}`,
				label: `@${agent.name}`,
				description: `[agent:${agent.source}] ${agent.description}`,
			}));

			// The built-in provider treats an `@…` prefix as a whole token, so its
			// own items already carry the `@`. Reuse its prefix when it produced
			// one, otherwise describe the token ourselves.
			const agentPrefix = `@${prefix}`;
			if (baseSuggestions && baseSuggestions.prefix === agentPrefix) {
				return { items: [...agentItems, ...baseSuggestions.items], prefix: agentPrefix };
			}
			return { items: agentItems, prefix: agentPrefix };
		},

		// Insertion math (quoting, trailing space, cursor placement) is identical
		// for agents and files, so there is nothing to override here.
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}
