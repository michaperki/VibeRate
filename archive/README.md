# Archive

Historical brain docs that have served their purpose. They're kept for provenance
(the decisions and bug diagnoses are real history) but moved out of the repo root so
they no longer clutter the live **brain graph** — `src/docs.js` deliberately skips the
`archive/` path when extracting brain nodes. Full git history is preserved (these were
`git mv`-d, not rewritten).

The living narrative that supersedes most of this is **`STORY.md`** (the project's
prose history). Where a doc's conclusion lives in STORY, that chapter is noted below.

## `experiments/` — dogfooding logs (June 17–18)

Throwaway apps an agent built purely to stress-test VibeRate's capture/publish loop on
real, varied runs. The point was never the toy apps — it was hardening the tooling
(`vbrt shot`, `vbrt doctor` were born here). Narrated in **STORY.md Ch. 4**.

- `EXPERIMENT_CONVO.md`, `EXPERIMENT_CONVO_2.md` — captured agent conversations
- `EXPERIMENT_LIFE.md` — Conway's Game of Life run
- `EXPERIMENT_MAZE.md`, `MAZE_3.md`, `MAZE_4.md`, `MAZE_EXPERIMENT_LOG.md`,
  `MAZE_RESULT_2.md` — the maze generator/solver experiment series
- `EXPERIMENT_SORT.md` — sorting visualizer run
- `PROMPT_GALLERY.md` — the research pass over 4,879 of Mike's real prompts that
  surfaced the 12 prompt archetypes. Concluded; its finding ("different archetypes
  demand different evidence") shipped as the polymorphic outcome rail (STORY Ch. 5).

## `drive-reconciliation/` — the Drive ingest saga (June 19–21)

Diagnosis + fix records for the bugs hit while making a *driven* session's output flow
back into the captured history. All **shipped/resolved**. Narrated in **STORY.md Ch. 7**.
Each had the same shape: the read-only capture pipeline fed a surface the write-path
didn't, and the Drive runtime closed the gap at turn-end by feeding that surface itself.

- `DRIVE_CONVO_RECONCILIATION.md` — the conceptual call that Drive and the reader are
  two views of one JSONL (live head / cooled history)
- `DRIVE_CONVO_INGEST_GAP.md` — hosted Drive turns reaching the Convos rail (transcript
  + evidence), watcher-free
- `DRIVE_DOCS_INGEST_GAP.md` — a driven turn's `.md` edits refreshing the brain at
  turn-end (no manual `vbrt push`)
- `DRIVE_LIVE_STREAM_DUP.md` — killing SSE reconnect-replay duplication on mobile

## Loose

- `BRAIN_3D_ASSESSMENT.md` — adjudication of the 3D/WebGL brain prototype. Verdict:
  keep the 2D brain as the centerpiece, ship 3D only as an opt-in layout if ever
  (STORY Ch. 8). Decision is final.
- `DOGFOODING.md` — the milestone that Drive could develop VibeRate itself, plus the
  no-instant-preview friction it surfaced. That friction is now **solved** by the
  `VBRT_PREVIEW_BASE` live-preview route (see `CLAUDE.md`), so the doc is history.
- `LIVE_ORCHESTRATION.md` — working notes for the live-dashboard legibility pass
  (ticker, hooks, `vbrt watch --tui`). Closed work-arc (STORY Ch. 5).
