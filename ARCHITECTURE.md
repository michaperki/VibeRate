# VibeRate — Information Architecture

Two tiers. The app is no longer "pick a project → see it"; there is a level above
the project.

## Tier 1 — Workspace (global / "you")

The overarching dashboard and default landing surface. Everything here pertains to
**all** your work, not one repo. In the hosted/social model this **is your public
profile** — the thing others follow.

Contains:
- **Agent memory** — what the agent has learned about *you*, across every project.
  Source: Claude's `~/.claude/projects/<workspace>/memory/*.md` (markdown, easy);
  Codex's `~/.codex/memories*` (SQLite, a fast-follow). Workspace-scoped, so it
  spans projects.
- **Global agent config** — `~/.claude/CLAUDE.md`, global `AGENTS.md`: your
  "how I always work" preferences.
- **Projects rollup** — every repo, last activity, aggregate stats; drill-in.
- **Prompter profile** *(future)* — prompting metrics aggregated across all
  sessions. The "am I getting better?" arc only exists at this tier — it spans
  projects.

## Tier 2 — Project (scoped / "a repo")

What exists today: one repo's sessions, activity timeline, conversation viewer, and
the AI-architecture centerpiece (the repo's *constitution* — `CLAUDE.md`,
`AGENTS.md`, `SOUL.md`, `README`, `ROADMAP`, `SEED`). In the hosted model this is a
**repo page**.

## The mapping (this is the backbone)

| GitHub            | VibeRate                                   | Data scope |
|-------------------|------------------------------------------------|------------|
| Profile / you     | **Workspace** — memory, profile, prompter style | account    |
| A repo            | **Project** — that repo's published sessions    | repo       |

Constitution vs. memory is the key conceptual split:
- **Constitution** (inputs you write, committed to the repo) → lives at the Project tier.
- **Memory** (what the agent learned, evolving, agent-authored) → lives at the Workspace tier.

## Data model

- **Account-level** (Tier 1): agent memory, global config, profile/metrics. Attaches
  to a *user*, not a project. Never stapled to a project bundle.
- **Repo-level** (Tier 2): the existing capture bundle (`schema`, `project`,
  `sessions`, `git`, `docs`).

This separation also resolves the publish-privacy snag: memory is workspace-wide and
would leak cross-project notes if embedded in a shared repo bundle. By living on the
**profile** (which the user controls and curates), it never rides along with a
shared repo.

## Navigation

- **Workspace (home)** is the default surface: agent memory + all projects.
- Click a project → **Project view** (focused).
- "⌂ Workspace" returns home.
- Hosted `/p/:id` opens straight into a Project view (no home), since a shared link
  points at one repo. A shared profile (future) would open the Workspace tier.

## Memory model (how the Workspace tier reads agent memory)

Memory is normalized into one shape regardless of agent:
`note = { source, authored, type, title, description, body, mtime, loading, recallCount }`.

- **source** — `claude` | `codex`. Badged on every card so it's never ambiguous.
- **authored** — `curated` (Claude: user-written markdown) vs `auto` (Codex: machine-distilled).
- **scope** (per store) — `workspace` (cross-project / "how to work with you") vs
  `project` (scoped to one repo). A Claude store is `workspace` when it's an ancestor
  directory of another store (e.g. `…/dev` contains `…/dev/catain`). This is what stops
  the dashboard from flattening every repo's notes into one blob.
- **loading** — `always` (the `MEMORY.md` index, loaded into context every session) vs
  `recall` (note bodies, surfaced only when relevant). Codex's `recallCount` makes this
  *measured* rather than inferred.

### Claude vs Codex memory

| | Claude Code | Codex |
|---|---|---|
| Form | user-curated markdown files | auto-distilled, SQLite (`stage1_outputs.raw_memory`) |
| Scope | one store per working directory | per session/rollout (`thread_id`/`rollout_slug`) |
| Loading | index always + recall-on-relevance | recall, ranked by `usage_count` |
| Reader | `readClaudeMemory()` | `readCodexMemory()` (SQLite via `node:sqlite`, gated behind `VBRT_CODEX_MEMORY=1` — experimental + often empty) |

Both adapters emit the same `store`/`note` shape, so the UI is source-agnostic: add a
reader, badge the source, done. Codex's distilled+usage-ranked nature means its cards
should lean on `authored: auto` and the real `recallCount`, where Claude leans on the
curated index/notes split.

## Surfaces (consolidated)

There is **one Workspace view: Cold-start context** — the old "Memory" browser tab was
retired (its content folded in below). Two surfaces total:

- **Workspace → Cold-start context** (the home/landing):
  - **🌐 Global** — split by *loading*, not scope: **always in context** (the
    `CLAUDE.md`/`AGENTS.md` instruction facts, decomposed into atomic rows, deduped
    across agents) and **recalled when relevant** (cross-project memory notes; only
    their `MEMORY.md` index line preloads). Click a recall row to read it.
  - **📂 Per directory** — each directory's cold-start manifest (instruction chain +
    index always; notes as a recall count).
- **Project page** — adds a **🧠 Agent memory** card showing that repo's memory notes
  (recall-only). A store matches a project by **normalized leaf name**, so memory
  created from a WSL-home path (`/home/.../horsey_v2`) still attaches to the project
  captured from the Windows mount (`/mnt/c/.../horsey_v2`).

## Status

- Tier 2 (Project): built, incl. per-project agent memory.
- Tier 1 (Workspace): built (Cold-start context, single view).
- Follow-ups: Codex distilled memory (reader wired, gated behind `VBRT_CODEX_MEMORY=1`,
  empty on this machine), global config beyond the two facts, prompter profile/metrics.
