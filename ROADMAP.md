# VibeRate — Roadmap

Canonical frame: see `PRODUCT_STRATEGY.md`.

VibeRate is a **mobile, agent-first IDE** for terminal-agent development: you
**drive** coding agents from your phone — steering them through the project's brain
(`.md` docs, plans, memory) and your prompts, managing context and the work in
flight — and watch it land, without opening the code. It also captures the work
(prompts, diffs, commits, screenshots, brain docs) so you can understand and review
it. A **social / learning layer** (feedback, sharing, discovery) sits on top as a
later byproduct, not the core: the first job is making the single-developer
capture → understand → drive loop frictionless on a phone. Full framing reframed
2026-06-21 in `PRODUCT_STRATEGY.md`.

Working category remains open. "Agentic Code Viewer" / "Agentic Work Environment"
were useful probes; the center of gravity is now the **drive** verb (the agent
runtime + control surface), with capture/understand as its read mode.

## Done (v0 — local + push foundations)

- **Capture pipeline** — discover → parse Claude/Codex sessions, extract git history + agent docs.
- **Viewer** — activity timeline, conversation viewer, and the AI-architecture network with **Web / Tree / Recent** layouts, animated transitions, and the doc-reader **lightbox** (full-screen; plan/checklist docs get a parsed completion view).
- **Client/server split** — `buildBundle` produces one payload; local sink (disk) and push sink (HTTP) share the contract.
- **Hosted ingest** — `POST /api/projects` mints an unlisted id, `/p/:id` serves that project's dashboard.
- **Secret redaction** on upload (keys/tokens/private-key blocks scrubbed before leaving the machine).
- **Agent skill** — non-interactive `vbrt push --all`, pure-Node bundled client (no node_modules), installed via personal skills folder.
- **Marketplace scaffolding** — `marketplace.json` + plugin manifest; `build-skill.mjs --plugin`.

## Phase 1 — Make the loop real (deploy + publish)

Social features all require a shared backend, so a thin deploy gates most of what follows.

- **Deploy the host** ✅ — viewer + ingest live on a real URL (`vbrt.fly.dev`); infra in `DEPLOY.md` / `Dockerfile` / `fly.toml`. Store is JSON files on a Fly persistent volume (keyed by project id) — we kept the file store on durable storage rather than swapping to a DB; revisit a DB only if the file store strains.
- **Publish the marketplace** ◐ — repo pushed to GitHub (`github.com/michaperki/VibeRate`) with `marketplace.json`; still to verify the `/plugin marketplace add` → `/plugin install` round-trip from a clean machine.
- **Default endpoint** ✅ — skill points at the deployed URL by default (`DEFAULT_API = https://vbrt.fly.dev`); the localhost step is gone (`VBRT_API_URL` overrides for a local host).
- **Identity (gist → claim)** ✅ — anonymous push mints a gist-style owner token (`auth.js`); a full "claim your account" flow (`accounts.js` + GitHub/Google OAuth in `oauth.js`) links a signed-in user to their pushed projects.
- **Live read-only monitor (`vbrt watch`)** — ✅ **shipped** (brain + conversation stream live, hands-free, delta pushes, viewer follows). Spec `STREAMING.md` archived → graveyard ghost. Streaming follow-ups, only if needed:
  - SSE/WebSocket (drop polling) if polling ever feels laggy.
  - Reader refinement — ✅ live session updates patch the reader in place, preserving expanded `<details>` and scroll position while following.

## Next priorities (accepted order)

1. **Prompt-unit navigation + deep links** — make individual prompts the default
   navigation object, with sessions as a secondary view. ✅ Shipped: project-level
   prompt rail API, `Prompts | Sessions` rail, prompt-row click into the exact card.
2. **Auto-derived outcome chips** — files changed, commits produced, brain docs
   changed, commands run, screenshot attached, context fullness, and follow-up
   type. ✅ First pass shipped: files, commits, brain docs, command count,
   screenshots, and context fullness. (Command pass/fail was removed — the cheap
   heuristic was meaningless; real result tracking belongs to the diff/test family.)
3. **Hosted hardening + privacy preview** — upload limits, validation, quotas,
   admin/delete tools, backups/export, and `push --dry-run` / hosted visibility
   preview before broader social. ◐ First pass shipped: hosted JSON/session/message/
   evidence/image caps, in-memory upload rate limiting, server-side bundle checks,
   and `vbrt push --dry-run`.
