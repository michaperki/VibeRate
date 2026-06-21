# The Story of VibeRate

> A prose narrative of how VibeRate was built — what came in what order, and the
> decisions behind each turn — synthesized from the git history, the brain docs, and
> the captured Claude/Codex sessions. Written 2026-06-21 as an orientation for anyone
> (human or agent) picking the project up cold. Companion to `PRODUCT_STRATEGY.md`
> (the canonical *current* frame); this doc is the *history* that produced it.

---

## Prologue: a modest idea

VibeRate began on **2026-06-15** with a deliberately small ambition. The genesis
prompt (`SEED.md`) asks for nothing grand:

> "It's a UI where I can browse old Codex or Claude Code conversations… a 'project
> viewer'. It should be fun and simple. I should be able to execute a terminal
> command from any folder and… 'select all' or individual sessions to upload as a
> 'project'. When I click on a project… I want to see the codex / claude code convos
> that were uploaded. The code isn't as important yet."

That's the whole seed: a local terminal command that finds a folder's agent sessions
and a web viewer to read them back. Everything VibeRate became grew out of repeatedly
asking "what would make this more useful?" — and each answer pulled the product one
level up the stack, from *reading* agent work, to *understanding* it, to *driving* it.

The very first commit was literally titled **"VibeRate — GitHub for agent
conversations."** That framing — publish, share, review terminal-agent work the way
GitHub does for code — was the founding thesis and held for roughly the first week.

---

## Chapter 1 — The capture pipeline and the hosted leap (June 15)

The first day was explosive. The initial commit shipped the core local loop the seed
asked for: a `vbrt` CLI that **discovers** a folder's Claude Code (`~/.claude`) and
Codex (`~/.codex`) sessions, **parses** their JSONL into a normalized message shape
(`src/parsers.js`, `src/discover.js`), **stores** them as flat JSON (`src/storage.js`),
and **serves** a vanilla HTML/CSS/JS viewer (`src/server.js`, `public/`).

Within hours the project made a decision that shaped everything after: it went
**hosted**. Rather than staying a local-only viewer, it added Fly.io deploy config,
claimed `vbrt.fly.dev`, and built **hosted multi-tenancy** — owner tokens, a public
landing page, and a dashboard SPA at `/app`. The reasoning was simple and is recorded
in the roadmap: *every social feature requires a shared backend*, so a thin deploy
gates everything that follows. The data store stayed deliberately humble — JSON files
on a Fly persistent volume, keyed by project id — a "revisit a DB only if the file
store strains" call that still holds today.

A cluster of foundational decisions landed in quick succession:

- **Private-by-default** projects with explicit publish, plus **secret redaction**
  on upload (keys, tokens, private-key blocks scrubbed before anything leaves the
  machine). Trust boundaries were taken seriously from the start.
- An **account layer** (`AUTH.md`): GitHub + Google OAuth, sessions, and a CLI
  *claim* flow — anonymous `vbrt push` mints a gist-style owner token, and signing in
  later links those pushed projects to a real account.
- A rename from the working title "ratemyprompt" to **viberate** (with an
  auto-migration of the old `~/.ratemyprompt` data dir to `~/.viberate`).
- An **overarching workspace view** — memory and activity across all your projects,
  not just one.

By end of day one the landing page was reframed "around the mission" —
**social prompt-learning** — and the **prompt unit** appeared as the product's social
atom: `eca5e58 "Prompt units + discover feed (the social atom)"`, soon followed by
**ratings** and per-card **permalinks**. The thesis was crystallizing: the shareable,
rateable, learnable unit of agent work is not the session but the *prompt* — a single
human instruction and everything the agent did in response.

---

## Chapter 2 — The Brain: making agent work *legible* (June 15–16)

The next phase is documented in `PROJECT_VIEW_PLAN.md`, a synthesis of two research
passes (one by Claude, one by Codex) plus Mike's direction. It defined two tracks
joined at a seam, which remain VibeRate's core organizing principle:

1. **The prompt unit** (`before → prompt → agent work → after`) — how you read your
   own sessions, each with an outcome/evidence rail.
