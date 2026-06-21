# Drive live stream — the reconnect-replay duplication bug(s)

> Status: **FIXED (2026-06-20).** Two symptoms reported from mobile Safari
> (background-tab return; red "resume" button) that are **one root cause**: the SSE
> stream replayed from `after=0` on every reconnect and the client appended the
> backfill with no dedup. Diagnosis below; the fix is in the "Shipped" section at
> the end. Companion to `DRIVE_CONVO_RECONCILIATION.md` / `DRIVE_CONVO_INGEST_GAP.md`
> (those cover ingest + the rail merge; this covers the *live transcript transport*).

## The two reported symptoms

**Symptom 1 — background and return (mobile Safari).** Start a Drive session, send
a few messages, then switch to another app (Messages, YouTube) while the agent is
working. Return to the Safari tab. The session is still running, but:

- the page is still scrolled to roughly the old pixel offset (the old bottom),
- yet the message rendering *at* that offset is your **first** message, not your
  latest,
- scrolling all the way down reveals the latest message,
- scrolling **up** reveals the *entire* conversation history a second time, ending
  at your first message again at the very top.

i.e. the whole transcript has been **reprinted below the original copy**.

**Symptom 2 — the red "resume" button.** Tap resume on a suspended session and
every message — both your prompts and each of the agent's replies / tool chips —
prints **twice or three times** in a row. Execution speed makes clear the agent is
**not** re-running the work; only the *rendering* is duplicated.

## Root cause — one mechanism behind both

The server's backfill design is correct and gapless. Every event carries a
monotonic `seq` (`src/agent.js:296`, `emit()`), and `subscribe(id, fn, afterSeq)`
replays only `e.seq > afterSeq` before attaching the live listener
(`src/agent.js:653-658`). The SSE route exposes that as `?after=N`
(`src/agentRoutes.js:201-217`) with the comment *"a reconnecting client resumes
without gaps or dupes."*

**That contract is silently broken in transport.** Two gaps:

### Gap A — the server never emits an SSE `id:` line

The stream writes only the data frame:

```js
// src/agentRoutes.js:216
res.write(`data: ${JSON.stringify(event)}\n\n`);
```

There is **no `id: <seq>` field**. The standard SSE resumption mechanism is: the
server tags each event with `id: <n>`, the browser remembers the last one, and on
an automatic reconnect it sends `Last-Event-ID: <n>` so the server can resume past
it. With no `id:` emitted, the browser has nothing to send, and the route never
reads `req.headers['last-event-id']` anyway.

### Gap B — the client opens at `after=0` and never advances it

```js
// public/app.js:4025-4031
function driveOpenStream(id, after) {
  if (state.drive && state.drive.es) state.drive.es.close();
  const es = new EventSource('/api/agent/sessions/' + id + '/stream?after=' + (after || 0));
  es.onmessage = (m) => { if (state.drive && state.drive.id === id) { try { driveRender(JSON.parse(m.data)); } catch {} } };
  es.addEventListener('error', () => {/* EventSource auto-reconnects */});
  if (state.drive) state.drive.es = es;
}
```

Both `enterDrive` and `resumeDrive` call this with `after = 0`
(`app.js:3574`, `3721`). The `after` value is baked into the **URL** at
connect-time. When the native `EventSource` auto-reconnects (the `error` handler
explicitly relies on this: *"EventSource auto-reconnects"*), it re-issues the
**exact same URL** — `?after=0`. So every reconnect asks the server to replay the
**entire** event log from the beginning.

And the client has no defense: `es.onmessage` calls `driveRender(...)` on every
message, and `driveRender` **appends** (`driveAddEv` → `t.appendChild`,
`app.js:3800-3809`). There is no client-side high-water `seq`, no dedup, no
"clear before backfill." `seq` is never even read on the client. So a replayed
backfill is appended on top of whatever is already in `#dv-transcript`.

### Why this produces each symptom

**Symptom 2 (resume) is the direct case.** `resumeDrive` clears the DOM via
`renderDriveView` (`app.js:3577`, `innerHTML = ...`) and then calls
`driveOpenStream(id, 0)` — so the *first* paint is clean. The duplication arrives
on the **next reconnect**: any network blip, server heartbeat gap, or proxy idle
timeout drops the SSE; native EventSource reconnects to `?after=0`; the whole log
re-appends under the existing transcript. Mobile networks blip often, so over a
session you accumulate 2×, then 3×. Each reconnect = one more full copy.

**Symptom 1 (background return) is the same mechanism, triggered by Safari.** iOS
Safari suspends a backgrounded tab and tears down or freezes its network
connections. On return, the frozen/closed EventSource reconnects — again to
`?after=0` — and the entire transcript is re-appended **below** the copy that was
already on screen. That is the "reprinted entire history."

The scroll oddity is a side effect of the doubled DOM:

