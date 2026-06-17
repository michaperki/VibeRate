# VibeRate — Product Strategy

Status: **canonical frame** for near-term product and roadmap decisions.

## One-sentence frame

VibeRate lets agents publish the work behind a repo — prompts, decisions,
screenshots, diffs, commits, and brain docs — so developers and reviewers can
see how the project was built and give feedback on the work as it happens.

## Category, for now

The category name is still open. "GitHub for agent conversations" is useful as a
shortcut, but it points at the wrong center of gravity: GitHub is version control,
while VibeRate is the viewer and feedback surface for agentic development.

The better analogy starts from the tool shift. Developers used to do most
development inside an IDE such as VS Code or Neovim. Increasingly, the active
work happens through terminal agents: Codex, Claude Code, and whatever comes
next. That means the missing product is not another IDE. It is the environment
around terminal-agent work: something that watches, explains, reviews, and shares
what the agent and developer did.

Possible names:

- **Agentic Code Viewer** — clear, a little narrow.
- **Agentic Work Environment** / **AWE** — broader, a little too coined for now.
- **Agent Work Viewer** — plain, probably closest to current reality.

Decision: do not force the acronym yet. Keep the product copy concrete: publish,
watch, review, and understand agent work.

## Product thesis

The atomic object is the **prompt unit**: before state -> prompt -> agent work ->
after state. VibeRate should make prompt units easy to scan, deep-link, evaluate,
and discuss.

The durable context is the **project brain**: the repo docs, memory, decisions,
plans, and architecture notes that shape what the agent does. VibeRate should
show how the brain changes over time and which prompts caused those changes.

The social loop is feedback, not discovery theater. The first social feature
should help someone comment on a project or a specific prompt card. Forks,
trending, and broad discovery come after the review loop proves useful.

## Immediate priority order

1. **Prompt-unit navigation + deep links.** The left rail should make individual
   prompt units first-class, with sessions available as a secondary view.
2. **Auto-derived outcome chips.** Every prompt should show cheap, scannable
   evidence from data we already capture: files changed, commits produced, brain
   docs changed, commands run, screenshot attached, context-window fullness, and
   follow-up type. (Command pass/fail is intentionally excluded until real
   test/diff capture exists — guessing it from exit-code text was noise.)
3. **Hosted hardening + privacy preview.** Before broader sharing, uploads need
   rate/size limits, payload validation, owner/project quotas, admin/delete
   tools, backups/export, and a dry-run or preview that shows exactly what will
   be published.

## What to build before more social

- A `Sessions | Prompts` rail, defaulting to prompts.
- Prompt rows with agent/source color, session identity color, timestamp, intent
  tag, and outcome chips.
- Stable prompt-card permalinks.
- Live mode where new prompt units slide into the rail.
- Outcome chips from existing captured data before adding more artifact families.
- Privacy controls that are visible in the hosted dashboard, not only the CLI.

## What to delay

- Forking until the product knows whether the fork unit is a prompt, session, or
  whole project.
- Trending/discovery until there is a real feedback loop.
- Heavy storage migration for its own sake. Do the minimum hardening now, then
  move comments/ratings/social data to SQLite or Postgres when that behavior
  becomes real.

## Test spine

Add focused tests before the next schema or social expansion:

- Claude parser.
- Codex parser.
- Redaction.
- Evidence binding.
- Prompt-unit extraction.
- Activity attribution.
- Hosted visibility and private/public behavior.
- `pushBundle` endpoint and token selection.

## Demo target

Make one canonical public demo that shows the full loop: project brain graph,
live history and graveyard nodes, prompt-unit chain, before/after screenshots,
outcome chips, and comment/feedback affordances. The Tasky/2048 experiments are
good source material because they already exercised brain docs, live capture,
screenshots, and prompt-by-prompt development.
