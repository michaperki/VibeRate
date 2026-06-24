# VibeRate — Product Strategy

Status: **canonical frame** for near-term product and roadmap decisions.
Reframed 2026-06-21 (the agent-first IDE pivot — see "How we got here" below).

## One-sentence frame

VibeRate is a **mobile, agent-first IDE**: you drive coding agents (Claude Code
today, other harnesses later) from your phone, steer them through the project's
**brain** (its `.md` docs, plans, and memory) and your **prompts**, manage their
context and the work in flight, and watch it land — without ever needing to open
the code.

## How we got here (the pivot)

VibeRate started as an **observation tool**: a viewer and feedback surface for
terminal-agent work. We researched a developer's historical prompts, derived 12
prompt archetypes, and built bespoke renderers for agent replies — the "Convos"
half of the app. The thesis was "GitHub for agent conversations": publish, watch,
review, discuss.

Then we shipped **Drive** — a chat box in the dashboard that spawns and steers a
real `claude` binary on a bound checkout. That inverted the product. The read-only
watcher became the *read* mode of a thing whose center is now **write**: starting,
steering, and managing agents. Observation didn't disappear — it became the
byproduct of driving, not the point.

So the category moved:

- **Was:** an agent *work viewer* — publish and review what already happened.
- **Is:** an agent *work environment* / **mobile agent-first IDE** — where the work
  actually happens, control surface and all, with a phone as a first-class client.

The old "viewer + feedback + sharing/discovery" surface is now a **later social /
learning layer**, not the core (see `ROADMAP.md` Phase 2). The first job is making
the single-developer **capture → understand → drive** loop frictionless on a phone.

## Product thesis (agentic-first coding)

The premise of agentic-first coding is that **you mostly don't read code anymore.**
The leverage moved up a level:

- **The control surface is the brain + the prompt, not the source.** The `.md`
  files — `CLAUDE.md`, `SEED.md`, plan/roadmap docs, memory — are where you actually
  steer the agent. VibeRate's brain web makes that control surface legible and
  navigable; the prompt is the verb that acts on it. Code is an artifact the agent
  produces; the brain and the prompt are what you touch.
- **Context is the scarce resource.** An agent gets dumber as its window fills (the
  "dumb zone," ~past 75%). Surfacing context fullness, and helping a driver decide
  *when to compact, branch, or start fresh*, is core IDE work — not a nice-to-have
  chip.
- **You run a fleet, not a session.** The unit of work is shifting from one
  conversation to *several agents in flight at once* on the same or different repos.
  Starting, parking, resuming, and re-entering the right one is the real ergonomic
  problem (today only the most-recent Drive session resumes — see `ROADMAP.md`;
  fixing that is a now-priority).
- **The atomic object stays the prompt unit** (`before → prompt → agent work →
  after`), and the **durable context stays the project brain.** Both survive the
  pivot; what changed is that you now *act* on them live, not just read them back.

## What "mobile, agent-first" actually demands

Drive made the phone the obvious client: you kick off and babysit agents from
anywhere, and the work runs on the host (the Fly volume), not the device. That sets
the bar:

- **Mobile is the primary surface, not a port.** Nearly everything belongs on the
  phone: the brain, the live transcript + composer, context/progress, the rail.
  Reserve desktop only for genuinely space-hungry tasks (e.g. dense brain editing,
  side-by-side diffs) — assume mobile-first until a feature proves it can't be.
- **The conversation is the home.** Drive and the reader are the *same* object —
  the live head and the cooled history of one JSONL
  (`archive/drive-reconciliation/DRIVE_CONVO_RECONCILIATION.md`).
  On mobile that collapses into one vertical scroll with a brain header strip
  (`PLAN_MOBILE.md`, Variant A).
- **Driving is an RCE control plane.** Merging the read and write surfaces must
  never merge their trust boundaries: the composer is admin/loopback-gated; the
  reader is public/shareable.

## Onboarding & business model (open decision — `ONBOARDING.md`)

The hardest unsolved product question is how a *new* user gets to "my agent is
working" on their phone. Two sub-questions, both open:

1. **Whose Claude runs the agent?** Today Drive runs on the operator's
   credentials, admin-gated (`agent.js`). For real users we lean toward
   **operator-Claude + billing** (the user adds a payment method and rents our
   Claude) as the clean, ToS-safe path, possibly alongside **BYO** (user supplies
   their own key/login) for faster time-to-market. BYO an OAuth/subscription token
   risks Anthropic's ToS and needs legal clarity before we ship it.
