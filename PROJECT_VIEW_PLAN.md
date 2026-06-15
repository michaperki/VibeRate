# VibeRate — Project View Plan

Synthesis of two independent research passes (Claude + Codex) and Mike's own
notes. Focus: the **internal Project view** — the AI Brain, the Chat Display,
and the Prompt Display. Supersedes the now-deleted `CLAUDE_SUGGESTIONS.md` and
`CODEX_SUGGESTIONS.md`.

## Positioning (the frame, corrected)

VibeRate is **not** "GitHub for agent conversations" (that's version control;
wrong). It is about: **getting feedback / collaborating** on agent work,
**managing your project's AI brain** (the constitution + docs + memory the agent
runs on), and **seeing how others manage theirs**. The internal product's
strongest potential, per both passes: *a living history of how a person and
their agents understood, discussed, and changed a project* — with every claim
traceable to the work that created it.

## Core organizing principle

Two parallel tracks, joined at the seam:

1. **The prompt unit becomes the internal reading unit.** `before → prompt →
   after`, the atom that today only renders on the public surfaces (`/explore`,
   `/c/:id`), becomes how you read your *own* sessions. Around each prompt hangs
   an **outcome / evidence rail**: files changed, diffs, tests, commits, context
   fullness, screenshots, and whether the follow-up was a correction or an
   approval. (Both passes' #1; Mike agreed to give it a shot.)
2. **The Brain becomes the project's evolving model**, not a filename map — with
   organization, motion, and history.

The seam: the rail links a prompt to *which Brain concept it changed*. That link
is the "living history."

Both passes independently recommended unifying the prompt unit into the reader.
That convergence is why it's first.

---

## Workstream A — Unified prompt-unit reader

Make `selectSession` render the prompt-card chain (consume the orphaned
`GET /api/projects/:slug/sessions/:id/prompts` endpoint), instead of the legacy
`renderTurn` / `renderTurnItems` path.

- **[DECISION — toggle]** Reading density. Build a live toggle:
  - **Narrative** — prompts + meaningful replies + outcomes (prompt cards).
  - **Worklog** — adds summarized tool activity + files changed.
  - **Raw** — the exact normalized transcript (today's view).
- Keep acks ("go ahead") *inside* the reader as styled connectors (the
  `↳ you: …` tail from the mid-convo prototype), even though the public feed
  drops them.
- Deep-link + restore state: each session / turn / card gets a stable URL;
  returning restores scroll + expansion. (Prereq for "open session →" from a
  card actually landing on the right turn.)

## Workstream B — Outcome / evidence rail

A compact rail beside each prompt showing observable consequences (not an
AI-generated "score"):

- Files changed · **real diffs** (we have `file_path` + old/new; today edits
  render as raw JSON) · tests run + result · commits produced · Brain/docs
  changed · interrupted? · follow-up = correction / continuation / approval.
- **Context fullness ("dumb zone") — confirmed buildable.** The raw logs carry
  it; `src/parsers.js` currently drops it:
  - Claude: assistant `message.usage` → `input + cache_read + cache_creation` =
    effective context at that turn; `message.model` gives the window.
  - Codex: `token_count` events → `info.total_token_usage`,
    `info.model_context_window`, rate-limit `used_percent`.
  - Show a per-prompt **context gauge** ("62% full · 124k/200k") + a dumb-zone
    flag past a threshold, and a per-session **context-growth sparkline**.
- **[DECISION — mock]** Rail placement/shape: right-side rail vs. under-prompt
  chip-row vs. an expandable footer. Mock 2–3 on real data.

## Workstream C — Brain organization (no more "3 READMEs you click into")

Ladder, cheap → rich:

1. **Hover peek** — hover a node → card with the doc's heading outline + first
   line. See inside without clicking.
2. **Heading explosion** — render large docs as a small cluster of their H2/H3
   sections, so topics ("Architecture › Data model") are first-class nodes.
3. **Role grouping** — cluster/color constitution (SOUL/CLAUDE/AGENTS) vs
   reference (README/ROADMAP) vs memory. (`ARCHITECTURE.md` names
   constitution-vs-memory as *the* split.)
4. **Concepts (later)** — extract goals / decisions / constraints / open
   questions as nodes; files become *evidence* attached to concepts. Heuristic
   (doc headings) first; LLM-assisted later. Keep Web / Tree / Recent layouts,
   applied to this semantic layer.

- **[DECISION — toggle/mock]** Whether heading-explosion is always on, a zoom
  level, or a toggle alongside Web/Tree/Recent. Mock it.

## Workstream D — Brain motion & lifecycle

Make the graph feel alive *and* encode meaning.

- **Pulse — [DECISION, mock the encoding]:**
  - rate ∝ recency (recently-touched docs breathe faster), and/or
  - intensity ∝ load-bearing-ness (how often the agent actually `Read` it in
    sessions — from tool_use).
  Mock both encodings (and a plain ambient pulse) so Mike picks.
- **Lifecycle effects (Mike's add: what happens on add / delete / modify):**
  - **Added** — node "births": scale/fade in with an expanding ring + brief
    glow; edges draw in. In Recent/time-travel, tagged "new."
  - **Modified** — a flash / ripple on the node; edge set re-settles.
  - **Deleted / retired** — node "dies": shrink + fade; **[DECISION — mock]**
    does it vanish, or leave a faint **ghost/tombstone** so the brain's history
    stays visible? (Leaning ghost, because Brain *evolution* is a core story.)
- **Brain time travel (the distinctive feature)** — a timeline slider: "what did
  the agent believe on May 20?" Scrubbing births/flashes/kills nodes per the git
  history of doc changes, and shows the responsible prompt + the actual doc diff.
  The existing brain-edit ribbon lane is the seed (today it only knows a named
  file changed — needs doc diffs preserved at capture).

## Workstream E — Evidence-capture skill (needs its own design doc)

Generalize "screenshots" → **outcome evidence**, where screenshot is the
*frontend* specialization and the backend equivalents are test output / diff /
curl-or-API response / a benchmark number. An agent skill captures evidence at
**prompt boundaries** (before = state when prompt sent; after = state when agent
yields).

Open questions to pin down before code (write `EVIDENCE.md`):
- Manual trigger vs. automatic at turn boundaries.
- Where the target comes from (dev-server URL for screenshots; command for
  tests/curl).
- Storage in the bundle + size budget + redaction of screenshots.
- How "before/after" is anchored to a specific turn/card id.

## Workstream F — Supporting (as needed, not blocking)

- **Parser:** retain `usage` on assistant turns; attach to the preceding prompt.
  (Prereq for B's context gauge.)
- **Scale:** the dataset is large (286 sessions, ~92k messages, sessions up to
  1,357 msgs / 1.68 MB). Summary-first + progressive/chunked loading is a
  requirement, not polish.
- **Search / filters:** prompt+response text, files, commands, Brain concepts,
  commit subjects, agent, date, outcome. Filters: only-prompts, failed work,
  brain-changing turns, high-churn, interrupted.
- **Episodes (later):** group related sessions/agents into work episodes
  ("Redesign IA", "Fix auth", "Abandoned mobile nav") with status
  completed/ongoing/abandoned/superseded — makes hundreds of sessions browsable.
- **Editable intent-based session titles** (first prompts make poor titles).
- **Tests** around parsers / prompt extraction / redaction / activity
  attribution (no suite today).

---

## Decision points (resolved via toggle or mock, per Mike's method)

For every fork below, build a live **toggle** or a **mockup** (à la
`prototypes/prompt-unit*.html`) — don't pick unilaterally.

| # | Decision | Method |
|---|----------|--------|
| 1 | Reader density: Narrative / Worklog / Raw | live toggle |
| 2 | Outcome-rail placement (side rail / chip row / footer) | mock 2–3 |
| 3 | Brain heading-explosion: always-on / zoom / toggle | mock + toggle |
| 4 | Pulse encoding: recency / load-bearing / ambient | mock all three |
| 5 | Deleted-node effect: vanish vs. ghost/tombstone | mock |

## Sequencing

1. **Slice 1 — Unified reader + context gauge.** Parser keeps `usage` (F) →
   prompt-card reader (A) with the density toggle (decision 1) → context gauge
   on each card (B). Highest convergence, immediate "this is *mine*" payoff.
2. **Slice 2 — Brain organization.** Hover peek + heading-explosion + role
   grouping (C), with mocks for decisions 3.
3. **Slice 3 — Brain motion & lifecycle.** Pulse + add/delete/modify effects
   (D), mocks for decisions 4–5.
4. **Slice 4 — Outcome rail in depth.** Real diffs + test/commit signals (B),
   mock decision 2.
5. **Slice 5 — Evidence-capture skill.** After `EVIDENCE.md` (E).
6. **Ongoing — scale, search, episodes** (F) as the data demands.
