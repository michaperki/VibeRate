# UI Feedback — external review synthesis (2026-06-22)

Two independent reviewers walked the live app (landing → workspace → project
dashboard → brain → drive → reader) and wrote up first-contact feedback. This doc
**synthesizes both**, weights it by where they *agreed*, adds my own judgement on
what's worth doing, and turns each accepted item into a **prescriptive fix** with the
exact function / CSS to touch. Issues only one reviewer raised — or that conflict with
a settled product decision — are kept, but demoted and labelled.

Companion to `PROJECT_VIEW_PLAN.md` §G (the earlier 2026-06 legibility pass — same
genre, narrower scope) and `PLAN_MOBILE.md` (the responsive port these fixes must land
inside). Frame is `PRODUCT_STRATEGY.md`.

> **Both reviewers' headline is the same:** the visual identity is strong and this now
> reads as a real product. The remaining problem is **not design quality — it's
> information hierarchy and first-time comprehension.** Every P0/P1 below is a
> hierarchy/legibility fix, not a restyle.

## How to read the priority order

The signal I trust most is **agreement** — where two strangers independently flagged
the same thing, it's real. On top of that I weight against our own thesis: the app is
**mobile-first** (`PRODUCT_STRATEGY.md`), so a defect that's worse on a phone than on
desktop jumps the queue. Several "low contrast / clipped / hover-only" notes are
exactly that class of bug — they're invisible on desktop-with-a-mouse (where the
reviewers' worst complaints came *anyway*) and total failures on the primary surface.

- **P0** — both reviewers + breaks the mobile-first promise. Do first.
- **P1** — both reviewers, or one reviewer + a real safety/clarity stake.
- **P2** — agreed polish; cheap, do in a sweep.
- **P3** — single-reviewer, copy, or a strategy call that isn't mine to make.

---

## P0 — consensus + mobile-thesis-breaking

