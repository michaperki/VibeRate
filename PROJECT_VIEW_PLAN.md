# VibeRate — Project View Plan

Focus: the internal Project view — the AI Brain, the Chat Display, and the Prompt
Display. Synthesis of two research passes (Claude + Codex) plus Mike's direction.

## Positioning (the frame)

VibeRate is **not** "GitHub for agent conversations" (that's version control;
wrong). It's about **getting feedback / collaborating** on agent work, **managing
your project's AI brain** (the constitution + docs + memory the agent runs on),
and **seeing how others manage theirs**. The internal product's potential: *a
living history of how a person and their agents understood, discussed, and
changed a project* — every claim traceable to the work that created it.

## Core organizing principle

Two tracks joined at the seam: the **prompt unit** (`before → prompt → after`) is
how you read your own sessions, with an **outcome/evidence rail** per prompt; the
**Brain** is the project's evolving model. The rail links a prompt to the Brain
concept it changed — that link is the "living history."

## Architecture note (decided)

- **Topology:** hosted product. `vbrt push` runs locally and uploads a bundle;
  users **view at a hosted URL**. `vbrt serve` is a dev/local-viewer mode, *not*
  where product users live — so the hosted web app has only the uploaded bundle,
  never a live repo. (GitHub can edit-in-browser because it *is* the git host;
  VibeRate is not.)
- **Scope for now: READ-ONLY.** No editing the brain from the UI. Git stays the
  brain's ledger; VibeRate captures and visualizes.
