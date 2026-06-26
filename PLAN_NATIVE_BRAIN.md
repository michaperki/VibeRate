# PLAN_NATIVE_BRAIN — porting the brain & activity surfaces to native iOS (and what Swift unlocks)

**Legibility pass (2026-06-26):** a first-contact reviewer found the rings "the best
visual element and the least legible". Shipped on `BrainView`: the bare ring number gets a
`%` unit, the plans header carries a *"ring = % of checklist done"* legend, and node labels
now drop `.md` + the redundant `PLAN_` prefix and de-snake to spaced words so they wrap
cleanly instead of hyphenating mid-word (`BrainDoc.displayLabel`). Doc-reader blockquote
contrast was bumped too. See `UI_FEEDBACK.md` §"2026-06-26 — native iOS first-contact pass".

**Status:** **Phase 1 + the brain⇄chat live link (B8) shipped** (2026-06-25, client-only —
backend already served it). The native app can now **show the brain** (doc graph at rest,
plan completion rings, tap-to-open reader, long-press peek, haptics) **and make it move**:
a `tool_use` on a brain doc glows that node and fires a haptic, live from the Drive SSE.
The real drag force-sim (Phase 3), activity ribbon/time-travel (Phase 4), and the
Dynamic-Island card (Phase 5) are the next batches. This is the sibling of
`PLAN_NATIVE_PARITY.md`. That plan closed the *agent-control* gap (stop/queue/scroll/
tool-collapse) and is largely shipped. **It deliberately never covered the brain or the
activity surfaces** — and those are exactly what the mobile-web build invested in, and
exactly what VibeRate *is*: "manage your project's **brain** as the control surface"
(`PROJECT_VIEW_PLAN.md`, `PRODUCT_STRATEGY.md`). So the native app today can drive an
agent but **cannot show you the brain it's steering through.** This doc charts the
mobile-web brain/activity development arc, inventories every interaction it shipped,
maps each to native, and adds the gestures Swift unlocks (drag, long-press/peek,
haptics, pinch-zoom, context menus) that a WKWebView never had.

Grounded in: the web app (`public/app.js`), the native app (`app-ios/Sources/**`), the
backend (`src/server.js` routes), and the history (`PROJECT_VIEW_PLAN.md`,
`PLAN_MOBILE.md`, `PLAN_COCKPIT.md`, git log).

---

## ✅ Implementation log (2026-06-25) — Phase 1 core

Shipped in one batch (client-only, **no backend changes** — `/api/projects/:slug/docs`
already served it). New files: `app-ios/Sources/Views/BrainView.swift`,
`Views/DocView.swift`, `Core/Haptics.swift`; edits to `Models.swift`, `APIClient.swift`,
`Core/NavRouter.swift`, `Views/ProjectsView.swift`, `Views/CockpitView.swift`. XcodeGen
globs `Sources/`, so the new files build with no project-file edit.

- **`BrainDoc` model + client-side graph math (B1/B3).** `BrainDoc` decodes the `docs`
  array and computes, exactly mirroring the web: `completion` (the `^[ \t>*+-]*\[([ xX])\]`
  checkbox ratio = `completionOf`), `role` (`docRole` — constitution / reference / memory),
  `isPlan`, `summaryLine`, `peekText`. `APIClient.docs(slug:)` fetches them.
- **Brain screen — "nodes at rest" (B1/B2/B3).** `BrainView` renders the **working set**:
  the constitution **anchor** on top, a **plan shelf** of nodes each carrying a `CompletionRing`
  (amber→green — the keeper signal), and the quiet reference docs behind a `+N docs` spring
  toggle. A calm structured layout, no ambient motion — the 2026-06-24 rethink, not the old
  orbital field. Reached from a **`brain` toolbar button** on the cockpit, via a `BrainRoute`
  registered at the stack root.
- **Doc reader (B11/B13/B14).** `DocView` reuses the chat's `MarkdownView` (one renderer,
  both surfaces) with a plan completion-ring header + a render↔raw toggle; pushed as a
  `DocRoute` carrying the already-fetched `BrainDoc` (no re-fetch); native sheet/back dismiss.
- **Native unlocks (§3).** Tap a node → open (with a **haptic** tick, `Haptics`); **long-press
  → peek** via `contextMenu(preview:)` showing the doc's ring + first lines + Open — the touch
  home for the desktop hover-peek (B6) that can't exist on a phone.

