# VibeRate — Roadmap

Canonical frame: see `PRODUCT_STRATEGY.md`.

VibeRate is an **Agentic IDE / work environment** for terminal-agent development:
it captures the work behind a repo — prompts, decisions, screenshots, diffs,
commits, and brain docs — so a developer can watch, understand, and drive how the
project gets built. A **social / learning layer** (feedback, sharing, discovery) sits
on top as a later byproduct, not the core: the first job is making the single-developer
capture → understand → drive loop frictionless and robust.

Working category remains open. "Agentic Code Viewer" and "Agentic Work
Environment" are useful probes, but the current product copy should stay concrete:
publish, watch, review, and understand agent work.

## Done (v0 — local + push foundations)

- **Capture pipeline** — discover → parse Claude/Codex sessions, extract git history + agent docs.
- **Viewer** — activity timeline, conversation viewer, and the AI-architecture network with **Web / Tree / Recent** layouts, animated transitions, and the doc-reader **overlay** (compact, no-scroll dashboard).
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
6. **Live orchestration + timeline legibility** *(now-priority)* — make the dashboard
   feel real-time and coherent while an agent is actively working. Full breakdown +
   code root-causes in `LIVE_ORCHESTRATION.md`. ✅ First pass shipped (2026-06-18):
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
   - **Web-view layout fills the canvas** ✅ — `layoutGraph` spreads to encompass the
     available width instead of clustering nodes mid-canvas.

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

- **Prompt-unit rail** — `Sessions | Prompts` toggle, default Prompts; prompt rows
  show source, session color, timestamp, intent tag, and outcome chips; live mode
  slides new prompt-units into the rail. ✅ Shipped first pass.
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
  - diff/test/provenance families still tracked in `PROJECT_VIEW_PLAN.md §C`.
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

- **Hardening vs. social** — feedback is the differentiator, but anonymous hosted
  ingest plus persistent storage is the operational risk. Do prompt navigation
  and outcome chips now, then harden ingest/privacy before pushing discovery.
- What's the right unit to "fork" — a whole project, a session, or a single prompt?
- How much conversation content is safe to expose publicly even after redaction?