4. **Onboarding / setup simplification** *(now-priority)* — today the first run is a
   gauntlet: sign up at `vbrt.fly.dev`, authenticate the terminal, `vbrt push`,
   `vbrt watch`, then go to the site and click the **Live** toggle, all in order,
   before convos/brain/artifacts appear. Chosen direction: **flow B** — one command,
   private-by-default, but immediately viewable by the pusher (no forced sign-in),
   with "claim to keep/share" as an optional upgrade.
   - **Self-view without sign-in** ✅ — the real blocker was that a browser can't
     present the CLI's bearer token, so viewing your own *private* push forced an
     OAuth + claim dance. Fixed: a push now returns a short-lived, project-scoped
     signed **view token** (`/p/<id>#v=…`), redeemed client-side (`POST /api/view`)
     into an HttpOnly `vbrt_view` cookie that `canRead` honors. Grant is read-only and
     per-project — it never unlocks the account list, publish, or other projects
     (covered by an 11-case end-to-end test). CLI prints the openable link on push.
   - **Auto-Live when actively streaming** ✅ — ingest stamps `lastPushAt`; the project
     API returns a `streaming` flag (pushed within a 3-min window — the one place the
     threshold lives), and the viewer auto-enables Live on open when it's set. A
     `vbrt watch` keeps it true via its delta pushes; it self-clears once pushes stop,
     so archived projects don't poll. Verified both sides of the window.
   - Later: fold token claim into an optional one-click upgrade; tighten first-run copy
     so the no-account path is obvious.
5. **Robustness / stress-testing the capture+viewer loop** *(now-priority)* — exercise
   the system the way real devs actually work, not just the happy path. Run new
   experiments across project shapes, and probe the edge cases that break capture or
   the viewer: **`git reset`** / force-push / rebase rewriting history, branch
   switches, amended/squashed commits, multiple agents in one repo, very long or
   resumed sessions, deleted/renamed brain docs, watch left running across reboots,
   pushing the same project from two machines. Capture each failure mode as a fix or a
   documented limitation.
   - **Rewritten-history capture** ✅ (2026-06-22) — first failure mode closed. Every
     push (and Drive turn-end ingest) re-ran `git log` from scratch and `saveGit`
     *overwrote* `git.json`, so `git reset` / rebase / squash / force-push silently
     **dropped** commits that no longer sat on HEAD — the dogfood timeline lost work.
     `saveGit` now reconciles via `reconcileGit` (`src/storage.js`): a union by hash
     where the fresh capture is authoritative for current HEAD and prior commits that
     vanished from the log are *kept* and flagged `rewritten` (the timeline dims them as
     ghosts rather than losing them); a rewritten commit that reappears is promoted back
     to live. Bounded at 6000 commits. Known limitation, documented in code: two
     machines on one slug with divergent history ping-pong which set is "live" each
     push, but no commit is ever lost. Remaining edge cases above (branch switches,
     renamed-doc history, two-machine reconciliation proper) still open.
   - **Dogfood destructive git actions in a *scratch* repo, not our own (2026-06-23,
     Mike).** Exercising `git reset` / rebase / force-push / branch-switch capture by
     running it on the VibeRate repo itself risks resetting the app we're building.
     Stand up a separate throwaway checkout to drive these experiments against — still
     dogfooding the capture loop, but with no blast radius on our own history. (This is
     also the natural place to work through "how different git actions happen" in the UI
     — branch/commit/reset affordances — without endangering the dogfood timeline.)
6. **Live orchestration + timeline legibility** *(now-priority)* — make the dashboard
   feel real-time and coherent while an agent is actively working. Full breakdown +
   code root-causes in `archive/LIVE_ORCHESTRATION.md`. ✅ First pass shipped (2026-06-18):
   - **Real-time watch** ✅ — the watcher debounce gained a `maxWait`, so a push fires
     during continuous agent activity instead of only on a quiet window; previously a
     `plan.md` written early only appeared after the agent finished implementing
     (the session log never went quiet long enough to settle the debounce). Tick → 1s,
     frontend poll → 2s, `refreshLive` fetches parallelized.
   - **Agent activity ticker** ✅ — a subtle marquee under the brain shows what the
     agent is chewing on (reading / editing / running), surfaced from `tool_use`
     blocks the parser already had; `GET /api/projects/:slug/ticker`. Zero added agent
     load (read-only tail of the session log).
   - **Liveness-aware end-of-convo** ✅ — `endState` no longer flips a still-working
     agent to "End of conversation" when its latest block happens to be narration text;
     while streaming it reads "Agent working…".
   - **Concerted live updates** ✅ — one `liveEventDigest` per snapshot drives every
     surface (rail / timeline / brain / ticker) so a single event reads as one update,
     with a "what just happened" pulse on the Activity header.
   - **Duration-based convo bars** ✅ — timeline convo blocks now span their real
     start→end instead of a fixed count-width stub at the start, so message bars no
     longer float over empty space with no convo beneath them.
   - **Agent-colored message lane** ✅ — the timeline's message heat is now colored by
     the agent that sent it (claude / codex), matching the convo blocks below, so the
     two lanes read as the same threads.
   - **Web-view layout fills the canvas** ✅ — `layoutGraph` spreads to encompass the
     available width instead of clustering nodes mid-canvas.
   - **`vbrt watch` terminal → live TUI** ✅ *(first pass shipped 2026-06-18)* — the watch
    terminal was the blindest seat: only a scrolling push log while the dashboard rendered a
    rich ticker from data the watcher already ships. Now `vbrt watch --tui` renders a
    dependency-free ANSI dashboard — a panel per agent (status / current action /
    context-token gauge), header, footer — as a *presentation layer* over the existing
    `.vbrt/stream.jsonl` (`readStream`) + `discoverSessions`, **no new capture or agent
    overhead**. Hook events now carry `sid` for per-agent grouping. **Now the default** on an
    interactive terminal; `vbrt watch --log` forces the plain scrolling log (also the
    automatic fallback when output is piped/redirected). Deferred: Codex log-tail fallback.
    Full breakdown in `archive/LIVE_ORCHESTRATION.md §8`.
  - **Real-time ticker via Claude Code hooks** ✅ — CC flushes its session log in
     chunks (~20–30s lag); `vbrt hooks --install` wires `Pre/PostToolUse` /
     `UserPromptSubmit` / `Stop` hooks that fire `vbrt hook` (zero token cost — runs in
     the harness, not the model), appending live activity to `.vbrt/stream.jsonl`. The
     watcher ships it; the ticker becomes a **status-line-style readout** — working /
     idle, current action, and per-step context/token load — instead of a lagged
     tool-history list. `getTicker` prefers the hook stream, falls back to the log.
     *Known limit:* per-step (per event), not a smooth per-token odometer — hooks are
     event-driven, and the CC spinner verbs ("Pondering…") aren't exposed.

