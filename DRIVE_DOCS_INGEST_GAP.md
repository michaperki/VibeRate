# Drive re-ingests brain docs at turn end (the docs-ingest gap — closed)

> Status: **CLOSED 2026-06-21** (documented + fixed same day). Sibling of
> `DRIVE_CONVO_INGEST_GAP.md` (turns) and `DRIVE_LIVE_STREAM_DUP.md` (streaming) —
> same root shape: the Drive write-path didn't feed every surface the read-only
> capture pipeline used to feed. This one was about the **brain doc network**. It
> now closes the same way the others did: the Drive runtime owns the process, so at
> turn end it refreshes the bound project's docs directly — no manual `vbrt push`.
> The history below is kept as the record of the bug and the shape of the fix.

## Symptom

A Drive session creates or edits `.md` files (e.g. adds `STORY.md`, updates
`CLAUDE.md`), commits, and the app redeploys — **but the brain in the dashboard
doesn't show the new/changed docs.** The CLAUDE.md node still renders its old
content; a newly-added doc never appears as a node.

This surfaced on 2026-06-21: a Drive session added `STORY.md` + a `CLAUDE.md`
pointer to it, `git push`ed to main (which triggers the Fly deploy), and the
operator correctly expected the `STORY.md` node to appear. It didn't.

## Cause: two separate pipelines, and the wrong one ran

The hosted brain does **not** read the repo live. It serves a **stored docs
bundle**:

- `GET /api/projects/:slug/docs` → `getDocs(slug)` (`src/server.js:365`), which
  reads previously-saved docs from storage (`src/storage.js:281`).
- That store is written **only** by `saveDocs` (`src/storage.js:274`), called from
  `saveBundle`/`ingestBundle` (`src/storage.js:39`).
- The doc set itself is produced by `extractDocs` (`src/docs.js:55`), and the
  **only** caller of the `extractDocs → saveDocs` chain is the CLI push/watch path
  (`bin/vbrt.js:250`, `extractDocsMulti`).

So the brain's doc set is refreshed by exactly one thing: **`vbrt push` /
`vbrt watch`** (the read-only capture pipeline).

What actually ran instead:

- **`git push` → Fly redeploy** ships the **server code**, not any project's
  **data**. (This is why landing-copy edits go live but brain docs don't.)
- **Drive's auto-ingest** (`src/driveIngest.js`) refreshes **conversation turns**
  (`ingestDriveTurn`) and **evidence/shots** (`forwardTurnEvidence`) — and nothing
  else. It never calls `extractDocs`/`saveDocs`, so doc changes made *by a driven
  session* are invisible to the brain until a separate push.

Net: a git commit + redeploy touches neither the docs bundle nor the conversation
store's doc view. The brain shows the last-pushed snapshot.

## Secondary detail: not every `.md` is a node

`extractDocs` seeds from a **known list** of root files (`src/docs.js` `KNOWN`:
`CLAUDE.md`, `README.md`, `ROADMAP.md`, `SEED.md`, …) plus `.agent/*.md`, then
**crawls `.md` references** transitively (`mdRefs`, `src/docs.js:45`). `STORY.md`
is **not** in `KNOWN`, so it becomes a node **only because** `CLAUDE.md` now
mentions `` `STORY.md` ``, which the crawler follows. Takeaway: a new doc that
nothing references will never appear, even after a correct push — link it from a
seed (e.g. the CLAUDE.md index) or it stays orphaned.

## Fix (shipped 2026-06-21)

Docs are now wired into Drive's ingest the same way turns and evidence already
were. At turn-end — in `ingestDriveTurn` (`src/driveIngest.js`), right after the
transcript and evidence forward — a new `forwardTurnDocs(slug, session)`:

1. re-runs `extractDocs(session.cwd)` over the **live workspace checkout** and
   `saveDocs(slug)` — so a node added/edited this turn appears immediately;
2. re-runs `extractGit(cwd)` + `saveGit(slug)` so the timeline picks up the turn's
   new commits;
3. rebuilds per-doc history via `extractDocHistory` + `saveDocHistory(slug)` so the
   brain **time-travel scrubber** shows the new versions.

Crucially every write is **keyed by `slug`, never `cwd`** — exactly like
`ingestDriveSession` — so it can't repoint `manifest.cwd` at the host's checkout
path and fork the project from the user's real repo on a later local push. The
whole thing is best-effort and wrapped in try/catch: a docs refresh can never break
turn ingest (and the server's `setIngestHook` already swallows errors above it).

The "what counts as a brain doc" logic that decides which committed `.md` get
time-travel history (`AGENT_DOCS`, `BRAINISH`, and the `brainBasenames(docs,
commits)` helper) now lives in **`src/docs.js`** as the single source of truth,
shared by both the capture path (`bin/vbrt.js` `assembleBundle`) and this Drive
refresh — previously the constants were duplicated in `bin/vbrt.js`.

Note the secondary detail above still holds: a **new doc that nothing references**
won't node even after this fix — link it from a seed (e.g. the `CLAUDE.md` index)
or it stays orphaned. (`STORY.md` nodes only because `CLAUDE.md` mentions it.)

## Workaround (no longer needed; kept for older containers)

Before this fix you had to re-run the docs ingest by hand: **`vbrt push`** (or
`vbrt watch`) from the workspace, rebuilding the bundle from the checkout to refresh
`getDocs`. Caveat in a fresh Drive container: there's no `.vbrt/project.json`
binding and push derives the slug from the cwd — so you had to confirm it targeted
the **existing** project (with the owner token) lest it mint a duplicate. With the
turn-end refresh in place this is only relevant in an *old* container running from
before the redeploy.

Related: `STORY.md` (Ch. 10 records this kind of Drive-vs-capture seam),
`DRIVE_CONVO_INGEST_GAP.md`, `ARCHITECTURE.md` (the pipeline shape).
