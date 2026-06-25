# PLAN_NATIVE_PARITY — closing the agent-control gap between the web Drive and native iOS

**Status:** **Phase A shipped + most of B/C** (2026-06-25). Research/inventory was complete
2026-06-25; the same day the whole real-cockpit gap was ported in one batch (slow native
build loop → batch related changes). Feeds and extends `PLAN_NATIVE_REWRITE.md` (the
canonical native intent); grounded in the web app (`public/app.js`), the native app
(`app-ios/Sources/**`), the backend (`src/agent.js`, `src/agentRoutes.js`,
`src/apns.js`, `src/mcpAsk.js`), and the history (`STORY.md` Ch.10–11, `PLAN_COCKPIT.md`,
`PLAN_AGENT_RUNTIME.md`, `UI_FEEDBACK.md`, git log).

## ✅ Implementation log (2026-06-25)

Shipped in one batch (client-only — **no backend changes**, the server already supported
all of it). New file `app-ios/Sources/Core/AgentRunState.swift`; edits to
`DriveSessionView.swift`, `CockpitView.swift`, `RosterStore.swift`, `APIClient.swift`.

- **§1 state unification (P0 prereq)** — one `AgentRunState` enum (`from(_:)`, `busy`,
  `pill`, `human`, `color`) replaces the scattered status switches in the Drive view and
  the cockpit roster row; `DriveSessionView.busy` and the cockpit pill/colour/elapsed all
  key off it now. Matrix #1–4 keys off the single `busy` predicate, mirroring web `driveBusy()`.
- **Stop / interrupt (matrix #2, P0)** — two-tap armed Stop in the composer (shows only
  while busy), `APIClient.stop` → `POST /sessions/:id/stop`; the `stopped` event renders a
  neutral "Turn stopped" system line; auto-disarms after ~4s and on settle.