## Now — agent-first IDE priorities (2026-06-21 reframe)

The pivot from observation tool to **mobile, agent-first IDE** (Drive at the center)
puts a new cluster ahead of the old viewer/social backlog. These are the gates to
anyone but the operator using VibeRate to actually drive.

1. **Onboarding / credentials** *(top blocker)* — today Drive runs only on the
   operator's Claude credentials, admin-gated (`agent.js`, `agentRoutes.js`), and a
   new user has no path to "my agent is working." Two open forks, laid out in
   `ONBOARDING.md`: (a) **whose Claude runs** — lean **operator-Claude + billing**
   (user adds a payment method, rents our Claude), possibly alongside **BYO** key,
   with BYO-OAuth-token gated on Anthropic-ToS clarity; (b) **new app vs existing
   app** — today `workspaces.js` only **clones an existing repo**; we also need a
   **scaffold-a-new-project** path. Decide the forks, then make first-run on a phone
   one obvious flow.
   - **No-terminal "New project" button** ✅ *(Fork 2 existing-app, Slice 1 — shipped
     2026-06-24)* — minting a project no longer requires `vbrt push` from a terminal. A
     **New project** entry in the workspace home (`app.js` `openNewProjectModal`) takes a
     repo → `POST /api/projects/new` (`server.js` → `createProject`, `storage.js`) mints
     the project record (account-scoped; private by default) → the modal kicks the
     one-time clone (admin-gated `/workspace/:slug/setup`) and drops you into Drive.
     Deliberately decoupled: project *creation* is account-scoped, the *clone* stays
     admin-scoped, so this shipped **without** any progress on Fork 1 (credentials/
     billing).
   - **Per-user GitHub connect + repo picker** ✅ *(Fork 2 existing-app, Slice 2 —
     shipped 2026-06-24)* — makes it one-tap for a user's *private* repo, not just
     public/operator. **Connect GitHub** is a `repo`-scoped grant separate from sign-in
     (`oauth.js` `/auth/github/connect`); the New-project window then lists the user's
     repos (`/api/github/repos`). Private clones **and** the agent's pushes use the
     project owner's connected token (resolved owner→user→token in `agentRoutes.js`),
     not the shared instance `GITHUB_TOKEN`: stored **encrypted** at rest
     (`auth.encryptSecret`, AES-256-GCM), decrypted only in-memory — clone via a
     command-scoped credential helper that resets the global one (`workspaces.js`),
     push via the session child env (`agent.js childEnv`); never sent to the browser. A
     pasted URL stays as fallback; the picker degrades to it where GitHub OAuth isn't
     configured (local). **Remaining:** Slice 3 = scaffold-a-new-app for repo-less users
     (`createProject` already mints the record); later, a GitHub App for finer scopes.
     See `ONBOARDING.md`.
