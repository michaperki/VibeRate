# VibeRate — agent context

We are both building the dev tool VibeRate and using the devtool VibeRate to
build VibeRate, so tolerate some level of meta.

In practice that means: the sessions, brain docs, plan rings, and graveyard
nodes you see in this repo's own VibeRate dashboard are often *this* project's
work being viewed through the very tool you're editing. Don't be thrown by the
self-reference — treat the repo's own output as both the product and the
test fixture.

## Where things live

- `PRODUCT_STRATEGY.md` — product framing & current priorities
- `PROJECT_VIEW_PLAN.md` — detailed viewer planning
- `ROADMAP.md` — shipped / next work
- `SEED.md` — the original genesis prompt (a brain node, kept as history)
- `public/app.js` — the dashboard front-end (brain web, progress rings, live mode)
- `src/` — the `vbrt` CLI, parsers, server, push/watch
- `PLAN_MOBILE.md` — the mobile-unified plan (responsive port; Variant A chat + brain header)

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
  after`. Headless capture needs the chromium *binary* in this workspace — if `shot`
  says it's missing, run `vbrt doctor --fix` once (the image already carries chromium's
  system libs), then re-run the same `shot`. Last resort: register a file you produced
  yourself with `vbrt shot ./shot.png`.
- **`prototypes/` is gitignored at any depth** — a prototype under `public/prototypes/`
  won't stage. Use a non-ignored path (e.g. `public/proto/`) if it must be committed,
  or just preview it (above) and skip the commit.