- Before backgrounding you were pinned at the bottom; `scrollTop ≈ scrollHeight`.
- The replay **doubles** `scrollHeight` by appending a second full copy.
- Safari restores the *saved pixel* `scrollTop` on tab resume (and its scroll
  restoration runs after our `driveScroll` snap, so the bottom-pin loses). That
  saved pixel offset, which used to be the bottom, now lands at the **midpoint** of
  a document that is twice as tall — exactly the boundary between the original copy
  and the replayed copy, i.e. your **first message again**.
- Scroll down past the duplicate to reach the true latest; scroll up through the
  duplicate to the original first message at the top.

## What it is *not*

The user's hunch ("a duplicate watcher" / "a Claude session that never exited")
is a reasonable guess but not the cause:

- **Not double execution.** The agent runs once; `seq` numbers are unique
  server-side. Only the *client transcript* doubles. (The reported "execution speed
  proves the work isn't re-run" is correct.)
- **Not a second watcher.** Hosted Drive runs no `vbrt watch` at all
  (`DRIVE_CONVO_INGEST_GAP.md`); ingest is event-triggered on turn-end. `_drivePoll`
  (`app.js:3513`) is only a workspace-clone refresh timer — it renders no transcript
  events.
- **Not orphaned EventSources (usually).** `driveOpenStream` closes the prior `es`
  before opening a new one (`app.js:4026`), and `suspendDrive` closes it on every
  navigation away (`app.js:3654`). The duplication is the *single* socket reconnecting
  to `after=0`, not two live sockets. (One latent exception below.)

### Checked and cleared — the adopt replay

When the in-memory `Map` was wiped (redeploy) and resume falls through to
`POST /sessions/adopt` (`app.js:3695`), `adoptSession` *"replays the saved
transcript into the event log"* (`src/agent.js:590-591`) so a fresh `after=0`
backfill works. I checked whether this could itself double the server log and it
**cannot**: adopt mints a fresh `createSession` (empty `events`/`seq`) before
replaying (`src/agent.js:612`), and it has an idempotency guard that returns the
existing session if a live record already wraps the same claude id
(`src/agent.js:599-601`). So the server log holds exactly one copy. No change
needed there; the duplication was entirely the transport bug above.

## Shipped (2026-06-20) — the fix

The server already had the right primitive (`seq`); the work was wiring real SSE
resumption and making the client idempotent. Belt and suspenders, because mobile
reconnects are messy.

1. **Server emits `id: <seq>` per event and honors `Last-Event-ID`**
   (`src/agentRoutes.js:201-217`). Each frame is now
   `id: <seq>\ndata: <json>\n\n`, and the backfill floor prefers the
   `Last-Event-ID` header over the connect-time `?after` query param:
   `const after = Number.isFinite(lastEventId) ? lastEventId : (Number(req.query.after) || 0)`.
   This alone makes the *native* auto-reconnect gapless and dupe-free — the textbook
   SSE behavior the original comment already claimed but never delivered.

2. **Client tracks a high-water `seq` and drops anything at/below it**
   (`driveOpenStream`, `public/app.js`). `state.drive.lastSeq` is seeded from the
   `after` argument and advanced on every frame; `onmessage` returns early when
   `ev.seq <= lastSeq` *before* `driveRender`. This makes the transcript idempotent
   regardless of how the reconnect happens — it covers proxies that strip
   `Last-Event-ID`, the `resumeDrive` re-entry path, and the visibility resync below.
   This is the single most robust guard.

3. **A `visibilitychange` resync** (`wireDriveVisibilityResync`, wired once). On
   `document.visibilityState === 'visible'` while a Drive session is open, the
   client proactively closes and reopens the stream from `lastSeq`. iOS Safari does
   not reliably fire `error` on a socket it froze while backgrounded, so the native
   auto-reconnect may never fire on return; this makes Symptom 1 deterministic. The
   seq dedup (2) makes a redundant resync a harmless no-op.

4. **Adopt was checked and needed no change** — it already mints a fresh session and
   guards against a duplicate live record (see "Checked and cleared" above).

Items (1) + (2) fix both reported symptoms; (3) hardens the Safari-background edge
that the browser itself can miss. A manual `error`-driven reconnect was considered
and skipped: with `id:`/`Last-Event-ID` in place the native auto-reconnect is
already correct, and the seq dedup catches anything it misses.

## TL;DR

The Drive transcript duplicated because the **SSE stream replayed from `after=0` on
every reconnect** (the server emitted no `id:` line, the client URL was fixed at
`after=0`) and the **client appended the backfill with no `seq` dedup**. Mobile
Safari backgrounding and the resume button were just two ways to trigger a
reconnect. The doubled-DOM plus Safari's pixel scroll-restoration explains the
"first message in the middle, history reprinted" symptom. **Fixed** by emitting
`id: <seq>` + reading `Last-Event-ID` server-side, tracking a high-water `seq` to
drop already-seen events client-side, and a `visibilitychange` resync for the
frozen-socket case Safari never reports.