2. **The Brain** — the project's evolving *AI architecture*: the `.md` network
   (`CLAUDE.md`, `SEED.md`, plans, roadmap, memory) that the agent actually runs on.

The insight that would later become the entire product thesis was already implicit
here: **the brain is the control surface.** The code is an artifact; the `.md` files
are where a developer steers the agent.

Development proceeded in disciplined "slices," each its own commit, and the brain
visualization grew into something remarkably rich for a vanilla-SVG, hand-rolled
force layout:

- **Slice 1** — the prompt-unit reader with a *context-fullness gauge* (the first
  appearance of "context is the scarce resource," a theme that never left).
- **Slice 2** — hover-peek on the brain graph, then motion and organization.
- **Slice A** — a clickable activity timeline and a dedicated **Brain history** view.
- **Slice B** — a brain *lifecycle*: "just changed" entrance animations, per-doc
  **version history**, and a **time-travel scrubber** that replays the brain across
  commits — including **ghost nodes** for archived docs.

A lot of careful **legibility work** happened in parallel, much of it prompted by an
external UX review the team captured into the plan: legends to decode the timeline
marks and session dots, jargon tooltips ("what is a brain edit?"), pluralized counts
(*1 msg*, not *1 msgs*), folding empty sessions into collapsed groups. The recurring
worry was that the app's own concepts (brain, prompt unit, AI architecture) were
jargon a newcomer couldn't parse — so a meaningful share of effort went into making
the thing self-explaining.

Two ideas from this era are worth flagging because they recur:

- **The completion ring** (`PLAN_COMPLETION.md`): a plan/checklist doc's completion %
  rendered as an arc ring around its brain node. When a plan hit 100%, it was
  **archived to the "brain graveyard"** — a literal place where finished plans go,
  visible as ghost nodes in time-travel. "Loop closed" became a satisfying ritual,
  and the graveyard mechanism itself was iterated on (decoupled from git into a
  `status: archived` frontmatter marker; later inverted so any 100% checklist
  auto-retires by default).
- A **recency glow** toggle was added — and then *removed* a few commits later.
  This small reversal is characteristic: the project repeatedly shipped a visual
  idea, lived with it, and cut it when it didn't earn its keep. (The recency-as-
  physics idea later came back in a different, better form on mobile.)

---

## Chapter 3 — Going live: streaming the work as it happens (June 16)

With the static viewer mature, attention turned to **live** viewing — watching agent
work unfold rather than reviewing it after the fact. This is `STREAMING.md`, and like
the completion plan it was driven to 100% and then archived to the graveyard.

The arc within streaming:

- `vbrt watch` — a daemon that auto-re-pushes on any brain or git change, keeping the
  hosted dashboard live hands-free. It learned to **delta-push** (only changed
  sessions after the first sync) and to fingerprint the *active session logs* so a
  conversation could be followed as it was being written.
- The viewer side learned to reconcile updates **in place** — rings fill, nodes fade
  in and out on add/remove, "just changed" glows linger — *without* rebuilding the
  graph, preserving the user's scroll and expanded sections.
- A **live session-reader follow** mode: watch a single conversation stream in.

A small but important infrastructural decision underpinned all of this: local pushes
**upsert by repo path** rather than minting a new project each time, which is what
made a continuous live-streaming dev loop possible (and fixed duplicate hosted
projects on re-push).

---

## Chapter 4 — Dogfooding through experiments (June 17–18)