### 1. Brain-graph labels are unreadable (collision + low contrast)
**Both** (R1 #2 "labels collide, unreadable at phone width"; R2 #6 "too dark/low
contrast, hard to read on mobile"). This is the strongest consensus item and it
directly undercuts the product's core claim — "the brain is the control surface."

**Root cause (two code paths, two distinct bugs):**
- **Legacy SVG layouts** (Web/Tree/Recent — `renderCenterpiece` → SVG at
  `app.js:1811`): labels use `.glabel`, which is `opacity: 0` and only revealed on
  `:hover` / `.on` (`style.css:778,780`). **There is no hover on a phone**, so on the
  primary surface every label is invisible unless the node is selected. This is the
  collision/unreadable complaint's real source.
- **Live brain** (the default centerpiece — `liveBrain.draw()` `app.js:4708`): labels
  *are* always drawn, but opacity is `0.35 + 0.65·…` (`app.js:4743`). An idle non-core
  node lands at **~0.42 opacity** of a mid-dark fill (e.g. `#5aa9e6`), which is the
  "too dark" complaint. Core docs (CLAUDE.md…) compute to ~0.74 and read fine — which
  is exactly R2's "keep CLAUDE.md prominent, fade the rest less aggressively."

**Prescriptive fix:**
1. Raise the label floor in `liveBrain.draw()` (`app.js:4743`): change the constant
   from `0.35` to ~`0.55` so idle non-core labels clear ~0.6 opacity; keep the heat/core
   boost so active and core nodes still pop. One-line change, biggest single win.
2. Make labels **tap-revealable on mobile** for the legacy path: today `.on` is set on
   select. Ensure a node tap toggles `.on` (it already does for the lightbox) and that
   `body.is-mobile .glabel` has a non-zero floor (e.g. `opacity: 0.55`) instead of `0`,
   so labels aren't hover-gated on a touch device (`style.css:778`). Add
   `body.is-mobile .gnode.on .glabel { opacity: 1 }` for the tapped node.
3. **Collision** (R1's specific note — STORY.md over PRODUCT_STRATEGY.md): the live
   force-sim already separates *dots* but not *label boxes*. Cheapest acceptable fix is
   to **only render labels for core + heated nodes by default** and reveal the rest on
   tap — R2 listed this as an option and it sidesteps collision entirely. A true
   collision-aware label layout is more work; defer it unless tap-to-reveal tests badly.

**Don't:** invent a third brain renderer. Both paths share the doc-graph data; fix them
in place (the standing `PLAN_MOBILE.md` rule — relocate/adjust, never fork a renderer).

### 2. Workspace home is empty — surface recent projects on the page
**Both** (R1 #4 "stats at top, bottom ~60% empty — surface recent projects or live
activity"; R2 #3 "should show top 3 recent projects immediately, before opening the
drawer"). Near-identical suggestion.

**Root cause:** `renderWorkspaceSection(ws)` (`app.js:5016`) prints only the
`.ov-line1` stat line; the actual project list lives **only** in the `#sidebar` drawer
via `loadProjects()` (`app.js:391`). On mobile the drawer is off-canvas, so the home
screen is a stat line over a blank page — the useful content is one hamburger tap away.

**Prescriptive fix:** under the stat line in `renderWorkspaceSection`, render a **Recent
projects** list — the top 3–5 by `updatedAt`, each row = name · `pathTail(cwd)` ·
`plural(sessions, 'session')` · `fmtAgo(updatedAt)`, tapping into `selectProject`. The
data is already loaded (same array `loadProjects` maps); this is a second, condensed
render of it on the home pane, not a new fetch. Keep the full list in the drawer.
Matches R2's exact mock (viberate 74 sessions · active 9h ago, …).

### 3. Nav rows clip / read as broken
**Both** (R1 #1 "right edge cuts off mid-word — 'expa al', 'brain ▾' crowding — add a
fade/scroll cue"; R2 #11 "'expand all' is cut off; that row needs horizontal scrolling
or fewer buttons").

**Root cause:** the reader's `.nav` row (back · Follow · prev · counter · next · final ·
expand all · collapse all) inside `.conv-toolbar` has **no overflow handling** — it
wraps or clips at phone width. The mobile brain strip `.m-chips` already does this right
(`overflow-x:auto` + hidden scrollbar, `style.css:1378`); the reader nav never got the
same treatment.

**Prescriptive fix:**
1. Give the reader `.nav` row `overflow-x: auto; flex-wrap: nowrap` under
   `body.is-mobile`, mirroring `.m-chips`, with a right-edge **fade mask** (a
   `mask-image` linear-gradient) so the scroll reads as intentional (R1's explicit ask).
2. Better still, **reduce the button count** (R2): collapse `expand all` / `collapse
   all` into one toggle, and fold `final` into the counter affordance. Fewer controls is
   the more durable fix than scrolling a crowded row.

---

## P1 — consensus or single-reviewer + real stakes

### 4. Driving status row is overloaded — split primary vs advanced
**Both** (R2 #9 spells it out: `idle · bypass · 189k · 95% · viberate claude: 46ce40bf`
is "useful for power users, scary for new users"; R1 #3 overlaps via "one percentage,
several meanings"). 

**Root cause:** `renderDriveView` (`app.js:3717`) packs every pill into one toolbar:
`#dv-pill` (status), `.dv-mode`/`.danger` (permission), `#dv-ctx` (tokens + %),
`#dv-cid` (session id).

**Prescriptive fix:** keep a **primary** line — status · agent · context% — and tuck
**advanced** detail — `bypassPermissions` (full label), exact token count, session id —
behind a tap (a `⋯` or a tap on the row that expands the detail). R2's split is right:
primary `idle · Claude · 95% context`; advanced `bypassPermissions · 189k tokens ·
46ce40bf`. The session id especially is operator-debug noise for a first-timer.

### 5. One percentage, several meanings — give context-full its own alarming treatment
**R1 #3** (R2 #9 touches it). 60% tasks-done, 95% context-full, and 47%/12% context all
share ring/bar treatments but mean opposite things — a full context bar is *bad*, a full
completion ring is *good*.

**Root cause:** the completion ring uses `pctColor()` amber→green (`liveBrain.draw`
`app.js:4737`), and the context gauge *also* goes amber when hot (`contextGauge()`
`app.js:2923`, `.ctx-gauge.hot { #f0a93b }` `style.css`). Two different meanings, one
amber language. A near-full context (the "dumb zone," `PRODUCT_STRATEGY.md`) deserves to
look *alarming*, not "almost done."

**Prescriptive fix:** make context-fullness diverge from completion as it climbs:
healthy completion stays the green ring; context ≥75% goes amber and ≥90% goes **red**
(`--live` / `#f85149`) with a `⚠`, distinct shape (a *draining* bar, not a filling
ring). This also sets up the "compact / branch / start fresh" affordance that's a
now-priority in `ROADMAP.md` (Context management as a feature) — the alarm is the entry
point to that action.

### 6. bypassPermissions needs a real safety gate
**R2 #10** only — but I'm *raising* it, not demoting it, because it aligns with our own
stated risk: **"Driving is an RCE control plane"** (`PRODUCT_STRATEGY.md`). A purple,
inviting **Start session** button next to a one-line amber warning is too easy to fly
past for a mode that runs arbitrary shell with no approval.

**Root cause:** `renderDrivePrompt` (`app.js:3648`) shows the warning as `.dv-warn`
text (`#dv-permwarn`, copy at `app.js:3680`) while `#dv-start` stays the standard accent
button regardless of mode.

**Prescriptive fix:** when mode is `bypassPermissions`, (a) expand the warning to name
the concrete capability — "The agent can run shell commands, edit files, and push to
this repo **without asking**." — and (b) gate `#dv-start` behind an explicit checkbox
("I understand this agent can modify this repo") that enables the button. Consider
de-emphasizing the Start button's fill in this mode so the checkbox is the deliberate
act. Note R1's adjacent observation: the live-red **Return to Drive** and the red
`bypass` **danger** pill share a red — keep *danger* red exclusive to permission/RCE so
the safety signal isn't diluted (see #11).

---

## P2 — agreed polish (do in one sweep)

### 7. Project cards: de-clutter + format big numbers
**Both** (R1 polish: "repeats a publish button under every item — noise; only viberate
shows a timestamp — inconsistent"; R2 #4: "too many separate small elements; simplify").

- **De-clutter:** `loadProjects()` (`app.js:391`) renders name · path · sessions · vis
  badge · publish button per card. Collapse to R2's shape: title on line 1; `path ·
  N sessions · Xago` on line 2; `[private] [publish]` as a single quiet action row.
  Make `fmtAgo` show for **every** project (R1's inconsistency — it's currently gated on
  the name-collision `disambig` branch), not just disambiguated ones.
- **Thousands separators:** R1 #4 — `+122,345 / −30,760` parses far faster than the raw
  run. Today line diffs render raw (`+${s.added}` / `−${s.removed}`, `app.js:~5018,2435`)
  and stat counts are raw integers in `.ov-line1`. Add one helper
  (`const fmtN = (n) => n.toLocaleString()`) and apply it to the diff totals and the big
  project/session/commit/message counts. (`fmtTokens` already does k-notation for
  tokens; keep that for the dense token pills, separators for the human-readable totals.)

### 8. Define "brain" once, near first use
**R2 #2** — "brain" appears everywhere (live brain, brain edits, brain history, project
brain) and risks reading as internal jargon to a newcomer. Cheap, high-clarity.

**Prescriptive fix:** add a one-liner at first use on the project dashboard near the
live-brain card — *"Brain = the markdown docs, plans, and memory that steer the agent."*
We already ship `jargon` tooltips on 🧠 brain edits / context-% (`ROADMAP.md` legibility
pass); extend that same `jargon`/`title` mechanism to the live-brain card header rather
than inventing new UI. Also rename the bare metric "brain edits" → **"brain-doc edits"**
(R2's copy note) for self-evidence.

### 9. Reader header: compact-on-scroll
**R2 #11** (R1 touches via the clipped reader nav, #3 above). The reader's
`.conv-toolbar` (title + meta + tool-count chips + full nav row) is **sticky at full
height** with no compaction (`style.css` `.conv-toolbar { position: sticky }`), eating
vertical space on a phone.

**Prescriptive fix:** after a scroll threshold, collapse to a compact sticky bar —
`CLAUDE · 31 edits · 12 cmds   prev/next` — hiding the date range and secondary nav.
Pairs naturally with the #3 nav-row reduction; do them together.

---

## P3 — single reviewer, copy, or not-my-call

### 10. Prompt/session cards too tall (R2 #7 only)
R2 wants 4–5 prompt cards per screen vs ~2.5 today, compressing the collapsed card to a
one-line summary + outcome chips, expanding on tap. Reasonable, but **single-reviewer**
and the cards carry deliberately-rich outcome chips (a shipped feature, `ROADMAP.md`).
Worth a compact/expanded toggle for `renderReaderCard` (`app.js:3072`) — `.pc-prompt`
`max-height:280px` is already a clamp — but it's polish, not a first-contact blocker.

### 11. "Return to Drive" — naming + red collision (both, minor)
R2 #8: "Drive" is overloaded (page? mode? metaphor?) — suggests "Back to driving" /
"Return to agent." R1: the button's red collides with the `bypass` danger pill.
Reality check on R1: the button is **purple** normally (`var(--accent)`) and only red in
the **resume/live** state (`.pb-drive.resume { #f85149 }`, `app.js:1140`) — that red is
our *live* convention, not an error. But the deeper point stands: **live-red and
danger-red are the same red** doing two jobs. My call: keep the *naming* ("Return to
Drive" is fine and on-brand), but resolve the red overlap from the safety side (#6) —
reserve danger-red for permission/RCE, and consider shifting the live accent. Low effort,
low urgency.

### 12. Landing copy: concreteness + hero emphasis (both, partial)
R2 #1/#5 wants the hero sub-copy to lead with the concrete mechanic ("Start a real
Claude Code session in your repo, from your phone. Pick context files, send prompts,
review changes, push — without opening your laptop") and *then* introduce "brain"; R1
notes the hero body mixes gray/white-bold/gray so the bold middle competes with the
headline. Both are right and cheap — `landing.html:269` (`.lede`) — lead with the
mechanic, demote "brain" to a second sentence, pick one emphasized line. Also R1 #5: the
nav wraps awkwardly at mobile ("How it works" / "The loop" break while "Sign in" is an
oversized box, `landing.html:255`) — collapse to a hamburger or drop the two anchor
links below the breakpoint. Worth doing, but the **in-app** P0/P1s are the product; the
landing page is the smaller lever.

### 13. "IDE" vs "control room" — a strategy call, flag don't fix
R2 argues "Mobile, agent-first IDE" mis-sells ("IDE implies code editing"; suggests
"Mobile control room for coding agents"). The critique has merit — but **"mobile,
agent-first IDE" is a settled framing**, used verbatim across `CLAUDE.md`,
`PRODUCT_STRATEGY.md`, and `ROADMAP.md`. This is a positioning decision for Mike, not a
UI bug to fix unilaterally. Logged here as a genuine tension worth a deliberate look,
not an action item. (R2's smaller copy tweaks — "The code is no longer the only control
surface" over "The control surface isn't the source anymore" — are fine to take if the
landing gets a copy pass under #12.)

---

## What I'm explicitly *not* taking

- **R1: graph legend & arrow touch targets ~44px** — valid in principle, but the legend
  work largely shipped (`ROADMAP.md` legibility pass) and touch-target sizing is already
  owned by `PLAN_MOBILE.md` Slice 4 (polish). Folded there, not duplicated here.
- **R2: per-card "publish" everywhere is fine** — covered by #7; no separate item.
- Nothing here proposes new capture or agent tokens — every fix reads data the UI
  already has (the standing "make capture boring" rule, `ROADMAP.md`).

## Suggested execution order

1. **P0 sweep** (#1 label opacity floor + tap-reveal, #2 recent-projects on home, #3
   nav overflow) — three small, independent changes that kill the worst first-contact
   failures and all land inside the `PLAN_MOBILE.md` work.
2. **P1 hierarchy** (#4 status split, #5 context-vs-completion divergence, #6 bypass
   gate) — the "scary for new users / unsafe for everyone" cluster.
3. **P2 polish pass** (#7 cards, #8 brain definition, #9 compact reader header) in one
   commit.
4. **P3** as copy/strategy bandwidth allows; #13 needs Mike.
