# Experiment 3 — Sorting Visualizer (artifact-loop test)

> Drop this file into a **fresh empty repo** as `SEED.md` and start an agent
> (Claude Code or Codex) with: *"read the SEED.md and prepare to implement."*
> This is VibeRate's third experiment run. Exp 1 = Claude/Tasky (to-do), Exp 2 =
> Codex/2048. This one is purpose-built to exercise the **new motion-clip
> artifact** alongside screenshots, tests, and the auto outcome rail.

## What we're building

A small, genuinely satisfying **array-sorting visualizer**: a row of bars that
animates as a sort algorithm runs — comparisons and swaps highlighted, bars
settling into order. Vanilla HTML/CSS/JS + (optionally) a tiny static server.
No backend, no accounts. The app is the excuse; **the real job is to exercise
VibeRate's artifact + brain loop end-to-end**, so *how* you work matters as much
as what ships.

Why a sorting visualizer specifically: it is the rare app where the **point only
exists in motion** (a still frame of mid-sort bars says little) *and* the core
logic is **pure and testable** (a sort is deterministic). That makes it a clean
test of clips + tests + screenshots together.

## The artifacts this run must exercise

This is the experiment's actual purpose — treat these as **required
checkpoints**, not nice-to-haves. (Exp 2 under-captured and we learned the hard
way.)

1. **Screenshots** (`vbrt shot <url> --label before|after`) — for *static* visual
   states: the initial bars, a finished/sorted board, a theme or layout change,
   the controls panel. Before/after on any prompt that changes how it *looks* at
   rest.
2. **Motion clips** (`vbrt shot <url> --clip [seconds] --label after`) — **the
   headline.** Capture the sort *running*. A clip per algorithm once it animates;
   a clip whenever you change the animation (easing, speed, color states). This is
   the only artifact that shows what the app is actually for. Keep clips short
   (~4s) and the `--viewport` modest (e.g. `960x600`) — they inline into the
   bundle.
3. **Tests** — write unit tests for the pure sort functions (assert the output is
   sorted and is a permutation of the input; assert the recorded step/animation
   trace is consistent). **Run them** and commit the passing run. (This exercises
   the command/commit signals in VibeRate's outcome rail; a dedicated test-status
   artifact family isn't built yet, so just run + commit.)
4. **Commits + brain docs** — commit each meaningful step; keep the brain docs
   (below) current. VibeRate renders these as the timeline, the brain graph, and
   the per-prompt outcome chips, so steady commits + doc updates make the run
   legible.

## Suggested build phases (adapt freely)

Each phase = a checkpoint with at least one artifact. Don't batch everything into
one commit — the loop is the point.

- **Phase 1 — Scaffold.** Bars from a random array; controls (generate, sort,
  algorithm picker, speed). No animation yet. → **before screenshot** of the
  initial bars.
- **Phase 2 — First animated sort.** Implement one algorithm (bubble or
  insertion) with a step animation; highlight compare/swap. → **clip** of it
  running + **after screenshot** of the sorted state.
- **Phase 3 — More algorithms + visual states.** Add quicksort + mergesort;
  distinct colors for comparing / swapping / sorted / pivot. → **clip per new
  algorithm**; **before/after screenshot** of the color-state design change.
- **Phase 4 — Polish + tests.** Easing/speed tuning, maybe a "race two algorithms"
  view. Write + run the sort unit tests. → a final **clip** of the polished motion
  and a **before/after** if you restyle.

## Kickoff (do this first)

1. **Load the VibeRate skill**, then **run `vbrt doctor`** before anything else —
   it confirms repo / watch / capture readiness and prints the exact `shot` command.
   Follow its brain + capture conventions from the start.
2. **Ask me a short round of clarifying questions** before writing code — at
   minimum: stack (vanilla vs a framework), deploy vs localhost (default:
   **localhost** — the clip recorder uses Playwright against the URL, and
   localhost works fine), and how opinionated the visual design should be. Pause
   at genuine forks; don't pick unilaterally.
3. **Write the brain docs as the proposal, before app code:** `ROADMAP.md`,
   `DEVLOG.md`, `DECISIONS.md`, and a linked `PLAN_scaffold.md`. Keep `PLAN_*.md`
   per effort; check items off as you go; log decisions with their *why*.
4. Then build phase by phase, committing and capturing artifacts at each
   checkpoint per the list above.

## Notes / known constraints

- **Clip format is environment-dependent and that's fine.** `vbrt shot --clip`
  produces an animated **gif** if `ffmpeg` is on the PATH, otherwise a **webm** —
  both loop in the VibeRate reader. Don't install ffmpeg just to force gif; webm
  is expected.
- **Shot target is *your app's* URL, never VibeRate's** — `push`/`watch` already
  send to VibeRate.
- If `vbrt watch` is running, artifacts and commits **stream live** — in that case
  **do not also run `vbrt push --all`** (it's redundant and burns the ingest limit).
  If watch is *not* running, push at the end. `vbrt doctor` tells you which is true —
  pick one and say which.
- Keep it small. A polished, well-captured 4-phase build beats a sprawling one.

> **For experimenters:** this seed deliberately over-specifies brain docs and
> artifacts (multiple `PLAN_*` files, an artifact per phase) — it's a **stress test**
> of VibeRate's capture + brain loop, *not* the product's recommended default. The
> SKILL.md guidance for real work is much leaner (run `vbrt doctor`; `DEVLOG.md` only
> unless the work outgrows one session; 2–3 artifacts). Don't "fix" this seed to
> capture less — that's its job here.