- **Mid-turn queue (matrix #3, P0)** — `queue: [String]` + `flushQueue()` drains one
  follow-up per turn on the idle/turn_end transition, cancelable chips above the composer,
  re-queues on send failure. The server's busy-400 is no longer hit — the queue is the
  client contract (don't-regress invariant §7).
- **Busy-aware composer + failed-send recovery (matrix #1,4,5, P0)** — field stays enabled
  while busy; Send relabels to **Queue**; a busy tap enqueues instead of 400ing into a lost
  error bubble; a failed flush re-queues.
- **Scroll-pinning + jump pill (matrix #16a, P0)** — bottom-sentinel `onAppear/onDisappear`
  tracks "is the user at the bottom"; auto-scroll only when pinned, otherwise a "New
  activity" pill. A tool card no longer yanks you down while reading history.
- **Collapse tool cards (matrix #16b, §3.1a)** — one compact chip per call, the
  `tool_result` paired into the *same* bubble by `toolUseId` (status dot + output behind a
  tap), instead of two stacked bubbles per call.
- **P-1 Markdown perf** — the live streaming assistant bubble renders as plain `Text` and
  swaps to parsed Markdown once at `block_stop` (kills the O(n²) re-parse-per-token). P-2's
  smoothness half is partly covered by the pin-gated scroll.
- **Foreground resync (matrix #7, P1)** — `onChange(of: scenePhase)` reopens the stream
  from `lastSeq` on `.active`, healing a frozen backgrounded socket.
- **Roster auto-reconnect (matrix #8, P1)** — `RosterStore.start()` now loops with 1→8s
  backoff instead of demanding a pull-to-refresh.
- **End agent (matrix #18, P1)** — swipe-to-end on cockpit roster rows → `APIClient.endSession`
  → `POST /sessions/:id/end`; optimistic local removal, then re-loads the resumable past list.
- **Push deep-link to the convo (matrix #13, P1)** — ✅ **SHIPPED 2026-06-25, client-only.**
  A tapped notification (finished/error/ask) now lands you *in the conversation* instead of
  just foregrounding. `PushManager.handle` sets a `pendingRoute` (project + session) for any
  tap that identifies a session; a new app-level `NavRouter` owns the signed-in
  `NavigationStack` path, and `ProjectsView.consumeRoute` pushes Cockpit + `DriveSessionView`
  in one path assignment. The whole stack was unified onto that one path (`DriveRoute`
  registered once at the root; CockpitView's old `navigationDestination(item:)` retired) so
  there's no item/path mixing. The detached global `AskSheet` is now a fallback for the
  no-project case only: a deep-linked `ask` re-surfaces as the **inline** `askCard` via the
  session's SSE replay — so you answer in context, and the old "questions stripped past the
  4KB cap → tap routed nowhere" gap is closed too.

### Cockpit + conversation-list polish pass (2026-06-25, client-only, `CockpitView.swift`)

A legibility/polish pass over the project cockpit screen and the swipe-to-end state —
no behavior change, no backend. All in `app-ios/Sources/Views/CockpitView.swift`.

- **Swipe-to-end layout fixed (the reported clip/shift).** The destructive action is now a
  bare **✕ glyph** (`Image("xmark")` + `.tint(.red)`, VoiceOver "End agent") — the "End"
  word was redundant next to the red and read as squeezed. Rows carry a **shared
  `rowInsets` (16pt h)** via `.listRowInsets` so they stay aligned to the screen margin
  *while swiped* (the default insets shifted content under the revealed action). The agent
  title now has `.layoutPriority(1)` + `.truncationMode(.tail)` so a long title truncates
  cleanly instead of pushing the row; the elapsed timer, status pill, and **context meter
  are `.fixedSize()`** so the meter never clips its "%" and the *plan chip* is the one that
  truncates — the meter can no longer overflow the title/row.
- **Agent rows scan title-first.** Title is `.subheadline.weight(.medium)` on line 1 (with
  the status dot); status pill + plan chip + context meter are the secondary line. (No meter
  on the title line, so the title can never be pushed off-screen by context fill.)
- **Section spacing.** `.listSectionSpacing(28)` puts a clear gap between the **Agents**
  (Now) and **Conversations** zones so they read as two sections, not one run of rows.
- **Conversation rows polished.** Strong title (`.weight(.medium)`, tail-truncated), a
  **muted** metadata line where only the *status word* is tinted (green/orange live,
  secondary when resumable) and the rest (message count · last-active) stays quiet, and a
  fixed, aligned chevron that never compresses.
- **Empty / loading / error states.** A shared `stateCard` family backs four states:
  **project loading** (`didLoad` gate → centered spinner, no "empty" flash), **project load
  failure** (warning + **Try again** → `retry()`, instead of a bare red string),
  **no agents** (full card when the project is otherwise empty; a slim inline "No agents
  running right now · New" row when there *are* past conversations below), and
  **no conversations** ("No past conversations yet."). A transient stream drop while rows
  exist stays a thin inline banner, not the full error state.

**Still open (deferred, lower priority):**
P-2 throttle/tail-outside-array smoothness; P-3/P-4 (measure on device first); Phase D QoL
(#14 cooling card, #15 any-time chips, #16 flipped newest-first, #19 advanced reveal,
#20 harness version).

The native app is a **solid skeleton with a real gap in mid-run control**. It can start,
stream, resume, and answer asks — but once an agent is *running*, the phone goes
read-only: you can't queue a follow-up, you can't stop a bad turn, and a message typed
mid-turn is silently lost. The web app solved all three. This plan ports those semantics
faithfully, plus a short performance pass.

---

## 0. The one-paragraph finding

**The backend already supports everything a real cockpit needs** — `POST
/sessions/:id/stop` (SIGTERM the turn), `/end`, `/answer`, the live roster stream, the
`after=<seq>` backfill, durable adopt-by-`claudeSessionId`. **The web app uses all of
it. The native app uses about half.** The missing half is exactly the "agent is running
right now" controls: **stop, queue, busy-aware input, failed-send recovery.** None of
these need server work — they're client behaviors the web app already proved
(`_driveQueue` + `driveFlushQueue`, two-tap armed `#dv-stop`, seq-dedup resync). That's
the good news: this is a port, not an R&D project.

---

## 1. Concept model — fix the vocabulary first (it's overloaded, the docs admit it)

Both `PLAN_COCKPIT.md` §X and the native "legibility passes" (`fd0a2d8` v1–v3) already
fought this; the native code still carries the ambiguity in *scattered string switches*
rather than one type. Settle it before adding controls, because the new controls
(stop/queue) need a single source of truth for "is this agent busy."

| Term | Canonical meaning | Where it lives now (iOS) | Problem |
|---|---|---|---|
| **project / workspace** | a project record bound to a real checkout on the host | `Project` (`Models.swift:14`), `WorkspaceInfo/State` (`:42/:51`) | OK |
| **agent / session** | one `claude` process VibeRate owns; one short-lived process **per turn**, resumed by id between turns | `AgentSession` (`:124`) + `RosterAgent` (`:136`) | two shapes for one thing; tolerable |
| **run / turn** | one message → one process lifetime | *no type* — only `promptStartedAt` | **no first-class "is a turn in flight" state** — this is the root of the missing controls |
| **conversation** | the JSONL log; Drive (hot) and the reader (cold) are the *same* object | `WorkspaceSession` (`:63`) | OK |
| **status** | `starting\|working\|waiting\|idle\|error\|exited` from the server | raw `String?`, re-bucketed in **5+ separate switches** | duplicated mapping; drift-prone |
| **resumable / idle / connecting** | display strings, not states | computed ad hoc per view | "Connecting…" (transport) vs "Idle" (agent) conflated in `headerSubtitle` |

**Action (P0, prerequisite):** introduce **one `AgentRunState` enum** + a single
`busy` derivation, replacing the duplicated switches in `DriveSessionView.humanStatus`
(`:706`), `isLive` (`:436`), `CockpitView.AgentRow.statusLabel` (`:242`),
`RosterStore.rank` (`:102`), `ConversationRow.statusLabel` (`:319`). Mirror the web's
`driveBusy()` (`app.js:4782`): **busy = working | starting | waiting**. Everything in §2
keys off this one predicate, exactly as the web composer/queue/stop do.

---

## 2. Feature matrix — old web vs native iOS

Status key: ✅ full · ◑ partial · ❌ absent. Priority: **P0** ship-blocker for "real
cockpit" · **P1** important QoL · **P2** nice-to-have.

| # | Feature | Web (old) | iOS (new) | Relevant files / symbols | User-visible behavior | Backend dep | Risk | Priority |
|---|---|---|---|---|---|---|---|---|
| 1 | **Type while agent runs** | ✅ composer never disabled; Send → "Queue" | ◑ input enabled but **send 400s → message lost** | iOS `DriveSessionView.composer` `:332`, `send()` catch `:551`; web `driveSetStatus` `:5029` | web: keep typing, message queues; iOS: typed msg discarded into error bubble | none (client) | Low | **P0** |
| 2 | **Stop / interrupt a bad turn** | ✅ two-tap armed `#dv-stop` → `POST /stop` | ❌ **no stop control at all** | web `driveStopClick` `:4770`; backend `stopSession` `agent.js:987` (SIGTERM); iOS: ABSENT | web: arm→confirm kills turn, session survives; iOS: must wait it out | `POST /sessions/:id/stop` (exists) | Low | **P0** |
| 3 | **Queue follow-ups mid-turn** | ✅ `_driveQueue`, one-per-turn drain, cancelable chips, auto-requeue on fail | ❌ (only a 1-slot `queuedPrompt` for the workspace-clone detour) | web `driveSend` `:4739`, `driveFlushQueue` `:4791`, `renderDriveQueue` `:4811`; iOS `queuedPrompt` `:47` | web: see pending chips "sends when turn finishes," pull items back; iOS: none | none (server has **no** queue — `agent.js:975` 400s) | Med | **P0** |
| 4 | **Busy-aware Send button** | ✅ relabels Send↔Queue on `busy` | ❌ Send only knows `sending`/`ready` | web `:5029`; iOS `:356-363` | web: button tells you what'll happen; iOS: looks normal, then fails | none | Low | **P0** |
| 5 | **Failed-send recovery** | ✅ banner + auto-requeue (`q.unshift`) | ◑ rollback to error bubble, **no retry** | web `driveFlushQueue` catch `:4800`; iOS `send()` catch `:562` | web: failed msg stays queued, retries next idle; iOS: gone | none | Low | **P0** |
| 6 | **SSE reconnect + seq dedup** | ✅ `lastSeq` drop + `after=<seq>` backfill | ✅ `reconnect()` from `lastSeq`, skips 4xx | iOS `SSEClient.swift`, `openStream`/`reconnect` `:485/:519`; web `driveOpenStream` `:5463` | both: reconnect without gaps/dupes | `?after=N` / `Last-Event-ID` (exists) | — | **done** |
| 7 | **Foreground resync (frozen socket)** | ✅ `wireDriveVisibilityResync` `:5493` | ❌ no `scenePhase` resync | web `:5493`; iOS: ABSENT | web: tab refocus tears down + reopens from high-water seq; iOS relies on URLSession `waitsForConnectivity` only | none | Low | **P1** |
| 8 | **Roster stream auto-reconnect** | ✅ CLOSED→poll, CONNECTING→native retry | ❌ disconnect = manual pull-to-refresh | web `openRosterStream` `:1755`; iOS `RosterStore` `:52` | web self-heals; iOS shows "disconnected — pull to refresh" | `roster/stream` (exists) | Low | **P1** |
| 9 | **Resume / adopt (durable)** | ✅ adopt by `claudeSessionId`, **bypassPermissions cold default** | ✅ adopt + best-effort auto-adopt from UserDefaults | iOS `connect()` `:396/:420`, `adopt` `APIClient:79`; web `resumeDrive` `:4957` | both: redeploy-surviving resume | `/sessions/adopt` (exists) | — | **done** |
| 10 | **Cross-device session list** | ✅ server index merged w/ local log | ✅ `workspaceSessions` → Conversations section | iOS `loadPast` `:146`; web `fetchWorkspaceSessions` `:4274` | both: phone-started session resumes on laptop | `/workspace/:slug/sessions` (exists) | — | **done** |
| 11 | **Ask/answer inline picker** | ✅ `driveRenderAsk` `:5328` | ✅ `AskView`/`AskSheet`, parses from push payload | iOS `AskView.swift`, `PushManager` `:74`; web `:5328`; backend `mcpAsk.js` | both: agent blocks on a question, you tap an answer | `/sessions/:id/answer` (exists) | — | **done** |
| 12 | **Push notifications** | ❌ **web has none** (APNs-only) | ✅ register, `ask` deep-link to picker | iOS `PushManager.swift`, `apns.js`; web: ABSENT | iOS-only win: agent reaches out | `/push/register` + APNs | — | **iOS wins** |
| 13 | **Push tap → correct context** | n/a | ✅ **any tap (finished/error/ask) deep-links into that `DriveSessionView`; ask re-surfaces inline via SSE backfill** | iOS `PushManager.handle`+`pendingRoute`, `NavRouter`/`DriveRoute`, `ProjectsView.consumeRoute`; payload `sessionId`/`projectSlug` (`apns.js:149`) | tapping any push opens that exact convo | payload already carries the ids | — | **done** |
| 14 | **Provisional "cooling" card** | ✅ optimistic rail card → cools on `result` | ◑ optimistic bubble only, no roster card | web `driveProvisionalRow` `:5990`; iOS `send()` `:536` | web: convo never visibly vanishes between turn-end and ingest | none | Med | **P2** |
| 15 | **Prompt chips / suggested starters** | ✅ data-seeded chips, ★ save, mid-session | ◑ 4 hardcoded starters, **new-agent only** | iOS `starters` `:149`; web `renderDriveChips` `:4220` | web: tappable openers any time, saved phrases; iOS: only on empty new agent | none | Low | **P2** |
| 16 | **Flipped newest-first + jump pill** | ✅ sticky-top composer, "↑ new activity" | ❌ standard bottom-up chat + auto-scroll | web `driveScroll` `:5136`, `#dv-jump`; iOS `:121` scroll-to-bottom | web: type at top, reply below, no scroll-chase; iOS: classic chat | none | Med | **P2** |
| 16a | **Scroll-pinning (don't yank during a run)** | ✅ `_drivePinned` (scrollTop≤80) gates auto-scroll; jump pill otherwise | ❌ **unconditional `scrollTo("bottom")` on every new bubble** | iOS `onChange(of: bubbles.count)` `:121` + `bubbles.last?.text` `:124`; web `_drivePinned` `:5136` | iOS: scroll up to read history → next tool card yanks you back to bottom; web: stays put, surfaces a pill | none (client) | Low | **P0** |
| 16b | **Tool-call density / collapse** | ✅ compact one-line chips, full I/O behind a tap, matched by `toolUseId` | ❌ **two stacked `.tool` bubbles per call** (`→ name` + `⤷ 240-char slice`), no grouping | iOS `ingest` `tool_use` `:619-626` + `tool_result` `:627-636`; web `driveAddTool`/`driveAttachToolResult` `:5263/:5285` | iOS: a tool-heavy turn becomes a wall of low-signal telemetry burying the actual reasoning/results; web: collapsed chips | none (client) | Med | **P0/P1** |
| 17 | **Context-window meter** | ✅ pill, amber≥75 red≥90, interim-usage-fed | ✅ `CtxMeter` in roster row | iOS `CtxMeter` `CockpitView:365`; web `driveUpdateCtx` `:5083` | both: see the scarce resource draining | `usage` events (exists) | — | **done** (roster only; not in chat header) |
| 18 | **End agent (swipe)** | ✅ roster ✕ → `/end` | ◑ tap-to-drive exists; **end/swipe?** verify | web `endRosterAgent` `:1703`; iOS `CockpitView` rows | no terminal ctrl-c on a phone → idle agents accrue without this | `/sessions/:id/end` (exists) | Low | **P1** |
| 19 | **Status-row split (primary/advanced)** | ✅ `#dv-more` hides tokens/sid/bypass | ◑ `headerSubtitle` already calmer | web UI_FEEDBACK P1 #4; iOS `:466` | both reasonably calm; iOS lacks the "advanced" reveal of exact tokens/sid | none | Low | **P2** |
| 20 | **Harness version surface** | ◑ discarded from `system/init` | ❌ not shown | backend `/api/agent/harness`; iOS: ABSENT | neither surfaces it well (own backlog: `PLAN_HARNESS_VERSIONING.md`) | `/api/agent/harness` (exists) | Low | **P2** |

---

## 3. What the web did well that native is missing (the "must port" list)

Ranked by impact on "is this a real cockpit or a chat viewer":

1. **Mid-turn message queue** (matrix #3) — *the single most important agent-control
   affordance.* Type-ahead while the agent works, see what's pending, pull items back.
   The server has **no queue** and 400s a mid-turn send (`agent.js:975`), so this is
   purely the client's job. Port `_driveQueue` + `driveFlushQueue` semantics exactly:
   push on busy, drain **one per turn** on the `turn_end`/`idle` transition, re-queue on
   failure. (`STORY`/`PLAN_AGENT_RUNTIME` "Approvals + interrupt".)
2. **Stop the turn** (matrix #2) — the only server-supported "redirect now" is
   stop-then-send. Native has no stop button at all today. Port the **two-tap armed**
   pattern (`368ae35`): explicitly chosen because on a phone Stop sits a thumb-width from
   Send and stopping kills in-flight work. First tap → red "Tap to confirm," second
   within ~4s → `POST /stop`, auto-disarm on settle.
3. **Busy-aware composer + failed-send recovery** (matrix #1,4,5) — without these the
   typed message is *lost* on the server's busy-400 today. This is a few lines once the
   `busy` predicate from §1 exists.
4. **Foreground/roster resync** (matrix #7,8) — iOS Safari/URLSession freezes a
   backgrounded socket; the web app proactively resyncs on `visibilitychange`. Native
   should resync on `scenePhase == .active` and auto-reconnect the roster, not demand a
   pull-to-refresh.
5. **Push tap → the actual convo** (matrix #13) — the payload already carries
   `sessionId`/`projectSlug` (`apns.js:149`); a `finished`/`error` tap should deep-link
   into that `DriveSessionView`, not just foreground the app.

### 3.1 The transcript-during-a-run problem (observed on device, high priority)

Two compounding defects make a **long-running session actively annoying to review** —
together they're the worst day-to-day UX issue in the app, and both are regressions from
the web Drive (matrix #16a, #16b):

**(a) The chat becomes tool telemetry, not conversation.** Every `tool_use` appends a
`.tool` bubble (`→ Read app.js`) at `DriveSessionView.swift:619-626`, and every non-empty
`tool_result` appends a *second* `.tool` bubble (`⤷ <240-char slice>`) at `:627-636`. So
a single tool call produces **up to two stacked bubbles**, and a tool-heavy turn
(Read app.js → Bash → Agent → Read agentRoutes.js → tiny output snippets…) floods the
visible transcript with low-signal cards that **bury the agent's actual reasoning and
results.** The web app rendered each call as **one compact chip with the full input/output
behind a tap, matched by `toolUseId`** (`driveAddTool`/`driveAttachToolResult`,
`app.js:5263/:5285`) — collapsed by default. Native is *noisier than the thing it
replaced.* The current code even comments the intent ("so a tool-heavy turn visibly
progresses instead of looking frozen", `:628`) — the right fix keeps that progress signal
without the wall of cards.

**(b) Every tool card yanks you back to the bottom.** `onChange(of: bubbles.count)`
(`:121`) fires `proxy.scrollTo("bottom")` on **every** new bubble — including every tool
card — with **no pinned/unpinned guard**, and `onChange(of: bubbles.last?.text)` (`:124`)
does the same on every streamed delta. So if you scroll up to read earlier messages while
the agent is still working, the next tool call (which increments `bubbles.count`) drags
you straight back down. The web app already solved this: `_drivePinned = scrollTop <= 80`
(`app.js:5136`) — auto-scroll **only when the user is already at the bottom**, otherwise
hold position and surface a "↑ new activity" jump pill (`#dv-jump`). iOS dropped that
guard entirely.

**Fix (combine with the §5 perf work — same code paths):**
- **Scroll-pin:** track whether the user is near the bottom (a scroll offset reader or a
  `.bottom`-anchor visibility check); auto-scroll only when pinned; otherwise show a tap
  -to-jump affordance. This is also the right home for the P-2 throttle — once you only
  scroll-when-pinned, the per-delta `:124` scroll stops fighting the user.
- **Collapse tool cards:** render one chip per tool call (verb + target + a status dot),
  pair the `tool_result` into the *same* chip by `toolUseId` instead of a second bubble,
  and put the 240-char slice / full output behind a tap. Optionally fold a run of
  consecutive tool chips into a single "🔧 4 steps" group that expands. Keep a lightweight
  live "working on X" line for the progress signal the current code was reaching for.

---

## 4. What native already does better (preserve, don't regress)

- **Authenticated SSE via `URLSessionDataDelegate`** (`SSEClient.swift`) — sets a real
  `Authorization: Bearer` header, retiring the web's `?access_token=` URL hack and the
  whole WKWebView seam (`STORY` Ch.11). Refuses gzip + caching to kill buffering.
- **Push notifications** (matrix #12) — the web app has *none*. The agent reaching out
  when it blocks on you is a genuinely new capability.
- **Native ask selector from the push payload** — the picker can render from the
  notification *before* the stream connects (`PushManager.parseQuestions`).
- **Calmer status language** — the "streaming · idle" jargon was deliberately killed
  (`0ddf15c`); `humanStatus` reads plainly. Don't reintroduce operator jargon (memory:
  ui-copy-general-audience).
- **OS-native safe area / nav** — no double-counted header, no clipped nav rows (the
  web's UI_FEEDBACK P0 #1/#3 don't recur natively).

---

## 5. Performance / optimization pass (native)

Two real costs, both in the streaming hot path, both cheap to fix. Everything else is
fine.

### P-1 (high impact): Markdown re-parses from scratch on every streamed token
`MarkdownView.body` (`MarkdownView.swift:16`) calls `MarkdownParser.parse(text)` **inline
in `body`** — full block parse + per-span `AttributedString(markdown:)` (regex) — and
`body` re-runs on *every* `assistant_text_delta` because `appendAssistant`
(`DriveSessionView.swift:675`) rewrites the last `Bubble` in the `@State [Bubble]` array.
So a 1,000-token reply re-parses the entire accumulated Markdown ~1,000 times, each parse
longer than the last (O(n²) over the reply). **This is the "streaming gets janky as the
reply grows" cost.**
- **Fix A (cheapest):** memoize the parse — cache `(text) → [Block]` so an unchanged
  prefix isn't re-parsed; or only re-parse the *growing tail* block.
- **Fix B:** during active streaming render the live assistant bubble as **plain `Text`**
  (monospaced is fine) and swap to parsed Markdown once on `block_stop`/`turn_end`. The
  web app already coalesces md renders to one per frame via `requestAnimationFrame`
  (`driveScheduleMd` `app.js:5224`) — same idea.

### P-2 (medium): scroll-to-bottom + full-array diff on every token
`onChange(of: bubbles.last?.text)` (`DriveSessionView.swift:124`) fires
`proxy.scrollTo("bottom")` on every delta, and rewriting `bubbles[last]` re-diffs the
whole `ForEach`. The `LazyVStack` saves off-screen rows, but the visible bubble churns.
- **Fix:** throttle the auto-scroll to ~30–60ms (or scroll only on `bubbles.count`
  change + a coalesced tail tick), and/or hold the streaming tail in a separate
  `@State String` rendered as one view *outside* the array, committing to `bubbles` only
  at `block_stop`. Removes per-token array diffing. **Note:** the *correctness* half of
  this — only scrolling when the user is pinned to the bottom — is the §3.1b / matrix #16a
  P0 fix; this P-2 item is the *smoothness* half (throttle + tail-outside-array). Do them
  together.

### P-3 (low): main-actor JSON decode + 1s roster re-render
`ingest` (`:587`) does `JSONSerialization` per event on `@MainActor`; fine for small
frames but a large `tool_result` is fully parsed before being sliced to 240 chars
(`:633`) — slice on the raw string first, or decode off the main actor. `CockpitView`'s
1-second `Timer` (`:113`) re-renders every roster/conversation row each tick; gate it to
re-render only rows with a *running* elapsed timer.

### P-4 (low): initial backfill paints the whole transcript
`openStream(after:0)` replays the entire buffered transcript into the `LazyVStack` at
once (no windowing). Fine for short convos; for a long resumed one it's a visible hitch.
Lazy stack mitigates layout, but consider a "load earlier" cap if long-conversation
resume feels slow on device. **Lower priority — measure first.**

**Load-faster wins:** the cockpit already does instant-fetch-then-stream (good). The
main *perceived* load cost is P-1 during the first streamed reply. Fixing P-1 + P-2 is
the highest-leverage smoothness work and is self-contained to `MarkdownView` +
`DriveSessionView`'s streaming path.

---

## 6. Rebuild roadmap (prioritized)

Sequenced so each phase is independently shippable and on-device verifiable. Remember
the native loop is slow (~10–15 min Codemagic build per change, `PLAN_NATIVE_REWRITE.md`)
— batch related changes per build.

### Phase A — make "agent running" controllable (the real-cockpit gap) — **P0** ✅ SHIPPED 2026-06-25
1. **§1 state unification:** one `AgentRunState` enum + `var busy: Bool` derivation,
   replacing the 5 scattered switches. *Prerequisite for everything below.*
2. **Stop button** (matrix #2): two-tap armed control in the composer/header, `POST
   /sessions/:id/stop`, render the `stopped` event as a system line. (Backend ready.)
3. **Mid-turn queue** (matrix #3): port `_driveQueue` + drain-one-per-turn on the
   `turn_end`/`idle` transition + cancelable pending chips + re-queue on failure.
4. **Busy-aware composer** (matrix #1,4,5): Send relabels to "Queue" when `busy`; failed
   send re-queues instead of vanishing.
5. **Scroll-pinning** (matrix #16a, §3.1b): auto-scroll only when the user is at the
   bottom; otherwise hold position + a tap-to-jump pill. Without this, the §3.1 tool-card
   flood makes a running session unreadable — it belongs in the P0 batch even though it's
   a small change.
*Outcome: you can steer a running agent from the phone — type-ahead, see the queue, kill
a bad turn, and actually read the transcript while it runs. This is the line between
"chat viewer" and "cockpit."*

### Phase B — resilience & continuity — **P1** ✅ SHIPPED 2026-06-25 (incl. deep-link #13)
5. **Foreground resync** (matrix #7): on `scenePhase == .active`, tear down + reopen the
   stream from `lastSeq` (handles the frozen backgrounded socket).
6. **Roster auto-reconnect** (matrix #8): `RosterStore` retries with backoff instead of
   demanding pull-to-refresh.
7. **Push deep-link to convo** (matrix #13) — ✅ shipped: any tap (finished/error/ask)
   opens that `DriveSessionView` via `pendingRoute` → `NavRouter` path; an `ask` re-surfaces
   inline through the SSE replay, so the global `AskSheet` is now a no-project fallback.
8. **End-agent affordance** (matrix #18): confirm/ensure swipe-to-end on roster rows so
   idle agents don't accrue (no phone ctrl-c).
9. **Collapse tool-call cards** (matrix #16b, §3.1a): one tappable chip per tool call
   (`tool_result` paired into it by `toolUseId`), optionally folding a run of consecutive
   chips into a "🔧 N steps" group. Stops a tool-heavy turn from burying the reasoning.
   (P0/P1 — pair with the Phase-A scroll-pin; together they fix §3.1.)

### Phase C — performance pass — **P1 (do alongside A/B)** ◑ P-1 SHIPPED; P-2 partial; P-3/P-4 deferred
9. **P-1 Markdown memoization / stream-as-plain-then-parse.**
10. **P-2 throttled auto-scroll + tail-outside-array.**
11. **P-3/P-4** only if device testing shows them.

### Phase D — mobile QoL polish — **P2**
12. **Prompt chips** any-time + saved phrases (matrix #15).
13. **Flipped newest-first + jump pill** (matrix #16) — bigger UX change; validate it's
    still wanted natively before porting.
14. **Provisional cooling card** in the roster (matrix #14).
15. **Status-row advanced reveal** + **context meter in the chat header** (matrix #17,19).

---

## 7. Don't-regress invariants (carried from the history)

- **Trust boundary:** the composer is RCE on the dev box — keep it admin-gated; the
  reader stays public. (`STORY` Ch.10; every plan doc.)
- **Always `bypassPermissions`** on start/adopt — `default` silently denies edits
  headless and strands a session mid-edit (`10d32ad`, `PLAN_NATIVE_REWRITE.md`).
- **Context meter from interim usage only**, never `result.usage` (which sums every
  tool-loop call → false "100% ⚠"). (`73c9aa3`, `PLAN_COCKPIT.md` §X.1.)
- **No mid-turn server send** — the queue is a *client* contract; the server only
  accepts a message when `idle` (`agent.js:975`).
- **End is non-destructive** — `/end` drops the live record but keeps the transcript
  re-adoptable.
- **Don't sell the mid-execution interrupt as the differentiator** — both CC and VibeRate
  can stop mid-flight; steering = ongoing direction across the whole loop (`STORY` Ch.10).
- **No new agent tokens for capture** — read events the runtime already emits.

---

*Linked from `CLAUDE.md` index and `PLAN_NATIVE_REWRITE.md`. This doc is the parity
backlog; `PLAN_NATIVE_REWRITE.md` remains the canonical native architecture/intent.*
