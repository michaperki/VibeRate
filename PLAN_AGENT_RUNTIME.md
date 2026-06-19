---
status: active
---

# VibeRate as a local agent runtime — the "drive" half

Working spec for the move from **read-only watcher** to **local agent runtime**:
a chat box in the dashboard where Mike types to the agent *through* VibeRate
instead of the terminal. Canonical frame: `PRODUCT_STRATEGY.md` and `ROADMAP.md`
(VibeRate is the Agentic IDE loop **capture → understand → drive**). This doc is
the *drive* surface. Adjacent live-mode work: `LIVE_ORCHESTRATION.md`. Current
pipeline shape: `ARCHITECTURE.md`.

> Status: **open spec** — the central fork below is undecided. Mock both before
> committing (see `PROJECT_VIEW_PLAN.md` for the house decision style: build the
> forks, let Mike choose; don't pick unilaterally).

## Where this came from

A Codex research pass argued VibeRate could host the box where prompts are typed.
Validated against the Claude Agent SDK, the Claude Code CLI, the Codex app-server,
and our own watcher code (`src/discover.js`, `src/push.js`). Verdict: **feasible,
and Codex is fundamentally right** — with corrections that matter for *us*
specifically.

## The load-bearing constraint (confirmed, both providers)

There is **no supported way to inject input into an arbitrary interactive terminal
process VibeRate did not launch.** Neither Claude Code nor Codex exposes an IPC
channel into a live TUI. To drive an agent you must either:

1. **Own the process from the start** (full chat, streaming, approvals, steering), or
2. **Resume an *idle* session by ID** — at which point VibeRate becomes its new
   controller.

A session actively driven by a terminal stays **read-only** in VibeRate. So *this*
session could later be resumed in a VibeRate chat box — but VibeRate cannot take it
over while the terminal still holds it. Everything else follows from this.

## Today's pipeline is strictly read-only (grounded)

`src/discover.js` tails JSONL from `~/.claude` + `~/.codex`; `src/push.js` redacts
and uploads. One direction: tail → parse → redact → upload. Chat genuinely inverts
this into a local control plane. Codex did not overstate it.

```
read-only (today):   agent logs/hooks → watcher → hosted UI
drive (proposed):    UI → local agent gateway → owned CLI/app-server → streamed events → UI
```

## THE FORK (decide by mocking both)

The choice that determines everything downstream is **what the gateway spawns**:

- **Fork A — spawn the user's *real* installed binary** (`claude -p --input-format
  stream-json --output-format stream-json --resume <id>`; the `codex` binary /
  app-server). Full fidelity: same `settings.json`, hooks, skills, slash commands,
  MCP, output styles, and **local auth**. Output lands in the *same JSONL the watcher
  already tails*, so chat flows back through the existing parse/redact/render
  pipeline for free, and we get **ground-truth liveness** (a real process handle)
  instead of the TTL inference live mode uses today (`LIVE_ORCHESTRATION.md`).
- **Fork B — drive via the Agent SDK / app-server adapter.** Cleaner, typed
  protocol (threads/turns/steer/interrupt). But the Agent SDK is a *reimplementation*
  of the agent loop — a session that *looks* like Claude Code in the transcript but
  lacks the user's real CLI environment unless re-replicated, and reintroduces the
  Anthropic auth/distribution constraint Fork A sidesteps.

**Recommendation: Fork A**, for VibeRate's "show my *real* sessions" thesis. This is
the main correction to Codex, which treated SDK and real-binary as interchangeable.
Provider order (Codex-first vs Claude-first) is a genuine judgment call — Claude-first
validates against Mike's daily driver and reuses the JSONL pipeline immediately.

## Pitfalls the build must handle

- **Two-writer race.** Per-session JSONL is append-only (no corruption), but a resume
  racing a live TUI yields **divergent continuations**. Single-writer must be enforced
  on *our* side — neither CLI enforces it. Ownership lease is mandatory, not optional.
- **Control plane = RCE.** Prompts cause shell + file ops, so a compromised control
  endpoint is remote code execution on the dev machine. Categorically different threat
  model from today's redacted read-only uploads. **Local-only first; never start with
  the hosted relay.** Separate device/control credentials from share/view credentials
  when it eventually goes hosted.
- **Approvals are the real surface area.** The chat box is trivial; the permission /
  approval UX (showing exact commands before they run) is the project.

## Phasing (rough, validated against Codex's estimates)

- [x] **Local PoC:** localhost-only chat, Claude-first, Fork A, start/resume idle
      sessions, stream assistant text. No approvals, no relay. Shipped as
      `src/agent.js` (spawns the real `claude` binary, one turn per message,
      resume-by-id), `src/agentRoutes.js` (`/api/agent/*` + SSE, mounted only when
      `!HOSTED` and loopback-guarded), and `public/drive.html` (the `/drive` chat
      UI). Turn model is one short-lived process per message resuming by session
      id — matches "resume an idle session by ID" and keeps a real process handle
      for ground-truth liveness. Streaming partial tokens into the reader is the
      obvious next polish; turn-level assistant text lands today.
- [ ] **Approvals + interrupt** on the owned session; ownership lease + read-only
      fallback for terminal-driven sessions.
- [ ] **Dual-provider** unified event model (the likeliest schedule overrun —
      normalizing app-server JSON-RPC and CLI stream-json into one schema, plus
      reconnect/process recovery).
- [ ] **Hosted control** (weeks): authenticated command queue, nonces/idempotency,
      ownership leases, audit log + revocation, device-vs-view credential split.

The reframe that matters: this is **not "watcher with an input box."** It is a
**local VibeRate agent runtime, with `watch` as its read-only mode.**
