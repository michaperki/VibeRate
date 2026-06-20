# Reconciling the two convo surfaces — Drive ⇄ the conversation reader

> Status: **research pass, no code changes.** Documents the current split, why
> the two surfaces are the *same object* rendered twice, and the reconciliation
> options (to be mocked/toggled for a decision, not picked unilaterally).
> Companion to `PLAN_AGENT_RUNTIME.md` (Drive) and `PROJECT_VIEW_PLAN.md` (reader).

## The observation that started this

We now have two places that show a conversation:

1. **The reader** — click a convo (or a prompt) in the rail, land in
   `#conversation`. Read-only, historical, *rich*.
2. **Drive** (`/drive`) — create a session and chat with a live agent. Write,
   live, *plain*.

They look like two different products, but they are the same thing — a
conversation — drawn by two disjoint codebases off two different data sources.
This doc is the case for merging them, and the seams that make it non-trivial.

## What each surface actually is today

### Read surface — the reader (in the SPA)

- **Entry:** rail row → `selectSession(slug, id, turn)` (`app.js:2579`).
- **Data:** the *bundle*. `GET /api/projects/:slug/sessions/:id/prompts`
  returns **prompt units** — JSONL parsed post-hoc into `{ before, prompt,
  after.steps, archetype, outcomeArtifact, evidence, context, attachments }`.
