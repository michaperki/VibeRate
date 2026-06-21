# PLAN — Mobile unified view (responsive port of the whole app)

> Status: **shell shipped.** Slices 1–3 are live in `public/{index.html,style.css,app.js}`
> (responsive shell + nav, the Variant-A brain header strip + expand overlay, and the
> brain↔chat live link). The prototype `public/proto/mobile-unified.html` is kept as
> the visual spec until the real screen is fully proven. This is the architecture plan
> for porting VibeRate to mobile. Companion to `PROJECT_VIEW_PLAN.md` (the read
> surfaces), `DRIVE_CONVO_RECONCILIATION.md` (Drive = live head of the reader),
> and `PLAN_AGENT_RUNTIME.md` (the runtime).
>
> **What shipped (gated entirely by `body.is-mobile` from `matchMedia(max-width:760px)`
> — desktop above the breakpoint is byte-for-byte unchanged):**
> - Slice 1 — fixed app bar (☰ projects · title/sub · follow · ≣ rail), `#sidebar`
>   off-canvas drawer, `#sessions` bottom sheet, single-column panes, safe-area insets,
>   `viewport-fit=cover`. A small `mobileInit()` module wraps the existing render fns so
>   every surface transition re-syncs the chrome — no renderer was forked.
> - Slice 2 — the `.brainbar` header strip (a chip per brain doc) and an expand overlay
>   that mounts the **real** `renderCenterpiece()` SVG (node tap → doc lightbox; layout /
>   time-travel toggles re-mount in place). Rail = the bottom sheet.
> - Slice 3 — `tool_use → brainTouch()` glows a doc's chip + node from the live Drive
>   SSE (reuses `toolFile`/`classifyTool`; no new capture). Lands on the desktop brain too.
>
> **Flow update (2026-06-21):** the Drive chat shipped with a **flipped, top-anchored
> flow** rather than the bottom-pinned composer the IA below sketches. The composer is a
> sticky stack at the **top**; the transcript reads **newest-first** (oldest at the
> bottom), so the live activity always sits directly under the input — no scroll-to-
> bottom on mobile. Where this plan says "composer pinned bottom," read "pinned top,
> newest-first." See ROADMAP Phase 3 "top-anchored flipped flow."
>
> **Deferred (open question, by design):** project home is still the **dashboard**, with
> the brain strip on top and Drive (the composer surface) one tap away via the rail. The
> chat-first "conversation IS the home" default is the one-line `data-screen` flip noted
> below — left for Mike to confirm against the live shell.

## Decisions locked (Mike, 2026-06-20)

1. **Layout = Variant A** — chat-first with an expandable **brain header strip**.
   Nodes pulse in the collapsed strip; tap to expand the full network. (B split /
   C tabbed rejected.)
2. **Delivery = responsive, one codebase.** No separate `/m/` route, no second
   SPA. Same `index.html` / `app.js` / `style.css`; a mobile shell + media-query
   layer below a breakpoint reorganizes the existing screens. Desktop above the
   breakpoint stays byte-for-byte what it is today.
3. **Scope = full read + drive port.** Not just brain + chat — the dashboard,
   timeline, side rails, and reader all get a mobile home. Variant A is the
   *project home*; the rest are drill-ins / sheets off it.

## The insight that makes this tractable

Two facts already in the codebase make "full port" much smaller than it sounds:

- **The desktop app has no framework and no router** — it's vanilla JS that
  builds HTML strings and toggles **body classes** (`view-home` / `view-project`)
  plus shows/hides three `.pane` columns (`boot()` `app.js:~4148`; `selectProject`
  `:574`; `selectSession` `:2665`). Every screen is already a self-contained
  render function off the data layer. Mobile is a **new shell + nav state machine
  + CSS**, not a rewrite of the renderers.
- **Drive and the reader are already one conversation** (`DRIVE_CONVO_RECONCILIATION.md`,
  Decision 2026-06-19 = Option B: Drive is the live head of the reader). That
  collapses the two heaviest columns — the prompt rail and the live chat — into a
  single vertical scroll, which is *exactly* the mobile-native shape. The
  prototype's Variant A is that shape with a brain header bolted on top.

So the mobile job is mostly **layout + navigation reorganization of existing
render output**, plus one genuinely new piece of chrome (the brain header strip
and its expand interaction).

---

## Current desktop architecture (what we're porting)

