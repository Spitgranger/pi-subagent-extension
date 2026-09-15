/**
 * Shared, theme-aware formatting for subagent activity.
 *
 * Both the inline transcript renderer and the full-screen viewer use these, so
 * a tool call looks the same wherever you read it.
 */

import * as os from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ActivityItem, SubagentRecord, SubagentStatus, UsageStats } from "./registry.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model: string | undefined): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function statusIcon(status: SubagentStatus, theme: Theme): string {
	switch (status) {
		case "starting":
			return theme.fg("muted", "◌");
		case "running":
			return theme.fg("warning", "⏳");
		case "idle":
			return theme.fg("success", "✓");
		case "stopped":
			return theme.fg("muted", "■");
		case "error":
			return theme.fg("error", "✗");
	}
}

function shortenPath(value: string): string {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Render one tool call the way pi renders its own built-in tools. */
export function formatToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): string {
	switch (toolName) {
		case "bash": {
			const command = asString(args.command, "...");
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
		}
		case "read": {
			const filePath = shortenPath(asString(args.file_path ?? args.path, "..."));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = theme.fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return theme.fg("muted", "read ") + text;
		}
		case "write": {
			const filePath = shortenPath(asString(args.file_path ?? args.path, "..."));
			const lines = asString(args.content, "").split("\n").length;
			let text = theme.fg("muted", "write ") + theme.fg("accent", filePath);
			if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return (
				theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(asString(args.file_path ?? args.path, "...")))
			);
		case "ls":
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(asString(args.path, ".")));
		case "find":
			return (
				theme.fg("muted", "find ") +
				theme.fg("accent", asString(args.pattern, "*")) +
				theme.fg("dim", ` in ${shortenPath(asString(args.path, "."))}`)
			);
		case "grep":
			return (
				theme.fg("muted", "grep ") +
				theme.fg("accent", `/${asString(args.pattern, "")}/`) +
				theme.fg("dim", ` in ${shortenPath(asString(args.path, "."))}`)
			);
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
		}
	}
}

/** One activity item as a single display line (or a short block, for text). */
export function formatActivityItem(item: ActivityItem, theme: Theme, textLineLimit: number): string {
	if (item.kind === "tool") {
		return theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme);
	}
	if (item.kind === "status") {
		const color = item.level === "error" ? "error" : "muted";
		return theme.fg(color, `· ${item.text}`);
	}
	const lines = item.text.split("\n");
	const shown = textLineLimit > 0 ? lines.slice(0, textLineLimit) : lines;
	const suffix = lines.length > shown.length ? theme.fg("muted", ` … +${lines.length - shown.length} lines`) : "";
	return theme.fg("toolOutput", shown.join("\n")) + suffix;
}

/** Header line for a subagent: icon, handle, source, status. */
export function formatRecordHeader(record: SubagentRecord, theme: Theme): string {
	let header = `${statusIcon(record.status, theme)} ${theme.fg("toolTitle", theme.bold(record.handle))}`;
	header += theme.fg("muted", ` (${record.source})`);
	if (record.status === "error" && record.error) {
		header += ` ${theme.fg("error", record.error.split("\n")[0] ?? "error")}`;
	}
	return header;
}