- **Editing — deferred (Mike's call):** when revisited, via **git-provider
  integration** (commits/PRs through a GitHub App — the clean hosted answer) or a
  **host-native brain** (flip source of truth, repo syncs via `vbrt pull`).
  *Not* a separate diverging store reconciled to git (that's the sync mess). The
  agent-as-bridge ("VibeRate surfaces the edit, your agent applies it") is the
  near-free option when we want it.

---

## ✅ Done

- **Slice 1 — prompt-unit reader + context gauge.** Session reader renders the
  prompt-unit chain (Narrative only; toggle/Worklog/Raw removed). Parser retains
  Claude token usage → per-prompt **context-fullness gauge** ("dumb zone" past 75%).
- **Slice 2a — hover-peek.** Hovering a brain node floats its heading outline +
  first line; click still opens the full reader.
- **Slice 2b — brain motion + organization.** Gentle recency-modulated breathing
  halo (+ jank fix, reduced-motion); "glow = recency" legend; Recent time-axis;
  **role clustering** (web only); **web fit-to-canvas** so it fills the frame.

## ❌ Dropped

- **Heading-explosion** — overengineered; hard to read the exploded ideas. The
  existing graph + hover-peek is sufficient.

---

## Remaining (read-only)

### A. Activity timeline + Brain history — *cheap, no new capture* ← NEXT
- [ ] Make **commits / brain / code lanes clickable** (today only convos + the
  message brush are wired; the rest are tooltip-only).
- [ ] **Brain diamond → detail** (which brain docs that commit changed + subject/
  date/hash).
- [ ] A dedicated **Brain history view** from the git data already in the bundle.
- [ ] git capture → `--name-status` for **add / modify / delete / rename**
  (one-line change; unlocks lifecycle).
- [ ] **Unify "what is the brain"** — timeline uses a fixed filename allowlist
  (`git.js` `BRAIN_DOCS`); the graph uses a broader doc set (`docs.js`). Reconcile.

### B. Brain lifecycle & time-travel
- [ ] Cheap **"just-changed" entrance flash** (docs touched in the latest commit
  glow on first draw).
- [ ] **Time-travel scrubber** (brain state / diffs on date X) — needs richer
  capture: historical doc content/diffs at push time.

### C. Prompt reader / outcome rail (Slice 4)
- [ ] **Real diffs** per edit in the reader.
- [ ] **Outcome signals** beside each prompt: files changed, tests run + result,
  commits produced, brain changed.
- [ ] **Follow-up classification** — correction / continuation / approval.
- [ ] **Prompt intent auto-tagging** (design / debug / refactor / ask / fix).
- [ ] **Prompt-quality-through-consequences** signals (needed clarification?
  caused rework? referenced docs? survived later commits?).
- [ ] *Decision (mock):* outcome-rail placement — side rail / chip row / footer.

### D. Scale & navigation
- [ ] **Progressive / summary-first loading** (sessions up to ~1,300 msgs / 1.6 MB).
- [ ] **Search + filters** (prompt/response text, files, commands, outcome, …).
- [ ] **Conversation minimap.**
- [ ] **Deep links + state restoration** (stable URLs per session/turn/card).
- [ ] **Work episodes** — group related sessions into named efforts.
- [ ] **Auto intent-based session titles.**

### E. Capture enrichment — *bigger build*
- [ ] **Evidence-capture skill** (Slice 5): screenshots for frontend, test/diff/
  curl output for backend; captured at push, viewed read-only. Needs `EVIDENCE.md`.

### F. Hygiene
- [ ] **Tests** around parsers / prompt extraction / redaction / activity attribution.

### G. Legibility & polish — *external review, ranked by impact*
> An outside review (2026-06) of the live UI. The bones are strong; these are the
> first-contact legibility gaps. Ranked by the reviewer's impact order.

1. [ ] **Color/dot legend (highest impact).** The per-session **identity hues**
   (`colorForIndex`, golden-angle HSL → `state.colorById`) appear as `.sw`
   swatches in the session list and as the timeline colors, with **no key** — so
   the primary visual signal can't be decoded. They mean "which session is this"
   (links list ↔ timeline), *not* status. Add a legend / hover; make any
   header status dot self-explain. *(Verify exactly what each dot encodes before
   labelling — identity hue vs. source badge vs. visibility.)*
2. [ ] **Suppress empty / duplicate sessions.** `(no prompt) · 0 msgs · 0s` cards
   waste prime space — collapse / filter-by-default / render as thin rows.
   **Group or dedupe** near-identical sessions (same prompt across models) into one
   expandable cluster instead of N stacked cards.
3. [ ] **Project rename-collision (workspace tier).** Two projects both named
   `viberate` are interchangeable — disambiguate with path / last-active / a
   differentiator so navigation isn't a coin-flip.
4. [ ] **Timeline legibility.** Make the row labels + color coding legible **at
   rest** (not hover-only); ensure every mark has a hover detail. (Commit/brain/
   code ticks are now clickable + detailed — this is the at-rest labelling pass:
   bigger labels, a small inline key for code red/green + brain diamond.)
5. [ ] **Pluralization pass.** `1 msgs`→`1 msg`, `1 session(s)`→`1 session`, etc.
   Sites incl. `renderSessionList` ("msgs"), the projects sidebar ("session(s)"),
   ribbon tooltips. Add a `plural(n, word)` helper. Small, but reads as sloppiness.
6. [ ] **Jargon tooltip layer.** One-line tooltips on "brain edits", 🧠,
   "glow = recency" (have one), the context-% gauge (`7%`/`21%`), CLAUDE/CODEX
   badges. Keep the density; lower the first-contact cost.

## Guardrails — keep, don't regress (external review)

The review flagged these as the strongest parts. Don't break them while polishing:
- **Session detail view** — turn nav (`prev · turn 1/5 · next · final`), action-type
  pills (`7 edit · 22 cmd · 15 read · 6 files`), inline file cards, collapsible
  "how it played out · N steps". This is the best screen.
- **CLAUDE/CODEX badges** + source filter pills (`all 62 / claude 31 / codex 31`).
- **Web / Tree / Recent** layouts — keep all three; **Tree reads as most legible**.
- **Dark theme + purple accent**; unambiguous selected-project highlight.

---

## 🧪 Experiment — plan-completion % → brain node status

Plan/spec docs (this file, ROADMAP, BACKLOG, *_NEXT_PASS, …) get created and
progressively completed. Idea: surface a **completion %** per plan doc and use it
to **annotate that doc's brain node**, so the user sees at a glance which plans are
fresh, in-progress, or done. Read-only — we visualize status, we don't
archive/complete from the UI.

Two sources for the number (use both; marker wins):
- **Semantic marker (authoritative).** The coding agent, when it updates a plan,
  writes a completion line at the **bottom** of the doc (LLMs estimate a number
  more accurately *after* reading the whole doc than before). Convention TBD, e.g.
  a trailing `<!-- completion: 45% -->` or `**Completion: 45%**`. Parsed at push.
- **Checkbox parser (fallback, nearly free).** Ratio of `- [x]` to `- [ ]` in the
  doc. Works on any checklist-style plan with no marker.

Visualization (don't overload existing encodings): node **color already = doc
type/role**, so layer completion as a **progress ring/arc around the node** (empty
→ full) rather than recoloring — a donut of doneness. Only "plan-type" docs get a
ring (heuristic: has a completion marker or checkboxes, or filename matches
PLAN/ROADMAP/BACKLOG/TASKS). Capture step extracts `completion` per doc into the
bundle; the brain renderer draws the ring.

*Status: idea to prototype — fits read-only, no editing required.*

---

## Decisions resolved via toggle/mock (Mike's method)

For any fork with >1 viable UI path, build a live **toggle** or a **mock** (à la
the prompt-unit / brain prototypes) — don't pick unilaterally.
- Reader density → resolved: **Narrative** (others removed).
- Brain organization → resolved: hover-peek + role-clustering + fit-to-canvas;
  heading-explosion dropped; recoloring not pursued (clustering sufficed).
- Still open: outcome-rail placement (C); completion-ring visual (experiment).
