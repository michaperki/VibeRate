# VibeRate — Information Architecture

> **Reframe note (2026-06-21):** this doc's "hosted/social model = your public
> profile" framing is from the observation-tool era. VibeRate is now a mobile,
> agent-first IDE (`PRODUCT_STRATEGY.md`); the public-profile / social reading is a
> *later* layer, not the center. The **two-tier structure below (Workspace = you,
> Project = a repo) still holds** — it's the right shape for both driving and
> reviewing. Read "public profile" as "the future social surface," not today's
> priority.

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

Research into dynamic memory/document relevance, Brain-node metrics, and per-turn
context credit assignment is documented in `CONTEXT_CREDIT_RESEARCH.md`. The current
architecture supports useful activity and structural signals, but not authoritative
memory-to-outcome attribution.

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

### Workspace memory rollup — removed (decided + shipped 2026-06-19)

**Resolution:** the cross-project agent-memory section was **removed** from the workspace
home. The workspace now shows only its faithful global **stats** (projects · sessions ·
messages · commits); each repo's memory lives on its own project page (the 🧠 Agent
memory card), where it's in the right context. `getWorkspaceRollup()` no longer reads any
`memory.json` (it returns `memory: []` for client back-compat); `renderWorkspaceSection()`
no longer renders a memory block. The investigation that led here is kept below.

> **Why remove rather than filter?** The section couldn't be made *faithful* with the data
> we capture. Saved `memory.json` is always a project's **own** project-scoped notes, so
> there's nothing genuinely cross-cutting to aggregate; and the real global "about you"
> facts (e.g. "works on Windows + WSL") live in the global `~/.claude/CLAUDE.md`
> instruction store, which we don't capture. A type allow-list would just leave the
> section near-empty and still mislabeled. A faithful "what your agent knows about *you*"
> surface would read the global/ancestor-scoped stores — **revisit this** if/when that
> capture exists, or repurpose the space for the future social/feed surface.

**Original symptom (kept for context):** the workspace home ("Your workspace") showed a
**Feedback** group full of project-specific notes, each tagged with a project badge. It
felt misplaced — that guidance is about *one repo*, so it read like it belonged on the
project dashboard, not the global "you" surface.

**Why it happens — two memory paths that disagree on `scope`:**
- The **scope-aware** path is `src/workspace.js`: a store is `workspace`-scoped only if
  it's an ancestor dir of another store; otherwise `project`. `getProjectMemory()` even
  *adopts* `project`-typed notes from a workspace store down onto the relevant project.
  This is the path the architecture above describes.
- The **workspace rollup** that actually feeds the home page is a *different* function —
  `getWorkspaceRollup()` in `src/storage.js` (served at `/api/workspace`). It reads each
  project's saved `memory.json` via `getMemory(slug)` and flattens **every** note,
  grouping only by `type` (`user`/`feedback`/`project`/reference/note`) and tagging each
  with its source projects. It **never consults `scope`** — in fact `memory.json` doesn't
  even carry the per-note scope, which is derived from the directory tree in `workspace.js`
  and thrown away at save time. So a project-scoped `feedback` note (e.g. VibeRate's
  `decision-method`, `no-test-infra`) is surfaced globally.
- Front-end: `renderWorkspaceSection()` (`public/app.js:3280`) renders those groups
  verbatim; `order = ['user','feedback','project','reference','note']` is what names the
  "Feedback" header. The same notes *also* render on the project page via
  `/api/projects/:slug/memory`, so they appear in **both** places.

**Net:** the rollup's design goal ("aggregate every project's memory, tagged by project")
directly contradicts the scope principle ("project notes stay on the project"). The
`type` grouping makes it worse — `feedback`/`project` are inherently repo-local, yet they
get top-level global sections.

**Options considered (superseded by the removal above):** (1) honor scope by carrying it
into `memory.json` and keeping only workspace-scoped/`user` notes; (2) re-bucket by scope
into an "about you" vs. collapsed per-project drill-in; (3) a `user`/`reference` type
allow-list. All three still presented project memory as a global surface — and with only
project-scoped data captured, each would have left the section near-empty or mislabeled.
Removing it was the honest call; reintroduce a faithful version only once truly-global
memory is captured.

## Principles

**Liveness is inferred, never asserted.** We learn "what an agent is doing" from a stream
of discrete events (hooks → `.vbrt/stream.jsonl`; or parsed transcript turns). There is **no
authoritative "session alive / ended" signal**: a hard exit (Ctrl-C, terminal close, crash,
reboot) fires *no* hook — not `Stop`, not `SessionEnd` — so the event stream simply stops
mid-action. `Stop` is end-of-*turn*, not end-of-session, so even a clean "idle" is ambiguous.

The trap (which we shipped and had to fix — see LIVE_ORCHESTRATION §8a): deriving a status as
`last.ev === 'idle' ? 'idle' : 'working'`. A session killed mid-tool keeps a `tool` as its last
event and reads **"working" forever** — and a still-running `vbrt watch` keeps the project
"streaming", so it never ages out on its own.

Rules for any new live/status surface:
- **A non-terminal last event (`tool`/`prompt`) only means "working" while it is recent.** Gate
  it on an age/TTL (`WORKING_TTL_MS`, `LIVE_WORKING_TTL_MS`); past that, downgrade to idle/stale —
  never claim activity from a stale event. A long-thinking agent self-heals on its next event.
- **Always surface "last move Nm ago"** (the event timestamp) so a human can judge a frozen panel.
- **Handle `end` (graceful `SessionEnd`) explicitly** — auto-hide / "closed". It only covers
  clean exits; hard kills still need manual dismissal (the `vbrt watch` TUI: number-key dismiss).
- **Prefer "show + let the user dismiss" over a fixed auto-evict** — a live session can sit idle
  for a long time legitimately, so a timeout must not *remove* it, only stop it reading "working".

## Status

- Tier 2 (Project): built, incl. per-project agent memory.
- Tier 1 (Workspace): built (Cold-start context, single view).
- Follow-ups: Codex distilled memory (reader wired, gated behind `VBRT_CODEX_MEMORY=1`,
  empty on this machine), global config beyond the two facts, prompter profile/metrics.
