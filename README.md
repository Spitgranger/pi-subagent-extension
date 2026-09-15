# Subagents

Persistent, addressable delegates for [pi](https://pi.dev).

A subagent is a long-lived `pi --mode rpc` child process with its own context
window and its own system prompt, loaded from a markdown file you write. Because
the child stays alive between turns, the main agent holds a *conversation* with
it rather than firing one task and throwing away everything the subagent learned.

This document is written for both humans and agents. Agents: the tool schemas in
[Tool reference](#tool-reference) and the invariants in [Design](#design) are
normative — prefer them over guessing from behavior.

---

## Table of contents

- [What this gives you](#what-this-gives-you)
- [Install](#install)
- [Quick start](#quick-start)
- [Agent definitions](#agent-definitions)
- [Tool reference](#tool-reference)
- [`@name` in the editor](#name-in-the-editor)
- [The viewer](#the-viewer)
- [Design](#design)
  - [Why a separate process](#why-a-separate-process)
  - [Why RPC mode and not one-shot](#why-rpc-mode-and-not-one-shot)
  - [Why an overlay and not tmux](#why-an-overlay-and-not-tmux)
  - [Architecture](#architecture)
  - [Package layout](#package-layout)
  - [Lifecycle of one subagent](#lifecycle-of-one-subagent)
  - [How activity reaches the screen](#how-activity-reaches-the-screen)
  - [Invariants](#invariants)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Limits and known gaps](#limits-and-known-gaps)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## What this gives you

| Capability | How it shows up |
|---|---|
| Delegation with a clean context window | `subagent_start` — the child shares nothing with the parent transcript |
| Back-and-forth with a delegate | `subagent_send` against a returned handle; the child keeps its earlier turns |
| Parallel work | Several `subagent_start` calls in one assistant message; the tool is `executionMode: "parallel"` |
| Naming an agent in a prompt | `@scout` completion in the editor, above the usual file completions |
| Watching work happen | Inline stream in the transcript, plus a full-screen viewer on `alt+s` |
| Cost visibility | Per-subagent turns, tokens, cache reads/writes, dollar cost, context size |

Three sample agents ship with it: `scout` (fast recon), `planner` (implementation
plans), `reviewer` (correctness review with a required failure case per finding).

---

## Install

```bash
pi install git:github.com/Spitgranger/pi-subagent-extension
```

Pin a ref for reproducible installs, and add `-l` to install into the current
project (`.pi/settings.json`) instead of your user settings:

```bash
pi install git:github.com/Spitgranger/pi-subagent-extension@v0.1.0
pi install git:github.com/Spitgranger/pi-subagent-extension -l
```

Other sources work too — a local checkout, or npm if you publish it:

```bash
pi install ~/Documents/Projects/pi-subagents      # local path, no copy
pi install npm:pi-subagents@0.1.0
```

To try it for one session without installing, use `-e`:

```bash
pi -e git:github.com/Spitgranger/pi-subagent-extension
```

Manage it with `pi list`, `pi update --extensions`, and `pi remove
git:github.com/Spitgranger/pi-subagent-extension`.

> Only one copy may be loaded at a time. If you also have a hand-placed copy in
> `~/.pi/agent/extensions/`, remove it first — pi refuses to load the second
> one with `Tool "subagent_start" conflicts with ...`.

## Quick start

Nothing else to set up: the package ships `scout`, `planner` and `reviewer`, so
after installing you can go straight to:

```
use @scout to find where model selection happens
```

The main agent starts `scout#1`, streams its tool calls into the transcript, and
reports back. Follow up with:

```
ask scout whether any of that is provider-specific
```

which routes through `subagent_send` to the *same* child — `scout#1` still
remembers what it found.

Press `alt+s` at any time to watch running subagents full-screen.

---

## Agent definitions

A markdown file with YAML frontmatter. The body is the system prompt.

```markdown
---
name: reviewer
description: Reviews a change for correctness bugs
tools: read, grep, find, ls, bash
model: claude-sonnet-5
thinking: medium
---

You review code for defects. You do not rewrite it.

For every finding you must supply a concrete failure scenario...
```

### Frontmatter fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | no | string | Agent name used in tools and `@name`. Defaults to the filename without `.md`. |
| `description` | **yes** | string | One line. Shown in `@` completion and given to the main agent so it knows when to delegate. A file without it is skipped. |
| `tools` | no | string or list | Tool allowlist passed as `--tools`. `read, grep` and `[read, grep]` are both accepted. Omit for pi's default tool set. |
| `model` | no | string | Model spec resolved **independently by the child**, so it must be unambiguous across every provider you have configured. Prefer a provider-qualified id, e.g. `openrouter/anthropic/claude-haiku-4.5`. Omit to inherit the parent session's model. |
| `thinking` | no | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Omit to inherit the parent's level when `model` is also omitted. |

**Omitting `model` is usually right,** and all three shipped agents do. The
subagent then follows whatever model and thinking level the parent session is
on, so switching the parent with `ctrl+p` moves its subagents too.

Pin a model only when the agent's job has a genuinely different cost/quality
profile — cheap recon on a small model, say. If you do pin one, qualify it with
the provider. A bare pattern like `claude-haiku` is resolved by the child on its
own and can match a provider you have no key for, which fails the subagent with
`No API key found for <provider>`.

### Locations and precedence

Three sources, in increasing order of precedence:

| Source | Path | Loaded |
|---|---|---|
| bundled | `agents/` inside this package | always |
| user | `~/.agents/agents/*.md` (or `PI_AGENTS_DIR`) | always |
| project | `<repo>/.pi/agents/*.md` | only when a call passes `agentScope: "both"` or `"project"` |

Later sources override earlier ones **by name**. So the supported way to
customize a shipped sample is to copy it into `~/.agents/agents/` and edit it
there — your copy shadows the bundled one and survives `pi update`.

Discovery walks up from the working directory to find the nearest `.pi/agents`.
On a name collision, the project agent wins — a repo can specialize an agent you
already have. Files are re-read on every discovery, so you can edit an agent
mid-session and the next delegation picks it up. A malformed file is skipped
silently rather than taking down the whole directory.

---

## Tool reference

Four tools are registered. All are visible to the main agent; none are invoked
directly by you.

### `subagent_start`

Starts a subagent and runs its opening task. Returns once the first turn settles.
The child stays alive afterwards.

```jsonc
{
  "agent": "scout",              // required — name of the agent definition
  "task": "find the auth code",  // required — opening task
  "cwd": "/path/to/repo",        // optional — defaults to the session cwd
  "agentScope": "user"           // optional — "user" (default) | "project" | "both"
}
```

- `executionMode: "parallel"` — several calls in one assistant message run
  concurrently. There is no separate "parallel mode"; the agent loop provides it.
- Returns text of the form:

  ```
  handle: scout#1
  status: idle

  <the subagent's final reply>
  ```

- Handles are `<agent-name>#<counter>`, unique per session.
- The call **fails** (the runtime marks the tool result as an error) when the
  agent name is unknown, the user declines a project-local agent, or the
  subagent ends in `error` status. A failed subagent's activity log is still
  inspectable in the viewer.
- An unknown agent name returns an error listing the available names.

### `subagent_send`

Sends a follow-up to a running subagent and waits for its reply. The subagent
retains everything from its previous turns.

```jsonc
{
  "handle": "scout#1",                        // required
  "message": "is any of that provider-specific?" // required
}
```

- `executionMode: "parallel"`.
- Errors if the handle is unknown (listing running handles) or if that subagent
  is no longer running.

### `subagent_list`

```jsonc
{}
```

Returns running subagents with handle, status and any error, plus the agent
definitions currently available to start (user scope).

### `subagent_stop`

```jsonc
{ "handle": "scout#1" }
```

Stops the subagent and releases its process. Its transcript remains visible in
the viewer.

### Status values

| Status | Meaning |
|---|---|
| `starting` | Record created, child spawning, first task not yet sent |
| `running` | A turn is in flight |
| `idle` | Turn finished; the child is alive and ready for `subagent_send` |
| `stopped` | Stopped deliberately, by `subagent_stop` or session shutdown |
| `error` | The child died, the provider returned an error, or the turn was aborted |

---

## `@name` in the editor

Typing `@` offers agent names above the usual file completions. Completing one
inserts the literal text `@scout` into your message.

**That reference is a suggestion, not a command.** The main agent is told in its
system prompt what `@name` means and decides whether delegating is worth it:

- "use @scout to find the auth code" → it delegates
- "@scout is wrong about this" → it doesn't

This is deliberate. Routing your message straight to the subagent would take the
main agent out of the loop exactly when you want it coordinating.

pi already uses `@` for file attachments, so this **wraps** the built-in provider
rather than replacing it. Agent matches are listed first; file matches follow
underneath on the same trigger character; insertion math (quoting, trailing
space, cursor placement) is delegated back to the built-in provider so behavior
stays identical. The completion only fires at a token boundary, so `user@host`
and paths containing `@` are left alone.

---

## The viewer

`alt+s`, or `/subagents`.

```
 Subagents   3 total · 1 running
────────────────────────────────────────────────────────────
 ❯ ✓ scout#1     idle     4 turns ↑12k ↓1.2k R8k $0.0071 ctx:13k
   ⏳ planner#2  running  2 turns ↑9k ↓840 $0.0104 ctx:10k
   ■ scout#3     stopped
────────────────────────────────────────────────────────────
 scout#1  /home/you/project
 · task: find where model selection happens
 → grep /resolveModel/ in ~/project
 → read ~/project/src/core/model-resolver.ts:1-120
 Model selection resolves in three stages...
────────────────────────────────────────────────────────────
 ↑/↓ select · PgUp/PgDn scroll · End follow · s stop · Esc close
```

| Key | Action |
|---|---|
| `↑` `↓` | select a subagent |
| `PgUp` `PgDn` | scroll the selected subagent's activity |
| `Home` | jump to the oldest activity |
| `End` | resume following live output |
| `s` | stop the selected subagent |
| `Esc` or `q` | close |

The top pane shows at most 8 subagents and scrolls the selection into view; the
bottom pane gets the remaining terminal height, with a floor of 6 rows. While
scrolled back, a marker shows how many lines are below; `End` returns to
following. Selecting a different subagent also resets to following.

---

## Design

### Why a separate process

A subagent needs its own context window. Running it in-process would mean either
sharing the parent's transcript — which defeats the purpose — or building a
second agent runtime inside the first. A child `pi` process gets isolation for
free, and it gets it at the strongest boundary available: separate memory,
separate provider connection, separate abort handling.

The cost is process startup per subagent, which is why the child is kept alive
rather than respawned per turn.

### Why RPC mode and not one-shot

pi ships an example extension that dispatches subagents as `pi --mode json -p
--no-session`: task in, final text out, process exits. That is a good fit for
fan-out recon, and a bad fit for anything conversational. Once the process is
gone, a follow-up question has to re-establish everything the subagent had just
worked out, in the parent's context window, at the parent's token cost.

`--mode rpc` keeps the child alive and accepts commands on stdin:

- `prompt` starts a turn
- `abort` cancels one
- `agent_settled` on stdout marks the turn complete
- the full session event stream arrives as JSONL on stdout

So `subagent_send` is a second `prompt` to a process that still has its
transcript. The subagent's own context does the remembering, and none of it is
charged to the parent.

RPC framing is stdin/stdout JSONL, not a socket. That matters: pi's unix
transport explicitly refuses to run on Windows, and this never touches it.

### Why an overlay and not tmux

tmux does not exist on Windows, would need a different launcher on each platform,
and puts the subagent's output somewhere pi cannot render, search or theme.

pi's TUI already composites overlays. Using one gives a single code path on
Linux, macOS and Windows, works over ssh, needs nothing installed, and inherits
the active theme. The tradeoff is that the viewer is modal — it takes keyboard
focus while open — which is acceptable for something you open to check on
progress and then close.

### Architecture

```
                  ┌─────────────────────────────────────────┐
  you ── @name ──▶│  pi (parent session)                    │
                  │                                         │
                  │  index.ts                               │
                  │   ├─ tools: start / send / list / stop  │
                  │   ├─ @name autocomplete  ──▶ agents.ts  │
                  │   ├─ system-prompt roster ──▶ agents.ts │
                  │   └─ alt+s / subagents   ──▶ viewer.ts  │
                  │                                         │
                  │  registry.ts  ── records, activity, usage
                  │       │            ▲                    │
                  │       │            │ notify()           │
                  │       ▼            │                    │
                  │  rpc-child.ts ─────┘                    │
                  └───────┬─────────────────────────────────┘
                          │ JSONL over stdin/stdout
                  ┌───────▼─────────┐  ┌─────────────────┐
                  │ pi --mode rpc   │  │ pi --mode rpc   │   …
                  │ scout#1         │  │ planner#2       │
                  │ own context     │  │ own context     │
                  └─────────────────┘  └─────────────────┘
```

### Package layout

```
pi-subagents/
├── package.json              pi manifest: {"pi": {"extensions": ["./extensions"]}}
├── agents/                   bundled sample agents (scout, planner, reviewer)
└── extensions/
    └── subagents/            ONE extension: a directory with an index.ts
        └── *.ts              entry plus its helper modules
```

`extensions/` holds the extension in a **subdirectory**, not as loose files. pi
loads every top-level `.ts` under `extensions/` as its own extension, so flat
helper modules would each be loaded as a broken extension.

The bundled `agents/` directory is resolved from the extension's own location
via `import.meta.url`, so it resolves identically from a git install, an npm
install, or a checkout run in place.

| File | Lines | Responsibility |
|---|---:|---|
| `index.ts` | 421 | Extension entry. Registers the four tools with their renderers, the `@` provider, `/subagents` and `alt+s`, the system-prompt roster, and session lifecycle hooks. |
| `registry.ts` | 296 | The single source of truth. Owns records, the activity log, usage accounting, and the start/send/stop state machine. Notifies subscribers on every change. |
| `rpc-child.ts` | 278 | One child process. Spawn resolution, JSONL framing, request/response correlation, turn settlement, abort and shutdown. |
| `viewer.ts` | 204 | The full-screen overlay. Reads the registry; owns only selection and scroll position. |
| `agents.ts` | 211 | Discovery and frontmatter parsing across the bundled, user and project directories. |
| `format.ts` | 132 | Theme-aware formatting shared by the transcript renderer and the viewer. |
| `autocomplete.ts` | 73 | `@name` provider, stacked on pi's built-in file completion. |

The dependency direction is strict: `viewer` and `index` read `registry`;
`registry` owns `rpc-child`; `format` depends on nothing but types. Nothing
reaches back up.

#### Spawn resolution

The bundled `RpcClient` is not used. Its `start()` hardcodes `spawn("node",
[cliPath])`, which breaks when pi runs as a compiled standalone binary.
`getPiInvocation()` handles three cases in order:

1. `process.argv[1]` exists on disk and is not a bun virtual script → re-run that
   script with `process.execPath` (source checkout under node or bun)
2. `process.execPath` is not a generic `node`/`bun` binary → re-run it directly
   (compiled standalone binary)
3. otherwise → `pi` on `PATH`

### Lifecycle of one subagent

```
subagent_start
  │
  ├─ discoverAgents(cwd, scope)            fresh read from disk
  ├─ project agent + untrusted repo? ──▶ ui.confirm, or abort
  ├─ resolve model/thinking               agent file, else parent session
  ├─ write system prompt to a 0600 temp file
  ├─ registry.start()
  │    ├─ create record (status: starting)
  │    ├─ onCreate(record) ───────────▶ tool can now stream this subagent
  │    ├─ spawn pi --mode rpc --no-session [--model] [--thinking] [--tools]
  │    │                                  [--append-system-prompt <tmpfile>]
  │    └─ runTurn(task)                   status: running
  │         ├─ arm settle waiter          armed *before* sending, so a fast
  │         ├─ send {type:"prompt"}       child cannot settle in the gap
  │         └─ await agent_settled        status: idle
  └─ return { handle, status, lastReply }

subagent_send(handle, message)            repeats runTurn on the same child

subagent_stop | session_shutdown
  ├─ SIGTERM, then SIGKILL after 3s
  ├─ status: stopped
  └─ remove the temp prompt directory
```

Abort (`ctrl+C`) propagates: the tool's `AbortSignal` fires, the child is sent
`abort`, and the turn resolves as `"aborted"` rather than hanging.

### How activity reaches the screen

The child emits pi's full session event stream as JSONL. Two event types are
consumed:

| Event | Effect |
|---|---|
| `tool_execution_start` | Append a `tool` activity item — a tool call appears *as it starts*, not after it finishes |
| `message_end` | Append a `text` item for assistant text; accumulate usage; record `errorMessage` and flip status to `error` |
| `agent_settled` | Release the turn waiter |

Every mutation calls `registry.notify()`, which fans out to two subscribers:

1. the running tool's `onUpdate`, which repaints the inline transcript entry
2. the viewer, which calls `tui.requestRender()`

Both render from the same records through the same `format.ts` helpers, so the
transcript view and the viewer cannot drift apart.

### Invariants

Agents modifying this extension should preserve these:

- **The registry is the only mutable state.** The viewer holds selection and
  scroll offset and nothing else. Anything a renderer needs must be on the record.
- **Settle waiters are armed before the prompt is sent.** Reversing this loses
  turns against a fast child.
- **`waitForSettled` never rejects.** It resolves `"settled" | "aborted"`. An
  earlier version rejected on abort, which stranded an unhandled rejection
  whenever a turn failed before the child ever ran.
- **A dead child releases its waiters.** `fail()` calls `releaseSettledWaiters()`,
  so a crashed process surfaces as an error instead of hanging the tool.
- **Discovery is re-run per call, never cached across turns.** Editing an agent
  file mid-session must take effect.
- **The activity log is capped** at 500 items per subagent, trimmed from the front.
- **Only erasable TypeScript.** pi loads extensions through jiti in strip-only
  mode: no `enum`, `namespace`, parameter properties, or `import =`.
- **Top-level imports only.** No `await import()` or `import("pkg").Type`.

---

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PI_AGENTS_DIR` | `~/.agents/agents` | Directory holding your own agent definitions. A leading `~` is expanded. Does not affect the bundled samples, which always load. |

Everything else is per-call (`agentScope`, `cwd`) or comes from the agent file.

---

## Security model

**A subagent runs with the same permissions as pi itself. There is no sandbox.**
pi has no built-in permission system; it runs as the user and process that
launched it, and so does every child this extension spawns.

An agent definition is not data — it is a prompt that can instruct a model to
read any file and run any command. Treat one you did not write as executable code.

| Scope | Trust posture |
|---|---|
| `~/.agents/agents` | Yours. Loaded by default, no prompt. |
| `.pi/agents` in a repo | Repo-controlled. Only loaded when a call explicitly passes `agentScope: "both"` or `"project"`, and in an untrusted project pi asks for confirmation naming the agent and its file path before running it. |

The system prompt is passed to the child through a `0600` temp file rather than
argv, so it is not visible in the process table. The temp directory is removed
when the subagent stops.

If you need a real boundary, containerize pi — see
`packages/coding-agent/docs/containerization.md` in the pi repo for the Gondolin
micro-VM, plain Docker, and OpenShell patterns.

---

## Limits and known gaps

- **No session persistence.** Children run `--no-session`, so subagents live only
  as long as the parent pi session and are stopped on shutdown. You cannot resume
  a subagent tomorrow.
- **No cross-subagent communication.** Subagents talk to the main agent, not to
  each other. Chaining is the main agent passing one's output into another's task.
- **The viewer is modal.** It takes keyboard focus while open; you cannot type a
  prompt and watch at the same time.
- **Activity is capped** at the most recent 500 items per subagent.
- **Process startup cost** is paid once per subagent, not per turn — that is the
  point of keeping children alive, but a single trivial delegation is still more
  expensive than doing the work inline.
- **Verified end to end.** Start, tool-allowlist enforcement, live streaming,
  follow-up on the same child, usage accounting, error propagation and shutdown
  have been exercised against a local OpenAI-compatible mock, and delegation has
  been confirmed against a real model over OpenRouter. Long multi-turn runs on
  slow free-tier models are correspondingly slow; that is the model, not the
  extension.

---

## Troubleshooting

**`@` shows files but no agents.**
Check `ls ~/.agents/agents/*.md`. A file without a non-empty `description` in its
frontmatter is skipped by design. Agents load on `session_start`, so restart pi
after creating the directory for the first time.

**"Unknown agent" from `subagent_start`.**
The error lists the names actually discovered. A project agent needs
`agentScope: "both"`; ask the main agent to pass it.

**A subagent goes straight to `error`.**
Open `alt+s` and read the status line — the child's stderr is captured and
surfaced there. Most common causes: the model named in the agent file is not
configured for your providers, or `pi` is not resolvable for the spawn (see
[Spawn resolution](#spawn-resolution)).

**The extension does not load at all.**
Run `pi list` — it prints load failures. Check the package is in settings and
that nothing else registers the same tools.

**`Tool "subagent_start" conflicts with ...`.**
Two copies are installed. Most likely an older hand-placed copy in
`~/.pi/agent/extensions/subagents/` alongside the installed package. Delete the
hand-placed one; pi refuses to load the second copy, so the package's version is
the one that goes missing.

---

## Development

The extension is plain TypeScript with no build step — pi loads it through jiti,
and `@earendil-works/*` and `typebox` imports are aliased to pi's own bundled
modules at load time.

**The package declares no dependencies, deliberately.** pi runs `npm install` on
a freshly cloned git package, and npm >= 7 auto-installs `peerDependencies` —
so listing the pi core packages as peers (even with
`peerDependenciesMeta.optional`) pulled a full **277 MB** copy of pi into every
install. Those modules are never resolved from `node_modules` anyway, because
the loader aliases them. pi's own example extension packages (`gondolin`,
`sandbox`) declare none of them either.

Only genuine third-party runtime dependencies belong in `dependencies` here.

Work on it in place without reinstalling:

```bash
pi -e ~/Documents/Projects/pi-subagents
```

To typecheck against pi's real declarations, point a tsconfig at a pi checkout
with dependencies installed (`npm install --ignore-scripts`) and map the aliases:

```jsonc
{
  "extends": "<pi-repo>/tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true, "module": "ESNext", "moduleResolution": "Bundler",
    "paths": {
      "@earendil-works/pi-coding-agent": ["<pi-repo>/packages/coding-agent/src/index.ts"],
      "@earendil-works/pi-tui":          ["<pi-repo>/packages/tui/src/index.ts"],
      "@earendil-works/pi-agent-core":   ["<pi-repo>/packages/agent/src/index.ts"],
      "@earendil-works/pi-ai":           ["<pi-repo>/packages/ai/src/compat.ts"],
      "*": ["<pi-repo>/node_modules/*"]
    }
  },
  "include": ["<this-dir>/*.ts"]
}
```

Unresolved-module errors from inside `<pi-repo>/packages/**` are expected when
the workspace has not been built — generated model data and sibling package
declarations are missing. Only errors pointing at files in this directory matter.

Lint and format with pi's own config; `biome.json` here is that config narrowed
to `*.ts` in this directory:

```bash
<pi-repo>/node_modules/.bin/biome check --write .
```

Quick syntax and erasable-syntax check, which is what jiti actually requires:

```bash
for f in *.ts; do node --experimental-strip-types --check "$f"; done
```