Three fixed columns in one flex row (`style.css:23,25,67,74`), each `.pane`
`height:100vh; overflow-y:auto` (`:66`):

```
#app (flex, 100vh)
├─ #sidebar  (240px fixed)   project picker        — loadProjects() :376
└─ #main (flex)
   ├─ #sessions (320px fixed) Sessions|Prompts rail — renderSessionList() :1059
   └─ #conversation (flex:1)  one of:
        • dashboard   (brain + timeline + history)  — renderTimeline() :1265
            – brain graph (SVG, web/tree/recent)    — renderCenterpiece() :1700
            – activity ribbon                       — renderRibbon() :2425
            – brain history + time-travel           — renderBrainHistory() :1371
            – project memory                        — renderProjectMemory() :1325
        • reader      (prompt-unit cards)            — renderSessionReader() :2692
            – per-card outcome rail                  — renderOutcomeRail() :3027
        • drive       (live agent chat)              — renderDriveView() :3566
```

Live mode: `startLive`/`pollLive`/`refreshLive` poll `updatedAt`, animate the
brain in place (`streamUpdateBrain` `:944`). Modals (lightbox `#lightbox`, doc
panel `#doclightbox`, memo) are **already responsive** (`min()`, `vh/vw` —
`style.css:580,864,1023`) and need no porting.

**The only `@media` queries today are `prefers-reduced-motion`.** There is zero
viewport responsiveness. At 390px the two fixed columns (240+320=560px) overflow
the screen before `#conversation` gets any width. That's the whole problem.

---

## Mobile information architecture

The three desktop columns become a **navigation stack** with the project's
unified conversation at its center.

### The nav model (a small state machine)

```
L0  Projects            ← #sidebar, becomes an off-canvas DRAWER (hamburger)
     │ tap a project
     ▼
L1  PROJECT  =  Variant A unified screen  (the home)
     ┌─────────────────────────────────────┐
     │ app bar:  ☰  project · sub   live ⋯ │
     │ brain header strip (collapsed)  ▾    │ ← renderCenterpiece(), collapsed
     │ ───────────────────────────────────  │
     │ conversation scroll:                  │
     │   cooled reader cards (history)       │ ← renderReaderCard()
     │   live provisional cards (driving)    │ ← driveRender() → cool on result
     │ ───────────────────────────────────  │
     │ composer  [Message the agent…]   ↑   │ ← gated (drive rights only)
     └─────────────────────────────────────┘
     │ expand brain          │ open rail        │ open timeline
     ▼                       ▼                  ▼
L2  Brain network      Sessions|Prompts    Activity timeline
    (full overlay,      index (bottom       (full-screen sheet,
     existing SVG)       sheet / drawer)     horizontally scrollable)

    + drill-ins that already work: doc lightbox, media lightbox, memo modal
```

The project home is the **unified conversation** (Variant A), not the big brain
dashboard. This honors both locked decisions: Variant A *is* chat-first, and the
reconciliation decision already says Drive is the live head of the reader — so on
mobile the history cards and the live composer share one scroll, and the brain
"dashboard" becomes what the header **expands into**, plus a Brain drill-in.

### How each desktop component ports

| Desktop component | Render fn | Mobile home | Mechanism |
|---|---|---|---|
| Project picker (`#sidebar` 240px) | `loadProjects` :376 | **Off-canvas drawer** from app-bar ☰; backdrop to dismiss | reuse list HTML; wrap in a `transform:translateX` drawer below breakpoint |
| Sessions\|Prompts rail (`#sessions` 320px) | `renderSessionList` :1059 | **Bottom sheet / drawer** ("history" affordance) — also the conversation minimap/jump | reuse rows; tap a prompt → reader fills the conversation scroll |
| Brain graph (centerpiece) | `renderCenterpiece` :1700 | **Brain header strip** (collapsed chips) → **expand overlay** (full SVG) | strip = new chrome; overlay mounts the *existing* SVG render unchanged |
| Activity ribbon/timeline | `renderRibbon` :2425 | **Full-screen sheet** off brain header / overflow; horizontally scrollable | wrap in `overflow-x:auto`; reuse ribbon grid |
| Brain history + time-travel | `renderBrainHistory` :1371 | Inside the **Brain** drill-in (tab/section of the expand overlay) | reuse; scrubber needs touch-target sizing |
| Project memory | `renderProjectMemory` :1325 | Section of the Brain drill-in | reuse |
| Reader cards + outcome rail | `renderReaderCard` :3046 / `renderOutcomeRail` :3027 | **The conversation scroll** (full-width cards) | reuse; outcome-rail footers already stack; widen to 100% at breakpoint |
| Drive chat + composer | `renderDriveView` :3566 / `driveRender` :3772 | **The composer + live cards** in the same scroll | reuse; composer pinned bottom, gated slot |
| Modals (lightbox/doc/memo) | `:3122` / `:3229` / `:1023` | unchanged | already responsive |

