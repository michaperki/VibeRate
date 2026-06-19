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

## 8. `vbrt watch` terminal output → live TUI ✅ (first pass shipped 2026-06-18)

> **Shipped:** `vbrt watch --tui` — a dependency-free ANSI dashboard: header (repo · URL ·
> uptime · hooks-live), one boxed panel **per agent** (status pulse working/paused/idle ·
> current action · context bar `57% · 115k tok · opus-4-8`), and a footer (last push · outbox
> · Ctrl-C). Alt-screen buffer with guaranteed cursor/teardown restore on exit. Hook events
> now carry `sid` (`src/hooks.js`) so the repo's merged stream groups back into per-agent
> panels; events without `sid` fold into one panel. **Now the default:** `vbrt watch`
> launches the TUI on an interactive terminal; `vbrt watch --log` (alias `--no-tui`) forces
> the plain scrolling push log, and we fall back to it automatically when stdout is
> piped/redirected (agents, CI, `| tee`) so logs still capture cleanly. **Deferred (as
> planned):** Codex log-tail fallback (CC-only for now — no hooks stream from Codex).
> Verified against a synthetic two-agent stream (working + idle, different models/contexts),
> borders measured to terminal width, and both the TTY-default and piped-fallback paths.

### 8a. Stale panels: liveness can't be detected, so we show + let the user dismiss (2026-06-18)

**Problem.** Status was inferred purely from event recency over the last 200 stream lines,
with no notion of a session being *gone*. `.vbrt/stream.jsonl` is a persistent file, so on a
fresh `vbrt watch` after a reboot, prior sessions still render as panels. The killer: a
**hard exit fires no hook** — Ctrl-C, terminal close, and computer restart all bypass `Stop`
*and* `SessionEnd` (SIGINT/SIGHUP/SIGKILL give no chance to write). So a session killed
mid-tool keeps its last event as a `tool` and is pinned at `paused` forever — indistinguishable
from a dead session. Same root cause as the web ticker (`getTicker`, `src/storage.js`):
`state = last.ev === 'idle' ? 'idle' : 'working'` with **no age check**, so a dead session
reads "working/thinking…" indefinitely.

**Why not a timeout.** A fixed staleness cutoff is wrong: a live session can sit idle for a
long time between prompts without being dead. There is **no reliable liveness signal** — we
can't get Claude's PID from a shell-wrapped hook, and CC doesn't pass one. So we don't guess.

**What shipped instead** (`bin/vbrt.js`):
- **Last-move time per panel** — `[n] claude · 10998f  ◐ paused · 1h30m ago`. The relative
  inactivity (`ago(now - a.last)`) is the signal the user reads to spot a frozen/dead session.
- **Manual dismissal** — raw-mode stdin; number keys `1–9` hide the matching panel. Persisted
  to `.vbrt/watch-dismissed.json` as `{ sid: dismissedAtMs }` (pruned after 7 days). A dismissed
  session that emits a **newer** event auto-resurrects, so clearing a still-alive session
  self-corrects. (Raw mode swallows the auto-SIGINT, so `\x03`/`q` are handled by hand.)
- **`SessionEnd` hook wired** (`src/hooks.js` → `ev: 'end'`; installed in `hookSettings`) —
  marks a **graceful** close, and `visibleAgents` auto-hides ended panels. This only covers
  `/exit`/clear; hard kills still rely on manual dismissal above.

**Applied everywhere (2026-06-18).** Same staleness reasoning now in the **web** ticker
(`getTicker`, `src/storage.js`: `WORKING_TTL_MS` = 2 min; handles `end`; emits `stale` + `ts`)
and the viewer's `endState` end-marker (`public/app.js`: `LIVE_WORKING_TTL_MS` = 3 min, more
generous for transcript flush lag). The web ticker shows `working` / `no activity · last move
Nm ago` / `session closed` instead of a frozen "working". Codified as a principle in
ARCHITECTURE.md ("Liveness is inferred, never asserted").

**Still open (deferred):** a `/proc` open-fd liveness probe was considered but not built
(unconfirmed whether CC holds the transcript fd open while idle).


**The gap.** The terminal running `vbrt watch` is the *one* surface that doesn't show
the live agent activity — it shows a scrolling push log and nothing else:

```
👁  Watching … → https://vbrt.fly.dev  (16 session(s) + brain docs + git · Ctrl-C)
  ↑ 4:57:20 PM — pushed 0 session(s) [delta] → …/p/kedJW_GdLCGx
  ↑ 4:58:23 PM — pushed 0 session(s) [delta] → …/p/kedJW_GdLCGx
```

`cmdWatch` (`bin/vbrt.js:223`) just `console.log`s one dim line per push. Meanwhile the
*dashboard* renders a rich ticker (status, current action, context gauge) from data the
watcher is already shipping. So the person at the terminal sees the least.

**The key finding: the data already exists locally; this is a presentation layer, not a
capture project.** `.vbrt/stream.jsonl` (written by the CC hooks at **zero token cost**,
`src/hooks.js`) already carries per-event, in real time:
- `ev`: `prompt` | `tool` | `idle` | `start` | `note` → maps to a **status** (working/idle).
- `cat` + `verb` + `target` → the **current action** ("editing src/prompts.js", "running
  npm test", "searching renderOutcomeRail").
- `ctx`, `ctxPct`, `model`, `output` → a **context/token gauge** (window fill, not spend).

`readStream(cwd, n)` already reads it; `streamSignature` already fingerprints it. A TUI is
a render loop over `readStream()` + `discoverSessions()` on the existing ~1s tick — no new
capture, no new agent overhead, no server round-trip.

**Proposed v1 (dependency-free ANSI redraw — matches the pure-Node ethos; no `ink`/`blessed`):**
- Header: repo · dashboard URL · watch uptime.
- A panel per active agent/session: agent badge (claude/codex) · status pulse
  (working/idle) · current action (verb + target) · context bar (`84k / 200k · 42%`) ·
  model.
- Footer: last push (time · full/delta · N sessions) · outbox queued · `Ctrl-C to stop`.

**Honest unknowns / prerequisites (so this doesn't get mis-scoped):**
1. **Per-agent boxes need session attribution first.** `stream.jsonl` is today a single
   *merged* stream with **no session id on events** — CC hook payloads carry `session_id`,
   but `eventFromPayload` (`src/hooks.js:95`) drops it. To draw a box *per agent* we add an
   `sid` field and group by it. Without that we get one aggregate "current activity" panel,
   not per-agent boxes. (Small, well-contained change.)
2. **Codex emits no hook stream** (it logs per event, no hooks). Codex agents would be
   absent from a hook-only TUI unless we also derive their status from the session-log tail
   — the same fallback `getTicker` already does. v1 could be CC-only and say so.
3. **Hooks must be installed** (`vbrt hooks --install`) for the rich stream; without it the
   TUI degrades to the ~20–30s-lagged log tail. The TUI should detect "no hooks" and nudge.
4. **Full-screen TUI vs. the scrolling log.** A redraw (alt-buffer) replaces the push-log
   history some people want. → ship as **`vbrt watch --tui`** opt-in first (keep the current
   line log as default), promote to default once it's proven. Needs resize handling + a
   clean teardown that restores the terminal on Ctrl-C alongside the existing lock cleanup.
5. **"Token count" is context-window fill, not dollar spend.** We have per-step `output`
   tokens and `ctx`/`ctxPct`; we do **not** have cumulative cost without a pricing table.
   Label it honestly ("ctx 42%", "out 1.2k tok"), don't imply a running bill.

**Why it's worth doing:** highest "wow per hour" on the live-orchestration surface because
the hard part (real-time, zero-cost capture) is already shipped — this just stops the watch
terminal from being the blindest seat in the house. Builds directly on #2 and #7.

## 6. Brain "Web" view clustering ✅

Specific to `layoutGraph` (Web only; Tree/Recent have their own axes). After the force
sim, the fit step computed a **uniform** fit scale then capped anisotropy at
`base * 1.6`. On a wide card the tighter axis is height, so horizontal scale was
capped at 1.6× the height-fit — leaving wide margins with nodes bunched mid-canvas.

Fix: spread more in the sim (stronger repulsion / longer edge rest length scaled to
canvas) and relax the fit so each axis fills its extent with a higher anisotropy
allowance, while still clamping into frame. Result: the web encompasses the available
width instead of clustering center.

## 9. Opening a project is slow — the 7-request waterfall ✅ (fixed 2026-06-19)

**Fixed:** `selectProject()` now (a) renders the sidebar shell from the manifest
immediately, then (b) fetches activity/prompts/git/docs/dochistory/memory in one
`Promise.all` (latency dropped from *sum → max* of the calls), committing whatever
returns. Implemented options 1 + 2 below.

---

**Symptom:** clicking a project from the workspace takes several seconds before anything
useful paints.

**Cause:** `selectProject()` (`public/app.js:522`) fetches the project's data as a
**serial waterfall** — each `await api(...)` blocks the next:

1. `/api/projects/:slug` (manifest) → 2. `/activity` → 3. `/prompts` → 4. `/git` →
5. `/docs` → 6. `/dochistory` → 7. `/memory`

Worse, the first render (`renderSessionList()` / `renderTimeline()`) doesn't run until
**line 623–624, after all seven return**. So the wall time is the *sum* of seven hosted
round-trips, and the screen shows nothing until the slowest tail (`dochistory` can be
large) lands. On fly.dev with cold reads that's the "several seconds."

Note the live path already solved this: `refreshLive()` (`app.js:829`) fires the same
calls in **one `Promise.all`** and commits whatever legs return. The initial open never
got the same treatment.

**Fix options:**
1. **Parallelize** — wrap calls 2–7 in `Promise.all` (mirror `refreshLive`), keeping the
   `if (slug !== state.project) return` stale-nav guard once after the batch. Cuts latency
   from *sum → max* of the calls. Smallest, safest win.
2. **Progressive render** — paint the session list + timeline as soon as the manifest
   (call 1) returns, then fill git/docs/brain as each resolves. Best perceived latency;
   the brain graph build (`app.js:596`) still needs `docs`+`dochistory`, so it stays
   gated, but the shell appears instantly.
3. **Server roll-up** — a single `/api/projects/:slug/full` that returns the bundle in one
   response (fewer round-trips, one cold start). Bigger change; do 1+2 first.

Recommended: **1 + 2 together** — parallelize the fetches *and* render the shell on the
first response.

## 10. Brain dot lights up but Brain history lags — stale-render on the smooth live path ✅ (fixed 2026-06-19)

**Fixed:** added `refreshBrainHistoryCard()` and call it from `refreshLive()`'s smooth
path (alongside `refreshActivityCard()`/`updateTicker()`). It surgically replaces/inserts/
removes just the `.brain-history` card from `renderBrainHistory()` — no full
`renderTimeline()`, so the in-place brain animation is preserved — and re-wires the
doc-chip clicks. Handles the first-brain-commit-of-a-session case (insert after the
centerpiece) too. The open-doc-reader staleness noted below is left as a follow-up.

---

**Symptom:** a brain node flashes (dot lights up) on a live tick, but the **🧠 Brain
history** list doesn't show the matching entry until you navigate away and back.

**Two coupled causes:**

1. **Save vs. commit timing (inherent).** The dot reacts to a *doc content change*
   (reachable docs update on **save**, see §1), but **Brain history** (`renderBrainHistory`,
   `app.js:1268`) is built from **git commits** that touched brain docs. A save precedes its
   commit, so the dot legitimately leads the history row. Not a bug by itself — but it sets
   the expectation that the two surfaces move together, which (2) then breaks.

2. **The smooth live path never re-renders Brain history (the real bug).** `renderBrainHistory()`
   is only emitted *inside* `renderTimeline()` (`app.js:1191`). But on the common live
   update — node set unchanged, only content/commits changed — `refreshLive()` takes the
   **smooth path** (`app.js:872–877`): it calls `streamUpdateBrain()` + `refreshActivityCard()`
   + `updateTicker()` and **returns without calling `renderTimeline()`**. So even once the new
   commit *has* landed in `state.git` (updated at `app.js:842`), the Brain history card on
   screen is stale. Only the add/remove-node branch (`app.js:893`) re-renders the timeline —
   which is why navigating away and back (a full `renderTimeline`) "fixes" it.

**Fix:** in the smooth path, surgically refresh the Brain history card the same way
`refreshActivityCard()` / `updateTicker()` patch their cards in place — replace just the
`.brain-history` node from `renderBrainHistory()` after `state.git` is updated. (Re-rendering
the whole timeline here would defeat the in-place brain animation, so keep it targeted.)
Optionally also surface the not-yet-committed save in the history as a pending row, so the
dot and the history truly move as one (ties into §5's "one concerted update").

**Also check:** an *open doc reader* (`state.docOpen`) isn't refreshed on the smooth path
either — if a live tick changes the doc you're reading, its content can be stale until you
reopen it. Same class of bug; worth a follow-up.
