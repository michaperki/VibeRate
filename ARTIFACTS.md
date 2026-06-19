# Artifacts — evidence the agent captures for a prompt (`vbrt shot`)

> Status: **screenshot + motion-clip families shipped and exercised on a real
> experiment; agent-ergonomics gaps from that run fixed (`vbrt doctor`,
> repo-local Playwright resolution); broader outcome rail open**.
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
  dependency-free). Resolution tries the global/dev install first, then the **repo's
  own `node_modules`** (`resolvePlaywright(cwd)`) — so a `npm i -D playwright` in the
  project Just Works, instead of failing because the bundled client lives in the skill
  dir. If neither resolves, a clear message names the fix (install + `npx playwright
  install chromium`) and the `--image` fallback. Unlocks viewports/gifs later.
- **Preflight** (`vbrt doctor`): reports repo / watch / capture / clip / file-register
  readiness and prints the recommended `shot` command, so the agent doesn't probe
  capabilities by trial and error.

## Implementation checklist

- [x] `vbrt shot` CLI — url/image, `--label/--note/--viewport/--session/--pair`,
      `--click`/`--wait` (drive the page to a state a URL can't reach — modal/menu/detail
      view — via a thin `page.click`/`page.waitForSelector` pass-through),
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
  - ⚠️ **Pitfall (2026-06-18): the installed skill is a copy — rebuild it, per agent.**
    The Maze run 3 looked like "the agent ignores the clip / `doctor` guidance," but the
    agent had loaded a **stale `~/.codex/skills/viberate/SKILL.md`** (half the size of the
    repo's — no clip mandate, no "run `doctor` first"). `skill/SKILL.md` and `src/*` only
    reach agents via `node scripts/build-skill.mjs <dir>`, and it must be run into **both**
    `~/.claude/skills/viberate` and `~/.codex/skills/viberate`. The `vbrt` CLI is `npm
    link`-ed to the repo and stays live, which masks the staleness. Rule: rebuild both
    skill dirs after any `SKILL.md`/capture change, and verify the installed skill is
    current before drawing conclusions from an experiment run.
- [x] **Motion clips** — `vbrt shot <url> --clip [seconds]` records via Playwright
      → animated gif (if `ffmpeg`) or webm (`media: 'video'`); the reader + lightbox
      render both as looping media. (`captureClip` in `src/evidence.js`.)
- [x] **Exercise it** — done via the **sorting-visualizer** experiment (seed +
      dev-journal brain, multi-phase build, before/after + clip on the UI, streamed
      live). The run worked but surfaced two real ergonomics gaps, both now fixed:
      - **Capture resolution bug** — the agent installed Playwright *in the repo* and
        `vbrt shot <url>` still failed, because the bundled client did a bare
        `import('playwright')` that resolved against the **skill dir**, not the repo.
        It then burned tokens on `NODE_PATH` / patch-the-skill / write-own-capture
        detours. Fixed: `resolvePlaywright(cwd)` now falls back to the repo's
        `node_modules` (`src/evidence.js`); the error message names the two real
        options and says *not* to touch NODE_PATH; **`vbrt doctor`** preflights it.
      - **Protocol too heavy for a toy app** — ~8 brain docs + 10 artifacts where ~3
        were enough. Fixed in `skill/SKILL.md`: "scale the process to the work"
        (small-experiment mode) + a capture decision tree + a "trust `vbrt watch`,
        don't also `push --all`" rule.
- [x] **Re-run (iteration 2, Codex)** — confirmed the capture fix: `vbrt shot
      <localhost>` captured stills + clips on the first try, no Playwright spiral.
      Friction shifted from *tool* to *workflow*; the remaining items are publish
      resilience (429 + outbox), watch/push dedup, lean-by-default + `doctor` adoption,
      and a capturable-app-design tip — tracked in `ROADMAP.md` Phase 3. Note: the
      sort seed deliberately over-specifies docs/artifacts (it's a stress test), so its
      ceremony is *not* the product default.
- [x] **Re-run (iteration 3, Game of Life, lean seed)** — best yet: 4m39s, 3 light
      docs, 2 clips, capture direct, app designed around capturable URL params. Lean
      defaults landed without the seed forcing them. Capture/artifact friction is now
      essentially solved; the remaining friction is **state/status clarity** (is watch
      live, where's the project URL, what's queued, is a push needed) + the still-open
      **429** blocking the share-URL "reward moment" — both tracked in `ROADMAP.md`
      Phase 3 (`vbrt status`, enriched `watch.lock`, `shot` prints URL under watch).
- [x] **Re-run (iteration 4, status-clarity build)** — the artifact + publish loop is
      effectively closed: 4m16s, capture worked, **share URL surfaced during capture**
      (no hunting), **no 429**, final public link shipped. Overhead ~8–15%. Remaining
      issues are polish-level **workflow defaults** (lean docs harder, public/private
      clarity, require a clip on animated apps, commit-before-capture, end with
      `vbrt status`) — tracked in `ROADMAP.md` Phase 3, not artifact-capture problems.
- [x] **Maze series (experiment 5, runs 1–4, 2026-06-18)** — drove the capture loop to
      actually work for motion-first apps across Codex runs. Findings + fixes shipped:
      - **Cross-env capture was broken** — bare `chromium.launch()` hung under WSL/Snap.
        Fixed: one hardened launch config (`--no-sandbox --disable-dev-shm-usage
        --disable-gpu`) shared by the probe *and* `shot`/`clip` (`launchForCapture`), so a
        green `vbrt doctor` truly predicts capture. Plus `vbrt doctor --fix` to install
        Playwright + chromium on demand. (`src/evidence.js`, `bin/vbrt.js`.)
      - **Agent never reached for the clip path** — until the installed skill was rebuilt
        (it was stale; see the per-agent rebuild pitfall above). Once current, the agent
        ran `vbrt doctor` first and captured a clip.
      - **Fixed-length clips left long static tails** — a 6s clip of an animation that
        finished in <1s was mostly a frozen solved maze. Fixed: **motion-aware capture** —
        `--clip [s]` is now a *cap*; the clip records from first paint and **auto-stops
        when frames settle**, so length tracks real motion (button toggle → ~1s; long sim
        → cap). `captureClip` in `src/evidence.js`; CLI reports the auto-stopped duration.
- [~] *Then:* the other artifact families — **diff** + **test-status** shipped via the
      polymorphic outcome rail (`PROJECT_VIEW_PLAN.md §C`, Stages 1–2, 2026-06-18). The
      "broader outcome rail" that's still open, exploded into concrete work:

### Outcome rail — what's still open

Stages 1–2 already shipped a lot: the archetype→family router (`ARCH_FAMILY`/
`FAMILY_PLACEMENT`), the `shot` + `diff` families, the bespoke `railExperiment`/
`railOptions`/`railTest` renderers, and per-card `outcomeChips`. Each item below is
scoped to the **remaining** slice (what ships vs. what's open is called out), validated
against the code 2026-06-19. Deeper context in `PROJECT_VIEW_PLAN.md §C`.

- [ ] **Provenance layer** *(the big one).* The proof shown is still what the prompt
      *claimed*, not what the transcript *did*. *Ships:* `railDiff` lists the deliverable
      files + counts. *Open:* **real per-edit diffs** (deferred in `railDiff`'s own
      comment) and **executed/deferred** state on options menus (`railOptions` renders no
      ✓/▢ on purpose — faking it from keywords is brittle, `[[no-brittle-text-heuristics]]`).
      Needs a transcript↔artifact semantic match.
- [ ] **Follow-up classification.** *Ships:* per-prompt intent archetypes (`classify.js`,
      incl. a "positioning correction" archetype). *Open:* classifying the *relationship*
      between consecutive prompts — correction / continuation / approval — so the rail can
      show how a thread progressed (§C).
- [ ] **Prompt-quality-through-consequences** — surface signals like "needed
      clarification?", caused a retry, etc., as a rail cue (§C; no code yet).
- [ ] **Live visual check** of the **experiment** + **options** families (and scroll
      cost) on a real classified session — only the **test** family is verified
      end-to-end so far (§C Stage 2 is `[~]` for exactly this).
- [ ] **Multi-viewport capture.** *Ships:* single `vbrt shot --viewport WxH` (and `--pair`
      before/after). *Open:* capturing a **set** of viewports (responsive before/after) in
      one command, riding the same evidence sidecar.
- [ ] **Rail-row intent pill.** *Ships:* the archetype pill on the card (`renderArchetype`
      in `renderReaderCard`/`renderPromptCard`). *Open:* mirroring it into the prompt-rail
      *row* — `promptRows` renders only `outcomeChips` today (§C/§D).
- [ ] **Outcome rollup** — no aggregate outcome view exists (the workspace is stats-only
      after the memory-section removal); surface per-prompt outcomes in a workspace /
      prompt summary (the completion-ring experiment's open follow-up).

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