**Nothing in the table re-implements a renderer.** Every "mechanism" is *reuse +
relocate*. The new code is: the drawer/sheet wrappers, the brain header strip,
the expand overlay, and the nav state machine that decides which L1/L2 surface is
on screen.

---

## The Variant A unified screen (the centerpiece)

This is the prototype made real against live data. The prototype
(`public/proto/mobile-unified.html`) already encodes the visual vocabulary —
copy its structure, swap the mock for the real render paths.

Structure (matches the prototype 1:1):

- **App bar** — ☰ (projects drawer) · project title + sub (`following · …`) ·
  live dot · ⋯ overflow (rail, timeline, share, brain).
- **Brain header strip** (`.brainbar`) — horizontally-scrollable chips, one per
  brain doc / memory. A chip **lights** (`.chip.lit`) when its node is read/edited
  in the live turn. Tap the strip → expand to a ~58% overlay holding the **real**
  brain SVG (`renderCenterpiece` output), then collapse back.
- **Conversation scroll** — the merged read+write timeline: cooled reader cards
  (history) above, live provisional cards that **cool on `result`** (the Option-B
  flow already shipped for the rail — `driveProvisionalRow` :3855,
  `driveCoolProvisional` :3899 — reused here).
- **Composer** — pinned **top** (flipped flow; see the 2026-06-21 flow update above),
  **conditionally rendered** behind the drive
  trust gate (present only when you hold drive rights in your own cwd; absent on a
  shared/public view, degrading to a read-only reader). *Merging surfaces ≠
  merging trust boundaries* (`DRIVE_CONVO_RECONCILIATION.md` constraint 1).

### The signature moment: brain ⇄ chat live link

The prototype's whole pitch is "editing a memory lights up its node in the brain
network." Today this link **does not exist** even on desktop — Drive writes
files, ingest cools them into rail cards, but no event says *"this turn touched
these docs, glow them."* Wiring it is the one net-new feature, and it pays off on
desktop too:

- The runtime already streams `tool_use` events (`agent.js` `handleRawEvent`
  :299) — including `Write`/`Edit` with a file path.
- Filter those for brain-doc paths (`.md` in the doc graph), and drive the
  existing `light(id,'edit')` / born-node animation already implemented in
  `streamUpdateBrain` (:944) — both in the collapsed strip (`.chip.lit`) and the
  expanded SVG.
- This is the live, hot version of what live mode already does cold (poll
  `updatedAt` → ring-fill). Same brain animation layer, fed from the SSE instead
  of the poll.

This is the first place the read↔write merge produces something neither surface
had alone, so it's worth doing in the mobile slice rather than deferring.

---

## Implementation approach (responsive, non-regression-first)

**Principle: desktop CSS/JS paths are untouched above the breakpoint.** All
mobile behavior is gated by a single `@media (max-width: 760px)` block plus a
`body.is-mobile` class set from `matchMedia` (re-evaluated on resize/orientation).
Desktop renders exactly as today.

### CSS layer (`style.css`)