Here the project did something that defines its whole character: **it used itself to
build itself**, and ran a series of deliberate *experiments* — having agents build
small throwaway apps (a task manager "Tasky," a 2048 clone, a sorting visualizer, a
maze generator/solver, Conway's Game of Life) purely to stress-test VibeRate's
capture-and-publish loop on real, varied agent runs. These are the many
`EXPERIMENT_*.md`, `MAZE_*.md` files.

The experiments were not about the toy apps; they were a **harness for hardening the
tooling**, and they paid for themselves repeatedly:

- **`vbrt shot`** — screenshot/clip artifacts — was born here, because a prompt's
  outcome often *is* a visual, and a before/after image is the proof. It grew
  `--click`/`--wait` to capture interaction states and motion-aware clips.
- **`vbrt doctor`** (and `--fix`) — because agents kept tripping over environment
  gaps (Playwright/chromium availability, PATH, cross-env quirks). The goal stated
  in the commits was to *"make agent capture boring."*
- A hard-won lesson, now enshrined as a warning in the README and CLAUDE.md: **the
  agent skill is a COPY, not a live link.** A stale installed skill silently
  invalidated an entire experiment run — the agent never saw the new clip/doctor
  guidance and the team drew false conclusions from it. "Rebuild the skill bundle"
  became a recurring, load-bearing commit.

Alongside the experiments ran `PROMPT_GALLERY.md`, a research pass over **4,879 of
Mike's real prompts** (3,688 substantive, across ~61 repos — notably Codex 3,247 vs
Claude 441). It mined them for **archetypes** and reached the finding that drove the
next chapter: *different prompt archetypes demand different evidence.* A one-size
"before/after screenshot" rail would serve maybe a third of real prompts. A
conceptual-seed prompt needs to show the *idea that propagated*; a refactor needs a
diff; a test needs pass/fail; an options prompt needs the choices considered.

---

## Chapter 5 — The polymorphic outcome rail and the classifier (June 18)

Acting on the gallery's finding, the team built a **server-side intent classifier**
(`src/classify.js`): **12 prompt archetypes**, classified by **Haiku 4.5** — a model
choice locked in deliberately with a cost analysis (`§C` decisions in the commits),
because the classifier runs on every prompt and had to be cheap. A small but telling
fix: *log classifier failures*, because "a silent classifier looks identical to a
dormant one."

The output was a **polymorphic outcome rail** — the per-prompt evidence strip
*changes shape by archetype*. It shipped in stages: a router plus shot/diff families
first, then test/experiment/options families. The test-outcome family was
deliberately **gated on real test commands** so it couldn't fabricate a green check
out of nothing.

In parallel, **live orchestration** (`LIVE_ORCHESTRATION.md`) pushed the live view
toward real-time *operation*: a real-time agent **ticker** driven by Claude Code
hooks (`src/hooks.js`), the message lane colored by agent (claude vs codex), and —
notably — `vbrt watch --tui`, a **live in-terminal dashboard** that became the
default. A subtle correctness fix from this era: stop *inferring* "working" from
stale events; show the last actual move and let it be dismissed. The project kept
catching itself implying activity that wasn't real.

---

## Chapter 6 — The pivot: Drive (June 19)

This is the hinge of the entire story.

A **Codex research pass** argued that VibeRate could host *the box where prompts are
typed* — not just watch sessions, but **run** them. The team validated this against
the Claude Agent SDK, the Claude Code CLI, the Codex app-server, and its own watcher
code, and reached a verdict recorded in `PLAN_AGENT_RUNTIME.md`: **feasible, and
fundamentally right.**

One load-bearing constraint shaped the whole design: *there is no supported way to
inject input into an interactive terminal process VibeRate didn't launch.* You can't
hijack a running terminal agent. So to drive an agent you must **own the process from
the start** (or resume an *idle* session by id and become its controller). That
forced the central fork — and the team chose **Fork A: spawn the real `claude`
binary** — and `bd89304 "Local agent runtime PoC: drive Claude through VibeRate"`
inverted the product. The read-only tail-and-upload pipeline became one half of
something whose center is now **write**.

Drive matured fast and made a series of consequential calls:

- **Hosted, but admin-gated.** Driving is, literally, a **remote-code-execution
  control plane**. So the composer is **loopback-gated locally and admin-allowlisted
  when hosted** — the read surface stays public/shareable, the write surface never
  does. This trust-boundary discipline (present since day-one redaction) is treated
  as non-negotiable.
- **Run on the Max subscription, not API credits.** Hosted Drive runs on the
  operator's Claude Max plan via seeded OAuth (`src/oauth.js`), and the UI hides the
  cost estimate on subscription turns. A small detail with real economic logic.
