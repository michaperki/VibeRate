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

> Status: **shipped & live — this is now the product core.** The central fork was
> resolved (**Fork A**, spawn the real `claude` binary) and the PoC, token streaming,
> and inline `ask` picker all shipped. The "THE FORK" section below is kept as the
> decision record, not an open question.

> ### Post-pivot triage (2026-06-21)
> Drive went from "the proposed write half" to **the thing VibeRate is**
> (`PRODUCT_STRATEGY.md`). Re-reading the remaining phases against the now-priorities:
> - **Promote — ownership lease + single-writer + read-only fallback** (under
>   "Approvals + interrupt" below). The load-bearing piece of the
>   **fleet/session-management** priority (`PRODUCT_STRATEGY.md` #2). *Partly mitigated
>   today:* `agent.js` only resumes sessions **we** started (`sessions` Map, in-process),
>   so the two-writer race "can't happen yet" — the gap is **adopting/driving foreign
>   sessions** (a session started in a terminal, or by another instance), which the
>   cross-device index (`a4c1e40`, `f32dd6f`) now makes reachable. So this is lower
>   urgency than it reads until foreign-session adoption is turned on, but it gates it.
> - **Finish — surface `apiKeySource`** (from "Pitfalls"). *Half done, code-verified:*
>   `childEnv` already **strips a stale `ANTHROPIC_API_KEY`/`AUTH_TOKEN` when on the
>   subscription** (`agent.js:230`). The remaining slice is just **forwarding
>   `apiKeySource` from the `system/init` event to the UI** so the operator can see
>   which auth won — tiny, sits on the **onboarding** path (`ONBOARDING.md`).
> - **Defer — dual-provider (Codex) unified event model.** Claude-first is the daily
>   driver and reuses the JSONL pipeline; nothing in the now-cluster needs Codex.
>   Park it until a second provider is actually demanded.
> - **Approvals UX** stays important (the control plane is RCE) but is **single-tenant
>   today** — Mike is the only driver, admin-gated. It moves to genuinely-blocking only
>   when onboarding opens Drive to non-operators; track the real-multi-user pieces under
>   "Hosted control" and `ONBOARDING.md`.

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
- **Inherited `ANTHROPIC_API_KEY` shadows the real login.** `agent.js` spawns with
  `env: process.env` to pick up local auth — but if a stale/invalid
  `ANTHROPIC_API_KEY` is exported in the shell, it wins over the subscription
  `~/.claude/.credentials.json` and every turn dies with a 401 (`apiKeySource:
  ANTHROPIC_API_KEY` in `system/init`). Confirmed in Mike's own WSL shell. The
  gateway should surface `apiKeySource` (the init event already reports it) and/or
  strip a broken key, or Fork A silently fails to use the auth it's built around.

## Phasing (rough, validated against Codex's estimates)

- [x] **Local PoC:** localhost-only chat, Claude-first, Fork A, start/resume idle
      sessions, stream assistant text. No approvals, no relay. Shipped as
      `src/agent.js` (spawns the real `claude` binary, one turn per message,
      resume-by-id) and `src/agentRoutes.js` (`/api/agent/*` + SSE, guarded —
      loopback locally, admin-allowlisted hosted). The chat UI began as a
      standalone `public/drive.html`; it has since been **folded into the
      dashboard SPA** (`public/app.js`, the `✦ Drive` entry in a project) so a
      driven session lives in the same surface as the convos reader — the
      standalone page is gone. Turn model is one short-lived process per message resuming by session
      id — matches "resume an idle session by ID" and keeps a real process handle
      for ground-truth liveness.
- [x] **Token streaming.** `--include-partial-messages` per turn; `agent.js`
      streams `stream_event` text/thinking deltas as `assistant_text_delta` /
      `thinking_delta` and skips the consolidated `assistant` blocks it already
      streamed (flagged per-turn), so the reader fills in live without
      double-rendering. Falls back to whole-message text if partials are absent.
- [x] **Capture & present the agent's questions** (the delightful part). SHIPPED
      as B2: a custom MCP `ask` tool. `src/mcpAsk.js` is a hand-rolled stdio MCP
      server (no SDK dep) exposing one `ask` tool mirroring AskUserQuestion's
      schema; `agent.js` writes a per-turn `--mcp-config` pointing claude at it,
      steers via `--append-system-prompt`, and — the load-bearing finding —
      **allowlists it with `--allowedTools mcp__viberate__ask`** (MCP tools are
      otherwise permission-denied headless in `default` mode). On a call the
      sidecar POSTs to `/api/agent/internal/ask` (loopback); the server parks it,
      emits an `ask` SSE event (Drive UI renders a picker), and the UI replies via
      `/api/agent/sessions/:id/answer` → same-turn continuation. `MCP_TOOL_TIMEOUT`
      (10m) > server `ASK_WAIT_MS` (5m) so a graceful "no answer" result wins over
      a hard MCP timeout. Verified end-to-end in `default` mode: answered path
      (`SELECTED=Spaces`, 7.4s) and ignored path (timeout → agent proceeds).
      Full per-tool *approvals* remain backlogged. Original spike notes:
      - `AskUserQuestion` is available headless and emits a clean structured
        `tool_use`: `input.questions[]` = `{question, header, multiSelect,
        options:[{label, description}]}`. So we can render a real choice card.
      - **The built-in `AskUserQuestion` is TUI-only headless (confirmed).** It
        auto-denies (`tool_result {content:"Answer questions?", is_error:true}`,
        `permission_denials`) **even with stdin held open**, and emits **no
        `can_use_tool` control_request**. So answering it inline over the control
        protocol on the real `claude -p` binary is impossible. (The control
        protocol — `control_request`/`control_response`, subtypes `can_use_tool`,
        `interrupt`, `set_permission_mode`, `apply_flag_settings` — is for
        approvals/steering, backlogged.)
      - **DECISION (Mike, 2026-06-19): B2 — true inline picker, via a custom MCP
        `ask` tool** (the only route that works on the real binary). Run a local
        MCP server VibeRate owns; steer the driven agent (appendSystemPrompt /
        output style) to call `mcp__viberate__ask` instead of the built-in. An MCP
        tool_use blocks until the server returns, so the server fans the question
        to the Drive UI, awaits the click, and returns the chosen option as the
        tool_result — agent continues same-turn, no denial, Fork A intact.
        **CAVEAT to verify first:** MCP tool-call timeout must be generous enough
        for a human to answer. (Capture-only rendering of the built-in card works
        today; plain end-of-turn text questions already round-trip via resume.)
- [ ] **Ownership lease + single-writer + read-only fallback** *(fleet enabler — needed
      before foreign-session adoption).* Today we only resume sessions we started, so the
      race can't occur yet; the lease is what makes it safe to **adopt a session we
      didn't start** (terminal-driven, or another instance via the cross-device index).
      A resume racing a live writer must drop to read-only, not fork the JSONL.
- [ ] **Approvals + interrupt** on the owned session. *(Important but single-tenant
      today — Mike is the only admin-gated driver. Becomes blocking when onboarding
      opens Drive to non-operators; see `ONBOARDING.md`.)*
  - The composer's **"Stop turn"** is the interrupt control. On mobile it sits a
    thumb-width from **Send**, and stopping kills the agent's in-flight work — so the
    button is **two-tap armed**: first tap flips it to a red "Tap to confirm," a second
    tap within ~4s actually posts `/stop`; it auto-disarms on timeout and when the turn
    settles. (`driveStopClick` in `public/app.js`; first verified live from the
    TestFlight build, 2026-06-23.)
- [ ] ~~**Dual-provider** unified event model~~ *(deferred post-pivot — Claude-first;
      no now-cluster item needs Codex. Normalizing app-server JSON-RPC + CLI
      stream-json into one schema waits until a second provider is demanded.)*
- [ ] **Hosted control** (weeks): authenticated command queue, nonces/idempotency,
      ownership leases, audit log + revocation, device-vs-view credential split.

The reframe that matters: this is **not "watcher with an input box."** It is a
**local VibeRate agent runtime, with `watch` as its read-only mode.**
