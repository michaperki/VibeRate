# The Drive → Convos ingest gap (and the product framing behind it)

> Status: **the ingest bridge is SHIPPED (2026-06-20); the UI merge is not.**
> Companion to `DRIVE_CONVO_RECONCILIATION.md`. That doc decided the *rendering*
> merge (Option B, 2026-06-19). This one records the loose end it missed — there
> was **no hosted path that got a Drive session into the rail at all** — the fix
> that closed it, and the product framing for why the convos rail is not legacy
> cruft. See the "Shipped" section at the end for what landed.

## The observation

A Drive session started from the deployed site does **not** appear in the Convos
rail. A session captured locally (this very development conversation) does. The
two behave differently, and the difference is not cosmetic.

## Why — the capture pipeline has no hosted ingest path

`DRIVE_CONVO_RECONCILIATION.md` argues Drive and the reader are "already the same
JSONL on disk," so the merge is a rendering problem. **That is true locally and
false in production**, and the gap is the whole bug.

The capture pipeline (`vbrt watch` / `vbrt push`) is a filesystem-diff poller
designed for an **external observer** — your laptop tailing a Claude Code it did
not spawn. It discovers `~/.claude/projects/<…>/<id>.jsonl`, parses it into
prompt units, assembles a bundle, and pushes it to the server.

In **hosted Drive**, that chain has no driver:

1. **Nothing runs `vbrt watch` server-side.** The only `watch` references in
   `src/` are comments (`server.js:34,306`, `agent.js:3,7`). No watcher process,
   no push loop runs on the Fly machine.