- **An inline picker via a custom MCP `ask` tool** (`src/mcpAsk.js`). When the agent
  needs a decision, it surfaces a picker in VibeRate's UI rather than blocking on
  terminal text — and the result distinguishes a *picked label* from a *free-text
  note*. (This is the same `mcp__viberate__ask` an agent in this repo uses today.)
- **CI deploy to Fly on push to main**, because Drive now had to be live to be the
  product.
- **Fold Drive into the dashboard.** A standalone `/drive` page was built, then
  deliberately *retired* — Drive isn't a separate tool, it's the dashboard's center.

`DOGFOODING.md` records the milestone bluntly: **Drive can now develop VibeRate
itself.** The meta-loop the project had been edging toward — building the devtool
*with* the devtool — closed here.

---

## Chapter 7 — Making Drive real: workspaces, identity, one conversation (June 19–20)

A chat box that spawns an agent needs a real checkout to work on, and the work it
produces needs to flow back into the captured history. Two plans cover this.

**Drive workspaces** (`PLAN_DRIVE_WORKSPACES.md`) bind a project to an actual clone
on the host. The decisions here are mostly about **auth hygiene** and **legibility**:
clone via the git credential helper so the token is **never persisted**; **self-heal**
Claude credentials and GitHub push auth; name the checkout after the repo, not the
opaque slug. The barebones runtime container (`node:20-slim`, see `Dockerfile`) and
its sharp edges — `npm install` first, port 8080 taken, no `python` — got documented
straight into `CLAUDE.md` so future driven sessions stop rediscovering them.

**Convo reconciliation** (`DRIVE_CONVO_RECONCILIATION.md`) settled a conceptual
question that turned out to matter a lot: **Drive and the reader are the same object.**
A driven session's *live head* and its *cooled history* are two views of one JSONL.
So a finished turn ingests into the **Convos rail** (watcher-free), a streaming turn
**live-merges** into it (Option B), sessions become **resumable** ("Return to Drive"
survives a redeploy, a `/resume` analogue), and "live" gets reframed as "**follow**."
The `DRIVE_CONVO_INGEST_GAP.md`, `DRIVE_LIVE_STREAM_DUP.md`, and
`DRIVE_DOCS_INGEST_GAP.md` docs chronicle the fiddly bugs along the way (evidence
binding without a push; killing reconnect-replay duplication; the **brain doc set
not refreshing** when a *driven* session edited `.md` and committed) — the
unglamorous plumbing that makes "it just shows up" true. Each had the same shape and
the same fix: the read-only capture pipeline (`vbrt push`/`watch`) fed a surface the
write-path didn't, so the Drive runtime — which *owns* the spawned process — closes
the gap at turn-end by feeding that surface itself (transcript, then evidence, then,
as of 2026-06-21, the docs/time-travel bundle) with no manual push.

A consequential ergonomic gap surfaced and was named here: today only the
**most-recent** Drive session resumes cleanly. The move toward a real **fleet** —
many agents in flight, each parkable and resumable — began with a per-project session
log and a **cross-device, server-side session index**.

---

## Chapter 8 — The brain becomes the live centerpiece, and mobile (June 20)

Two threads converged.

First, a **mobile-unified** plan (`PLAN_MOBILE.md`). Drive made the **phone the
obvious client**: you kick off and babysit agents from anywhere, while the work runs
on the host. So mobile stopped being a "port" and became the *primary surface*. The
team prototyped three layouts and chose **Variant A**: one vertical scroll — the live
transcript + composer — under a **brain header strip**, with the brain and chat
**live-linked**. A run of mobile fixes followed (dead hamburger menus, rails not
closing, the composer flow).

Second — and this is a genuinely nice piece of design convergence — the **live brain
became the centerpiece**. The memory note "brain rethink direction" had argued for a
mobile-first brain synced to Drive's live stream: **ephemeral code-file activations**
(a file lights up when the agent touches it, then fades), **recency-as-physics**, a
**hero progress ring**, and explicitly **no 3D**. The commits execute exactly that:
the ephemeral code-activation viz was wired into the Drive view, and then
`d06710f "Live brain IS the brain: replace the centerpiece, drop the bolted-on Drive
panel"` made it *the* view rather than a panel beside the chat.

