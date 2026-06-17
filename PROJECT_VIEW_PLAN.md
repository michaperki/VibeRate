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

### A. Activity timeline + Brain history — *cheap, no new capture*
- [ ] Make **commits / brain / code lanes clickable** (today only convos + the
  message brush are wired; the rest are tooltip-only).
- [ ] **Brain diamond → detail** (which brain docs that commit changed + subject/
  date/hash).
- [x] A dedicated **Brain history view** — shipped as the **time-travel scrubber**
  (§B), driven by the git data already in the bundle.
- [x] git capture → `--name-status` for **add / modify / delete / rename**
  (`git.js` now logs `--name-status` and tags each changed `.md` with a status —
  this is what unlocked ghost-node lifecycle + streaming add/remove).
- [x] **Unify "what is the brain"** — `BRAIN_DOCS` allowlist retired; `git.js`
  keeps **all `.md`** and the viewer intersects with the captured doc graph
  (`docs.js`). Timeline and graph now agree on what counts as a brain doc.

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
> Research: `PROMPT_GALLERY.md` — a pass over Mike's real prompts found **12
> archetypes**, and the key product finding is that each needs a *different*
> artifact (only ~3/12 are screenshot-shaped). So the outcome rail must be
> **polymorphic**. Mock of all 12 artifact renderings: `prototypes/outcome-artifacts.html`.
> First family shipped: author-captured **screenshots** via `vbrt shot` — spec +
> checklist in `ARTIFACTS.md` (before/after on the prompt card, concurrency-safe binding).
- [x] **Screenshot artifacts** (`ARTIFACTS.md`) — `vbrt shot <url|img>` binds a
  before/after shot to the prompt that produced it; renders in the reader. *(first
  outcome-rail family; diff/test/provenance families still below.)*
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

## 🎮 Experiment 2 feedback (Codex · 2026-06-17)

Mike ran the artifact/brain loop with **Codex** on a 2048-style game. The loop held
(Codex loaded the skill first, followed the brain conventions, consulted at forks,
captured before/after). New observations, categorized:

**Shipped immediately**
- [x] **In-page media viewer.** Evidence images opened in a raw new tab; now a click
  opens an in-page lightbox (Esc/click-out to close), built to extend to video/gif.

**Viewer (→ §D)**
- [ ] **Sidebar = messages, not convos** *(Mike's strong steer).* The left list should
  populate with **individual prompt-units**, not whole sessions — color-coded by
  convo/agent, **sliding in** as you send each, click → the existing in-context reader
  at that turn. *Decision (mock first):* replace the convo list / a **toggle** between
  convo↔message views / hybrid. This is the prompt-unit thesis applied to navigation.
- [ ] **Interim sidebar fix:** session rows show the *starting* prompt (often
  "read SEED.md"); show the **most-recent** message preview (~100 chars) instead.
  Needs `lastUserText` in the session summary (pairs with §D auto intent-titles).
- [ ] **Live-motion feedback:** stronger "a new message just arrived / movement"
  cue in live mode (slide-in/pulse). Largely *falls out of* the message-sidebar.

**Capture / artifacts (→ §E, `ARTIFACTS.md`)**
- [ ] **GIF / short-clip capture.** Many before/afters are only legible in motion
  (later: sound/video). Extend `vbrt shot` → record a few seconds (Playwright video/
  webm or a frame loop). **Not token-costly** — clips never enter the model's context
  (same as screenshots); cost is wall-clock + file size, so prefer webm over gif.
- [ ] **Before-capture reuse.** Optionally reuse the prior `after` as the next `before`
  when the URL/file is unchanged (timestamp/hash check). *Low priority* — the worry
  was "token-wasteful," but a `before` shot costs **0 model tokens**, just ~a Playwright
  launch; keep always-capture for correctness unless the wall-time bites.
- [ ] **Auto-graveyard at 100%?** *Decision.* VibeRate is read-only — it **can't** delete
  repo files. Options: (a) SKILL convention (agent `git rm` on ship — current), (b) a
  `vbrt graveyard <plan>` helper (one clean step), or (c) the viewer **visually retires**
  a 100% plan (fade/ghost) **without** deleting. *Rec: (c)* for the auto-feel + keep
  deletion human/agent-driven.

---

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

## 🧪 Experiment — live streaming (`vbrt watch`) · ✅ shipped & archived

The dashboard is no longer a frozen snapshot. **`vbrt watch`** runs locally,
fingerprints the **active session logs + brain docs + git**, debounces, and
re-pushes (upsert, stable id) — so brain *and* conversation **stream live** while
you work. The viewer **polls the `updatedAt` stamp** and animates the diff in
place (reusing the time-travel `applyBrainAsOf` layer): nodes fade in/out, rings
fill, the activity ribbon pulses on new convos/commits/brain diamonds, and the
session reader **follows new turns** as they land. Delta pushes keep live updates
small (only changed sessions after the first sync). A `● live` indicator + pause
control + "updated Ns ago" readout sit on the dashboard and reader.

Mike watched the loop close **live from the deployed site**: spec `STREAMING.md`
was **archived** (git deletion, not a move — ghost detection keys on deletion),
so it now ghosts in the brain graveyard alongside `PLAN_COMPLETION.md` — the
feature burying its own spec in real time. (This was the experiment loop's
"streaming is next" item; loop now closed.)

Streaming follow-ups (only if needed — tracked in `ROADMAP.md` under `vbrt watch`):
- [ ] **SSE / WebSocket** transport if polling ever feels laggy (drop the poll).
- [ ] **Reader append-not-rerender** — append new turns instead of a full
  re-render, preserving expanded `<details>` while following a live session.

---

## Decisions resolved via toggle/mock (Mike's method)

For any fork with >1 viable UI path, build a live **toggle** or a **mock** (à la
the prompt-unit / brain prototypes) — don't pick unilaterally.
- Reader density → resolved: **Narrative** (others removed).
- Brain organization → resolved: hover-peek + role-clustering + fit-to-canvas;
  heading-explosion dropped; recoloring not pursued (clustering sufficed).
- Completion-ring visual → resolved: **Arc** (mocked Arc/Liquid/Segments).
- Streaming transport → resolved: **poll the `updatedAt` stamp** (SSE/WebSocket
  deferred until polling proves laggy); live affordance → `● live` + pause +
  "updated Ns ago"; reader → **auto-follow** new turns (scroll only if near bottom).
- Still open: outcome-rail placement (C).
