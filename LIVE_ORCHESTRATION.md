# Live Orchestration & Timeline Legibility

Working notes + plan for a pass on how the dashboard's moving parts behave **while
an agent is working live**, and on two timeline/graph legibility bugs. Findings are
grounded in the code (file:line), not assumptions. Status updated as each lands.

Frame: the core product is the Agentic IDE loop (capture → understand → drive). This
pass is about the *understand/drive* surface feeling real-time and coherent — one
logical event (a file write, a brain edit, an artifact, a new message) should read
as one concerted update across the rail, the timeline, the brain, and the new ticker,
within a couple of seconds rather than 10–15.

## 1. Live-watch latency — the "plan file shows up late" problem ✅

Three serial delays were stacked:

- **Debounce never settles during active work** — `bin/vbrt.js` `cmdWatch`. The
  watcher tick was every 2s but only pushed after `DEBOUNCE = 1500`ms of *zero* file
  changes. The watch signature (`watchSignature`) includes the session `.jsonl`
  mtime+size, which an agent appends to continuously in YOLO / skip-permissions mode
  — so the quiet window never opened and nothing pushed until the agent *paused*.
  That's why `plan.md` (written early) only appeared after implementation finished.
- **Frontend poll 4s** — `public/app.js` `startLive()` (`setInterval(pollLive, 4000)`).
- **`refreshLive` ran ~6 sequential `await`s** — project → activity → prompts → git →
  dochistory → docs, one after another.

Fix: debounce-with-maxWait (throttle hybrid) in `cmdWatch` — keep the settle window
but force a push once changes have been pending longer than `MAX_WAIT` (~3s) even if
the log is still growing; tighten tick to ~1s. Frontend poll → 2s; `refreshLive`
fetches run in parallel (`Promise.all`). No added agent load — capture is still just
read-only stat polling of the session log.

## 2. Agent activity ticker (granular monitoring) ✅

A subtle ticker under the brain showing what the agent is "chewing on" (reading
`maze.py`, editing `plan.md`, running `pytest`). Feasible with **no agent overhead**:
the watcher already tails the session `.jsonl`, and `parseClaude`/`parseCodex` already
emit `tool_use` blocks with `name` + `input` — they were just being dropped for the
dashboard (only user-message timestamps survive into `getActivity`).

Implementation: `getTicker(slug)` in `storage.js` returns the last N `tool_use`
actions (name → category, file, ts) from the most-recently-active session; endpoint
`GET /api/projects/:slug/ticker`; the dashboard polls it in live mode and renders a
one-line marquee under the brain card. Depends on #1 for the data to actually be
fresh.

## 3. Timeline — convo bars vs. message bars ✅

`renderRibbon` (`public/app.js`) drew two lanes from different geometry:

- **messages** lane bins every user message by its real timestamp across the span.
- **convos** lane drew each session as a **fixed-pixel bar whose width = message
  count** (`wpx`, 4–64px), positioned only at `pct(s.start)`.

So a convo's bar was a stub at its *start*, while that same convo's messages were
scattered to its right → message bars sitting where no convo bar exists. The width
encoded *count*, not *time*.

Fix: draw each convo block spanning `pct(s.start) → pct(s.end)` (real duration; both
already exist in `timelineSessions`), with a sensible minimum width, and move the
message-count signal to opacity/intensity. Now a convo bar covers the time its
messages actually occupy.

## 4. "Agent thinking" → "End of conversation" premature flip ✅

`endState(messages)` looked at only the **last message's kind**: ending on assistant
*text* → "■ End of conversation". A working agent narrates between tool batches, so a
snapshot landing right after such a text block declared the convo over even though
tools resumed next snapshot — the indicator yo-yoed.

Fix: pass liveness into `endState`. When the project is `streaming` (server's 3-min
push window, already returned by `/api/projects/:slug`) or `state.live`, an
assistant-text ending reads "Agent working…" instead of a definitive end; the
definitive end only shows once pushes stop.

## 5. Orchestration — one event, one concerted update ✅

Each live event refreshed its own widget in isolation with per-surface "fresh"
highlights (`_liveFreshConvos`, `_liveFreshPrompts`, `_liveFreshCommits`, brain
`live-glow`). A single new message independently flashed the rail, the timeline, and
maybe grew the brain — uncoordinated. Pass: a single `liveEventDigest` computed once
per snapshot describing what changed (new prompts / commits / brain docs / files /
artifacts), so every surface acknowledges the *same* event in concert, plus a small
"what just happened" pulse on the Activity header. Builds on #1 (events have to arrive
in real time for coordination to matter).

## 7. Real-time agent monitoring via Claude Code hooks ✅

The watcher already pushes disk artifacts (files, brain docs, git) in ~1–3s, but the
**conversation/ticker** lives only in Claude Code's session `.jsonl`, which CC flushes
in chunks — so "what is the agent doing/saying" lagged ~20–30s. We can't change CC's
flush, but **hooks** fire on each event, in the harness, at zero model/token cost.

Pipeline:
- `vbrt hooks --install` merges `PreToolUse` / `PostToolUse` / `UserPromptSubmit` /
  `Stop` / `SessionStart` hooks into `.claude/settings.json`, each running `vbrt hook`.
- `vbrt hook` (`src/hooks.js`) reads the hook payload on stdin and appends a compact
  event to `.vbrt/stream.jsonl` — tool start/end (name → cat/verb/target), prompt,
  idle — plus a best-effort context/token reading from the transcript tail. Always
  exits 0; a hook must never break the agent's turn. The sidecar self-trims.
- `vbrt watch` fingerprints `.vbrt/stream.jsonl` (so a hook append triggers a push) and
  ships the tail in the bundle (`buildBundle` → `stream`); the server persists it
  (`saveStream` → `stream.json`).
- `getTicker` prefers the stored stream: it returns `live { state: working|idle,
  action, ctx, ctxPct, model }` + recent completed actions; falls back to parsing the
  (lagged) session log when no stream is present.
- The ticker UI renders a **status-line-style** readout: a working/idle pulse, the
  current action, a recent-action trail, and a context gauge.

**What this gets us** (the honest scope): an accurate *working / idle* state, the
current action, and a context/token gauge that updates **per agent event** — close to
the CC status line. **Not** achievable: a smooth per-*token* counter mid-response
(hooks are event-driven, not token deltas) or the CC spinner's gerunds ("Pondering…",
which are internal UI). Codex writes its log per event already, so it needs no hook.

## 6. Brain "Web" view clustering ✅

Specific to `layoutGraph` (Web only; Tree/Recent have their own axes). After the force
sim, the fit step computed a **uniform** fit scale then capped anisotropy at
`base * 1.6`. On a wide card the tighter axis is height, so horizontal scale was
capped at 1.6× the height-fit — leaving wide margins with nodes bunched mid-canvas.

Fix: spread more in the sim (stronger repulsion / longer edge rest length scaled to
canvas) and relax the fit so each axis fills its extent with a higher anisotropy
allowance, while still clamping into frame. Result: the web encompasses the available
width instead of clustering center.