The **3D brain question** got a real adjudication (`BRAIN_3D_ASSESSMENT.md`): a
prototype 3D/WebGL brain looked great as a *demo*, but on a real ~10–30-node graph it
traded a permanent render loop and a ~580 KB dependency for capabilities the 2D brain
already had (time-travel, in-place ring fills, health signals, click-to-read). Verdict:
**don't swap the centerpiece; ship 3D only as an opt-in, lazy-loaded layout if ever.**
A clean example of resisting a shiny demo in favor of the working product.

---

## Chapter 9 — The reframe: a mobile, agent-first IDE (June 21)

By June 21 the product had outgrown its founding thesis, and the team formally
**rewrote the strategy** (`PRODUCT_STRATEGY.md`) to match what had actually been
built. The category moved:

- **Was:** an agent *work viewer* — "GitHub for agent conversations," publish and
  review what already happened.
- **Is:** an agent *work environment* — a **mobile, agent-first IDE** where the work
  happens: you **drive** coding agents from your phone, steer them through the
  **brain** and your **prompts**, manage **context**, and watch it land **without
  opening the code.**

The old social core — feedback, comments, ratings, sharing, discovery, forks — wasn't
thrown away; it was **demoted to a later social/learning layer**. Observation became
the *byproduct* of driving rather than the point.

The product thesis underneath the reframe is sharp and worth stating in full, because
it's the lens for every future decision:

- **The control surface is the brain + the prompt, not the source.** You mostly don't
  read code anymore; you steer.
- **Context is the scarce resource.** An agent gets dumber as its window fills (the
  "dumb zone," past ~75%). Helping a driver decide *when to compact, branch, or start
  fresh* is core IDE work, not a chip.
- **You run a fleet, not a session.** The unit of work is several agents in flight,
  and managing them is the real ergonomic problem.
- **The atomic object stays the prompt unit; the durable context stays the brain.**
  Both survived the pivot — you just *act* on them live now instead of reading them
  back.

The supporting docs were brought into line in a batch (`e23fd44`, `691e18b`), the
**landing page was overhauled** around the Drive pivot, the Drive chat got proper
markdown, a context meter, and a "newest-on-top" flipped flow, and a **demo & trial
plan** (`DEMO_PLAN.md`) was written. The demo plan's central insight is itself a
strong piece of product thinking: **the demo is the intervention, not the build.** A
clean one-shot just advertises Claude Code; the only thing unique to VibeRate is the
**steering loop** — a human catching an agent's drift from their phone. Hence the
thesis line: *"real development requires steering"* — vibe coding is a slot machine,
this is a skill game.

A nice bit of honesty also entered the strategy here: **completion % is probably not
the right headline metric**, because so many prompts are *discovery* prompts that
*find* new work and should make "% complete" go *down*. (This very story-writing
prompt is an example.) The honest dashboard shows "what's known, what's in flight, and
that the known scope is still growing" — not one bar marching to 100%.

---

## Chapter 10 — Sharpening the thesis (a course-correction, 2026-06-21)

This story was reviewed with Mike right after it was written, and several framings
got corrected. They're recorded here because new agents read this doc on init — so
these are the calibration notes to internalize, not the caricatures to repeat.

- **What "steering" actually means.** It is *not* the dramatic mid-execution
  interrupt ("catch the agent drifting from your phone"). Steering is the ongoing act
  of **directing** the agent across the whole loop: authoring the brain, shaping the
  plan, writing the prompt, correcting *between* turns, deciding what's next, and
  stopping when you need to. (A human refining an agent's framing across several
  messages — as Mike did to produce this very chapter — is steering.) Both Claude Code
  and VibeRate can stop a run mid-flight, so "stop mid-execution" is *not* a
  differentiator. Don't build the product story on the interrupt; build it on
  *directing well*.

