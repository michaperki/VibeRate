# VibeRate — Project View Plan

Focus: the internal Project view — the AI Brain, the Chat Display, and the Prompt
Display. Synthesis of two research passes (Claude + Codex) plus Mike's direction.

## Positioning (the frame)

Canonical strategy: `PRODUCT_STRATEGY.md` (reframed 2026-06-21).

VibeRate is a **mobile, agent-first IDE**: you **drive** coding agents through the
project's **AI brain** (the constitution + docs + memory the agent runs on) and your
prompts, and the Project view is where that happens — read *and* write. It is about
**managing your project's brain** as the control surface, **driving** agents against
it, and **understanding** the work they do (the prompt-unit reader + outcome rail).
Getting feedback / seeing how others manage their brain is a later social layer, not
the center. The durable potential is still *a living history of how a person and
their agents understood, discussed, and changed a project* — but now you act on that
history live, not just read it back.

> **Reframe note (2026-06-21):** this doc predates the Drive pivot, so parts below
> still describe a **read-only** viewer. Drive made the Project view a control plane:
> the brain isn't just visualized, it's the thing you steer the agent through, and the
> reader's live head *is* the Drive composer (`DRIVE_CONVO_RECONCILIATION.md`). Read
> "READ-ONLY" below as "the *captured/shared* view is read-only; the *driver's* view
> writes." Where it says "VibeRate is not the git host, so no editing" — that's still
> true of the hosted bundle, but Drive edits the bound **workspace checkout** directly.

## Post-pivot triage (2026-06-21)

This doc grew during the read-only era and is ~80% shipped. Re-ranked against the
now-priorities in `PRODUCT_STRATEGY.md`:

- **Promoted to now-work:**
  - **§H Mobile** — *mostly shipped* (Slices 1–3 live, code-verified 2026-06-21);
    only Slice 4 polish remains. Not the big item it was scoped as.
  - **§I Context management as a feature** *(new section below)* — priority #4. The
    gauge shipped; the *affordances* (compact / branch / fresh) never got tracked.
  - **§J Brain that fits any repo** *(new section below)* — priority #5. Promotes the
    prose note into concrete work.
  - A thin slice of **§D** (search, deep-link state, progressive load) supports a
    growing fleet — keep, but after the four above.
- **Deprioritized to the later social/learning layer** (`PRODUCT_STRATEGY.md` "what to
  delay"): the rest of **§C** (real per-edit diffs, follow-up classification,
  prompt-quality-through-consequences, provenance) and **§G #2** session clustering.
  These polish the *read/understand* surface, which is now the byproduct, not the core.
  Left in place, marked, not active.
- **Removed:** the §F "Tests" hygiene line (out of scope by direction).

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
  - **Update (post-Drive):** the agent-as-bridge is no longer hypothetical — Drive
    *is* the agent, editing the bound checkout directly. "Edit the brain from the UI"
    now means "tell Drive to," and the brain⇄chat live link glows the touched node as
    it happens (`PLAN_MOBILE.md`). The git-provider-integration / host-native-brain
    options only matter for editing on a *shared/non-driver* view.

---

## Brain must fit *any* repo's `.md` structure (2026-06-21)

The brain visualizer was tuned on this repo's conventions (`SEED.md`, `DEVLOG.md`,
plan/roadmap docs). **Most devs don't use those.** For the brain to be useful to
arbitrary projects it must infer structure from whatever `.md` network a repo
actually has — headings, links, sizes, recency, role (constitution vs plan vs
log vs memory) — without depending on our filenames. Concrete experiment on the
backlog: load Mike's older vibe-coded projects and see how their doc structures map
into the brain, then generalize the role/clustering heuristics from what's there.

## "Completion %" is non-monotonic — don't headline it (2026-06-21)

The plan/checklist completion view assumes a fixed denominator. But a large share of
prompts are **discovery** prompts: they *find and document* undiscovered work, which
correctly pushes "% complete" *down* (this doc-review prompt is itself an example).
Keep the per-doc checklist parsing, but don't treat a single bar marching to 100% as
the project's headline status. Pair it with **scope-discovered** and **work-in-flight**
signals so the dashboard reads "here's what's known, what's in flight, and that known
scope is still growing." See `PRODUCT_STRATEGY.md` "Is completion % the right metric?".