2. **Fleet / multi-agent session management** — the unit of work is shifting from
   one session to *several agents in flight*. The root cause of "only the most-recent
   Drive session resumes" was that the client kept a single `vbrt_drive_active`
   handle in `localStorage` (overwritten on each new session), and the server
   registry is in-memory (cleared on restart), with no index of past sessions — only
   durable JSONL transcripts + the `adopt` fallback (`agent.js`).
   - **Per-project session log** ✅ *(first pass shipped 2026-06-21)* — a
     `vbrt_drive_sessions` localStorage log records every session you've driven per
     project, keyed by the durable `claudeSessionId`, with its first-message title and
     last-active time. The new-session form now shows a **"Past sessions"** list; ↻
     resumes any of them (promotes it to the active handle, then re-adopts off the
     on-disk transcript), × forgets it. `resumeDrive` now handles a log entry with no
     live `id` by going straight to `adopt`. Reuses the existing adopt path — no server
     change. (`app.js` `recordDriveSession`/`listDriveSessions`/`driveHistoryHtml`/
     `resumeDriveSession`.)
   - **Server-side session index** ✅ *(shipped 2026-06-21)* — the per-browser log is
     now backstopped by a cross-device index read from the **durable on-disk
     transcripts** in the project's workspace, so a session started on a phone is
     listed (and resumable) on a laptop. `GET /api/agent/workspace/:slug/sessions`
     (guarded like the rest of the control plane) resolves the project's checkout cwd,
     reads Claude's `projects/<encoded-cwd>/*.jsonl` for that workspace, and peeks each
     for title + turn count + last-active (file mtime); sessions with no typed turn are
     dropped. The new-session form paints the localStorage list instantly, then
     **hydrates** with the server list (`hydrateDriveHistory`) — the two are merged by
     `claudeSessionId` (local carries the typed title + chosen permission mode; the
     server catches what this device never saw and annotates **live status**). Rows
     started elsewhere badge "⤳ other device"; a still-running session badges "● running"
     and resumes straight to its live handle via `liveId` (skips re-adopt). Wiring:
     `driveIngest.listWorkspaceSessions`, `agentRoutes` route, `app.js`
     `fetchWorkspaceSessions`/`mergeDriveSessions`/`driveSessionRecord`/`hydrateDriveHistory`.
   - **Still open:** a way to **see/switch agents running concurrently** (the actual
     fleet view — the index lists *past* sessions; live multi-agent switching is next).
3. **Mobile as the primary surface** — finish the responsive port (`PLAN_MOBILE.md`)
   so brain, drive, reader, and rail are all first-class on a phone. Default
   assumption flips: a feature is mobile unless it proves it needs desktop (dense
   brain editing, side-by-side diffs are the likely desktop-only exceptions).
   - **Convos/reader is behind Drive on mobile (2026-06-23, code-verified — the bounded
     near-term win).** The Drive chat got the full mobile treatment — sticky head-stack
     composer, fixed brain-chip strip (`#m-brainbar`), jump-to-latest pill, live status
     — but the conversation **reader** (`renderReaderCard`/`renderSessionList` + the
     `Sessions|Prompts` rail) did not: its toolbar only compacts *reactively* after you
     scroll (so the back/nav controls vanish), it has **no** brain strip, **no** jump
     pill, and the rail is buried in the bottom sheet. Bring the reader up to Drive's
     mobile bar so the read half of the loop is first-class on the phone too. Concrete
     gap list mapped this session; this is the most bounded, immediately-useful item in
     the cluster.
4. **Context management as a feature** — beyond the context-fullness gauge, help the
   driver act on the "dumb zone": surface when to **compact / branch / start fresh**
   before quality degrades. Context is the scarce resource in agentic-first coding.
5. **Brain that fits *any* repo** — make the brain useful for devs who don't use our
   `SEED.md`/`DEVLOG.md` conventions; infer structure from whatever `.md` network a
   repo actually has. Experiment: load Mike's older vibe-coded projects and see how
   their doc structures map into the brain (`PROJECT_VIEW_PLAN.md`).
6. **Rethink "completion %" as the headline metric** — it assumes a fixed
   denominator, but **discovery prompts** legitimately *grow* known scope (push %
   down). Keep it as one signal, treat it as non-monotonic, and pair it with
   **scope-discovered** and **work-in-flight** signals (`PROJECT_VIEW_PLAN.md`).
7. **Demo & first trial** *(`DEMO_PLAN.md`)* — how we *show* and *trial* the loop.
   Core reframe: the demo is the **intervention, not the build** (a one-shot
   advertises Claude Code; the steering loop is ours). Thesis: *"real development
   requires steering."* Trial ≠ video: the trial needs a pre-seeded **"starter
   brain"** to bias users toward steering-shaped tasks (ties into the new-app fork in
   item 1 / `ONBOARDING.md`); the recommended build is a screen-recordable demo set on
   the real mobile Drive view.

The items below (prompt-unit nav, outcome chips, hosted hardening, the existing
onboarding self-view/auto-live work, robustness, live orchestration) remain valid
and largely shipped — they're the read/understand half of the loop.

## Phase 2 — Social / learning layer (later — byproduct of the Agentic IDE, not the core)

> The core product is the **Agentic IDE / work environment** (capture → understand →
> drive agent work). Feedback and sharing are a valuable *learning* layer we add once
> the IDE loop is frictionless and battle-tested — not the first priority.

- **Feedback** ◐ — first pass shipped: +1/−1 voting on individual prompt cards (`ratings.js`, one vote per card, score = ups − downs). Still to come: threaded **comments** on a project or a specific prompt/turn, and surfacing controversy/agreement.
- **Sharing controls** — unlisted vs public; what conversation data is exposed (pairs with redaction).
- **Notifications** — "someone reviewed this" once prompt/project comments exist.
- **Fork** — copy someone's prompt(s)/session into your own space to adapt and re-run. Defer until the fork unit is clear.
- **Discovery** — popular / trending projects, profiles, browse by tag. Defer until feedback is useful.

