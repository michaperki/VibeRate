# Experiment 4 — Game of Life (lean / self-paced)

> Drop this file into a **fresh empty repo** as `SEED.md` and start an agent
> (Claude Code or Codex) with: *"read the SEED.md and prepare to implement."*
> VibeRate's fourth experiment. Exp 1 = Claude/Tasky (to-do), Exp 2 = Codex/2048,
> Exp 3 = sorting visualizer. Unlike Exp 3, this seed gives you **no process
> checklist on purpose** — the point is to see how you work when nothing forces it.

## What we're building

A small, genuinely satisfying **Conway's Game of Life**: a grid that animates
generation to generation — births and deaths highlighted, the population evolving.
Controls for play/pause, step, speed, grid size, randomize, clear, and a few classic
seed patterns (glider, pulsar, Gosper glider gun). Vanilla HTML/CSS/JS + a tiny
static server is plenty. No backend, no accounts.

Why Life: it's the rare app where the **point only exists in motion** (a still frame
of cells says little) *and* the core logic is **pure and deterministic** (a `step()`
over a grid). That makes it a clean fit for motion clips alongside a couple of real
unit tests, without much surface area.

## The one design rule worth following

Make the app **capturable by URL.** Drive its state from query params so a single
link reproduces a specific view — e.g. `?pattern=glidergun&autoplay=1&speed=8&grid=40`.
Then recording the thing worth showing is one command against that URL, with no
clicking or scripting. This is the only "how to build it" instruction here; the rest
of the design is your call.

## How to work

- **Load the VibeRate skill first, and follow its guidance** — including its
  preflight, how heavy to make the process, and how/when to capture and publish.
  Don't reinvent any of that here; the skill is the source of truth for it.
- This is a **small app**. Match the effort to it — don't stand up a formal
  project-management system for a toy. Capture what a reviewer would actually want to
  see (Life *running*), not everything.
- Pause and **ask me at genuine forks** — stack (vanilla vs a framework), how
  opinionated the visual design should be. Don't pick unilaterally on those.
- Build it, get it running on localhost, and share it on VibeRate so I can watch the
  build and the result.

## Notes / constraints

- **Shot target is *your app's* URL** (localhost is fine), never VibeRate's —
  `push`/`watch` already send to VibeRate.
- **Clip format is environment-dependent and fine either way** — `vbrt shot --clip`
  yields an animated gif if `ffmpeg` is on PATH, otherwise a webm; both loop in the
  reader. Don't install ffmpeg just to force gif.
- Keep it small. A polished, well-captured Life beats a sprawling one.