---

## Brain architecture rethink — prototype-led, not decided (2026-06-23)

> **Status: open. We do not solve this here.** Mike's explicit steer: "Nailing the
> brain will require prototyping." So this section *documents the thinking and the
> options to prototype* — it does **not** pick a design. Next step is **mocks/prototypes
> of the candidates, compared live** (the house toggle/mock method), then a decision.

The brain is the most important surface and the least settled. Two complaints from
dogfooding the PWA, both confirmed in code:

- **"Why is it always everything circling a CLAUDE.md?"** The *live* brain shown
  while Driving (`public/app.js` ~L4915 `step()`/`draw()`) is a **radial field**:
  constitution/core docs (`CLAUDE.md`, `SEED.md`, …) are pinned at the center (target
  radius ~32px) and every other node is pulled to an orbit radius set by its *heat*
  (recency of read/edit) — hot toward the core, cold to the rim. So the constitution
  literally is the hub everything orbits, **by construction, not by link topology**.
  (The static Web/Tree/Recent layouts — `layoutGraph` ~L1531 — cluster by role around
  anchor points instead; but the orbit field is what's on screen during Drive.)
- **"Constant rotation isn't the right way to give movement."** The orbital drift is a
  per-frame tangential velocity kick (`-sin(ang)*(0.08+heat*0.22)`, ~L4944) — motion
  for motion's sake, decoupled from anything actually happening. It reads as ambient
  spin, not as "the agent is touching *this* doc right now." Crowding compounds it:
  every `.md` plus ephemeral code-file activations shares one orbital field with no
  hierarchy beyond heat, so a real project's docs pack the center.

### What the view is *for* (functionality Mike is sure of)

The audience is a **vibe coder watching the agent cook**. The view should make a few
things obvious without reading code:
- **What is the agent touching right now**, and **what did it just touch** — movement
  should *mean* activity.
- **Am I being steered by my own principles?** — seeing the agent consult (or ignore)
  the right brain doc is the steering story made visible.
- **Progress** — *plans with a completion ring read as strong; keep that* (Mike). The
  ring filling as a checklist completes is exactly the "watch it cook" signal.
- **Structure** — what's load-bearing vs. a leaf — without everything collapsing onto
  the constitution.

### Candidate organizing principles (to prototype, not to choose now)

Mike's instinct leans **#1**, but called all four interesting and explicitly wants to
decide *through* prototypes, not on paper:

1. **Activity-driven, nodes at rest** *(leading instinct).* Kill the ambient tangential
   drift. Nodes sit still; motion happens **only** on a real event, then settles.
   "Recency as physics" becomes "recency as a one-shot settling animation that stops."
2. **Structure-first map.** Position encodes role/relationship (constitution → plans →
   logs → memory as regions/columns, or lean on the Tree layout already judged most
   legible). The force web becomes one optional view; constitution de-centered.
3. **Foreground/background split.** A small "now active" cluster (3–6 docs in play this
   session) prominent, with the full brain as a calm navigable map behind it — one
   surface stops doing two jobs.
4. **Health/centrality as the signal** (`CONTEXT_CREDIT_RESEARCH.md` Phase 1). Size &
   placement by inbound references + churn + staleness, with provenance labels, so the
   map *teaches* which docs are load-bearing vs. stale — not heat alone.

These aren't exclusive (e.g. #1's event choreography over #2's structured map, with
#3's foreground cluster, is a coherent combined target).

### The dimension to actually prototype: event choreography

The open design question Mike named is **"what does the brain look like when X
happens?"** — and he's unsure what events we can even observe. From the runtime
(`src/hooks.js`, `src/agent.js`, Drive `tool_use` → `brainTouch()`), the observable
events are:

| Event | Source today | Candidate brain reaction (to prototype) |
|---|---|---|
| Agent **reads** a brain doc / file | `Read` tool_use; `brainTouch()` glows node | one-shot pulse on that node; trail/edge from the prompt |
| Agent **edits/writes** a file | `Edit`/`Write` tool_use | flash the node's ring; if a `.md`, ripple to linked docs |
| Agent **runs a command** | `Bash`/`shell` tool_use | transient activation (current ephemeral code-file behavior) |
| **New brain doc** created / **deleted** | git `--name-status` (births/ghosts) | birth animation / ghost into the graveyard (already exists) |
| **Plan completion** changes | checklist parser, completion ring | ring fills live — *the keeper signal* |
| **Context** filling | `usage` events (`src/agent.js`) | dumb-zone warning surfaced on the brain, not just the gauge |
| **Commit** produced | git capture | mark the docs that commit touched |
| Turn **start / working / idle / end** | hooks (`UserPromptSubmit`/`Stop`) | global "cooking vs. settled" state of the whole field |

The prototype work is to choose, per event, the **reaction that's legible and
meaningful** to someone watching — and to make sure the field is calm when nothing is
happening (the anti-ambient-spin principle). Build these as live mocks of #1–#4 (or a
combination) driven by a scripted event stream, compare, then decide.