## Phase 3 — Viewer UX polish

- **Drive transcript: Claude-code clean view** ✅ Shipped (2026-06-20). Killed the
  raw waterfall — tool calls collapse to one tappable line (`verb · target · status`,
  full input/output one tap away), thinking tucks to a preview, and a working footer
  carries the live activity label + elapsed + token estimate (exact tokens on the
  turn-complete line, from the result event's `usage`). Reader stays glued to the
  newest activity only while parked there; scrolling away surfaces a "new activity"
  pill instead of yanking. Cures the mobile thumb-scroll fatigue. *(Anchor later
  flipped to the top — see "Drive transcript: top-anchored flipped flow" below.)*
- **Drive transcript: reconnect-replay duplication** ✅ Fixed (2026-06-20). The live
  SSE stream replayed from `after=0` on every reconnect and the client appended with
  no dedup, so backgrounding the mobile tab or hitting Resume reprinted the whole
  transcript (2×/3×). Fixed by emitting `id: <seq>` + honoring `Last-Event-ID`
  server-side, a client-side high-water-`seq` dedup, and a `visibilitychange` resync
  for the frozen-socket case iOS Safari never reports. Full diagnosis +
  fix: `archive/drive-reconciliation/DRIVE_LIVE_STREAM_DUP.md`.
- **Drive transcript: markdown + context meter + top-anchored flipped flow** ✅
  Shipped (2026-06-21). Three upgrades to the surface we dogfood in: (1) assistant
  bubbles render real markdown (tables/code/lists/headers), streaming-safe via a
  per-bubble raw buffer re-rendered ≤1×/frame, with copy buttons on code blocks; (2)
  a context-window meter pill in the header (tokens + % of the 200k/1M window from
  the result `usage`, amber past 75%); (3) the chat flipped on its head — the
  composer is pinned to the **top** in a sticky stack and the transcript reads
  **newest-first** (oldest at the bottom). The first pass (`5caa9cd`) only prepended
  whole *turns*, so a single long agent turn still streamed downward; the finish
  (`57db9bd`) prepends events *within* a turn too (`drivePlace`), so the live
  activity always lands directly under the composer. Scroll/"new activity" logic and
  the mobile sticky offset track the top.
  - **Live context-% pill** ✅ (2026-06-22) — the gauge used to update only on the
    end-of-turn `result`, so mid-turn (exactly when you're deciding "am I in the dumb
    zone?") the one accurate number was stale. The runtime now forwards interim usage:
    `handleRawEvent` emits a `usage` event off each `message_start` in the turn's tool
    loop (`src/agent.js`), whose input-side usage (fresh + cache) is the context that
    call actually saw. The front-end's `driveUpdateCtx` runs on `usage` as well as
    `result`, so the pill climbs as context fills and settles at the exact turn-end
    figure. Ground truth, not a delta approximation; no transcript/ingest bloat (the
    events are SSE-only, in-memory).
    - **🐛 Follow-up — the pill is inconsistent (2026-06-23, Mike).** It bounces
      mid-session (suspected sub-agent `message_start` usage leaking in), changes across
      resume (the adopt path re-seeds no usage/model, and the window defaults to 200k
      when the model is unknown), and silently drops on auto-compaction without telling
      the user. Mike also wants the **token count shown in the header pill itself**
      (K-formatted, ticking up, always visible alongside idle/bypass), not just the %.
      Full root-cause research + fix list in `PROJECT_VIEW_PLAN.md` §I ("Context meter
      is inconsistent — make it stable + always-on").
- **Prompt-unit rail** — `Sessions | Prompts` toggle, default Prompts; prompt rows
  show source, session color, timestamp, and outcome chips; live mode
  slides new prompt-units into the rail. ✅ Shipped first pass. (Intent auto-tagging
  shipped separately in §C and shows as the archetype pill on the card; mirroring it
  into the rail row is the one open follow-up.)
- **Prompt-card permalinks** — stable URLs to a specific prompt card / turn. ✅ Existing `/c/<cardId>` now pairs with exact-card rail navigation.
- **Outcome chips** — cheap summaries from captured data before building more
  artifact families. ✅ First pass shipped.
- **Live dashboard re-entry** ✅ — clicking the active project in the project rail
  from a conversation now returns to the AI brain/dashboard without turning live off.
- **Back-to-dashboard from a conversation** ✅ — a "← dashboard" breadcrumb in the
  reader returns to the project's brain/timeline without leaving the project (live stays
  on); previously the only way back was out to the workspace, which dropped live.
- **Evidence artifacts** — `vbrt shot` before/after screenshots ✅ + motion clips ✅
  (`--clip`, gif via ffmpeg or webm fallback). Hardened across the Maze series (exp 5):
  - **Cross-env capture** ✅ — one hardened headless launch (`--no-sandbox` etc.) shared
    by the `doctor` probe and real capture (so doctor predicts `shot`), + `vbrt doctor
    --fix` to install Playwright + chromium on demand. Fixes WSL/Snap/Docker/CI hangs.
  - **Motion-aware clips** ✅ — `--clip [s]` is now a *cap*; the clip records from first
    paint and **auto-stops when motion settles**, so length tracks the real animation
    (button toggle → ~1s, long sim → cap) with no per-app speed tuning.
  - **Polymorphic outcome rail** ✅ Stages 1–2 shipped (router + shot/diff/test/experiment/
    options families; server-side intent classifier, Haiku 4.5). **Test family hardened
    2026-06-18** (`684cece`): it was firing fabricated "FAIL — N passed, M failed" verdicts
    and "PASS passing" pills on *any* tool output (a `✓`, a stray "passed"/"failed" token in
    a diff/Read/`vbrt status`). Now gated on a real test command — same don't-guess-from-text
    principle as the chip work below. **provenance** + **multi-viewport** families still open
    in `PROJECT_VIEW_PLAN.md §C`.
- **Agent ergonomics — "make capture boring"** ✅ first pass, from experiment-3
  feedback: VibeRate was costing the agent tokens, not just collecting work. Fixed:
  (a) `vbrt shot` now resolves Playwright from the **repo's** `node_modules`, not just
  the skill dir, so an in-repo `npm i -D playwright` works instead of sending the agent
  down a `NODE_PATH`/patch-the-skill detour; (b) **`vbrt doctor`** preflight (repo /
  watch / capture readiness + the exact command); (c) `vbrt watch` writes a heartbeat
  so the agent can skip a redundant final `push --all`; (d) SKILL.md guidance —
  capture decision tree, "scale the process to the work" small-experiment mode, and a
  trust-watch sync rule.
- **Iteration-2 (Codex re-run of the sort experiment)** — the capture fix **worked**:
  `vbrt shot <localhost>` captured screenshots + clips immediately, no Playwright
  spiral (capture friction down ~80–90%). Friction **shifted from tool to workflow**;
  shipped in response:
  - **Publish resilience** ✅ — backoff/retry honoring `Retry-After`, a local **outbox**
    so a failed upload is never lost, `vbrt push --retry` to drain it, auth-aware
    rate-limit headroom server-side, and watch deltas opt out of the outbox.
  - **Watch/push double-send** ✅ — `push` warns on a fresh `watch.lock`; `shot` success
    message says whether the artifact streamed live or rides the next push.
  - **Lean-by-default + `doctor` adoption** ✅ — SKILL.md default: run `vbrt doctor`
    first; `DEVLOG.md` only unless the work outgrows one session; 2–3 artifacts.
  - **Capturable-app design** ✅ — SKILL.md teaches deep-link/query params so a single
    `shot <url>?…` reproduces the view.
- **Iteration-3 (Game of Life, lean prescription-free seed)** — best run yet: 4m39s vs
  7m32s, 3 lightweight docs (no `PLAN_*` sprawl), 2 clips, capture worked directly,
  better product per minute. Overhead down to ~10–20%. The lean defaults + capturable
  URL pattern **landed without the seed forcing them**. The bottleneck is no longer
  agent confusion — it's **VibeRate state/status clarity**: the agent should always know
  *is watch live, where is the project URL, what's queued, is a manual push needed*.
  Status-clarity gaps → all shipped:
  - **`vbrt status`** ✅ — one local-only glance: watch live?, project URL, evidence
    captured, outbox count, "manual push needed?".
  - **Enrich `watch.lock`** ✅ — now carries project **URL** + last-upload + queued; the
    watcher writes the share URL after each stream. No more searching `~/.vbrt` / `/tmp`.
  - **`shot` under live watch prints the project URL** ✅ — from the lock, so there's no
    reason to push just for a link.
  - **"No commit yet" guidance** ✅ — `gitHead` suppresses the leaked `fatal:` stderr;
    `shot` nudges commit-then-capture.
  - **`.gitignore` default** ✅ — `shot` ensures the whole `.vbrt/` dir is ignored on
    first capture.
- **Iteration-4 (Game of Life, status-clarity build)** — first run where it feels like a
  real product loop: *build → test → capture → get share link → push public → done.*
  4m16s (fastest yet), overhead ~8–15%. The **reward moment worked** — `shot` surfaced
  `Share/view: …/p/…` so the agent never hunted for the URL; **no 429**; the no-commit
  nudge worked (committed, then recaptured). Remaining friction is now **polish-level
  workflow defaults**, not tool friction → next priorities:
  - **Lean docs, harder default** ✅ — it still made `ROADMAP.md` + `PLAN_life.md` for a
    toy (the ROADMAP just pointed at the PLAN — pure ceremony). Tighten SKILL.md: small
    experiments are **`DEVLOG.md` + `README.md` only**; no `ROADMAP.md`/`PLAN_*` unless
    multi-session or asked.
  - **Public/private clarity** ✅ — it pushed (private), realized, then re-pushed
    `--public`. When a link already exists, say its visibility and the exact next command
    (`vbrt publish --public` / `--private` now flips visibility without re-sending the
    bundle, and `vbrt status` shows the saved link visibility).
  - **Require a clip for animated apps** ✅ — the final capture was a still
    (`✓ Captured artifact`), not a clip, on a motion-first app. SKILL.md: for animated
    work, capture at least one `--clip` after the first commit.
  - **Commit-before-first-capture, stated** ✅ — handled reactively now; make it the
    explicit default in SKILL.md (commit the first working version before capturing,
    unless the user wants a pre/post comparison).
  - **`vbrt status` as the natural finish** ✅ — it succeeded *without* `status`/`doctor`,
    inferring state from push output. Nudge agents to **end with `vbrt status`** so the
    tool, not the output log, is the source of truth.
  - Later, if needed: `doctor --fix`, SSE/WebSocket streaming, coalescing watch deltas.
- **Mobile — responsive port** *(planned 2026-06-20 → `PLAN_MOBILE.md`)* — full
  read+drive port to mobile, delivered responsively in the one codebase (no separate
  route/SPA), centered on the **Variant A** unified screen (chat-first + expandable brain
  header strip). Decided with Mike. Slices: responsive shell + nav → Variant-A project home
  → brain⇄chat live link (Drive `tool_use` glows the touched brain node, desktop too) →
  polish. Desktop above the breakpoint stays untouched. Prototype:
  `public/proto/mobile-unified.html`.
- **Minimap** for the conversation viewer (overview + jump for long sessions).
- **"Launch terminal session" from a convo** *(idea — value TBD)* — a per-conversation button that spawns a new WSL terminal running the matching agent (e.g. Codex/Claude) with that conversation already loaded/resumed, so you can pick up an archived session live. Needs: local-only affordance (won't work for hosted/shared views), a way to map a captured session back to its agent + resume command, and a host-side launcher (the browser can't open a WSL terminal directly — likely a small local helper / protocol handler). Park as exploratory until the resume-mapping is proven.
- **Collapse the repo-selector sidebar on drill-in** ✅ — once you click into a repo, the project picker hides for a focused view with an obvious workspace-back affordance.
- **Legibility pass (external review, 2026-06)** — first-contact gaps on an otherwise polished UI; full breakdown + ranking in `PROJECT_VIEW_PLAN.md` §G. Mostly shipped on audit (2026-06-17); only duplicate-clustering remains:
  - **Color/dot legend** ✅ — two legends live: the sessions-rail `list-legend` ("a colour per session · claude / codex = agent") and the activity-timeline `ribbonLegend()`, which decodes every mark at rest. (Per-session hues are identity tags, not a categorical scale, so no hue-by-hue key is needed — a third legend would be noise.)
  - **Suppress empty / duplicate sessions** ◐ — empty sessions ✅ collapse into a `<details>` group ("N empty sessions · you sent no prompt"). **Remaining:** cluster same-prompt-across-models duplicates so parallel-agent runs don't stack as full cards (needs care not to hide useful parallel work).
  - **Project name-collision** ✅ — identically-named projects are disambiguated (path / last-active) in the project list.
  - **Timeline legibility** ✅ — each lane carries a persistent left-edge label (code / brain / commits / messages / convos) and `ribbonLegend()` keys the colors, so the timeline reads at rest, not hover-only.
  - **Pluralization + jargon tooltips** ✅ — `plural()`/`plw()` give `1 msg`; one-line `jargon` tooltips on 🧠 brain edits, brain history, and the context-% gauge.
  - *Keep (don't regress):* session detail view, CLAUDE/CODEX badges + filter pills, Web/Tree/Recent (Tree most legible), dark/purple theme.

## Open questions / to weigh

- **Hardening vs. social** — *(reframed 2026-06-21: the differentiator is now the
  drive runtime, not feedback)* — anonymous hosted ingest plus persistent storage
  is still the operational risk for the read side; harden ingest/privacy before any
  discovery push. But the bigger near-term operational surface is the **drive
  control plane** (RCE): onboarding/credentials and multi-tenant gating
  (`ONBOARDING.md`) gate it before non-operator users.
- What's the right unit to "fork" — a whole project, a session, or a single prompt?
- **Drive surface (the "drive" in capture → understand → drive)** ✅ shipped — a chat
  box that types to the agent *through* VibeRate, turning the watcher into a local
  agent runtime. Fork A chosen (spawn the real `claude` binary, not an SDK adapter);
  live locally and on Fly (admin-gated), with token streaming, subscription-vs-API
  auth (local uses the Max plan; hosted seeds an operator login or bills an API key),
  and the **B2 inline picker** (custom MCP `ask` tool). Still open: per-tool approvals,
  dual-provider event model, and hosted multi-user (BYO per-user key). Full status in
  `PLAN_AGENT_RUNTIME.md`.
  - **Resume a Drive across a redeploy** ✅ shipped — the common dogfooding loop is
    "drive → commit + push → Fly redeploys → refresh". A redeploy wipes the agent's
    in-memory session Map, so the red **Return to Drive** button used to land on an
    empty/dead view (the `GET /sessions/:id` 404 dropped the handle). The claude
    session itself is durable on the volume, so we now treat that on-disk transcript
    as the source of truth: a new `POST /api/agent/sessions/adopt` re-binds a fresh
    local handle to the persisted `claudeSessionId`, replays the saved transcript into
    the event log (so the reconnect shows the prior conversation, not a blank box), and
    leaves it idle — the next message resumes via `claude --resume`. This is the
    `/resume` analogue the redeploy loop needed. `resumeDrive()` tries the live record
    first (fast path for a same-process reload) and falls back to adopt on 404; only a
    genuinely missing transcript drops back to the read-only ingested convo. Wiring:
    `agent.adoptSession` + `setTranscriptLoader`, `driveIngest.loadDriveTranscript`,
    server wires the loader. The durable handle now also carries `permissionMode` so a
    resumed session keeps its mode (e.g. `bypassPermissions` for a push-capable drive).
- **Prompt chips / "frequently used phrases" on the first-message page** *(v1 shipped 2026-06-22)*.
  Motivation: starting a Drive session almost always opens with the same boilerplate
  ("read the codebase and the .md files, then follow the plan doc, commit and push when
  finished"). Retyping it is friction, and the first-message page (`renderDrivePrompt`)
  has lots of unused real estate below the textarea. Proposal:
  - **v1 (cheap, ship-anytime):** ✅ — a `.dv-chips` row sits in the dead space between
    the `#dv-prompt` textarea and the Start button. Chips insert their phrase at the
    cursor (composing into a prompt) and **toggle**: a second tap on an active chip
    removes exactly what it inserted (`driveInsertPhrase`/`driveRemovePhrase`, active
    state keyed by phrase text in `state._driveChipsActive`, `.dv-chip.on` highlight).
    A "★ save" chip captures the current composer text as a reusable phrase, persisted
    in `localStorage` (`vbrt.drivePromptChips`, ≤20, de-duped) and rendered with a
    removable ×, mirroring the `DRIVE_*_KEY` pattern. Chips are built as DOM nodes (not
    innerHTML) so saved text can't inject markup.
  - **Seed phrases are data-grounded, not guessed** (2026-06-22): mined the project's
    own 51 driven-session openers (`/data/claude/projects/*viberate*/*.jsonl`,
    first-user-message per session) and seeded the six most frequent real habits —
    *get up to speed (codebase + MD network + git history)*, *follow the plan / implement
    to completion*, *add commit & push to main*, *update the MDs*, *investigate & fix*,
    *ask if unsure* — phrased the way they actually get typed. This is a one-off manual
    pass of what v2 automates.
  - **v2 (suggested phrases) — *now explicitly requested (2026-06-23, Mike): "think
    through how the auto text chips get populated / updated over time in an intelligent
    way."*** Mine the user's own history for recurring openers. We already parse every
    session's first user message (`parsers.peekClaude` → `firstUserText`, and
    prompt-unit data per project). A cheap pass — cluster/rank frequent opening
    sentences, optionally normalized by a Haiku call (`claude-haiku-4-5`) to merge
    near-duplicates and produce a clean canonical phrase — surfaces the top N as
    suggestion chips. Haiku (not a bigger model) keeps it cheap and fast; the server
    already holds an API key for the classifier (`classify.js`). **The "over time"
    half is the new ask:** the chip set should **refresh incrementally** as new
    sessions land (same once-per-`cardId` discipline as the classifier — don't re-mine
    the whole corpus each push) and **age out** phrases the user has stopped typing, so
    the chips track how their prompting actually *evolves* rather than freezing the
    one-off 2026-06-22 seed. Open: rank by recency-weighted frequency vs. raw count;
    cap + pin behavior so a user's saved chips aren't evicted by mined ones.
  - **v3 (prompt coaching):** once suggestions exist, steer toward *better* prompts —
    e.g. flag a vague opener and offer a tighter rewrite, or attach the relevant plan
    doc automatically. Tie-in with `archive/experiments/PROMPT_GALLERY.md`. Park until v1/v2 prove the chip
    UI earns its space.
  - Open question for v2: where to gather the corpus in hosted mode (per-account prompt
    history vs. the local `~/.claude` logs the watcher sees) — local has the richest
    history; hosted would lean on ingested prompt-units.
- **Mobile projects header — chat-bubble icon** ✅ shipped — the project screen's app
  bar showed two near-identical stacked-line glyphs (left `☰` = projects drawer, right
  `≣` = conversations rail), easy to misread as two hamburgers. The right button is now
  an inline-SVG speech bubble (currentColor, theme-aware) so it reads as "conversations".
  Markup only (`public/index.html`); the `#m-rail` id + `toggleSheet` wiring are unchanged.
- How much conversation content is safe to expose publicly even after redaction?
