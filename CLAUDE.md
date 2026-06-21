# VibeRate — agent context

VibeRate is a **mobile, agent-first IDE**: you Drive coding agents from your phone,
steering them through the project's brain (`.md` docs + prompts) and watching the
work — without opening the code. It began as an observation tool ("GitHub for agent
conversations") and pivoted once Drive shipped; capture/sharing is now the byproduct.
Frame in `PRODUCT_STRATEGY.md`.

We are both building the dev tool VibeRate and using the devtool VibeRate to
build VibeRate, so tolerate some level of meta.

In practice that means: the sessions, brain docs, plan rings, and graveyard
nodes you see in this repo's own VibeRate dashboard are often *this* project's
work being viewed through the very tool you're editing. Don't be thrown by the
self-reference — treat the repo's own output as both the product and the
test fixture.

## Where things live

- `PRODUCT_STRATEGY.md` — product framing & current priorities (canonical; reframed 2026-06-21)
- `ROADMAP.md` — shipped / next work (agent-first priority cluster at top)
- `ONBOARDING.md` — onboarding & credentials forks (whose Claude runs; new vs existing app)
- `PLAN_AGENT_RUNTIME.md` — Drive: the local agent runtime (the "drive" half)
- `PLAN_DRIVE_WORKSPACES.md` — binding a project to a real checkout on the host
- `DRIVE_CONVO_RECONCILIATION.md` — Drive + the reader are one conversation (live head / cooled history)
- `PLAN_MOBILE.md` — the mobile-unified plan (responsive port; Variant A chat + brain header)
- `PROJECT_VIEW_PLAN.md` — detailed viewer/brain planning
- `DEMO_PLAN.md` — demo & trial plan (the "steering" story; how we show/trial the tool)
- `AUTH.md` — web-account sign-in (separate from Claude credentials)
- `SEED.md` — the original genesis prompt (a brain node, kept as history)
- `public/app.js` — the dashboard front-end (brain web, drive chat, progress rings, live mode)
- `src/` — the `vbrt` CLI, parsers, server, push/watch, and the agent runtime (`agent.js`, `agentRoutes.js`)

## Drive runtime env (read this if you were spawned by Drive)

Driven sessions run in a barebones container (`node:20-slim`, see `Dockerfile`) in a
**fresh clone** under `/data/workspaces/<slug>` — not a full dev box. Past sessions
burned turns rediscovering these facts; don't.

- **`python` is absent — this is a Node project.** Parse JSON/JSONL and write scripts
  in `node`, never `python3`.
- **Run `npm install` first** in a fresh checkout — `node_modules` isn't cloned, so a
  bare boot fails with `Cannot find package 'express'`. Expected, not a bug.
- **Port 8080 is already taken** by the hosted server you're running inside. Don't
  `vbrt serve` on it; pick another port (e.g. `--port 8137`) or skip the local server.
- **Hosted routing:** `/` is the public landing page; the dashboard SPA is at **`/app`**
  (and `/p/:id`, `/c/:id`). Checking `/` for app markup will mislead you.
- **`curl`, `jq`, `gh`, `ffmpeg` are installed** (added 2026-06-20). If a `curl` ever
  still 127s, fall back to `node -e "fetch(...)"` — and **never** swallow probe errors
  with `2>/dev/null`, that has sent past sessions on phantom hunts.
- **Showing the human what you built — use the preview route, don't push to see it.**
  A file you write in the workspace is served live at **`$VBRT_PREVIEW_BASE/<path>`**
  (injected into your env; = `<instance>/preview/<slug>/<path>`), straight off the
  shared volume with **zero commit/push/redeploy**. Hand the human that URL for any
  prototype/mock/page. Only commit+push when the change is meant to ship.
- **Screenshots/clips for evidence:** `vbrt shot "$VBRT_PREVIEW_BASE/<path>" --label
  after` — works out of the box (fixed 2026-06-21): `vbrt` is on PATH, Playwright +
  chromium are baked into the image, and `shot` auto-rewrites a `$VBRT_PREVIEW_BASE`
  target to loopback so the admin-gated preview route doesn't 403 your headless capture.
  No `vbrt doctor --fix` dance needed. (If you're in an *old* container from before that
  redeploy, the prior workarounds in memory still apply.) Last resort: register a file
  you produced yourself with `vbrt shot ./shot.png`. **`--label` only takes `before` or
  `after`** — not an arbitrary string. The shot **auto-attaches to your prompt card in
  the Convos rail at turn-end — no `vbrt push`** (Drive binds + ingests evidence itself
  now; `DRIVE_CONVO_INGEST_GAP.md`). So a shot is the way to *show the human in the
  conversation* what you built, distinct from handing them a live preview URL.
- **`prototypes/` is gitignored at any depth** — a prototype under `public/prototypes/`
  won't stage. Use a non-ignored path (e.g. `public/proto/`) if it must be committed,
  or just preview it (above) and skip the commit.
