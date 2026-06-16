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

### B. Brain lifecycle & time-travel — ✅ shipped
- [x] **"just-changed" entrance** — docs from the most recent brain commit play a
  one-shot born/flash ring on project open (gated; reduced-motion aware).
- [x] **Time-travel scrubber** — capture: `extractDocHistory` stores each brain
  doc's content per changing commit (`history.json`, served at `/dochistory`).
  UI: a "🕰 Time travel" toggle on the graph reveals a scrubber that renders the
  brain *as of* a commit (born-later docs hidden, changed docs ring) + a real LCS
  diff panel. Mock kept at `prototypes/brain-timetravel.html`.
  - [x] *Ghost nodes:* archived docs (newest history version = deletion) are now
    laid into the graph and ghost in during time-travel — hidden before birth,
    live during their lifetime, struck-through ghost after deletion.
  - [x] *Push skill bundle:* rebuilt with `build-skill.mjs --plugin` so hosted
    pushes capture history (the build copies all of `src/` + `bin/vbrt.js`).

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
> **All shipped 2026-06** except the near-identical session clustering (noted in #2).

1. [x] **Color/dot legend.** Wired a real Activity-timeline legend under the ribbon
   (claude/codex, commit, 🧠 brain-doc change, code +/−, click/drag hint) +
   a session-list key for the per-session colour dot. (The dots are identity hues
   — `colorForIndex` — not status; the legend says so.) Replaced the dead
   unused `srcLegend()`.
2. [x] **Suppress empty sessions** — `(no prompt) · 0 msgs` sessions now fold into
   a collapsed "N empty sessions" group of thin rows.
   [ ] *Still open:* **cluster near-identical** sessions (same prompt across models)
   into one expandable group — needs similarity detection.
3. [x] **Project rename-collision.** Root cause fixed: hosted `ingestBundle` now
   **upserts** by (owner, repo path) instead of minting a new id per push. UI shows
   a path-tail + last-active differentiator when names collide.
4. [x] **Timeline legibility.** Legend decodes marks at rest; row labels bumped to
   11px/500 with brighter contrast + per-row breathing room.
5. [x] **Pluralization pass.** `plural()`/`plw()` helpers; fixed across sidebar,
   session list, timeline header, overview line, ribbon tooltips, reader meta.
6. [x] **Jargon tooltip layer.** Hover-explain + dotted-underline affordance on
   "🧠 brain edits", "🧠 AI architecture", "🧠 Brain history", the context gauge,
   and the "glow = recency" key.

## Guardrails — keep, don't regress (external review)

The review flagged these as the strongest parts. Don't break them while polishing:
- **Session detail view** — turn nav (`prev · turn 1/5 · next · final`), action-type
  pills (`7 edit · 22 cmd · 15 read · 6 files`), inline file cards, collapsible
  "how it played out · N steps". This is the best screen.
- **CLAUDE/CODEX badges** + source filter pills (`all 62 / claude 31 / codex 31`).
- **Web / Tree / Recent** layouts — keep all three; **Tree reads as most legible**.
- **Dark theme + purple accent**; unambiguous selected-project highlight.

---

## 🧪 Experiment — plan-completion % → brain node ring · ✅ shipped & archived

Plan/checklist docs now surface a **completion %** as an **Arc ring** on their
brain node (amber→green by %), via a checkbox-ratio parser (`completionOf`).
In **time-travel** the ring fills as you scrub (each as-of version reparsed).
Spec doc `PLAN_COMPLETION.md` was **archived** when v1 shipped — it now lives as
a ghost node, the first inhabitant of the brain graveyard (closing its own loop).

Completion follow-ups (when needed):
- [ ] **Semantic marker** — agent writes `<!-- completion: N% -->` at the doc's
  **bottom** (reads the whole plan before committing to a number; avoids cluttering
  the top), parsed at capture as an authoritative override of the checkbox ratio.
- [ ] **Filename-based plan detection** — give a ring to plan-named docs
  (PLAN/ROADMAP/BACKLOG/TASKS) that lack checkboxes (needs the marker to have a %).
- [ ] **Outcome rollup** — surface completion in the workspace/prompt outcome views.

---

## Decisions resolved via toggle/mock (Mike's method)

For any fork with >1 viable UI path, build a live **toggle** or a **mock** (à la
the prompt-unit / brain prototypes) — don't pick unilaterally.
- Reader density → resolved: **Narrative** (others removed).
- Brain organization → resolved: hover-peek + role-clustering + fit-to-canvas;
  heading-explosion dropped; recoloring not pursued (clustering sufficed).
- Completion-ring visual → resolved: **Arc** (mocked Arc/Liquid/Segments).
- Still open: outcome-rail placement (C).