- **Render:** `renderSessionReader` → `renderReaderCard` per unit (`app.js:2603`,
  `2957`). This is where all the richness lives:
  - archetype pill (`renderArchetype`, `classify.js`'s 12 archetypes),
  - context-fullness gauge (`contextGauge`),
  - before / "how it played out" disclosure,
  - **the polymorphic outcome rail** (`renderOutcomeRail`, `app.js:2938`):
    `shot` / `diff` / `test` / `options` / `experiment` families, each with a
    bespoke renderer and placement (`ARCH_FAMILY`, `FAMILY_PLACEMENT`),
  - pasted/agent attachments + `vbrt shot` evidence.
- **Trust:** public / shareable (`/c/:cardId` permalinks). No execution.

### Write surface — Drive (`public/drive.html`, standalone)

- **Entry:** `/drive`, its own HTML/CSS/JS, not part of the SPA shell
  (`index.html` only mounts `#home / #sessions / #conversation`).
- **Data:** the *live process*. `POST /api/agent/sessions` spawns the real
  `claude` binary; `GET /api/agent/sessions/:id/stream` is an SSE feed of
  normalized events (`agent.js`).
- **Render:** `render(ev)` over a flat `#transcript` of `.ev` bubbles
  (`drive.html:248`): `user_prompt`, `assistant_text(_delta)`, `thinking`,
  `tool_use`, `tool_result`, `result`, `ask`. Token-streaming bubbles.
- **One piece of richness:** `renderAsk` (`drive.html:186`) — the inline picker
  for the `mcp__viberate__ask` tool. **This is the `options` archetype rendered
  as an input widget.** The polymorphism already leaked across the boundary.
- **Trust:** RCE control plane. Gated to an admin-email allowlist when hosted
  (`server.js:139`), deny-by-default.

## The linchpin: they are already the same log

`agent.js:4-7` (verbatim intent):

> we spawn the user's real installed `claude` binary with stream-json in/out, so
> the session runs with their actual auth/config and **the per-session JSONL the
> watcher already tails gets written as a side effect**.

So a Drive session writes the **same JSONL** that `vbrt watch` / `vbrt push`
ingest into prompt units. Concretely:

```
Drive turn (live) ──spawns──> claude binary ──writes──> ~/.claude/…/<session>.jsonl
                                                              │
        SSE stream (hot view)                                 │ push / watch
        drive.html transcript                                 ▼
                                              bundle → prompt units → reader card (cooled view)
```

**The reader card is the cooled form of the Drive transcript.** Same underlying
conversation; "hot" while the turn streams, "cold" once parsed/classified. That
makes the merge a *rendering* problem, not a *data-modelling* one — we are not
unifying two objects, we are admitting they were one.

## Where the archetype/polymorphism layer fits

The archetype system (`classify.js` → `ARCH_FAMILY` → `renderOutcomeRail`) is the
bridge, not a third thing to reconcile:

- Today it runs **at ingest**, on the cooled bundle, and decides the *output*
  format of a finished prompt (which outcome rail to draw).
- In a merged surface it can also shape the **input**: classify the prompt as
  it's submitted in Drive and pick the affordance. The `options` → picker card
  in `renderAsk` is a working proof that an archetype can drive a *live* widget,
  not just a post-hoc rail. `screenshot` could invite a paste/dropzone;
  `experiment` could offer expected/actual fields; `spec` could show the
  deliverable target. Same classifier, two ends of the same conversation.

So "reconcile the two surfaces" and "lean into archetype polymorphism" are the
same move: one convo object, classified once, rendered hot (composer affordance)
and cold (outcome rail) by the same archetype.

## Reconciliation options (to mock/toggle, not decide here)

Per the project's decision method, these are forks to put in front of Mike, not a
pick. Ordered by blast radius.

### Option A — One component, two mounts *(lowest risk)*

Extract a `ConvoView` that accepts **either** a live SSE stream **or** a cooled
bundle, and have both `/drive` and `#conversation` mount it. The reader keeps its
rich card vocabulary; Drive keeps its composer + RCE gating. They stop diverging
because they share a renderer.
- Keeps the trust boundary intact (composer stays a separately-gated slot).
- Doesn't yet give you "type into a historical convo."

### Option B — Drive becomes the live head of the reader *(the real merge)*

`#conversation` grows a composer at the bottom when the session is live and
driveable. Streamed events render as **provisional** reader cards that "cool"
into parsed cards on `result`. One rail, one card vocabulary, one URL. Clicking a
historical convo and picking up the thread are the same gesture.
- Biggest job: reconcile the two event models — raw stream events
  (`assistant_text_delta`, `tool_use`) vs. the parsed prompt-unit shape — so a
  card can render mid-stream and re-render cooled without flicker.
- The composer/driveability **must stay behind the admin/RCE gate** even though
  the surrounding read view is public. Merging surfaces ≠ merging trust
  boundaries — call this out loudly.

### Option C — Historical convos open inside the Drive shell

Invert B: open cooled convos in Drive's chat layout, read-only until you resume.
- Simpler chat UX, but loses the outcome rail / context gauge / archetype rail
  unless they're ported into Drive (which is just B with more porting).

## Seams / open questions for whichever option wins

- **Identity join.** A Drive session has `claudeSessionId` + `cwd`; a bundle
  session has slug + parsed `sessionId`. Confirm the Drive `claudeSessionId`
  equals the JSONL session id the parser keys on, so the live convo and its later
  cooled card resolve to **one** rail entry instead of appearing twice.
- **Hosted vs local.** The reader is happily hosted/shareable; Drive is local-RCE
  (or admin-gated). A merged surface needs the composer to *disappear* when the
  viewer lacks drive rights, degrading to today's read-only reader.
- **Provisional → cooled handoff.** Define the swap precisely: stream events
  accumulate into a draft card; on turn end, replace with the parsed unit
  (archetype, outcome rail, evidence). Keep open `<details>`/scroll state across
  the swap (the reader already does this for live follow — `app.js:2777`).
- **Two CSS vocabularies.** Drive's `.ev` bubbles vs. the reader's `.pcard`. A
  merge picks one; the reader's is the richer and the one users share.

## TL;DR

The convos rail + reader and Drive are not two features — they are the **read**
and **write** ends of one conversation that already share one JSONL on disk. The
archetype/polymorphism layer is the hinge between them (cold: outcome rail; hot:
input affordance). The merge is a rendering unification, gated by one hard
constraint: **share the convo component, never the RCE trust boundary.**
Recommend mocking Option A (shared component) and Option B (live head of the
reader) side by side for the call.

## Decision (2026-06-19)

**Merge = port Drive's runtime into the reader. The SPA is the surviving shell;
`drive.html` is disposable.** This is Option B, with the host-shell question
resolved.

Rationale — the two framings ("port Drive into convos + delete Drive" vs. "grow
Drive to have the convos picker + brain, then delete the old thing") land on the
same screen but cost wildly different amounts:

- **The runtime survives untouched.** The browser→`claude` capability Drive
  proved out lives in server modules — `src/agent.js`, `src/agentRoutes.js`,
  `src/mcpAsk.js` — already mounted in the *same* Express app that serves the
  reader (`server.js:139`). The merge does not move it.
- **Only `drive.html`'s front-end is disposable** (~350 lines: stream rendering +
  the `renderAsk` picker). It folds into the reader as a composer + a
  provisional-cards-that-cool-on-`result` path.
- **The SPA keeps what Drive never had** — project picker, brain (time-travel,
  live ring-fills, health), timeline, rail, sharing, the hosted/public auth
  model. Growing Drive into all of that would mean re-implementing the entire SPA
  under the thinner page: same result, far larger surface and regression risk.

So: same destination, but porting the runtime into the SPA moves ~350 lines while
growing Drive rebuilds the whole product. We port into the SPA.

### Constraints carried into execution

1. **Never merge the trust boundary.** The reader is public/shareable; the
   composer is an RCE control plane (admin-gated when hosted, `server.js:143`).
   Render the composer **conditionally** — present when you hold drive rights in
   your own cwd, absent (degrading to today's read-only reader) on a shared/public
   view. One component, gated slot.
2. **Delete `drive.html` last, not first.** Keep it as a fallback dev harness
   until the in-reader composer is proven on a real session, then remove it in the
   same change that flips the default — avoiding a window where the only way to
   drive is half-built.

## Shipped — Drive sessions are resumable; "live" → "follow"

The first reconciliation step landed: navigating away from Drive no longer strands
the session, and the `vbrt watch`-era "live" toggle is reframed for the watcher-free
world.

- **A driven session is now a first-class, resumable handle.** `state.driveActive`
  (`{ id, project, claudeSessionId, cwd, status }`) is the durable record, mirrored
  to `localStorage` so it survives a reload. It's distinct from `state.drive`, the
  *live view binding* (the SSE) that only exists while the Drive view is open.
- **Navigation suspends, it doesn't kill.** `selectSession`, `showHome`,
  `selectProject`, and the `← dashboard` button all route through `suspendDrive()`:
  close the SSE/poll bindings, hand `#conversation` back, but keep the handle. The
  session keeps running server-side (the child is spawned *per turn* — between turns
  it's just an entry in the agent `Map`), so this costs nothing.
- **Return affordances.** The project bar shows **"✦ Return to Drive"** (in
  live-red) when a session for the project is suspended; the rail's live driven
  convo (provisional card *and* the cooled real card) is clickable to re-enter.
  `resumeDrive()` reconnects via `GET /sessions/:id/stream?after=0`, replaying the
  server's buffered events to rebuild the transcript, then continues live. A 404
  (server redeploy wiped the in-memory `Map`) drops the stale handle and falls back
  to the ingested transcript in the read-only reader — one timeline, both doors.
- **"Live" → "Follow".** The toggle's old meaning was capture-mode ("a `vbrt watch`
  is pushing, so poll"). With Drive ingesting watcher-free on turn-end, it's now a
  pure *view* signal: "follow this project/conversation; animate updates as they
  land," regardless of source. Labels are now **Follow / Following**; inside Drive
  there's no toggle at all — the SSE stream is inherently live.