### Open questions for the prototypes to answer
- Is the default a **map you navigate** or a **live activity monitor** — or two modes?
- Does movement ever happen with no triggering event? (Leaning: no.)
- How do we show "what the agent just read" without orbiting?
- Should the constitution be de-centered, or is "everything relates to the constitution"
  actually true and worth keeping (just shown without the spin)?
- How does crowding scale on a real 20–40-doc repo, not our tidy set?

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
- [x] Make **commits / brain / code lanes clickable** — all three ribbon lanes
  now open detail popovers (`[data-commit]`/`[data-brain]`/`[data-code]` handlers
  in `public/app.js`); the code lane selects + scrolls to its session.
- [x] **Brain diamond → detail** — `brainDetailHtml`/`commitDetailHtml` popovers
  show the commit's changed brain docs + subject/date/hash.
- [x] A dedicated **Brain history view** — shipped as the **time-travel scrubber**
  (§B), driven by the git data already in the bundle.
- [x] git capture → `--name-status` for **add / modify / delete / rename**
  (`git.js` now logs `--name-status` and tags each changed `.md` with a status —
  this is what unlocked ghost-node lifecycle + streaming add/remove).
- [x] **Unify "what is the brain"** — `BRAIN_DOCS` allowlist retired; `git.js`
  keeps **all `.md`** and the viewer intersects with the captured doc graph
  (`docs.js`). Timeline and graph now agree on what counts as a brain doc.
- [ ] **Timeline rethink + git-tree (2026-06-23, Mike).** The activity ribbon "gives a
  big-picture view but I don't reference it." It may earn its place mainly for
  **collaborators / a fleet** (multiple agents or people), so revisit its value-prop
  when fleet/multi-user lands — for a solo driver today it's low-value. Working
  hypothesis: pair it with, or partly replace it by, a **git-tree / DAG visual** — a
  branch/merge graph reads as "what happened to the code" better than a flat commit
  lane, and would sit *near* the timeline (or fold into it). **Cheap enabler:**
  `src/git.js` already parses parent hashes (`%P`) and discards them, keeping only an
  `isMerge` boolean (~L43–59) — capturing the parent list is a ~3-line change and
  unlocks a real DAG render with no other capture work. Park as an experiment; don't
  build until the brain rethink and convos-mobile parity land.

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

### C. Prompt reader / outcome rail (Slice 4) — *read-mode; remaining `[ ]` items deprioritized (see triage)*
> Research: `PROMPT_GALLERY.md` — a pass over Mike's real prompts found **12
> archetypes**, and the key product finding is that each needs a *different*
> artifact (only ~3/12 are screenshot-shaped). So the outcome rail must be
> **polymorphic**. Mock of all 12 artifact renderings: `prototypes/outcome-artifacts.html`.
> First family shipped: author-captured **screenshots** via `vbrt shot` — spec +
> checklist in `ARTIFACTS.md` (before/after on the prompt card, concurrency-safe binding).
- [x] **Screenshot artifacts** (`ARTIFACTS.md`) — `vbrt shot <url|img>` binds a
  before/after shot to the prompt that produced it; renders in the reader. *(first
  outcome-rail family; diff/test/provenance families still below.)*