- One `@media (max-width: 760px)` block (760 = the prototype's `max-width`).
- `#app` → single column; `#main` → stack, **one `.pane` visible at a time**
  driven by a `data-screen` attribute (`projects | project | reader | brain |
  timeline`) on `#app`.
- `#sidebar` (240px) → off-canvas drawer (`position:fixed; transform:
  translateX(-100%)`, `.open` slides in, backdrop).
- `#sessions` (320px) → bottom sheet (`transform:translateY(100%)` → `.open`).
- `#conversation` → full width, `padding` from fixed `28px` → `clamp()`.
- Inject the prototype's `.appbar` / `.brainbar` / `.composer` / `.chip` /
  `.tabs`-less Variant-A rules (lift verbatim; tokens already match — confirmed
  `style.css:1-13` == prototype `:9-15`). Add `--live`, `--doc`, `--mem` tokens to
  `:root` (prototype uses them; they're missing from `style.css`).
- Touch targets ≥ 44px; fix known narrow-screen offenders flagged in research:
  `.brain-ticker` `white-space:nowrap` (:791), `.brain-peek` 248px fixed (:836 —
  hover-only, hide on mobile), tall `max-height`s (`.docview` :331, `.pc-prompt`
  :514).
- `viewport-fit=cover` + `env(safe-area-inset-*)` for notch/home-bar padding
  (index.html currently lacks `viewport-fit=cover` — add it).

### JS layer (`app.js`)

- A small `mobile` module: `isMobile()` (matchMedia), a `setScreen(name)` that
  sets `#app[data-screen]`, drawer/sheet open/close, and a `back` stack so the
  hardware/gesture back behaves.
- **Brain header strip**: a mobile-only `renderBrainStrip()` that builds chips
  from the same doc-graph data `renderCenterpiece` uses; an `expandBrain()` that
  mounts the existing SVG into the overlay. Hook chip-lighting into
  `streamUpdateBrain` and the new `tool_use`→brain-node bridge.
- **Composer in the conversation**: reuse `renderDriveView`'s composer + the
  provisional→cooled path; mount it at the foot of the reader scroll instead of in
  a separate `#conversation` mode, behind the existing drive-rights gate
  (`state.driveable`).
- Re-evaluate layout on `matchMedia` change so rotating / resizing a desktop
  window across the breakpoint doesn't strand state.

### Non-regression guardrails

- Desktop above 760px: **no behavioral change.** The mobile block and `is-mobile`
  paths simply don't apply.
- Keep the prototype (`public/proto/mobile-unified.html`) as the visual spec /
  regression reference until the real screen is proven, then retire it (same
  discipline as "delete `drive.html` last" — `DRIVE_CONVO_RECONCILIATION.md`).
- Don't fork render functions; relocate their output via containers. A forked
  renderer is the thing most likely to drift desktop and mobile apart.

---

## Suggested slicing

1. **Responsive shell + nav (no new features).** Breakpoint, `body.is-mobile`,
   drawer for projects, single-pane `data-screen` switching, app bar. The existing
   dashboard/reader/drive render *into* the mobile shell, navigable. Desktop
   untouched. — proves the layer without touching renderers.
2. **Variant A project home.** Brain header strip (collapsed chips) + expand
   overlay mounting the real SVG; conversation scroll as the project home;
   composer pinned (top, flipped flow) + gated. Rail and timeline as sheets.
3. **Brain ⇄ chat live link.** `tool_use`→brain-node glow bridge (the signature
   moment); lights the strip and the expanded graph from the live SSE. Lands on
   desktop too.
4. **Polish pass.** Touch targets, safe-area insets, scroll/keyboard behavior
   (composer above the on-screen keyboard), time-travel scrubber on touch, the
   narrow-screen CSS offenders list.

Slice 1 is the riskiest for desktop regression and the most reusable, so it goes
first and gets the most testing at the breakpoint boundary.

---

## Open questions / seams to resolve in execution

- **Project home = conversation vs. dashboard.** This plan recommends the
  **unified conversation** (Variant A) as L1, with the brain dashboard reached by
  expanding the header / a Brain drill-in. If Mike wants the big brain to be the
  literal landing on project open (dashboard-first, chat one tap down), it's a
  one-line `data-screen` default change — flag for a look once Slice 2 is real.
- **Rail vs. conversation overlap.** Under Option B the prompt rail and the
  conversation scroll are *the same list* rendered twice. On mobile we may not
  need a separate rail sheet at all — the conversation scroll + a jump/minimap
  could replace it. Decide after Slice 1 shows how the scroll feels.
- **Composer + keyboard.** The on-screen keyboard resizing the viewport is the
  classic mobile-chat bug; `dvh` units + `visualViewport` API. Owned by Slice 4
  but prototype-test early.
- **Drive rights on mobile.** Drive is admin/loopback-gated (`agentRoutes.js`
  :17). A phone hitting the hosted URL is *not* loopback — confirm the hosted
  admin-email path is the intended mobile-drive door, or mobile is read-only-drive
  until a per-user key model exists (`ROADMAP.md` open item).
- **No new capture/tokens.** The brain-glow bridge must read `tool_use` events the
  runtime already emits — no extra agent overhead (the project's standing
  "make capture boring" rule).
