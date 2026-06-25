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
- `PLAN_DRIVE_RUNTIME_GUIDANCE.md` — the runtime guidance (preview/screenshot recipe, `NODE_ENV` dev-dep trap, container facts) used to reach VibeRate's *own* repo via this `CLAUDE.md` but **not** cloned third-party repos — env was injected, instructions weren't. **Core now shipped** (2026-06-24): `driveRuntimeGuidance()` (`src/agent.js:338`) appends a hosted-gated, stack-aware preamble to every driven turn's `--append-system-prompt`, and `boxResourceNote()` warns when the box is genuinely low on RAM/disk. So a Drive on someone else's repo now inherits the recipe, not just the tools. Still open: a *hard* box guard (machine bump / `node_modules` cap) and an optional per-project run-skill.
- `PLAN_MOBILE.md` — the mobile-unified plan (responsive port; Variant A chat + brain header)
- `PLAN_CAPACITOR.md` — native iOS via Capacitor + Codemagic (wrap the SPA, cloud-Mac build → TestFlight; no Mac needed). Scaffolded 2026-06-22. **Superseded as the live iOS path by `PLAN_NATIVE_REWRITE.md`** (2026-06-24); the Capacitor scaffold stays dormant.
- `PLAN_NATIVE_REWRITE.md` — the **native SwiftUI rewrite** (`app-ios/`): a real native client to the same Fly backend, shipped to TestFlight via a Codemagic XcodeGen build, reusing the Capacitor build/sign/publish plumbing. Deletes the WKWebView seam (`STORY.md` Ch. 11): OAuth via `ASWebAuthenticationSession` + a cookie-free deep-link flow (`/auth/native/*` in `src/oauth.js`), SSE via `URLSession.bytes` (sets the auth header, retiring the `?access_token=` hack in `PLAN_NATIVE_AUTH.md`). Tradeoff: ~10–15 min build per UI change, no local Swift compile. Scaffolded 2026-06-24.
- `PLAN_NATIVE_PARITY.md` — the agent-control gap between the web Drive and the native iOS app, as a feature matrix + prioritized rebuild roadmap (2026-06-25). **Phase A shipped + most of B/C (2026-06-25, client-only, no backend changes):** new `AgentRunState` enum unifies the status switches; native now has two-tap armed **Stop**, the mid-turn **queue** (`_driveQueue`/`driveFlushQueue` semantics ported), a **busy-aware composer** (Send↔Queue, failed-send re-queue), **scroll-pinning** + jump pill, **collapsed tool chips** (result paired by `toolUseId`), **plain-text-while-streaming** Markdown (P-1), **foreground/roster auto-reconnect**, **swipe-to-end**, and the **push deep-link** (#13: a tapped notification opens that exact `DriveSessionView` via a unified `NavRouter`/`DriveRoute` path — an `ask` re-surfaces inline through the SSE replay, retiring the detached `AskSheet` to a no-project fallback). **Phase B now fully shipped.** **P-2 smoothness shipped (2026-06-25):** throttled
  tail-scroll (~one `scrollTo`/50ms, not per-token) + **native transcript text selection** —
  message bodies render through a `UITextView`-backed `SelectableText` shim so long-press
  gives real iOS partial-copy (blue handles, range adjust, copy-the-span), which SwiftUI
  `Text(…).textSelection` can't; a `MarkdownNS` flattener gives contiguous selection across a
  prose reply (code/table messages keep the per-block chrome path). Still open: tail-outside-array
  (deferred — measure first), Phase D QoL. Extends `PLAN_NATIVE_REWRITE.md`.
- `PLAN_NATIVE_BRAIN.md` — the **other half** of native parity: the **brain & activity**
  surfaces, which `PLAN_NATIVE_PARITY.md` deliberately never covered (2026-06-25).
  **Phase 1 core shipped (2026-06-25, client-only):** native can now *show the brain* — a
  `BrainView` "nodes at rest" graph (constitution anchor + plan shelf with `CompletionRing`s +
  `+N docs` toggle), a `DocView` markdown reader reusing the chat's `MarkdownView` (ring header
  + render↔raw toggle), reached via a `brain` toolbar button on the cockpit; plus the native
  unlocks — tap-to-open with a **haptic**, **long-press peek** via `contextMenu(preview:)`
  (the touch home for the desktop hover-peek). **The brain⇄chat live link (B8) now shipped
  too:** a live `tool_use` on a brain doc glows that node (verb-tinted halo) + fires a
  haptic + pulses a chat-toolbar brain button, bridged by an observable `BrainActivity`
  store and replay-gated on the event timestamp so backfill doesn't buzz on open. Still
  open: the real `Canvas` **drag-to-fling force-sim** (Phase 3), pinch/pan, activity ribbon
  + time-travel (Phase 4), Dynamic-Island "cooking" card (Phase 5). Charts the mobile-web
  brain arc (read-only viewer →
  completion rings → time-travel → mobile `.brainbar` → live link → the 2026-06-24 "nodes
  at rest" rethink), inventories every web interaction against native (all ❌/◑), and adds
  the gestures **Swift unlocks** that a WKWebView never had: long-press peek + `contextMenu`,
  drag-to-fling nodes, **haptics** as the live-activity channel, pinch/pan, ProMotion spring
  physics, and a Dynamic-Island "agent cooking" card. Backend already serves it all
  (`/docs`, `/dochistory`, `/git`, `/activity`, `/memory`) — a client gap, like parity.
- `PLAN_NATIVE_AUTH.md` — why social sign-in fails in the wrapped iOS app (OAuth state-cookie context split) and the token-sign-in workaround. 2026-06-23.
- `PROJECT_VIEW_PLAN.md` — detailed viewer/brain planning (§G holds the earlier 2026-06 legibility pass)
- `UI_FEEDBACK.md` — synthesis of two external UI reviews (2026-06-22), prioritized by reviewer agreement + prescriptive fixes; feeds `PLAN_MOBILE.md`
- `DEMO_PLAN.md` — demo & trial plan (the "steering" story; how we show/trial the tool)
- `PLAN_COCKPIT.md` — change-map for migrating the project home from today's dense Activity dashboard to the calm "cockpit" (Now / Latest / Next + demoted Full timeline); grounds every current-state claim in `public/app.js` + `src/` and flags the new per-agent-telemetry/transport gaps
- `PLAN_HARNESS_VERSIONING.md` — keeping the Claude Code / Codex harness on latest **without** silently breaking on upstream schema drift: surface the running version (already in the `system/init` event, currently discarded), make "latest" deterministic (today a redeploy updates it only on a Docker layer-cache miss), smoke-gate updates with a golden-transcript test, and feed the cockpit's "harness rail" centerpiece. The concrete answer to `STORY.md` Ch.10's upstream-drift risk.
- `AUTH.md` — web-account sign-in (separate from Claude credentials)
- `SEED.md` — the original genesis prompt (a brain node, kept as history)
- `archive/` — retired/historical brain docs (dogfooding experiment logs, the resolved Drive ingest-reconciliation saga, concluded research). Out of the live brain by design; see `archive/README.md`. Drive + the reader being one conversation lives in `archive/drive-reconciliation/DRIVE_CONVO_RECONCILIATION.md`.
- `public/app.js` — the dashboard front-end (brain web, drive chat, progress rings, live mode)
- `src/` — the `vbrt` CLI, parsers, server, push/watch, and the agent runtime (`agent.js`, `agentRoutes.js`)

## Drive runtime env (read this if you were spawned by Drive)

Driven sessions run in a barebones container (`node:20-slim`, see `Dockerfile`) in a
**fresh clone** under `/data/workspaces/<slug>` — not a full dev box. Past sessions
burned turns rediscovering these facts; don't.

- **You are running on the deploy target — `git push origin main` restarts *you*, and
  is the last thing a turn does.** This repo dogfoods itself: a push to `main` fires the
  Fly auto-deploy (`.github/workflows/fly-deploy.yml` → `flyctl deploy`), which rebuilds
  and **restarts the very machine this Drive session runs on**. So the push *ends the
  session* — there is no "after" to verify from. Two consequences:
  - **Don't verify after pushing.** You won't be alive to. The human is the verifier once
    it's live — don't poll production in a sleep-loop, don't curl `vbrt.fly.dev`, don't
    "wait for the deploy and check." Push, tell the human what to look at, and stop.
  - **Don't over-verify before pushing.** Cheap, local *correctness* checks earn their
    keep — `node --check` on changed files, a quick logic/unit assertion, a `git diff`
    audit so you don't sweep in unrelated work. But **skip the expensive redundant runtime
    checks**: don't boot a second copy of the server you're already inside
    (`vbrt serve` / `node src/server.js` on another port) to smoke-test routes — it
    duplicates this process and routinely 404s on gated APIs; don't Playwright-capture the
    live app to confirm a change "works." The default loop is: make the change, run a fast
    static check, push, and let the human confirm in the live app and report back. If a UI
    change genuinely needs eyes *before* shipping, use the `$VBRT_PREVIEW_BASE` preview
    route (below) — not a booted server, and not production. When you're unsure whether a
    change is safe to ship unverified, **ask the human — don't loop trying to prove it.**
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
