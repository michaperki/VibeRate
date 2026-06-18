# Maze — generate & solve

## What we're building

A small, satisfying **maze generator + solver**. A grid carves itself into a maze
generation-by-generation (you can *watch* the walls fall), then a solver traces a path
from start to exit, lighting up the frontier as it searches. Controls for generate,
solve, step, speed, grid size, and a reseed. Vanilla HTML/CSS/JS + a tiny static server
is plenty. No backend, no accounts.

Why a maze: the **point only exists in motion** — a still frame of a solved maze says
little, but watching it carve and search is genuinely satisfying. It's also naturally
**two-phase and swappable** (a generator algorithm + a solver algorithm), so there's
room to try alternatives without much surface area.

## The one design rule worth following

Drive the app's state from **query params** so a single link reproduces a specific view
— e.g. `?gen=prim&solve=astar&seed=42&grid=40&speed=8&autoplay=1`. A specific maze, a
specific algorithm pairing, mid-search — all addressable by URL. This is the only "how
to build it" instruction here; the rest of the design is yours.

## How to work

- This is a **small app**. Match the effort to it — no formal project-management system
  for a toy. A short `DEVLOG.md` + `README.md` is plenty.
- Build it **iteratively, and don't be precious with the history**: if a generator or
  solver approach isn't working, reset and redo it rather than patching around it; tidy
  WIP commits before you call a phase done; try an alternative solver on a branch if
  you're unsure. Work the way you actually would.
- Get the first version **working and committed** before you polish.
- Pause and **ask me at genuine forks** — stack (vanilla vs a framework), and how
  opinionated the visual design should be. Don't pick unilaterally on those.
- Get it running on localhost so I can watch it carve and solve.