- **The differentiator is probably the plan that never gets finished — not "the
  steering loop" as a slogan.** A near-universal failure in agentic coding: you write
  a plan, uncover something or pivot midway, and **never return to or deprecate the
  original** — so scope silently drifts and work falls through the cracks. The brain
  is purpose-built to kill this by giving a clear visual of **work remaining**. Note
  the gap: the graveyard already handles *completed* plans well; the harder, more
  valuable case is the **abandoned-but-incomplete** plan (stalled, superseded, never
  closed). Surfacing "stalled vs active vs done" is the sharp, defensible thing a
  terminal can't do. Treat "steering loop" as an unsettled slogan, not a proven wedge.

- **VibeRate is a preferential, opinionated view of vibe coding.** The frame is *"we
  think this system will work for you"* — a methodology with a UI (brain + plans +
  prompt-units + the loop), not neutral tooling. That opinion *is* the product.

- **The real risk is upstream, not internal.** VibeRate sits on top of Claude Code's
  format, and these harnesses ship constantly. Two jobs follow: **catch regressions**
  when the JSONL/CLI/API schema shifts, and **capture new capabilities** Anthropic
  introduces (rather than silently dropping unknown events). The right shape is a thin
  **upstream canary** — re-parse a corpus of recent real sessions, flag unknown event
  types / dropped fields, watch the harness version — *not* a broad product test
  suite.

- **Broad tests are deliberately deferred.** The "add a focused test spine" line in
  the strategy docs was written by an *agent*, not set as Mike's priority. Tests wait
  until the product stabilizes. Do **not** propose a unit-test spine as now-work. (The
  upstream canary above is a different, narrower thing — it guards an external
  dependency you don't control, so it can be justified earlier.)

- **Correction: Claude Code auto-compacts.** It compacts the context window at a
  threshold on its own. So "the terminal can't manage context" is **false** — don't
  claim it. If context has product value, it's narrower: auto-compact is a *blunt*
  call made *off-screen*, so the value is **visibility** (especially remote/on mobile,
  away from the terminal scroll) and the **deliberate alternative** — branch, start
  fresh, or checkpoint the brain *before* the window compacts something away. Hold
  this loosely; context may not be a headline feature at all.

## Where it stands, and the open questions

As of the reframe, VibeRate is a working, hosted, self-dogfooding mobile agent-first
IDE. The loop is **capture → understand → drive**, and the project is routinely built
*through itself* — the sessions and brain nodes you see in its own dashboard are this
repo's work viewed through the very tool being edited.

The honestly-open questions, in the team's own priority order:

1. **Onboarding & credentials** (`ONBOARDING.md`) — the hardest unsolved problem.
   *Whose Claude runs the agent?* (leaning toward operator-Claude + billing as the
   ToS-safe path, with BYO as a faster but legally-fraught alternative). And *new app
   vs. existing app* — Drive only clones existing repos today; a scaffold-from-scratch
   path is missing. These are genuine forks, deliberately **not** yet decided.
2. **Fleet / session management** — make *every* past Drive session resumable, not
   just the most recent, and make several concurrent agents legible. The single
   `vbrt_drive_active` handle is the blocker.
3. **Mobile as the primary surface** — finish the responsive port so brain, drive,
   reader, and rail are all first-class on a phone.
4. **Context management as a feature** — not just a gauge, but compact/branch/fresh
   affordances when the agent nears the dumb zone.
5. **A brain that fits *any* repo** — infer structure from whatever `.md` network a
   repo has, not just VibeRate's own `SEED.md`/plan conventions.

## The throughline

If there's a single thread, it's that VibeRate kept **climbing the abstraction
ladder while refusing to lose what it built on each rung**. It started by *reading*
agent conversations, learned to *understand* them (the brain, prompt units, outcome
rails, live streaming), and then — once it could host the agent itself — pivoted to
*driving* them, keeping the entire read/understand surface intact as the "follow"
mode of a live conversation. The recurring discipline behind it: ship a slice, name
the decision in a plan doc, drive the plan to 100%, retire it to the graveyard, and
be willing to cut what doesn't earn its place (the recency glow, the standalone Drive
page, the 3D centerpiece, the social core as the headline). And throughout —
dogfooding so relentlessly that the product's own development *is* its best demo.
