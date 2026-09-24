import assert from "node:assert/strict";
import { test } from "node:test";
import { formatActivityItem } from "../extensions/subagents/format.ts";
import { SubagentRegistry } from "../extensions/subagents/registry.ts";

// Exercise real registry event handling without spawning a provider or requiring pi's runtime imports.
function harness() {
	const registry = new SubagentRegistry();
	const entry = {
		record: {
			handle: "test#1",
			status: "running",
			activity: [],
			lastReply: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		},
		thinking: new Map(),
		child: { running: true, runTurn: async () => {} },
		promptFile: null,
	};
	// Private access stays confined to this fixture; all assertions inspect observable records.
	const internal = registry as any;
	const emit = (event: object) => internal.applyEvent(entry, event);
	const update = (type: string, contentIndex = 0, extra = {}) =>
		emit({ type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra } });
	const end = (content: object[], stopReason = "stop") =>
		emit({ type: "message_end", message: { role: "assistant", content, stopReason } });
	const thinking = () => (entry.record.activity as any[]).filter((item) => item.kind === "thinking");
	return { registry, entry, internal, emit, update, end, thinking };
}
const theme = { fg: (_color: string, text: string) => text } as any;

test("delta-only streaming updates one item, notifies, and reconciles authoritative completion", () => {
	const h = harness();
	let notifications = 0;
	h.registry.subscribe(() => notifications++);
	h.emit({ type: "message_start", message: { role: "assistant" } });
	h.update("thinking_start");
	h.update("thinking_delta", 0, { delta: "Check " });
	h.update("thinking_delta", 0, { delta: "files" });
	assert.equal(h.thinking()[0].text, "Check files");
	assert.equal(h.thinking()[0].state, "streaming");
	h.update("thinking_end"); // No cumulative content or partial snapshot.
	h.end([
		{ type: "thinking", thinking: "Check files first" },
		{ type: "text", text: "Done" },
	]);
	assert.equal(h.thinking().length, 1);
	assert.equal(h.thinking()[0].text, "Check files first");
	assert.equal(h.thinking()[0].state, "complete");
	assert.equal(h.entry.record.lastReply, "Done");
	assert.equal(h.entry.record.usage.turns, 1);
	assert.equal(notifications, 6);
});

test("completion-only output and multiple indices/messages/children remain separate", () => {
	const h = harness();
	const other = harness();
	h.update("thinking_delta", 0, { delta: "first" });
	h.update("thinking_delta", 2, { delta: "second" });
	other.update("thinking_delta", 0, { delta: "other child" });
	h.end([
		{ type: "thinking", thinking: "first" },
		{ type: "text", text: "answer" },
		{ type: "thinking", thinking: "second" },
	]);
	h.emit({ type: "message_start", message: { role: "assistant" } });
	h.end([{ type: "thinking", thinking: "next message" }]);
	assert.deepEqual(
		h.thinking().map((item) => item.text),
		["first", "second", "next message"],
	);
	assert.equal(other.thinking()[0].text, "other child");
	assert.equal(h.entry.record.lastReply, "answer");
});

test("an optional thinking_end snapshot replaces accumulated deltas", () => {
	const h = harness();
	h.update("thinking_delta", 0, { delta: "partial" });
	h.update("thinking_end", 0, { content: "complete" });
	assert.equal(h.thinking()[0].text, "complete");
	assert.equal(h.thinking()[0].state, "complete");
});

test("abort preserves partial text and late message_end reconciles the same item", async () => {
	const h = harness();
	h.entry.child.runTurn = async () => {
		h.update("thinking_delta", 0, { delta: "unfinished" });
		throw new Error("Subagent turn aborted");
	};
	await h.internal.runTurn(h.entry, "task", undefined);
	assert.equal(h.thinking()[0].text, "unfinished");
	assert.equal(h.thinking()[0].state, "incomplete");
	h.end([{ type: "thinking", thinking: "unfinished" }], "aborted");
	assert.equal(h.thinking().length, 1);
	assert.equal(h.thinking()[0].state, "incomplete");
	h.entry.child.runTurn = async () => {
		h.update("thinking_delta", 0, { delta: "follow-up" });
		h.end([{ type: "thinking", thinking: "follow-up" }]);
	};
	await h.internal.runTurn(h.entry, "again", undefined);
	assert.deepEqual(
		h.thinking().map((item) => item.text),
		["unfinished", "follow-up"],
	);
});

test("settlement or a new message marks abandoned blocks incomplete", () => {
	for (const boundary of [{ type: "agent_settled" }, { type: "message_start", message: { role: "assistant" } }]) {
		const h = harness();
		h.update("thinking_delta", 0, { delta: "partial" });
		h.emit(boundary);
		assert.equal(h.thinking()[0].state, "incomplete");
		h.update("thinking_delta", 0, { delta: "fresh" });
		assert.equal(h.thinking().length, 2);
	}
});

test("redaction removes text and signatures never enter activity or rendering", () => {
	const h = harness();
	h.update("thinking_delta", 0, { delta: "remove me" });
	h.end([{ type: "thinking", thinking: "opaque", redacted: true, thinkingSignature: "SECRET" }]);
	assert.equal(h.thinking()[0].text, "");
	assert.match(formatActivityItem(h.thinking()[0], theme, 0), /redacted by provider/);
	assert.doesNotMatch(JSON.stringify(h.entry.record), /SECRET|opaque|remove me/);
	h.end([{ type: "thinking", thinking: "", thinkingSignature: "OTHER_SECRET" }]);
	assert.match(formatActivityItem(h.thinking()[1], theme, 0), /no reasoning text provided/);
	assert.doesNotMatch(JSON.stringify(h.entry.record), /OTHER_SECRET/);
});

test("retained text and collapsed previews are bounded; final snapshots can correct truncation", () => {
	const h = harness();
	h.update("thinking_delta", 0, { delta: "x".repeat(40_000) });
	h.update("thinking_delta", 0, { delta: "more" });
	assert.equal(h.thinking()[0].text.length, 32_000);
	assert.equal(h.thinking()[0].truncated, true);
	assert.match(formatActivityItem(h.thinking()[0], theme, 0), /\[truncated\]/);
	assert.ok(formatActivityItem(h.thinking()[0], theme, 3).length < 300);
	h.end([{ type: "thinking", thinking: "corrected" }]);
	assert.equal(h.thinking()[0].truncated, false);
	assert.equal(formatActivityItem(h.thinking()[0], theme, 0), "Thinking: corrected");
});

test("activity remains capped across long conversations, including thinking-disabled replies", () => {
	const h = harness();
	for (let i = 0; i < 510; i++) h.end([{ type: "thinking", thinking: String(i) }]);
	assert.equal(h.entry.record.activity.length, 500);
	assert.equal(h.thinking()[0].text, "10");
	h.end([{ type: "text", text: "plain answer" }]);
	assert.equal(h.entry.record.activity.length, 500);
	assert.equal(h.entry.record.lastReply, "plain answer");
});

test("error or aborted final messages preserve streamed text when content is empty or absent", () => {
	for (const stopReason of ["error", "aborted"]) {
		for (const content of [[], [{ type: "thinking", thinking: "" }]]) {
			const h = harness();
			h.update("thinking_delta", 0, { delta: "partial before failure" });
			h.end(content, stopReason);
			assert.equal(h.thinking()[0].text, "partial before failure");
			assert.equal(h.thinking()[0].state, "incomplete");
		}
	}
});