2. **Local `vbrt push` cannot see it.** The Drive session's JSONL is written onto
   the **Fly volume** (the spawned `claude` binary's `CLAUDE_CONFIG_DIR`), not the
   user's machine. The user is not `cd`'d into that checkout; it lives on the host.
3. **The live session is in-memory only.** `agent.js:228` — `const sessions = new
   Map()`. `listSessions()` enumerates that map. A Fly redeploy, crash, or machine
   sleep wipes every Drive transcript.

Net: a Drive session today is **doubly unpreserved** — ephemeral in memory, plus
an orphaned JSONL on the volume that no pipeline ever ingests. The reconciliation
doc flags "hosted vs local" only as a *trust-boundary* seam; it never noticed that
**ingest itself has no hosted path.**

```
Drive turn (hosted) ─spawns─> claude binary ─writes─> <Fly volume>/.claude/…/<id>.jsonl
        │                                                     │
        ▼ SSE (hot view, in-memory)                           ▼  ← NOBODY READS THIS
   transcript bubbles                                    (no watch, no push, no ingest)
        │                                                     ✗
        ▼ server restart                                 never becomes a bundle
   gone                                                  never appears in the rail
```

## The fix shape — event-triggered ingest, not a watcher

`vbrt watch` is the wrong tool here. Watch exists to observe a process you did
**not** spawn. In Drive the server *is* the spawner: it already holds the stream
events (`handleRawEvent`), the `claudeSessionId`, and the exact JSONL path.
Polling a file you are actively writing — via a second process and a lock file —
to rediscover data you already hold is backwards.

Direct path instead: **on the `result` event, ingest that one session into the
project bundle.** Parse the JSONL the turn just finished writing (path is known
from `claudeSessionId` + `cwd`) and call the same `saveBundle` / `ingestBundle`
storage path the push pipeline already uses. Event-triggered, not poll-triggered.
No new process, no lock file. It is "watch, but pushed by the writer instead of
pulled by a watcher."

The JSONL stays the source of truth (so the cooled card keeps full richness — tool
calls, archetypes, outcome rails), but ingestion fires *when the writer knows the
turn ended*, not on a 1s filesystem diff.

This is also a **prerequisite for Option B**. The reconciliation doc's
provisional-card-that-cools-on-`result` flow assumes a cooled card exists to swap
to. In hosted mode it never gets created. Close ingest first; the UI merge is moot
until a Drive session can become a rail entry at all.

## The product framing — Convos is not legacy cruft

The anxiety driving this ("Drive is a bigger capability; the watch-only convos
panel feels useless") inverts the right mental model. The convos rail is not
*behind* Drive — it is the **durable substrate Drive should be writing into**.

- **Drive = the write head.** Live, RCE-gated, present-tense. The cursor at the
  *end* of the log.
- **Convos / reader = the log.** Durable, shareable, rich, time-travelable.
  Past-tense.

They are one timeline. An agentic IDE needs both tenses: drive a session, then
return, read how it played out, branch from it. What is actually weak is not the
*concept* of convos — it is (a) two disjoint codebases (the reconciliation doc's
point) and (b) the missing hosted bridge from write head to log (this doc's point).
Close the bridge and "convos is useless" dissolves: every Drive session becomes a
returnable, classified, rich card for free.

The move is therefore **not** "modernize convos to catch up to Drive." It is the
opposite: make Drive write *into* convos, so the rail is the single home for every
session regardless of origin (externally captured **or** Drive-created).

### One honest caveat that cuts the other way

The 12 archetypes were reverse-engineered from **Mike's personal** message
taxonomy in the watch-only era. The *mechanism* — classify once, render
polymorphically (cold: outcome rail; hot: input affordance) — is the moat and
survives intact. Whether those *specific 12 labels* generalize to other users is a
genuine open question. But that is a "retune the classifier" problem, not a
"convos is obsolete" problem. Do not let the second conclusion ride on the first.

## TL;DR

1. Drive sessions miss the rail because **hosted ingest does not exist** — no
   server-side watch/push, and the JSONL is stranded on the Fly volume while the
   live session lives only in an in-memory `Map`.
2. The fix is **event-triggered ingest on `result`**, reusing the existing
   `ingestBundle` path — not a server-side `vbrt watch`.
3. The convos rail is the **durable log Drive writes into**, not legacy to retire.
   Bridge first (ingest); UI-merge second (Option B); retune the archetype labels
   for multi-user as a separate, later question.

## Shipped (2026-06-20) — the ingest bridge

Step 1 (the bridge) is done. A driven turn now folds itself into its bound
project's rail with no watcher, no second process, no lock file:

- **`src/driveIngest.js`** (new) — `ingestDriveTurn({ projectSlug, claudeSessionId })`.
  Locates the per-session JSONL under `claudeConfigDir()/projects/*` (which honors
  `CLAUDE_CONFIG_DIR` — the bug the capture-side `claudeRoots()` could never see),
  parses it with the same `parseClaude` the capture pipeline uses, and ingests it.
- **`src/storage.js`** — `ingestDriveSession(slug, session)` folds one parsed
  session into an *existing* project **without** rewriting the manifest's
  `cwd`/`owner`/`visibility`/`repoUrl`. Critical: a Drive checkout's path differs
  from the project's captured repo path, so the normal `saveSessions` cwd-rewrite
  would fork the project from the user's real repo on their next local push.
- **`src/agent.js`** — threads `projectSlug` into the session and, on each turn's
  end (when a `claudeSessionId` exists), fires an **injected** ingest hook
  (`setIngestHook`, mirroring `setBaseUrl`). The runtime stays storage-agnostic;
  the JSONL stays the source of truth. Re-ingest on follow-up turns upserts by id,
  so a growing convo refreshes one rail entry instead of duplicating.
- **`src/server.js`** — wires the hook to `ingestDriveTurn`, then re-runs
  `classifyProject` so the cooled Drive card earns its archetype + outcome rail
  like any captured convo.

**Why event-triggered, not a server-side `vbrt watch`:** the runtime *owns* the
process, so it already knows the session id the instant the turn ends. Polling a
file you just wrote — via a second process and a lock — to rediscover data you
hold is backwards. Ingest fires on the `turn_end` you already emit.

### Shipped next (2026-06-20) — the same-view live-merge (Option B)

The seam below is now closed. A streaming Drive turn renders **in the Convos rail
as a provisional card that cools in place**, without leaving the Drive view:

- **`public/app.js`** — while Drive owns `#conversation`, the rail (`#sessions`)
  stays visible beside it. `state.driveProvisional` (`{ project, sessionId,
  prompt, status }`) describes the in-flight turn; `driveProvisionalRow()` draws it
  as a dashed, pulsing `prompt-row` at the top of the rail. It's seeded on the
  `user_prompt` event and learns its `sessionId` from the `system` event.
- **Cooling.** On the `result` event, `driveCoolProvisional()` flips the card to
  "cooling…" and polls the bundle (`driveRefreshRail`) until the server's turn-end
  ingest surfaces the real parsed unit — then drops the provisional so the cooled
  card (archetype, outcome rail) stands in its place, flashed via
  `_liveFreshPrompts`. Bounded (~15 tries); a no-op ingest just leaves "cooling…".
- **Dedup / continuity.** The provisional is suppressed the instant its
  `sessionId` appears among the real units, so it never doubles the cooled card.
  `isDrivingSession()` badges the real card "● live" while you keep driving, so a
  follow-up turn reads as the same live convo rather than spawning a second
  provisional.
- **Trust boundary untouched.** This is pure rail rendering off data the read APIs
  already return; the composer/RCE gate is unchanged.

### Original known limit (now resolved by the above)

Ingest lands the convo in the *stored* manifest; it did not yet live-merge into
the rail **while you're still in the Drive view**. Return to the project (or
reload) and the convo is there — and since ingest bumps `lastPushAt`, the project
auto-enters Live mode. Making a streaming Drive turn render as a provisional rail
card that cools in place is exactly Option B's "live head of the reader." The
durable-preservation requirement ("return to a Drive session later") was met by
the bridge; the same-view live-merge is the work shipped above.
