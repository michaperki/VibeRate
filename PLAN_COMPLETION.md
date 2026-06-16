# Plan-Completion % → Brain Node Status

Status: **v1 shipped** (Arc ring, checkbox parser, time-travel fill) · follow-ups:
semantic marker + outcome rollup · an experiment within the [Project View Plan](PROJECT_VIEW_PLAN.md).

## Why

Plan/spec docs (this file, `PROJECT_VIEW_PLAN.md`, `ROADMAP.md`, `*_NEXT_PASS.md`)
get created and progressively completed. There's no at-a-glance signal for *how
done* each one is. Idea: derive a **completion %** per plan doc and surface it as
a **progress ring around that doc's brain node**, so the graph shows which plans
are fresh, mid-flight, or finished.

Read-only: we *visualize* status, we don't check items off from the UI.

## Why now (the synergy)

This rides the brain time-travel work we just shipped. `history.json` already
stores each plan doc's **content at every version** — so completion is computable
not just for the current doc but for **every historical version, with zero new
capture**. As you scrub the brain timeline, a plan's ring can **fill over time**:
watch a plan go 15% → 60% → 100% across commits. "See the brain evolve" becomes
"watch your plans get done." And the ring layers onto the existing node render
(`ghalo` pulse, `gring` lifecycle) — no new surface.

`PROJECT_VIEW_PLAN.md` and this file are full of `- [ ]` / `- [x]`, so the
checkbox parser produces a real, meaningful % on our own brain immediately.

## Sources for the number (staged)

1. **Checkbox parser (ship first).** Ratio of `- [x]` to total `- [ ]`/`- [x]`
   in the doc. Free, no convention, works on existing docs. `null` when a doc has
   no checkboxes (→ no ring).
2. **Semantic marker (later, authoritative override).** The agent writes a
   completion line at the **bottom** of the doc, e.g. `<!-- completion: 45% -->`.
   Parsed at capture; overrides the checkbox number when present. **Bottom, not
   top**, for two reasons:
   - **Reading-before-answering (the real one).** A number written *after* the
     whole doc is the model showing its work — it has read the plan before
     committing. Ask an LLM for a one-word answer to a math problem and it does
     worse than if it reasons first; a completion % at the *top* is exactly that
     cold one-word answer, forced before the doc is read.
   - **No clutter.** It stays out of the reader's way at the top of the doc; it's
     metadata, not content.

## Plan-type detection

A doc gets a ring when it's "plan-type": it **has checkboxes**, OR its filename
matches `PLAN` / `ROADMAP` / `BACKLOG` / `TASKS` / `*_NEXT_PASS`. Non-plan docs
(SOUL, README, ARCHITECTURE…) get no ring.

## Visualization

- A **progress arc/ring** around the node (empty → full sweep), *not* a recolor —
  node color already encodes role/type. A "donut of doneness."
- The ring honors the **time-travel as-of version**: in time-travel it reflects
  the content of the version at the scrubbed commit, so it animates as you scrub.
- Tooltip / small legend entry explaining "ring = plan completion".

## Implementation checklist (v1 — all shipped)

- [x] `completionOf(content)` — checkbox ratio → `{ pct, done, total }` or `null`.
- [x] Compute completion for current nodes in `buildDocGraph` (from doc content).
- [x] Render the progress **Arc** ring around plan nodes (amber→green by %).
- [x] Time-travel: ring uses the as-of version's content (from `history.json`),
      so it fills while scrubbing.
- [x] Ring legend (`◔ ring = % done`) + completion bar in the hover-peek.
- [x] Verify on `PROJECT_VIEW_PLAN.md` (0→8→17% over history) + this file.

Future work (semantic `<!-- completion: N% -->` marker, filename-based plan
detection, outcome-surface rollup) lives in `PROJECT_VIEW_PLAN.md` §🧪 — it's no
longer this doc's concern.

---

**Done.** This experiment is complete; the doc is now **archived** → it should
appear as a **ghost node** in the brain graveyard (visible while time-travelling
its own lifetime: born → ring fills to 100% → ghost). Loop closed. 🪦