- [x] **Motion-clip artifacts** *(shipped 2026-06-17)* — `vbrt shot <url> --clip
  [seconds]` records a few seconds via Playwright; emits an animated **gif** when
  `ffmpeg` is present, else a **webm** (`media: 'video'`), both loop in the reader
  + lightbox. Server caps clips at 6 MB; redaction skips inline `data:video/`.
- [x] **Auto-derived outcome chips** *(first pass shipped 2026-06-17)* —
  files changed, commits produced, brain docs changed, commands run,
  screenshot attached, context fullness, and follow-up type, all from existing
  captured data before adding heavier artifact families.
  Shipped signals: files, commits, brain docs, command count, screenshots,
  context fullness. *Command pass/fail was tried and removed — the only cheap
  signal (regex for a nonzero exit code in tool output) fired on normal runs and
  meant nothing; real pass/fail needs the diff/test family below.* Follow-up
  classification remains separate below.
- [ ] **Real diffs** per edit in the reader.
- [ ] **Follow-up classification** — correction / continuation / approval.
- [x] **Prompt intent auto-tagging** — *(server-side label shipped 2026-06-18; `src/classify.js`)*.
  Classify each
  prompt-unit into the **12 `PROMPT_GALLERY.md` archetypes** (the older design/debug/refactor/
  ask/fix list is a coarser roll-up that can derive from these). **Two halves, split deliberately:**
  - **Label = server-side**, classified at ingest, keyed by `cardId` (`project~session~turn`),
    **cached + incremental** (classify once per prompt; only new prompts on later pushes), as
    **soft scores per archetype + a top pick + confidence**, with a `default`/none bucket for the
    banal majority (#10 console-paste). Lives server-side so it gives **coverage** (backfills the
    ~3,688-prompt history, ~61 repos — instruction-tagging can't touch old prompts), **consistency**
    (one rubric across claude/codex/future agents), and **zero working-agent token cost**.
  - **Capture = skill-side**, as archetype-*aware evidence hints* (action, not a naming
    obligation): "producing a deliverable file → capture the file + a dry-run"; "visual change →
    before/after". Same gallery insight expressed as evidence the agent already wants to grab, so it
    doesn't put a 12-way taxonomy on the working agent's critical path (preserves "make capture
    boring", [[viberate-positioning]]).
  - **Method = LLM classifier** (first-party Claude) over the 12 prose definitions — beats
    embedding-nearest-centroid here because the taxonomy is half *structural* (#8 enumerated options,
    #4 pasted result+verdict, #10 console block), which an LLM reads natively and a text embedding
    blurs. **Embeddings deferred** until search (§D) + cross-project lineage (§C / gallery takeaway
    #4) are built — then the vectors pay for three features at once, not just the label.
  - **Model = Haiku 4.5** (`claude-haiku-4-5`) — cheapest in the catalog ($1/$5 per MTok), the
    right floor for a high-volume classifier. Cost stack to keep "reads every message" tiny:
    **Batches API** (50% off — it's a non-latency-sensitive ingest pass), **prompt-cache the
    12-archetype rubric** (stable prefix → ~0.1× on every call, the biggest lever), classify
    **substantive prompt-units only**, **once per `cardId`** (incremental), and **structured
    output** (`{archetype, confidence}` → minimal output tokens). Whole ~3,688-prompt history ≈
    ~$1 one-time, then fractions of a cent per new prompt. If volume ever explodes, **embeddings**
    are the order-of-magnitude lever (arrives free with the deferred search/lineage vector infra).
  - *Resolved (2026-06-18):* **family roll-up + a few bespoke** — route to ~5 artifact
    families (shot / diff / link / record / test), not 12 bespoke renderers; the 2–3
    highest-value archetypes get a tailored marquee on top. See the rail-build checklist below.
  - *Shipped reality vs. cost-stack above:* the classifier runs **synchronously**
    (`messages.create`), **not** via the Batches API yet, and prompt-caches the rubric but
    classifies one prompt per request. Batches/backfill remain the order-of-magnitude lever
    if volume grows; the per-prompt incremental path is what's wired today.
- [ ] **Prompt-quality-through-consequences** signals (needed clarification?
  caused rework? referenced docs? survived later commits?).
- [x] *Decision (mock → resolved):* outcome-rail placement — **per-archetype hybrid**,
  not one global mode. The rail is polymorphic about its own *placement*, the same way
  it's polymorphic about *content*: rich archetypes (screenshot redesign, spec/diff
  deliverable) get a full-width **footer panel** (those artifacts want width); the banal
  majority (#10 console-paste) collapses to a **chip row**, expandable on demand. So the
  same router that picks *what* renders also picks *how prominently*. Side rail rejected
  (cramps wide diffs/images). Toggle mock: `prototypes/outcome-placement.html`.

#### Polymorphic outcome rail — build checklist *(scope: Stages 1 + 2; granularity: 5 families + a few bespoke)*
> The archetype is already classified server-side and rendered as a head pill
> (`renderArchetype`, `app.js`), but it does **not yet drive the rail** — every card
> shows the same flat `outcomeChips` + before/after screenshot family. This builds the
> router that routes on `u.archetype` to a family renderer **and** its placement.
> Family → archetype map (mirrors the mock's filter bar):
> `shot`→screenshot, critique-tool · `diff`→spec, pickup · `link`→seed, handoff,
> positioning, tool-genesis · `record`→options, feasibility · `test`→experiment, console-debug.
> Marquee bespoke within this scope: **experiment** (expected→actual verdict pill) and
> **options** (executed checklist). positioning/tool-genesis bespoke deferred to the
> Stage-3 provenance layer (needs commit→prompt + cross-project linkage).
>
> **Stage 1 — router + placement + data-ready families (no new capture):** ✅ shipped 2026-06-18
- [x] `ARCH_FAMILY` (archetype→family) + `FAMILY_PLACEMENT` (footer / chips / inline) maps in `app.js`.
- [x] `renderOutcomeRail(u)` — routes on `u.archetype`; falls back to today's flat `outcomeChips`
  + screenshots for `default`/unclassified so nothing regresses (unit-tested, 12 assertions).
- [x] **`shot`** family → labeled `before / after` **footer** wrapping captured evidence.
- [x] **`diff`** family → `deliverable` footer listing the edit-tool file paths extracted from
  `after.steps` (deduped) + file/commit counts. (Real per-edit diffs remain the separate item above.)
- [~] **`link`** and **`console-debug`** deliberately route to the flat chip row in Stage 1, not a
  bespoke artifact: link's real proof is the Stage-3 provenance layer (commit→prompt, cross-project),
  and the console is already shown verbatim in the prompt body — a fold would only duplicate it.
- [x] Swapped the flat `outcomeChips`/`renderArtifacts` calls in **both** card renderers
  (`renderReaderCard`, `renderPromptCard`) for the single `renderOutcomeRail`.
- [x] CSS: `.outcome-rail.rail-footer` panel + `.rail-diff`/`.rail-file` deliverable styling.
- [ ] *Live visual check* of the shot/diff footers — pending a classified session. The API key
  was refreshed (2026-06-18) and the host redeployed, so classification now runs at ingest; this
  session's live stream should populate archetypes for the check.
>
> **Stage 2 — light extraction for `record` + `test` + bespoke:** ✅ shipped 2026-06-18 (mostly)
- [x] `src/prompts.js` emits a small `u.outcomeArtifact` (deterministic; no new capture, no
  model call): **test-status timeline** (reads a runner summary — counts / `PASS`·`FAIL`
  lines — out of a `tool_result`), **options menu** (lifts the enumerated list from the
  prompt), and **experiment** (the author's `EXPECTED`/`ACTUAL`/`RESULT` blocks + a
  PASS/PARTIAL/FAIL verdict). Prompt-parse families gate on `archetype` so they can't
  false-fire. *(feasibility decision-record deferred — the two named bespoke renderers
  were experiment + options.)*
  - ⚠️ **Test family was NOT self-gating — fixed 2026-06-18 (commit `684cece`).** The
    original "universal but self-gating" claim was wrong: `testStatusOf` ran over *every*
    `tool_result`, so a stray "passed"/"failed" token or any `✓` character in unrelated
    output (a `git diff`, a file Read, `vbrt status`) fabricated a verdict — a read-only
    review session got stamped **"FAIL — 14 passed, 2 failed"** (numbers scavenged from two
    unrelated spots in one blob) and almost every card showed a bogus "PASS passing" pill.
    Now **gated on a real test command**: a verdict is read only when the preceding
    `tool_use` was a recognized runner (`npm/yarn/pnpm test`, `jest`, `vitest`, `pytest`,
    `go test`, `cargo test`, `make test`, … across Claude `Bash` + Codex
    `shell`/`local_shell`/`exec`); the bare `✓`/`✗` heuristic is gone. Same principle as
    options/experiment: don't guess pass/fail from arbitrary text ([[no-brittle-text-heuristics]]).
- [x] Bespoke `railExperiment` (expected→actual + verdict pill) + `railOptions` + `railTest`
  (green→red→green dots + verdict), keyed off `u.outcomeArtifact`; the artifact drives a
  marquee placement, overriding the family default. **Options: menu lifted verbatim, no ✓/▢ —
  per-item executed/deferred state needs a transcript↔option semantic match and is left to the
  provenance layer, not faked from keyword hits ([[no-brittle-text-heuristics]]).**
- [~] Verify against a real session: the **test family is verified end-to-end on real data**
  (3 genuine `codeswipe` prompts rendered a status timeline) + a 14-assertion extraction test
  (incl. conservatism: prose numbers and bare exit codes don't fire). The command-gate fix
  (`684cece`) was verified by a regex harness — real runners match, `git status`/`vbrt
  status`/`npm install`/`npm run build`/grep/Read don't. *Still open:* live visual check of
  **experiment/options** + scroll cost — pending a classified bundle; an automated extraction
  test suite (none exists yet) would have caught the test-gating regression. (Earlier all
  archetypes were null because the API key returned 401; the key was refreshed 2026-06-18 and the
  host redeployed, so classification runs at ingest again.)

### D. Scale & navigation
- [x] **Prompt-unit sidebar + deep links** *(first pass shipped 2026-06-17)* — `Sessions |
  Prompts` toggle, default Prompts; prompt rows show agent/source color, session
  color, timestamp, and (compact) outcome chips; click deep-links to that exact
  card; live mode slides new prompt-units into the rail. Intent auto-tagging itself
  **shipped** (§C, `classify.js`) and renders as the archetype pill **on the card**
  (`renderArchetype`); the only remainder is mirroring that pill **into the rail row**.
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
- [x] **Hosted ingest hardening** *(first pass shipped 2026-06-17)* — rate limiting, per-owner/project bundle limits,
  max evidence/image counts, server-side payload validation, admin/delete tools,
  backups/export/restore for `/data`. Shipped: JSON/session/message/evidence/image
  caps, in-memory upload rate limit, bundle shape validation. Still open:
  admin/delete tools and backups/export/restore.
- [x] **Privacy preview** *(CLI first pass shipped 2026-06-17)* — `vbrt push --dry-run` and hosted "what will be
  visible?" summary: memory included/excluded, evidence warning, files/docs
  included, private/public badge, publish/unpublish controls. Shipped: CLI dry-run
  with redacted payload size, visibility, sessions/messages, commits, docs, memory,
  and evidence counts. Still open: hosted dashboard preview panel.

### G. Legibility & polish — *external review, ranked by impact*
> An outside review (2026-06) of the live UI. The bones are strong; these are the
> first-contact legibility gaps. Ranked by the reviewer's impact order.
> **All shipped 2026-06** except the near-identical session clustering (noted in #2).
>
> **Follow-up:** a second, broader pair of external reviews (2026-06-22) is
> synthesized in `UI_FEEDBACK.md` — same genre, whole-app scope, prioritized by where
> the two reviewers agreed. The open brain-label readability + nav-overflow items there
> extend this pass into the mobile surface (`PLAN_MOBILE.md`).

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

### H. Mobile — responsive port → **`PLAN_MOBILE.md`** *(mostly shipped — only Slice 4 polish open)*
> Correction (2026-06-21, code-verified): **Slices 1–3 are live** in
> `public/{index.html,style.css,app.js}` — not open. The Variant A core works:
> - [x] **Slice 1** — fixed app bar, off-canvas projects drawer, sessions bottom sheet,
>   single-column layout, all gated by `body.is-mobile` (`matchMedia(max-width:760px)`).
> - [x] **Slice 2** — `.brainbar` header strip (a chip per brain doc) + brain expand
>   overlay mounting the real SVG renderer.
> - [x] **Slice 3** — the **brain ⇄ chat live link**: a Drive `tool_use` glows the doc's
>   chip + node (`brainTouch()`); lands on desktop too.
- [ ] **Slice 4 polish only** — on-screen-keyboard scroll behavior (`visualViewport` /
  `dvh`, the classic mobile-chat bug), time-travel scrubber touch sizing, and the open
  design call on whether to consolidate the rail into the conversation scroll. Small
  remainder; not the big "port" it was scoped as. Slicing in `PLAN_MOBILE.md`.

### I. Context management as a feature — *NOW-PRIORITY #4 (new)*
> The context-fullness gauge shipped (§ Done, Slice 1) but it's still just a *gauge*.
> `PRODUCT_STRATEGY.md` is explicit: surface dumb-zone risk **and offer the
> affordances**, since context is the scarce resource in agentic-first coding. None of
> the actions below are tracked anywhere else — this is the gap.
- [ ] **Dumb-zone warning in Drive** — when the live session crosses ~75%, the
  composer/header flags it (not just the static reader gauge), so the driver sees it
  *before* sending the next prompt.
- [ ] **Compact / branch / fresh affordances** — one-tap actions off that warning:
  compact the running session, branch a fresh session that inherits the brain + a
  summary, or start clean. These are Drive-runtime actions (`PLAN_AGENT_RUNTIME.md`),
  not viewer chrome.
- [ ] **Per-turn context trend** — show direction (filling fast vs. steady), not only
  the absolute %, so "compact now vs. one more turn" is an informed call.

### J. Brain that fits *any* repo — *NOW-PRIORITY #5 (new; promotes the prose note above)*
> The brain visualizer was tuned on this repo's conventions (`SEED.md`, `DEVLOG.md`,
> plan docs); most devs don't use those (see "Brain must fit any repo" above). Concrete
> work to infer structure from whatever `.md` network a repo actually has:
- [ ] **Filename-independent role inference** — classify constitution vs. plan vs. log
  vs. memory from headings / links / size / recency, not from our filenames.
- [ ] **Generalize clustering + completion** off inferred roles so the web/tree layouts
  and rings work on a repo that never heard of our conventions.
- [ ] **Backlog experiment** — load Mike's older vibe-coded projects, map their doc
  structures into the brain, and generalize the heuristics from what breaks.

## 🎮 Experiment 2 feedback (Codex · 2026-06-17)

Mike ran the artifact/brain loop with **Codex** on a 2048-style game. The loop held
(Codex loaded the skill first, followed the brain conventions, consulted at forks,
captured before/after). New observations, categorized:

**Shipped immediately**
- [x] **In-page media viewer.** Evidence images opened in a raw new tab; now a click
  opens an in-page lightbox (Esc/click-out to close), built to extend to video/gif.

**Viewer (→ §D)**
- [x] **Sidebar = messages, not convos** *(Mike's strong steer — shipped via §D).*
  Delivered as the **Prompt-unit sidebar**: `Sessions | Prompts` toggle, default
  Prompts, rows with source/session/timestamp + outcome chips, live slide-in, click →
  exact in-context card (`railToggle`/`promptRows`, `app.js`). *Only remainder:* the
  per-row **intent pill** (the archetype pill renders on the card, not yet the row).
- [x] **Interim sidebar fix** *(shipped).* Session rows now preview the **most-recent**
  prompt, not the opener: `preview = s.lastUserText || s.title` (`renderSessionList`, `app.js`).
- [x] **Live-motion feedback** *(shipped via the prompt rail).* New prompt-units slide
  into the rail with a `.fresh` cue in live mode (`_liveFreshPrompts`, `app.js`) — as
  predicted, it fell out of the message-sidebar.

**Capture / artifacts (→ §E, `ARTIFACTS.md`)**
- [x] **GIF / short-clip capture** *(shipped 2026-06-17).* `vbrt shot <url> --clip
  [seconds]` records a few seconds via Playwright → gif (if ffmpeg) or webm. **Not
  token-costly** — clips never enter the model's context (same as screenshots); cost
  is wall-clock + file size. *Later:* sound/multi-viewport; before-capture reuse below.
- [ ] **Before-capture reuse.** Optionally reuse the prior `after` as the next `before`
  when the URL/file is unchanged (timestamp/hash check). *Low priority* — the worry
  was "token-wasteful," but a `before` shot costs **0 model tokens**, just ~a Playwright
  launch; keep always-capture for correctness unless the wall-time bites.
- [x] **Auto-graveyard at 100%** — *resolved 2026-06-19, option (c): visual retire, no
  deletion; revised same day to drop the `PLAN_` gate.* VibeRate is read-only, so it never
  deletes repo files. **Any** doc whose checklist hits 100% is **auto-retired** by the viewer
  — hidden from the live web, ghosting in time-travel — with **zero agent overhead** (no
  marker, no `git rm`). The earlier hybrid (agent adds `status: archived` on ship) was
  rejected: it spends user context/tokens on every completed doc. Inverted to opt-*out*:
  `status: active` keeps a finished checklist live; `status: archived` retires a doc that has
  no 100% checklist. The completion ring and the graveyard are now one rule (completion *is*
  the signal) rather than two — the old `PLAN_*`-filename gate was dropped because it
  surprised users (e.g. `ARTIFACTS.md` carried a ring but wouldn't retire). A doc you want to
  keep at 100% just adds `status: active`. Crossing 100% mid-live-session animates straight to
  the graveyard (no full re-render needed). (`graveyardOf`/`statusMarker`, `app.js`; the
  live-completion path in `refreshLive`; taught in `SKILL.md`.)

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
- [x] **Reader append-not-rerender** *(shipped).* `refreshLiveSession` →
  `refreshSessionReaderInPlace` patches the reader in place while following a live session,
  preserving expanded `<details>` + scroll position; full re-render only as a fallback.

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
- Outcome-rail placement (C) → resolved: **per-archetype hybrid** — full-width footer
  panel for rich artifacts (screenshots, diffs), collapsible chip row for the banal
  majority (#10 console-paste); not one global mode. Side rail rejected (cramps wide
  artifacts). Mock: `prototypes/outcome-placement.html`.
- Intent classification (C) → resolved (approach): **label is server-side** (LLM classifier
  over the 12 `PROMPT_GALLERY.md` archetypes, at ingest, `cardId`-keyed, cached/incremental,
  soft scores + confidence), **capture is skill-side** (archetype-aware *evidence hints*, not a
  naming obligation on the working agent). LLM over embeddings for the label (taxonomy is
  half-structural); embeddings deferred to the search/lineage layer. No keyword heuristics over
  prompt text ([[no-brittle-text-heuristics]]). **Model = Haiku 4.5** (cheapest; batched +
  rubric-cached + incremental keeps it ~$1 for the whole history). Fully resolved.
