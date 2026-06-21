# VibeRate — demo & trial plan (the steering story)

Status: **brainstorm captured, not yet built.** Canonical product frame:
`PRODUCT_STRATEGY.md`. This doc is the go-to-market companion to it — how we
*show* and *trial* the mobile, agent-first IDE. Roadmap home: `ROADMAP.md`
("Now — agent-first IDE priorities"). The surfaces it leans on are the mobile
Drive view (`PLAN_MOBILE.md`), the brain web (`PROJECT_VIEW_PLAN.md`), and the
auto-ingested shot card (`DRIVE_CONVO_INGEST_GAP.md`, `ARTIFACTS.md`).

## The thesis we're selling

**Real development requires steering.** Vibe coding — prompt-and-pray — is a slot
machine: you throw the dice and wait. This is the same dice, but a *skill* game.
The agent writes the code; the human makes the calls. VibeRate is the control
surface for that: drive and steer a coding agent from your phone, through the
project's **brain** (its `.md` docs) and your prompts, without opening the code.

The current name (VibeRate) sits *against* this thesis — the pitch is "for real
devs, not vibe coders." **Steer** is on-message. Parked, not decided; the name is
not today's problem. Noted here only so it isn't lost.

## The reframe that unlocks the demo

> **The demo is not the build. It's the intervention.**

The instinct is to demo a task being built. But a clean one-shot advertises Claude
Code, not VibeRate — the only thing *we* uniquely have is the **steering loop**: a
human on a phone catching the agent's drift and correcting course. So the subject
of every demo is the **redirect**, not the deliverable.

This dissolves the three tensions from the brainstorm:

- **"It's a dev tool — what do users build?"** Almost irrelevant. The build is
  backdrop; the steer is the subject. A roof going up is boring; a near-miss you
  catch is a story.
- **"Claude one-shots a to-do list."** That confidence is the *setup*. You want the
  agent to start briskly down a path so the redirect has something to redirect.
- **"Real dev requires steering."** Don't assert it in copy — *show* the instant
  where steering changed the outcome. Inherently skill-based, not gambling.

## The shot (≈25s, vertical, phone-only) — "the redirect"

Emotional arc: **spin → catch → control.** Earn the gambling metaphor, then break it.

1. **(0–4s)** Phone. Thumb types into Drive: *"real development requires steering."*
   The line doubles as the prompt **and** the thesis — meta, but it lands.
2. **(4–10s)** Motion. The agent starts. The mobile **brain web** lights up nodes as
   it reads `ARCHITECTURE.md` / `ROADMAP.md` (recency-as-physics, nodes pulsing);
   the progress ring spins. *This is the roulette wheel* — the "spinning its wheels"
   energy, made visual.
3. **(10–15s)** The catch. The agent heads toward the obvious-but-wrong approach.
   Tight insert of a brain node the human knows ("we decided against global state").
   Thumb cuts in: *"stop — use the event bus, see `ARCHITECTURE.md`."*
4. **(15–22s)** The adapt. The agent pivots; the *right* node lights up; the ring
   completes; an `.md` file visibly updates; a `vbrt shot` after-image snaps onto the
   prompt card (auto-ingested, no push — `DRIVE_CONVO_INGEST_GAP.md`). Control, not spin.
5. **(22–25s)** Hold on the now-settled brain. Tagline.

### Copy / taglines (react to these)
- **"Vibe coding is a slot machine. This is poker."**
- *"Stop praying. Start steering."*
- *"AI writes the code. You make the calls."*
- **"Real development requires steering."** ← strongest; it's also literally the
  prompt typed in the video.

### Using the gambling hook without poisoning the brand
Devs feel the slot-machine anxiety of prompt-and-pray viscerally — it's a great
hook. But be surgical: gambling is the **before**, never the **during**. Let the
*feeling* attach to the old way (the wait, the spin), then resolve it into control.
If the product moment feels like a casino, we've branded ourselves the house.

## What project to demo: dogfood, staged

| Option | Pro | Con |
|---|---|---|
| **Seeded generic project** (fake "dev journal" + "roadmap") | universally legible | smells like a toy/to-do demo — exactly where the "one-shots it" critique lives; devs have a high BS detector |
| **Dogfood this repo** | realest possible project; `CLAUDE.md` already says "we build VibeRate using VibeRate"; brain has real load-bearing nodes; nothing fabricated | meta / insider |

**Decision: dogfood, but stage it.** Use the real repo's brain, but pick a
*self-contained, visually obvious* task (e.g. "add the mode badge to the Drive
chat" — small, on-screen, the kind of thing we've actually shipped) so an outsider
can follow "badge appears + doc updates" without understanding VibeRate internals.
Authentic **and** legible.

## Separate the two asks: trial ≠ video

They have **opposite control profiles** and were blurred in the brainstorm:

- **The video** — total control. Stage the perfect steering moment (above).
- **The trial with real users** — *zero* control over what they type, which is where
  the one-shot risk actually bites: a user types a toy prompt, Claude nails it, they
  shrug "it's Claude on mobile." So the trial must **bias users toward steering-shaped
  tasks**:
  - Ship a pre-seeded **"starter brain"** — a roadmap + 2–3 decision docs *with
    opinions in them*. Now the user lands in a project that already has constraints to
    steer *within*; the brain gives them something to point at and say "no, follow
    this." Steering becomes the obvious move instead of something they must invent.
  - Optionally a **guided first session** that scripts one redirect, so they *feel*
    the loop once before they're on their own.

**The starter brain is one artifact doing two jobs:** set dressing for the video
*and* scaffold for the trial.

## Build plan — the demo set (recommended next step)

A screen-recording of the **real** tool catching a **real** redirect beats any
rendered ad, and it's the most honest version of "trial this for users." Concretely:

1. **Starter-brain MD set** — roadmap + 2–3 opinionated decision docs (the seed that
   makes steering the obvious move). Reusable in video + trial.
2. **Scripted steering task** — a small, on-screen change with a known "obvious-but-
   wrong" first path and a brain-doc-backed correction.
3. **Previewable demo project** — stand it up so the real mobile Drive view is
   screen-recordable at a `$VBRT_PREVIEW_BASE` URL (no fakery); a video-gen model can
   stylize from that capture if we want the "action-packed quick-cut" energy.

Alternative if we don't want to dogfood the live repo: build the demo set as a
throwaway project (seeded brain) and record against that — same shot list, neutral
content.

## Open decisions
- Dogfood-real-repo vs. throwaway-seeded for the *recording* (recommendation: dogfood).
- Whether the first trial ships the **starter brain** as a default new-project
  template (ties into `ONBOARDING.md`'s "new vs existing app" fork).
- Real screen-record vs. video-gen stylization (can do both: record first, stylize after).
- Name (`Steer`?) — parked; `PRODUCT_STRATEGY.md` owns the category question.
