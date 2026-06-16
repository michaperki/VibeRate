# Streaming — live read-only monitor (`vbrt watch`)

Status: **spec** · ROADMAP Phase 1 item · an experiment run via the
[experiment loop](PROJECT_VIEW_PLAN.md) (spec → push → build → archive→ghost).

## Why

Today a project is a **snapshot** — you `vbrt push`, then view a frozen moment.
Streaming makes the dashboard **update within seconds while agents work**: docs
get created/edited, prompts and commits land, and the UI **animates the change in
place** instead of you re-pushing and reloading. Read-only — we reflect what's
happening, we don't edit.

The delight: open the brain graph on one screen, code with Claude/Codex on
another, and **watch the brain breathe in real time** — nodes being born, rings
filling, the timeline growing.

**It's not just the brain.** The stream is the whole live session: new **prompts
and turns** should appear in the conversation reader and the activity timeline as
you talk to the agent — `vbrt watch` already re-pushes on git/doc change; it
should also watch the active session logs so live conversation streams too. This
is co-equal with the brain, not a footnote (and it pairs with the social vision:
watch someone work *live*, give feedback as it happens). Capture side =
session-log watching; viewer side = the activity ribbon + reader updating live.

## The big advantage: the animation is already built

`applyBrainAsOf()` (the time-travel work) is a **"diff the graph to a target
state and animate the transitions"** function. Streaming is the *same idea* with
a different target:

- time-travel → diff to the **as-of** state (a past commit)
- streaming → diff to the **latest** state (the newest snapshot)

Births fade in, rings fill, deaths fade to ghost — all reusing the build-once +
animate-in-place layer. The genuinely new work is **transport** and a
**structural diff** (today `applyBrainAsOf` works on a fixed node set; streaming
must add/remove node elements as docs appear/disappear).

## Architecture

```
agent edits repo  →  vbrt watch (local)  →  upsert push  →  host  →  viewer polls → diffs → animates
   (logs/docs/git)     debounce + rebundle    (id stable)            (updatedAt stamp)   (reconcile + applyBrainAsOf)
```

1. **`vbrt watch` (local):** a long-running client that watches the active
   Claude/Codex **session logs**, the **brain docs**, and **git**; debounces
   (~2–3s) and re-pushes a refreshed bundle. Re-push **upserts** (same id / share
   link — already built in `ingestBundle`).
2. **Transport (start simple):** the viewer **polls** a cheap version stamp
   (project `updatedAt` / a content hash) every few seconds; on change it
   refetches. Graduate to SSE/WebSocket + delta events only if the UX needs it.
3. **Reconcile + animate:** on a new snapshot, rebuild the docGraph, **diff
   against the current one** (added / removed / changed nodes + edges), then add
   new node elements (fade in), drop gone ones (fade out → optional ghost), and
   re-run the in-place updaters (rings, glow, positions). Same for the activity
   timeline (new prompts/commits animate in).

## Open questions / decisions (mock or default)

- **Poll interval** — 3s? 5s? balance freshness vs. load. Likely a default + a
  "live/paused" control.
- **"Live" affordance** — a pulsing `● live` indicator; pause button; maybe a
  subtle flash on whatever just changed.
- **New positions** — when a node is added, the force layout shifts everything;
  do we re-run layout and tween *all* nodes, or pin existing + place only the new
  one? (Tween-all is prettier but busier.)
- **Session reader during a live session** — auto-follow new turns, or just badge
  "N new"?
- **Hosted vs local** — `watch` runs locally (it has the filesystem); the viewer
  side works hosted or local.

## Implementation checklist

- [x] `vbrt watch` CLI — poll brain docs + git **+ the active session logs**
      (`watchSignature`), debounce, re-push (upsert). So live *conversation* growth
      (new prompts/turns) triggers pushes too, not just brain edits.
- [x] Rebundle on change — `assembleBundle` (shared with `add`/`push`) re-bundles
      and pushes; ingest upsert keeps it one project.
- [x] Viewer transport — poll the project `updatedAt` stamp; refetch on change.
- [~] **In-place reconcile** — when the node *set* is unchanged (the common case:
      a doc's content changed), the brain updates in place: completion rings
      **fill smoothly** + the changed node **glows**, no rebuild. *(Add/remove of a
      doc still falls back to a full re-render — the smooth add/remove fade is the
      remaining piece.)*
- [~] Live **activity** — the Activity card re-renders on each live update so new
      prompts / commits appear; gliding them in (animated) is still to do.
- [x] `● live` indicator + pause control (the `Go live` / `Live` toggle).
- [ ] Verify by editing a brain doc while watching (node/ring updates live).

## Later

- [ ] SSE/WebSocket + delta events (drop polling) if latency/load demands it.
- [ ] Live session-reader follow (new turns stream into the conversation view).

---

When shipped, this doc gets **archived → ghost node**, like its predecessor
[the plan-completion experiment]. Loop continues.
