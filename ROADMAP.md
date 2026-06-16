# VibeRate — Roadmap

> "GitHub for agent conversations." A downloadable agent skill (push client) plus
> hosted infra where vibe coders publish, view, and share their Claude Code /
> Codex sessions as interactive dashboards.

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
- **Live read-only monitor (`vbrt watch`)** — a long-running local client that watches the repo's Claude/Codex session logs, brain docs, and git commits, then debounces and re-pushes refreshed snapshots so the hosted dashboard updates within seconds while agents work. Start with near-real-time bundle upserts/polling; graduate to delta events + SSE/WebSocket only if the UX needs it. **Spec + checklist: `STREAMING.md`** (the viewer-side animation reuses the time-travel `applyBrainAsOf` layer).

## Phase 2 — Social / sharing (the core product)

- **Feedback** — comment / give feedback on a shared project or a specific prompt/turn.
- **Fork** — copy someone's prompt(s)/session into your own space to adapt and re-run.
- **Discovery** — popular / trending "repos", profiles, browse by tag.
- **Sharing controls** — unlisted vs public; what conversation data is exposed (pairs with redaction).

## Phase 3 — Viewer UX polish

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

- **Deployment vs. features** — Phase 2 is the differentiator but structurally needs Phase 1's backend. Recommendation: a *minimal* deploy early (unblocks real testing + social), then invest in features. Don't gold-plate infra before the social loop proves out.
- What's the right unit to "fork" — a whole project, a session, or a single prompt?
- How much conversation content is safe to expose publicly even after redaction?