2. **New app vs. existing app.** The existing-repo path is now no-terminal and
   one-tap: a **"New project"** button + **Connect GitHub** repo picker creates a
   project and clones the repo (private included) using the user's own token
   (`createProject` + per-user GitHub grant + `workspaces.js`), no `vbrt push` and no
   shared instance token required (shipped 2026-06-24; `ONBOARDING.md` Fork 2 Slices 1
   & 2). Project *creation* is account-scoped while the *clone* stays admin-scoped, so
   this landed without touching the credentials fork. Still missing: a
   **start-from-scratch** path (scaffold a new project + brain) for users without a
   repo yet.

These are genuine forks, not yet decided — `ONBOARDING.md` lays out the options and
tradeoffs. Do not invent a default in product copy until they're picked.

## Is completion % the right metric?

Probably not as the headline number. Completion percentage assumes a fixed
denominator, but a large share of prompts are **discovery** prompts — they *find*
and document undiscovered work, which should make "% complete" go *down*, not up.
(This very doc-review prompt is an example: it uncovers work.) Keep the metric as
*one* signal, but treat it as non-monotonic and pair it with **scope discovered**
and **work-in-flight** signals. The honest dashboard answer is "here's what's known,
what's in flight, and that the known scope is still growing," not a single bar
marching to 100%.

## Immediate priority order

1. **Onboarding / credentials.** Pick the credential-sourcing model and the
   new-vs-existing-app flow, then make first-run on a phone a single, obvious path
   (`ONBOARDING.md`). This is the gate to anyone but the operator using Drive.
2. **Fleet / session management.** Make every past Drive session per project
   resumable (not just the most recent), and make running several agents at once
   legible. Today's single `vbrt_drive_active` handle + in-memory registry is the
   blocker.
3. **Mobile as the primary surface.** Finish the responsive port (`PLAN_MOBILE.md`)
   so the brain, drive, reader, and rail are all first-class on a phone.
4. **Context management as a feature.** Surface dumb-zone risk and offer
   compact/branch/fresh affordances, not just a gauge.
5. **Brain that fits *any* repo.** Make the brain useful for devs who don't use our
   `SEED.md`/`DEVLOG.md` conventions — infer structure from whatever `.md` network a
   repo has (`PROJECT_VIEW_PLAN.md`).

## Showing it / first trial (`DEMO_PLAN.md`)

How we *demonstrate* and *trial* the loop is its own problem, captured in
`DEMO_PLAN.md`. The core reframe: **the demo is the intervention, not the build** —
a clean one-shot advertises Claude Code, not us; the only thing unique to VibeRate
is the steering loop (a human catching the agent's drift from their phone). Thesis
line: *"real development requires steering"* (vibe coding is a slot machine; this is
a skill game). Trial and video are separate problems — the trial needs a pre-seeded
**"starter brain"** to bias users toward steering-shaped tasks (ties into the
new-vs-existing-app fork in `ONBOARDING.md`), the video can stage the perfect
redirect. Leans on the mobile Drive view (`PLAN_MOBILE.md`) and the brain web
(`PROJECT_VIEW_PLAN.md`).

## What to delay (the old social core, now a byproduct)

- **Feedback / comments / ratings, sharing controls, discovery/trending, forks.**
  Valuable as a *learning* layer once the IDE loop is frictionless and
  battle-tested — not before. First pass of voting shipped; the rest waits.
- **Heavy storage migration** for its own sake. Minimum hardening now; move to a DB
  when real social/multi-user behavior demands it.

## Test spine

Add focused tests before the next schema or runtime expansion:

- Claude parser / Codex parser / redaction.
- Prompt-unit extraction, evidence binding, activity attribution.
- Hosted visibility and private/public behavior; `pushBundle` token selection.
- **Drive runtime:** session start/resume/adopt across a redeploy, the loopback /
  admin gate, workspace clone status, and the ownership-lease single-writer rule.

## Demo target

One canonical public demo of the full loop **driven live from a phone**: kick off an
agent against a real repo, watch the brain glow as it edits docs, see the context
meter and live transcript, then the cooled prompt-unit history with outcome chips
and evidence. VibeRate building VibeRate is the natural fixture.
