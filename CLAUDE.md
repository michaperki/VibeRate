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

- `STORY.md` — the development narrative (good to read on init): how VibeRate got here, in order, with the decisions. Ch. 10 holds the 2026-06-21 thesis course-correction (what "steering" really means; the differentiator; upstream risk; tests deferred; auto-compact).
- `PRODUCT_STRATEGY.md` — product framing & current priorities (canonical; reframed 2026-06-21)
- `ROADMAP.md` — shipped / next work (agent-first priority cluster at top)
- `ONBOARDING.md` — onboarding & credentials forks (whose Claude runs; new vs existing app)
- `PLAN_AGENT_RUNTIME.md` — Drive: the local agent runtime (the "drive" half)
- `PLAN_DRIVE_WORKSPACES.md` — binding a project to a real checkout on the host
- `PLAN_MOBILE.md` — the mobile-unified plan (responsive port; Variant A chat + brain header)
- `PLAN_CAPACITOR.md` — native iOS via Capacitor + Codemagic (wrap the SPA, cloud-Mac build → TestFlight; no Mac needed). Scaffolded 2026-06-22.
- `PLAN_NATIVE_AUTH.md` — why social sign-in fails in the wrapped iOS app (OAuth state-cookie context split) and the token-sign-in workaround. 2026-06-23.
- `PROJECT_VIEW_PLAN.md` — detailed viewer/brain planning (§G holds the earlier 2026-06 legibility pass)
- `UI_FEEDBACK.md` — synthesis of two external UI reviews (2026-06-22), prioritized by reviewer agreement + prescriptive fixes; feeds `PLAN_MOBILE.md`
- `DEMO_PLAN.md` — demo & trial plan (the "steering" story; how we show/trial the tool)
- `PLAN_COCKPIT.md` — change-map for migrating the project home from today's dense Activity dashboard to the calm "cockpit" (Now / Latest / Next + demoted Full timeline); grounds every current-state claim in `public/app.js` + `src/` and flags the new per-agent-telemetry/transport gaps
- `AUTH.md` — web-account sign-in (separate from Claude credentials)
- `SEED.md` — the original genesis prompt (a brain node, kept as history)
- `archive/` — retired/historical brain docs (dogfooding experiment logs, the resolved Drive ingest-reconciliation saga, concluded research). Out of the live brain by design; see `archive/README.md`. Drive + the reader being one conversation lives in `archive/drive-reconciliation/DRIVE_CONVO_RECONCILIATION.md`.
- `public/app.js` — the dashboard front-end (brain web, drive chat, progress rings, live mode)
- `src/` — the `vbrt` CLI, parsers, server, push/watch, and the agent runtime (`agent.js`, `agentRoutes.js`)

## Drive runtime env (read this if you were spawned by Drive)

Driven sessions run in a barebones container (`node:20-slim`, see `Dockerfile`) in a
**fresh clone** under `/data/workspaces/<slug>` — not a full dev box. Past sessions
burned turns rediscovering these facts; don't.

- **`python` is absent — this is a Node project.** Parse JSON/JSONL and write scripts
  in `node`, never `python3`.
- **Deps auto-install on clone now** — Drive runs `npm install` after cloning a
  workspace, so `node_modules` is normally already there. If a bare boot still fails with
  `Cannot find package` (an older container, or a manual checkout), run `npm install`
  once — `node_modules` isn't committed.
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
- **Seeing your own UI work (to verify a change):** you're headless — you can't refresh
  the app like the human can. Preview the page at `$VBRT_PREVIEW_BASE/<path>` (above),
  capture it yourself (a short Playwright script is fine), and **`Read` the PNG** to look
  at the actual pixels. Note: **`vbrt shot` does *not* return the image** — it only prints
  a confirmation — so don't run `shot` expecting to see your work. Capture-and-`Read` is
  that loop; `shot` is not.
- **`vbrt shot` is on-request only.** It captures a screenshot/clip into the human's
  Convos-rail evidence card. **Don't fire it automatically after UI changes** — only when
  the user actually asks to see something captured. (Most humans just refresh the live
  app; an unrequested shot is wasted turns and tokens.) When asked, it works out of the
  box: `vbrt shot "$VBRT_PREVIEW_BASE/<path>" --label after` — `vbrt` is on PATH,
  Playwright is baked in, and `shot` auto-rewrites a `$VBRT_PREVIEW_BASE` target to
  loopback past the admin gate (no `doctor --fix` dance). `--label` takes only `before`/
  `after`; register a file you already made with `vbrt shot ./shot.png`. It auto-attaches
  at turn-end — no `vbrt push` (`archive/drive-reconciliation/DRIVE_CONVO_INGEST_GAP.md`).
- **Editing `.md` brain docs updates the brain automatically — no `vbrt push`.** When
  a driven turn ends, Drive re-extracts the workspace's docs (+ git timeline +
  time-travel history) into the bound project, so a `STORY.md` you add or a `CLAUDE.md`
  you edit shows up as a brain node on its own (Drive ingests docs itself now, like it
  does turns and shots; `archive/drive-reconciliation/DRIVE_DOCS_INGEST_GAP.md`). Caveat: a **new** doc nodes only
  if something already in the brain references it — link it from the `CLAUDE.md` index
  or it stays orphaned. (A `git push` ships server *code*, not project *data*, and
  never refreshed the brain — that was the gap.)
- **`prototypes/` is gitignored at any depth** — a prototype under `public/prototypes/`
  won't stage. Use a non-ignored path (e.g. `public/proto/`) if it must be committed,
  or just preview it (above) and skip the commit.
- **Tell the human which plan you're driving — call `mcp__viberate__report`.** When you
  start advancing a `PLAN_*.md` (or switch to another), call the `report` MCP tool with
  `{ plan, status }`. It returns instantly (no human wait) and lights up the plan you're
  on, plus a status note, in the cockpit's live agent roster — ground truth instead of the
  dashboard inferring it from the files you touch. Re-report when your focus changes.
  (Defined in `src/mcpAsk.js`; see `PLAN_COCKPIT.md` §3.1 tier 2.)
