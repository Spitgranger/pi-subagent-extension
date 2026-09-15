/**
 * Full-screen subagent viewer.
 *
 * A pi overlay rather than a tmux pane: overlays are drawn by pi's own
 * renderer, so this is one code path on Linux, macOS and Windows, and it works
 * over ssh and inside any terminal pi already runs in.
 *
 * Top half lists every subagent this session started; bottom half streams the
 * selected one's activity live.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { formatActivityItem, formatUsage, statusIcon } from "./format.ts";
import type { SubagentRecord, SubagentRegistry } from "./registry.ts";

const MAX_LIST_ROWS = 8;
const MIN_DETAIL_ROWS = 6;

export class SubagentViewer implements Focusable {
	focused = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly registry: SubagentRegistry;
	private readonly done: (result: undefined) => void;
	private readonly onStop: (handle: string) => void;
	private unsubscribe: () => void;

	private selected = 0;
	/** Lines scrolled up from the bottom of the detail pane; 0 follows live output. */
	private scrollBack = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		registry: SubagentRegistry,
		onStop: (handle: string) => void,
		done: (result: undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.registry = registry;
		this.onStop = onStop;
		this.done = done;
		this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const records = this.registry.list();

		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.scrollBack = 0;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, records.length - 1), this.selected + 1);
			this.scrollBack = 0;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollBack += Math.max(1, this.detailRows() - 1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBack = Math.max(0, this.scrollBack - Math.max(1, this.detailRows() - 1));
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollBack = Number.MAX_SAFE_INTEGER;
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollBack = 0;
			return;
		}
		if (data === "s") {
			const record = records[this.selected];
			if (record) this.onStop(record.handle);
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const records = this.registry.list();
		if (this.selected >= records.length) this.selected = Math.max(0, records.length - 1);

		const inner = Math.max(20, width);
		const lines: string[] = [];

		const running = records.filter((r) => r.status === "running" || r.status === "starting").length;
		lines.push(
			theme.fg("toolTitle", theme.bold(" Subagents ")) +
				theme.fg("muted", `  ${records.length} total · ${running} running`),
		);
		lines.push(theme.fg("muted", "─".repeat(inner)));

		if (records.length === 0) {
			lines.push(theme.fg("muted", " No subagents started yet."));
			lines.push("");
			lines.push(theme.fg("dim", ' Ask the agent to delegate, e.g. "use @scout to find the auth code".'));
			lines.push(theme.fg("muted", "─".repeat(inner)));
			lines.push(this.footer());
			return lines;
		}

		for (const line of this.renderList(records, inner)) lines.push(line);
		lines.push(theme.fg("muted", "─".repeat(inner)));

		const record = records[this.selected];
		if (record) {
			for (const line of this.renderDetail(record, inner)) lines.push(line);
		}

		lines.push(theme.fg("muted", "─".repeat(inner)));
		lines.push(this.footer());
		return lines;
	}

	private renderList(records: SubagentRecord[], width: number): string[] {
		const theme = this.theme;
		const rows = Math.min(records.length, MAX_LIST_ROWS);

		// Keep the selection in view when there are more subagents than rows.
		let start = 0;
		if (this.selected >= rows) start = this.selected - rows + 1;

		const lines: string[] = [];
		for (let i = start; i < Math.min(records.length, start + rows); i++) {
			const record = records[i];
			if (!record) continue;
			const isSelected = i === this.selected;
			const marker = isSelected ? theme.fg("accent", "❯ ") : "  ";
			const name = isSelected ? theme.fg("accent", theme.bold(record.handle)) : theme.fg("toolTitle", record.handle);
			const usage = formatUsage(record.usage, record.model);
			const line = `${marker}${statusIcon(record.status, theme)} ${name} ${theme.fg("muted", record.status)}  ${theme.fg("dim", usage)}`;
			for (const rendered of new Text(line, 0, 0).render(width)) lines.push(rendered);
		}

		if (records.length > rows) {
			lines.push(theme.fg("muted", `  … ${records.length - rows} more`));
		}
		return lines;
	}

	private renderDetail(record: SubagentRecord, width: number): string[] {
		const theme = this.theme;
		const body: string[] = [];

		const header = `${theme.fg("toolTitle", theme.bold(record.handle))} ${theme.fg("dim", record.cwd)}`;
		for (const line of new Text(header, 0, 0).render(width)) body.push(line);

		for (const item of record.activity) {
			const formatted = formatActivityItem(item, theme, 0);
			for (const line of new Text(formatted, 0, 0).render(width)) body.push(line);
		}

		if (record.error) {
			for (const line of new Text(theme.fg("error", record.error), 0, 0).render(width)) body.push(line);
		}

		const rows = this.detailRows();
		if (body.length <= rows) {
			this.scrollBack = 0;
			return body;
		}

		const maxScrollBack = body.length - rows;
		if (this.scrollBack > maxScrollBack) this.scrollBack = maxScrollBack;
		const end = body.length - this.scrollBack;
		const visible = body.slice(Math.max(0, end - rows), end);

		if (this.scrollBack > 0) {
			visible.push(theme.fg("muted", `↓ ${this.scrollBack} more lines (End to follow)`));
			visible.shift();
		}
		return visible;
	}

	/** Rows available to the detail pane after chrome and the list. */
	private detailRows(): number {
		const records = this.registry.list();
		const listRows = Math.min(records.length, MAX_LIST_ROWS) + (records.length > MAX_LIST_ROWS ? 1 : 0);
		const chrome = 2 /* title + rule */ + 1 /* rule */ + 2 /* rule + footer */;
		const available = this.tui.terminal.rows - 2 - chrome - listRows;
		return Math.max(MIN_DETAIL_ROWS, available);
	}

	private footer(): string {
		return this.theme.fg("dim", " ↑/↓ select · PgUp/PgDn scroll · End follow · s stop · Esc close");
	}
}
