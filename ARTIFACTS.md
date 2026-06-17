# Artifacts — evidence the agent captures for a prompt (`vbrt shot`)

> Status: **screenshot + motion-clip families shipped; broader outcome rail open**.
> Follows the research in `PROMPT_GALLERY.md` and feeds the polymorphic **outcome
> rail** (`PROJECT_VIEW_PLAN.md §C`). Mock of the per-archetype renderings:
> `prototypes/outcome-artifacts.html`.

## Why

A prompt is more legible when you can *see what it produced*. `PROMPT_GALLERY.md`
found that the dominant evidence is **diffs / test-status / provenance** (already
captured) — but the one artifact that needs a deliberate capture step is the
**screenshot** (and later gif / multi-viewport) for UI work. This is that step.

## Principle: trivial for the agent, cheap on context

The agent shouldn't have to think about sessions, turns, or ids. It runs **one
line** mid-task and keeps working:

```
vbrt shot https://<your-app>.fly.dev --label after --note "wired the dev-journal header"
vbrt shot ./shot.png                 --label before --note "baseline"   # image it already took
```

The URL is **your app's** (normally its **deployed** site — reachable for headless
capture and reflecting the shipped state; `localhost` only if that's where it runs).
Not VibeRate's URL — `push` already targets the host; `shot` captures the app.

Everything else is resolved for it:
- **Binding without ids.** `shot` resolves the *active session* = the repo's
  most-recently-written log (the turn that triggered this work), so artifacts land
  on the right conversation **even when several run at once**. Timestamp then only
  places it on the right *turn within that session* — so concurrent convos can't
  cross-contaminate. `--session <id>` overrides if ever needed.
- **No new upload step.** The shot is written to a repo-local sidecar
  (`.vbrt/evidence/*.json`, gitignored) and rides the **next `vbrt push`** — or
  streams live if `vbrt watch` is running. Image data is inlined (≤1.5 MB each),
  redaction skips it.

## Flow

```
agent makes a UI change → vbrt shot <url|img> --label after   (one line, no context cost)
   └─ resolveActiveSession(cwd) binds it → .vbrt/evidence/  → push/watch bundles it
        → server attaches it to the prompt whose [ts,next) window contains the shot
            → reader renders before/after on that prompt card
```

**before/after** is just two shots on the same prompt: take a `--label before`
baseline at UI init, a `--label after` once the change lands; they render side by
side. (Lone shots stand alone.)

## Capture engine

- **Image path** (`vbrt shot ./x.png` or `--image`): zero-dependency — register a
  screenshot the agent already produced with its own tooling. Works today.
- **URL** (`vbrt shot https://<your-app>.fly.dev`): the deployed app, captured
  headless via **Playwright if installed** (lazy import keeps the pushed skill
  dependency-free); otherwise a clear message says to pass `--image`. Reachable from
  the agent's env regardless of where it runs. Unlocks viewports/gifs later.

## Implementation checklist

- [x] `vbrt shot` CLI — url/image, `--label/--note/--viewport/--session/--pair`,
      arg validation, friendly usage. (`bin/vbrt.js`)
- [x] `src/evidence.js` — `recordShot` (sidecar + inline image), `resolveActiveSession`
      (most-recently-active log, parsed for the exact stored id), `readEvidence`,
      `attachEvidence` (session-scoped, ts-window placement).
- [x] Bundle/transport — `buildBundle` carries `evidence`; `assembleBundle` reads
      the full sidecar each push (idempotent); redaction preserves `data:image/…`.
- [x] Storage/serve — `saveEvidence`/`getEvidence`; the prompts + card endpoints
      attach evidence to units server-side.
- [x] Reader render — before/after strip on the prompt card (`renderArtifacts` in
      `public/app.js`, `.pc-artifacts` styles), click-to-zoom.
- [x] Rebuild skill bundle so the agent's `shot`/`push` include `evidence.js`.
- [x] **Motion clips** — `vbrt shot <url> --clip [seconds]` records via Playwright
      → animated gif (if `ffmpeg`) or webm (`media: 'video'`); the reader + lightbox
      render both as looping media. (`captureClip` in `src/evidence.js`.)
- [ ] **Exercise it** — fresh repo (next: a **sorting visualizer**, see
      `EXPERIMENT_SORT.md`): seed + dev-journal brain, run a few plans, capture
      before/after **and a clip** on the UI ones. Verify they stream in live.
- [ ] *Then:* viewport set / multi-shot; the other artifact families (diff,
      test-status, provenance) — mostly auto-derived, tracked in §C.

## Decisions (Mike's method — defaults, revisit if wrong)

- **Binding** → active-session + ts-window (not ts alone — concurrency-safe). ✔ Mike's call.
- **Curation** → *promote-to-enrich*: capture is cheap/continuous; deeper artifacts
  (the deliberate after-shot) attach to the prompts you care about. ✔ Mike's call.
- **Engine** → image-path now (no dep), Playwright-for-URL optional. Revisit if the
  agent would rather always hand us a file.
- **Shot target** → the app's **deployed URL**, not localhost. The before/after loop
  is *shot before → change → **deploy** → shot after* (the "after" reflects the change
  once shipped). Matches Mike's ship-it workflow; `shot` never points at VibeRate
  itself (`push` does that). The experiment seed should tell the agent to deploy,
  then shot the live URL. ✔ Mike's call.

---

When the families in `PROJECT_VIEW_PLAN.md §C` are all rendering and this has been
exercised on a real repo, this doc **archives** → graveyard ghost, per the loop.