**Next batches (deferred):** Phase 3 real `Canvas`/`TimelineView` force-sim with
**drag-to-fling** + pinch/pan; Phase 4 activity ribbon + time-travel; Phase 5 Live
Activity / Dynamic Island. Matrix below marks each.

## ✅ Implementation log (2026-06-25) — B8, the brain⇄chat live link

The "editing a memory lights up its node" moment (the web's `brainTouch`), native and
**decoupled across two screens**. New file `app-ios/Sources/Core/BrainActivity.swift`;
edits to `DriveSessionView.swift` and `BrainView.swift`. No backend changes — reads the
`tool_use` events the SSE already delivers (no new agent tokens).

- **`BrainActivity` — one observable bridge.** A `@MainActor @Observable` singleton records
  recent doc touches per project (basename → verb + timestamp), with `glow(…)/verb(…)/
  isActive(…)` decaying linearly over a 4s window. The chat *writes* touches; the brain
  *reads* the glow — no event plumbing between the two screens.
- **Chat side (`DriveSessionView`).** The `tool_use` ingest classifies the tool
  (`verb(forTool:)` → read/edit/run) and calls `BrainActivity.touch(slug:file:verb:)` for
  any `.md` path — which fires a **haptic** (sharper for an edit, soft for read/run). A new
  **brain toolbar button** pops to `BrainView`, with a **green pulse** while the agent is
  touching docs this turn. *Gated on the event's own `t` (≤30s old)* so the backfill replay
  on open/reconnect doesn't buzz and glow the whole graph — only genuinely live touches do.
- **Brain side (`BrainView`/`BrainNodeView`).** Each node renders a verb-tinted halo
  (read = blue, edit = warm, run = green) that fades as the touch decays; a 0.3s tick drives
  a smooth fade. Pop over mid-turn and you watch the agent work the brain in real time.

---

## 0. The one-paragraph finding

**The native app has zero brain and zero activity visualization.** Its only views are
`ProjectsView` → `CockpitView` (a live roster + a past-conversations list) →
`DriveSessionView` (the chat). There is **no brain graph, no doc/markdown lightbox, no
plan completion rings, no activity timeline/ribbon, no time-travel scrubber, no project
memory, and no brain⇄chat live link** — the only trace of the brain is a one-word
**plan chip** (`Label(plan, …)`, `CockpitView.swift:365`) and a context meter in a
roster row. Meanwhile **the backend already serves all of it**: `/api/projects/:slug`,
`/activity`, `/ticker`, `/git`, `/memory`, `/docs`, `/dochistory` (`src/server.js:416–466`).
So, like the parity work, this is a **client gap, not an R&D project** — but a *bigger*
one than parity, because the web shipped these as relocated HTML/SVG and native must
**re-render them in SwiftUI/Canvas**. The upside (the user's instinct): rebuilding
natively is the chance to make the brain *feel* native — real drag, long-press peek,
haptics, pinch-zoom, ProMotion physics — instead of a force-sim trapped in a webview.

---

## 1. The mobile-web brain/activity arc (what we built, in order)

A retrospective of how the brain became a product surface, so the native rebuild
inherits the *reasoning*, not just the pixels:

1. **Read-only viewer era** (`PROJECT_VIEW_PLAN.md` §Done). The brain shipped first as a
   force-sim SVG graph: hover-peek (heading + first line), Web/Tree/Recent layouts,
   recency-modulated breathing halo, role clustering. Verdict at the time: **Tree reads
   as most legible** (kept as a guardrail).
2. **Plan-completion rings** (`PROJECT_VIEW_PLAN.md` "Experiment — completion %"). A
   checkbox-ratio parser put an **amber→green arc ring** on plan nodes. Mike's standing
   note: *"plans with a completion ring read as strong; keep that."* The keeper signal.
3. **Lifecycle & time-travel** (§B). git `--name-status` capture unlocked born/ghost
   nodes; a **🕰 time-travel scrubber** renders the brain *as of* any commit with a real
   LCS diff panel; finished docs (100%) **auto-retire to a graveyard**.
4. **Live streaming** (`vbrt watch`). The dashboard stopped being a snapshot — nodes
   fade in/out, rings fill, the ribbon pulses, all animated in place from a poll.
5. **The mobile port** (`PLAN_MOBILE.md`, Slices 1–3). The three desktop columns
   collapsed into a nav stack; the brain became a **`.brainbar` header strip** (a chip
   per doc) that **expands into the real SVG** overlay; the **doc lightbox** got a
   checklist↔markdown toggle.
6. **The signature moment — brain⇄chat live link** (Slice 3). A Drive `tool_use` event
   **glows the touched doc's chip + node** (`brainTouch()`, `app.js:6576`). This is the
   one feature neither read nor write had alone: *editing a memory lights up its node.*
7. **The brain rethink — "nodes at rest"** (`PROJECT_VIEW_PLAN.md`, shipped 2026-06-24).
   The biggest design correction. Killed the ambient orbital spin and the
   everything-orbits-CLAUDE.md hub. At rest the brain shows **only the working set** (the
   constitution anchor + plans-with-rings); the other ~18 docs are a **`+N docs`** count
   that expands onto a dim rim. Motion happens **only on a real event**: a touched file is
   *summoned* near its active plan, flares, links, then **decays and fades**. Idle reads
   as *quiet*. **This is the model native must rebuild — not the old orbital field.**

Then the native rewrite (`PLAN_NATIVE_REWRITE.md`) started from the *chat*, and the
parity backlog (`PLAN_NATIVE_PARITY.md`) deliberately scoped only chat control. The
brain came along **only as the roster's plan chip.** That is the gap this doc fills.

---

## 2. Feature inventory — web brain/activity vs native iOS

Status: ✅ full · ◑ partial · ❌ absent. Priority: **P0** brain is the thesis / first
thing missing · **P1** important · **P2** nice-to-have. Every native cell below is ❌ or
◑ — this whole table is greenfield on iOS.

| # | Feature | Web gesture | Web code | iOS today | Native approach (Swift) | Pri |
|---|---|---|---|---|---|---|
| **Brain graph** |
| B1 | **Brain node graph at rest** (anchor + plan shelf, "nodes at rest" model) | renders on open | `renderCenterpiece` `app.js:1700`; `liveBrain` step/draw | ✅ structured layout (`BrainView`); force-sim Phase 3 | laid-out nodes (at rest = fixed homes, no per-frame field); `Canvas` force-sim later | **P0** |
| B2 | **Tap node → open doc** | tap | `onPick` `:5910` → `openDocLightbox` | ✅ tap → `DocRoute` → `DocView` (+haptic) | — | **P0** |
| B3 | **Plan completion rings** (amber→green arc) | passive | ring SVG in centerpiece | ✅ `CompletionRing` (trim'd `Circle`) | — | **P0** |
| B4 | **`+N docs` toggle** (expand quiet docs to rim) | tap | `refs.showall.onclick` `:5932` | ✅ spring toggle in `BrainView` | — | **P1** |
| B5 | **Layout switch** Web/Tree/Recent | tap toggle | `setLayout` `:2586` | ❌ | segmented control; Tree is the legibility keeper | **P2** |
| B6 | **Hover-peek** (heading + first line) | hover (desktop only) | `wireBrainPeek` `:2549` | ✅ **long-press peek** via `contextMenu(preview:)` | the touch home for hover (§3) | **P1** |
| B7 | **Pin/unpin node label** | tap again | `selectedId` `:5917` | ❌ | tap toggle / part of selection state | **P2** |
| **Live link** |
| B8 | **Brain⇄chat live glow** (tool_use → node/chip flares) | passive (live) | `brainTouch` `:6576`, Slice 3 | ✅ `BrainActivity` bridge — node halo + chat pulse + haptic | replay-gated on event `t` | **P0** |
| B9 | **Read/edit/run reactions** (pulse / ring flare / ripple) | passive | `liveBrain` touch verbs `:5654` | ✅ verb-tinted halo (read/edit/run) + verb-keyed haptic | distinct per-verb *animations* still flat | **P1** |
| B10 | **Plan checkbox tick → ring fills live** | passive | `planPulse` `:5665` | ❌ (ring updates on next brain load) | animate the B3 ring on a `Plan` tool event / doc re-fetch | **P1** |
| **Doc lightbox** |
| B11 | **Doc viewer** (full markdown) | open from node/chip | `openDocLightbox` `:3951` | ✅ `DocView` reuses `MarkdownView` | — | **P0** |
| B12 | **Checklist render + progress ring + bar** | passive | `docLightboxHtml` `:3928` | ◑ ring header ✅; checklist still markdown bullets | native checklist list (toggle states) | **P1** |
| B13 | **Checklist ↔ raw markdown toggle** | tap | `[data-dl-expand]` `:3962` | ✅ render↔raw toggle in `DocView` | — | **P2** |
| B14 | **Close** (✕ / backdrop / Esc) | tap/key | `closeDocLightbox` `:3977` | ✅ native nav back / swipe | — | **P0** |
| **Activity / timeline** |
| B15 | **Activity ribbon** (commit / brain / code / convo lanes) | scroll | `renderRibbon` `:2425` | ❌ | `Canvas` lanes or a `ScrollView` of marks; `/activity`, `/git` | **P2** |
| B16 | **Click ribbon mark → detail popover** | tap | `[data-commit/brain/code]` `:3156` | ❌ | tap → popover/sheet | **P2** |
| B17 | **Drag-to-filter time range** | drag-brush | brush listeners `:3189` | ❌ | **→ native drag** (§3) | **P2** |
| B18 | **Time-travel scrubber** (brain as-of commit + diff) | drag slider / play | `wireTimeTravel` `:2660` | ❌ | `Slider` + step buttons; `/dochistory` | **P2** |
| B19 | **Ghost / born nodes** in time-travel | passive | lifecycle in centerpiece | ❌ | node enter/exit transitions | **P2** |
| **Memory** |
| B20 | **Project memory list + memo modal** | tap row | `renderProjectMemory` `:1325` | ❌ | `List` + sheet; `/api/projects/:slug/memory` | **P2** |

**The P0 cluster is the minimum that makes native "show the brain":** a node graph at
rest (B1) with plan rings (B3), tap-to-open-doc (B2) into a doc viewer (B11/B14), and the
live glow (B8). Everything else layers on.

---

## 3. What Swift unlocks — the net-new native interactions (the user's ask)

The mobile-web brain was a force-sim in a WKWebView: hover didn't exist on touch, drag
fought the page scroll, there was no haptic vocabulary, and pinch-zoom was the browser's,
not ours. Native is the chance to make the brain a **first-class touch object.** These
are *additions* to the port above, not replacements:

- **Long-press → peek (replaces hover-peek B6).** A press-and-hold on a node previews its
  doc — heading + first line, or a full `contextMenu`/`.contextMenu(preview:)` card with
  actions ("Open", "Tell the agent to update this", "Time-travel this doc"). This is the
  natural touch home for the desktop hover-peek that simply *cannot* exist on a phone.
- **Drag to rearrange / fling nodes.** With a real force-sim (`Canvas`+`TimelineView`),
  a `DragGesture` lets you grab a node, fling it, and watch it settle — the "nodes at
  rest" physics becomes *interactive*. Drag the time-travel scrubber and the ribbon brush
  (B17/B18) become real native drags instead of brittle web brush handlers.
- **Haptics as the live-activity channel.** The brain⇄chat live link (B8) gains a
  *physical* signal: a soft `UIImpactFeedbackGenerator` tick when the agent touches a
  brain doc, a sharper one when it **edits** one, a success notification when a plan ring
  **completes**. You feel the agent working the brain without watching the screen.
- **Pinch-to-zoom + pan the graph.** `MagnificationGesture` + `DragGesture` on the canvas
  — zoom into a dense cluster, pan around a 30–40-doc repo (the crowding problem
  `PROJECT_VIEW_PLAN.md` flagged for real repos). Free natively, painful in a webview.
- **Swipe & context menus on doc/memory rows.** Swipe a doc row → "open / time-travel /
  ask agent to revise"; `contextMenu` on a node → quick actions. (The roster already
  proved swipe-to-end, `CockpitView` — same vocabulary.)
- **Spring/ProMotion animation.** `withAnimation(.spring)` + `matchedGeometryEffect` make
  the chip-strip → full-graph expand, node summon/decay, and ring fill feel native at
  120Hz — the "summoned-then-decay" choreography the rethink described, done in real
  physics instead of CSS transitions.
- **Live Activity / Dynamic Island (stretch, P2).** "Agent is cooking" — current plan +
  context fill + last-touched doc on the lock screen / island, fed by the same roster SSE.
  A capability the web literally cannot have. (Pairs with push, `PLAN_NATIVE_PARITY.md` #12.)

> Design rule carried from the web: **motion must mean activity** (the anti-ambient-spin
> principle, `PROJECT_VIEW_PLAN.md`). Drag/pinch are user-initiated, so they're fine;
> but don't reintroduce idle drift. At rest the native brain is *still*, like the web's.

---

## 4. Prioritized roadmap

Sequenced so each phase is independently shippable and on-device verifiable. Native loop
is slow (~10–15 min Codemagic build, `PLAN_NATIVE_REWRITE.md`) — **batch per build.**

### Phase 1 — the brain exists on the phone — **P0** ◑ MOSTLY SHIPPED 2026-06-25
1. ✅ **`DocView`** (B11/B13/B14): tap-to-open markdown doc via `/docs`, reusing
   `MarkdownView`, with a completion-ring header + render↔raw toggle; native back/swipe
   dismiss. (B12 full checklist-with-toggle-states still a markdown bullet list — P1.)
2. ✅ **Brain graph at rest** (B1/B2/B3/B4/B6): `BrainView` — anchor + plan shelf as
   laid-out nodes with completion rings, `+N docs` toggle, tap → `DocView` (haptic),
   long-press → peek. Structured/static; the real force-sim is Phase 3.
3. ✅ **Brain⇄chat live glow + haptic** (B8/B9): the SSE `tool_use` file path drives a
   verb-tinted node halo on `BrainView` + a haptic + a chat-toolbar pulse, via the
   `BrainActivity` bridge; replay-gated on the event timestamp. (B10 live ring-fill still
   waits on the next brain load — next batch.)
*Outcome: the native app now shows the brain it's steering through **and makes it move** —
the thesis, live, on the phone. Not just a chat.*

### Phase 2 — make it native to the touch — **P1**
4. **Long-press peek + `contextMenu`** (B6 → §3): node press preview + quick actions.
5. **Per-verb live reactions + ring-fills-live** (B9/B10): read/edit/run animations,
   plan tick fills the ring with a success haptic.
6. **`+N docs` expand** (B4) + **pinch/pan** the graph (§3) for dense repos.
7. **Project memory** (B20): list + memo sheet.

### Phase 3 — the brain feels alive — **P1/P2**
8. **Real force-sim** (`Canvas`+`TimelineView`) with **drag-to-fling** + spring settle
   (§3) — the "summoned-then-decay" choreography in real physics.
9. **Layout toggle** Web/Tree/Recent (B5; lead with Tree, the legibility keeper).

### Phase 4 — activity & history — **P2**
10. **Activity ribbon** + tap-mark detail (B15/B16); **drag-to-filter** (B17).
11. **Time-travel scrubber** + ghost/born nodes (B18/B19) via `/dochistory`.

### Phase 5 — beyond-web capabilities — **P2 / stretch**
12. **Live Activity / Dynamic Island** "agent cooking" card (§3) — no web equivalent.

---

## 5. Don't-regress invariants (carried from the brain's history)

- **"Nodes at rest" is the model, not the old orbital field.** At rest = anchor + plans
  only; ~18 docs behind `+N`; motion only on a real event; idle is *quiet*
  (`PROJECT_VIEW_PLAN.md`, 2026-06-24). Do not port the deleted ambient spin.
- **Plan completion rings stay** — Mike's explicit keeper signal.
- **Tree is the most legible layout** — keep it; lead with it if shipping one.
- **Motion must mean activity** — user-initiated gestures (drag/pinch) are fine; no idle
  drift, no motion-for-motion's-sake.
- **No new agent tokens for capture** — the live glow reads `tool_use` events the runtime
  already emits and the SSE already delivers; no extra agent overhead.
- **Completion % is non-monotonic** — don't headline a single bar to 100% as project
  status; discovery prompts push it *down* legitimately (`PROJECT_VIEW_PLAN.md`).
- **Backend is ready** — `/docs`, `/dochistory`, `/git`, `/activity`, `/memory`,
  `/ticker` all exist (`src/server.js:424–466`); this is client-only, like parity.

---

*Linked from the `CLAUDE.md` index. Sibling of `PLAN_NATIVE_PARITY.md` (chat control,
shipped) — this is the **brain & activity** half of native parity, still to build.
Canonical native intent remains `PLAN_NATIVE_REWRITE.md`; the brain design canon remains
`PROJECT_VIEW_PLAN.md` + `PLAN_MOBILE.md`.*
