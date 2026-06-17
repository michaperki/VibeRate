# VibeRate — Roadmap

Canonical frame: see `PRODUCT_STRATEGY.md`.

VibeRate is the hosted viewer and feedback layer for terminal-agent development:
agents publish the work behind a repo — prompts, decisions, screenshots, diffs,
commits, and brain docs — so developers and reviewers can watch, understand, and
discuss how the project was built.

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

- **Deploy the host** — viewer + ingest on a real URL; swap file store for a DB (projects keyed by id).
- **Publish the marketplace** — push repo to GitHub; verify `/plugin marketplace add` → `/plugin install`.
- **Default endpoint** — point the skill at the deployed URL so the localhost step disappears.
- **Identity (gist → claim)** — anonymous push returns an unlisted link; optional "claim your account" attaches projects to an owner (token flow).
- **Live read-only monitor (`vbrt watch`)** — ✅ **shipped** (brain + conversation stream live, hands-free, delta pushes, viewer follows). Spec `STREAMING.md` archived → graveyard ghost. Streaming follow-ups, only if needed:
  - SSE/WebSocket (drop polling) if polling ever feels laggy.
  - Reader refinement — append new turns instead of full re-render (preserve expanded `<details>` while following).

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

## Phase 2 — Feedback / sharing (the core product)

- **Feedback** — comment / give feedback on a shared project or a specific prompt/turn.
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
- **Evidence artifacts** — `vbrt shot` before/after screenshots ✅ + motion clips
  (`--clip`, gif via ffmpeg or webm fallback) ✅ shipped and exercised on the
  sorting-visualizer experiment; diff/test/provenance families still tracked in
  `PROJECT_VIEW_PLAN.md §C`.
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
- **Collapse the repo-selector sidebar on drill-in** — once you click into a repo, hide the picker for a focused view, with an obvious "back to repos" affordance. (Hosted `/p/:id` already runs picker-less; this brings the same focus to the local multi-project view.)
- **Legibility pass (external review, 2026-06)** — first-contact gaps on an otherwise polished UI; full breakdown + ranking in `PROJECT_VIEW_PLAN.md` §G:
  - **Color/dot legend** — per-session identity hues carry no key; users can't decode the primary signal *(top priority)*.
  - **Suppress empty / duplicate sessions** — `(no prompt) · 0 msgs` cards and same-prompt-across-models dupes should collapse / cluster, not stack as full cards.
  - **Project name-collision** — disambiguate identically-named projects (path / last-active).
  - **Timeline legibility** — row labels + color coding readable at rest, not hover-only.
  - **Pluralization + jargon tooltips** — `1 msg`, and one-line tooltips for "brain edits" / 🧠 / context-% gauge.
  - *Keep (don't regress):* session detail view, CLAUDE/CODEX badges + filter pills, Web/Tree/Recent (Tree most legible), dark/purple theme.

## Open questions / to weigh

- **Hardening vs. social** — feedback is the differentiator, but anonymous hosted
  ingest plus persistent storage is the operational risk. Do prompt navigation
  and outcome chips now, then harden ingest/privacy before pushing discovery.
- What's the right unit to "fork" — a whole project, a session, or a single prompt?
- How much conversation content is safe to expose publicly even after redaction?
