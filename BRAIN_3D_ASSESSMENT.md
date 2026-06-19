# Is the 3D brain worth the weight? — prototype assessment

> Status: **research pass, no code changes.** Evaluates
> `prototypes/viberate-3d-brain.html` against the shipped 2D SVG brain
> (`app.js` `renderBrainGraph` / the `.brain` SVG) on load cost, runtime cost,
> and bang-for-buck. Verdict up front, evidence below.

## Verdict

**Don't swap the centerpiece wholesale.** The 3D brain is a genuinely nicer
*demo*, but on this app's actual graph (~10–30 nodes) it trades a feature set we
already ship — and a near-zero idle cost — for a permanent WebGL render loop and
a ~580 KB third-party dependency, while *dropping* capabilities the 2D brain has
(time-travel, live in-place ring fills, health/orphan signals, doc reader on
click). The bang isn't worth the buck **as a replacement**. If the 3D look is
wanted, ship it as an **opt-in "3D" layout toggle**, lazy-loaded, not the default.

## Side-by-side

| | 2D SVG brain (shipped) | 3D brain (prototype) |
|---|---|---|
| Tech | Inline SVG + hand-rolled force layout | `three.js r128` + WebGL canvas |
| Extra payload | **0** (uses existing `app.js`) | **~580 KB** min (`three.min.js`, ~150 KB gzip) from a CDN |
| Idle CPU/GPU | **~0** — rAF loop is a *finite settle* then stops (`app.js:2041`) | **Continuous** — `requestAnimationFrame` forever (`viberate-3d-brain.html:470`), even at rest (idle auto-rotate) |
| Per-frame work when active | DOM attribute writes during a brief settle | resize check + layout ease + camera + **billboard every node** + **rebuild every link's geometry** + **raycast** + hover lerp + project every label, every frame |
| Mobile / low-power | Cheap; SVG, no GPU context | A live WebGL context + perpetual loop = battery/heat; `prefers-reduced-motion` only stops auto-rotate, not the loop |
| Accessibility / SSR | DOM nodes, selectable labels, inspectable | Opaque canvas; labels are an HTML overlay, graph is not in the DOM |

## What the prototype is genuinely better at

- **Depth reads well for a dense web.** 3D orbit disambiguates a hairball that 2D
  has to untangle with force tuning. For a "wow" landing/marketing shot it's
  stronger.
- **The three layouts are nice** (`web` force, `tree` BFS, `recent` spiral) and
  the transitions are smooth.
- **Material/glow language** (emissive by recency, halo, billboarded rings) is a
  richer visual vocabulary than flat SVG strokes.

These are real, but they're **aesthetic**, and they're achievable in 2D too
(recency-brightness already exists; layouts are layout math, not a renderer
choice).

## What a straight swap would *cost us* (capability regressions)

The shipped 2D brain is not just a picture — it's wired into the product. The
prototype is a static mock of 14 hardcoded nodes and reimplements none of this:

- **Time-travel** over brain history (`state.timeTravel` / `ttIndex`, the
  `renderTimeTravel` controls) — scrub the brain across commits.
- **Live in-place updates** — `streamUpdateBrain` (`app.js:886`) fills/empties
  completion rings and glows changed nodes *without rebuilding*, kept in sync
  with the Brain-history card. A WebGL swap means re-porting this whole live path.
- **Brain-health signals** — quiet importance brightness + orphan pulse
  (link-or-retire), the reads/edits join via `deriveOutcomes`.
- **Click → doc reader** — every node opens the doc in the lightbox reader
  (`wireDocTabs`). The prototype's click does nothing.
- **Graveyard / archived-node handling**, fallback brain-doc set, the activity
  ribbon coupling.

So "move from the existing brain to this new brain" is not a reskin — it's a
re-implementation of the centerpiece's entire behavior layer on top of three.js,
*plus* the payload and loop costs. That's the expensive part, and it's invisible
in a 20 KB prototype.

## Load / heaviness — the concrete answer to the question

- **Does it make loading worse?** Yes, measurably but not catastrophically: one
  extra ~580 KB (min) / ~150 KB (gzip) script, currently from a CDN (third-party
  origin = extra DNS/TLS/connection, an availability dependency, and a privacy
  hop). Today the whole front-end is `app.js` (~160 KB) + `style.css` with **no**
  third-party JS. This would roughly double JS weight for one widget.
- **Does it make the app significantly heavier at runtime?** Yes, in the
  dimension that matters: **idle cost.** The 2D brain settles and then does
  nothing; you can leave the dashboard open and it's free. The 3D brain holds a
  WebGL context and runs a full render+raycast loop *forever*, including idle
  auto-rotate. On a laptop that's fans/battery; on mobile it's worse; with the
  dashboard's live-poll already running every 2 s, you're now also painting 60 fps
  for a decorative graph. For a tool people leave open all day, perpetual idle
  cost is the wrong trade.
- At this graph size (tens of nodes) **neither renderer is CPU-bound on the
  graph** — the 2D force sim and the 3D scene are both trivial. The cost
  difference is entirely *dependency weight* + *idle loop*, not *scale*.

## Recommendation

1. **Keep the 2D SVG brain as the default centerpiece.** It's free at idle, has
   no third-party dep, and carries the time-travel / live / health / reader
   behavior that is the actual product.
2. **If the 3D view is wanted, make it an opt-in layout**, not a replacement:
   - lazy-load `three.js` only when the user switches to "3D" (keep the default
     path zero-dependency),
   - **self-host** the library (don't depend on a CDN for a core view),
   - **stop the loop when idle/unfocused** — render on interaction + a short
     decay, pause on `visibilitychange` and when off-screen; have
     `prefers-reduced-motion` actually halt the loop, not just auto-rotate,
   - share the existing graph data + click→reader wiring so it inherits behavior
     instead of forking it.
3. **Cheaper alternative if the goal is just "more depth/polish":** push the 2D
   brain — parallax/pseudo-depth, the prototype's recency-glow and halo language,
   the tree/recent layouts — for a fraction of the cost and none of the
   regressions.

Per the project's decision method, the right next artifact is a **toggle mock**:
2D default with a "3D (beta)" layout button, lazy-loaded, so the look can be
judged in-app without paying the cost on every load or losing the behavior layer.

## Net

The 3D brain is a better screenshot and a worse default. Loading gets heavier
(~580 KB third-party JS) and runtime gets *meaningfully* heavier where it counts
(a perpetual WebGL loop vs. today's free-at-idle SVG), while a naive swap would
regress time-travel, live ring-fills, health signals, and click-to-read. Ship it
as an opt-in, lazy, self-hosted, idle-stopping layout — or invest the same effort
into depth cues on the 2D brain — rather than replacing the centerpiece.
