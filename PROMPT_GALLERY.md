# Prompt Gallery — a research pass over Mike's real prompts

> Status: **research** (not a spec). Input to the "prompt unit" thinking before we
> build social/feedback. Goal: see the *variety* of substantive prompts Mike has
> actually written to Claude Code / Codex, then reason about **what artifact would
> make each one's outcome legible** — the thing a reader (or future Mike) needs to
> see to judge "was this a good prompt, and did it land?"

## How this was gathered

Extracted every user message from **all** local logs — `~/.claude/projects/*/*.jsonl`
(Claude Code) and `~/.codex/sessions/**/*.jsonl` (Codex) — then dropped pure acks
("continue", "go ahead"), banal openers ("read SEED.md and implement"), and harness
noise (command wrappers, system reminders, tool results).

- **4,879** raw user messages → **3,688** substantive candidates
- **~61** repos represented; **codex 3,247 / claude 441** (Mike runs Codex far more)
- Cross-referenced with Mike's own prior experiment, `dev/research/agent_action_bpe/`
  ("BPE for agent behavior" — tokenizing action sequences), which indexes 419 sessions.

The banal majority really is banal. But sieving for conceptual density, design framing,
pasted evidence, and self-correction surfaced a clear set of **archetypes**. The
finding that matters: *different archetypes demand different artifacts.* A one-size
"before/after screenshot" rail would serve maybe a third of them.

---

## The archetypes (with real examples)

### 1. The conceptual seed — an idea proposed by analogy
The highest-value, lowest-frequency kind. Mike proposes a *frame*, not a task.

> *"essentially BPE but for agent behavior instead of text… you notice that
> `ls → cat README.md → grep -r` appears in 80% of conversations as an opening
> move. That whole sequence becomes Action Token #42 — 'orient to project.'"*
> — seed of `dev/research/agent_action_bpe/` (`RESEARCH_SEED.md`)

**What made it good:** a genuine analogy that transfers structure (BPE merges →
behavioral grammar), plus a concrete first data representation.
**Artifact that proves it:** *not* a screenshot. The proof is the **derived
result** — the learned vocabulary, the merge audit ("are these real behaviors or
noise?"). The right artifact is a **claim → evidence link**: the idea, and the
doc/output it eventually produced. (This is exactly VibeRate's "living history"
thesis, in miniature.)

### 2. The structured pickup — clearly LLM-generated, file-addressed
A handoff prompt, formatted by a model, that onboards a fresh agent precisely.

> *"You are picking up an in-progress research project. Read these files first:
> `RESEARCH_SEED.md`… `extract_actions.py` (skim — focus on `learn_bpe` and
> `infer_task_label`)… **Your task:** Generate a single markdown report… that
> answers one question: do the learned BPE merges capture real, nameable agent
> behaviors, or are they statistical noise?"* — `dev` (claude)

**What made it good:** names exact files + what to skim vs read, states the corpus
size, and collapses the whole job to **one question**.
**Artifact that proves it:** the **file-reference graph** (which docs the prompt
pointed at — VibeRate already extracts `docRefs`) + the **deliverable diff** (the
report it produced). Outcome signal: did the agent read the named files?

### 3. The screenshot-driven redesign — frontend, visual, "feel"
> *"I'm including some screenshots of my app… this is really a 'backend unearthed'
> moment for Daber… now that I have the input issue mostly solved (via stroke data)
> I want to consider redesigning…"* — `Daber` (codex, images attached)

**What made it good:** supplies visual state, names the breakthrough, and asks for
*direction* before code.
**Artifact that proves it:** **before/after screenshots** — the canonical case.
This is the archetype the obvious "image rail" serves. Note the input images are in
the log (`local_images`) but our parser currently drops them — capturing the *prompt's
own* attached screenshots is half the artifact.

### 4. The experiment-as-prompt — a designed test with pasted results
> *"TEST A: Create a new file 'test_A.md' with Hello World inside. RESPONSE: FOUR
> FILES CREATED (!) … (RESULT) PASS… The second test… fails… the error says
> 'git apply --check failed'… Explain to me what is going wrong with our loop."*
> — `CodeSwipe` (codex)

**What made it good:** Mike runs a controlled test, pastes the raw result, states
the expected vs actual, and asks for a causal explanation.
**Artifact that proves it:** a **test transcript card** — the test definition, the
console/observed output (pasted *into* the prompt — we should preserve these blocks,
not strip them), and pass/fail. This is Slice-5 "evidence capture" but **author-
supplied**, not auto-captured.

### 5. The cross-conversation handoff — pasting another model's reasoning
> *"Consider this conversation that I just had with Claude… I think we really landed
> on something important… The Claude Code analogy is clarifying, and it reveals a
> specific architectural gap… What's missing is 'read' as a first-class command…"*
> — `rustsheet` (codex, pasting a Claude analysis into Codex)

**What made it good:** Mike *moves insight between tools*, using one model's framing
to redirect another's architecture.
**Artifact that proves it:** the **quoted source** (which conversation/turn this came
from) as a first-class link — provenance across sessions/tools. VibeRate's `cardId`
(project~session~turn) is exactly the addressing scheme this needs; the artifact is a
**permalink to the originating turn**.

### 6. The precise visual critique → tooling ask
> *"the avatar reads as 'frame PNG pasted on top of knight PNG' instead of 'single
> coherent identity object'… 1. The knight is positioned outside the frame… I think
> the next step is NOT more manual manifest tweaking. We should build a dev/admin
> cosmetics composition canvas so we can visually tune the system."* — `horsey_v2`

**What made it good:** numbered, specific visual diagnosis, then escalates from
"fix this pixel" to "build the tool that lets us tune the class of problem."
**Artifact that proves it:** before/after screenshot **plus** the meta-outcome —
*a new tool/route was created.* Outcome signal: "this prompt spawned `…/admin/cosmetics`."

### 7. The positioning correction — re-steering the agent's mental model
> *"Github for agent conversations is not right and I've corrected this mistake
> before from you… our thing is about collaborating / getting feedback and managing
> your project's AI brain… My thoughts, unstructured: make the Brain dots pulse…
> screenshots become super important… do we have metadata on how much context was
> used (the 'dumb zone')?"* — `viberate` (claude)

**What made it good:** corrects a recurring misframe, then dumps unstructured but
fertile direction. *Several VibeRate features trace directly to this one prompt
(pulsing brain, context gauge, screenshot capture).*
**Artifact that proves it:** the **downstream commits/features** that cite it — the
"every claim traceable to the work that created it" rail. Best possible demo of the
product's own thesis.

### 8. The options menu — the decision method
> *"I'm going to give you a few options for where to focus next. You can pick one,
> all, or none if you feel there is some higher-level fix to perform first… GAME UI:
> 1 … 2 … 3 … DASHBOARD UI: …"* — `betmate` (codex)

**What made it good:** delegates prioritization while constraining scope; explicitly
licenses the agent to propose a better path. (This is Mike's documented
mock/toggle/decision habit, applied to roadmap order.)
**Artifact that proves it:** **which option(s) got executed** + the resulting diffs —
a checklist outcome, not a screenshot.

### 9. The spec deliverable — structured, no model needed
> *"Write a deterministic duplicate resolver for Daber… Deliverable:
> `scripts/auto_resolve_duplicates.mjs` with `--dry-run` (default) and `--apply`…
> Normalization helpers (build these first): `normalizeEnglish(s)`: lowercase,
> trim… `normalizeHebrew(s)`: strip niqqud (U+0591–U+05C7)… Resolution passes (run
> in order)…"* — `hebrew_drills` (codex)

**What made it good:** reads like a mini-RFC — named deliverable, flags, ordered
algorithm, edge cases. Almost no ambiguity left.
**Artifact that proves it:** the **created file + a dry-run transcript** showing the
algorithm's decisions. Outcome: tests pass / N duplicates resolved.

### 10. The console-paste debug loop — the raw terminal *is* the prompt
> *"betmate on dev … ❯ npm run e2e … [50 lines of Playwright output] … Whats going
> on… at the start of this conversation, all tests passed or skipped… now some
> fail…"* — `betmate` (codex; this is the **single most common** substantive shape —
> betmate alone has 1,560 such candidates)

**What made it good:** sometimes nothing — it's just pasted noise. But the *good*
ones pair the paste with a sharp observation ("at the start of this conversation all
tests passed; now some fail" = a regression hypothesis).
**Artifact that proves it:** the **diff in test results** across the turn (was-green
→ now-red → green again). The artifact is a **test-status timeline**, and the lesson
is that *most* of these are low-value — a feedback product should be able to **fold
them away**, surfacing only the ones with a real observation attached.

### 11. The feasibility / architecture discussion — thinking aloud
> *"Good job getting us to this checkpoint. I want to take a moment to have a
> discussion about future capabilities… clicking the diamond doesn't do anything…
> for Brain it'd be cool to get a timeline, I'm wondering if we just build that from
> Git?… I could see wanting to 'add a file to the brain' via the interface… I'm not
> 100% this is the way I want to go, but I want to explore if it's architecturally
> possible."* — `viberate` (claude)

**What made it good:** no deliverable demanded — it opens a design space, flags
intuitions, and explicitly defers the decision. (This thread seeded time-travel +
the read-only-vs-editable call now in `PROJECT_VIEW_PLAN.md`.)
**Artifact that proves it:** a **decision record** — the question raised and the
resolution it later reached (often a plan-doc edit, not code).

### 12. The tool-genesis prompt — describing a tool that doesn't exist
> *"when I use a terminal agent like Codex or ClaudeCode, I would like more
> visibility into what is happening in real time… some sort of terminal command…
> it displays a nice GUI of the folder as files and folders are created and
> modified… that would be a nice start anyways."* — `CodeWatch` (codex, 2025-11)

**What made it good:** this is **VibeRate's own origin**, six months early —
"watch the agent work in real time" is precisely what `vbrt watch` / streaming
became. A vague wish that turned into a product.
**Artifact that proves it:** the **lineage** — this prompt → that repo → eventually
this one. The ultimate "living history" artifact spans *projects*, not just turns.

---

## Synthesis — what artifact does each archetype actually need?

| # | Archetype | Primary artifact | Screenshot? |
|---|-----------|------------------|:-----------:|
| 1 | Conceptual seed | claim → derived-output link | no |
| 2 | Structured pickup | docRef graph + deliverable diff | no |
| 3 | Screenshot redesign | **before/after images** | **yes** |
| 4 | Experiment-as-prompt | test transcript (def + output + verdict) | sometimes |
| 5 | Cross-convo handoff | permalink to source turn (provenance) | no |
| 6 | Visual critique → tool | before/after **+ new route created** | yes |
| 7 | Positioning correction | downstream commits that cite it | no |
| 8 | Options menu | which option ran + diffs | no |
| 9 | Spec deliverable | created file + dry-run transcript | no |
| 10 | Console-paste debug | test-status timeline (mostly foldable) | no |
| 11 | Feasibility discussion | decision record | no |
| 12 | Tool-genesis | cross-project lineage | rarely |

### Takeaways for the product

1. **Screenshots are necessary but not sufficient.** Only ~3 of 12 archetypes are
   truly screenshot-shaped. The dominant outcome signals are **diffs, test-status
   deltas, file-reference graphs, and provenance links** — most of which VibeRate
   *already captures* (git, `docRefs`, `cardId`). The "outcome rail" should be
   **polymorphic**: it renders whatever evidence the archetype implies.

2. **Capture the prompt's own attachments.** Several gems *paste evidence inward* —
   screenshots (`local_images`), console output, another model's reasoning. The
   parser currently strips most of this. The artifact often lives *in the prompt*,
   not after it. Preserving pasted blocks (and inbound images) is cheap and high-value.

3. **Folding is a feature.** The single most common substantive shape (#10, betmate
   e2e logs) is mostly low-value. A feedback product earns trust by **collapsing the
   banal** and elevating the prompt+observation pairs — the same instinct as the
   empty-session folding already shipped in `PROJECT_VIEW_PLAN.md` §G.

4. **The richest artifact is lineage across projects** (#1, #7, #12). The
   "important juncture" → feature, or `CodeWatch` wish → `vbrt watch`, only reads as
   impressive *across* the corpus. A per-session view can't show it; this argues for
   a **cross-project "idea → consequence" thread** as a marquee feature.

5. **A prompt-quality signal could be auto-derived**, lightly: conceptual density,
   whether it carried evidence, whether it named files, whether it deferred a
   decision vs demanded a deliverable. Not a score to rank people — a **lens** to
   help someone find their own best prompts (which is what this very task was).

---

## Open questions to think over together

- Do we want an **author-supplied** evidence step (Mike pastes/attaches at push) or
  **auto-captured** (skill grabs diffs/screens/tests)? The gallery suggests *both*:
  auto for diffs/tests, author for screenshots + "here's what I observed."
- What's the unit of the lineage thread — a tagged idea that we follow across
  commits/sessions/repos? How is it created (manual tag vs inferred)?
- For the console-paste majority: fold by default, or never ingest? (Leaning: ingest
  but collapse, because the *observation* attached to the paste is the value.)
- This doc is itself archetype #11. Its artifact is whatever spec it seeds — likely
  the polymorphic outcome rail (`PROJECT_VIEW_PLAN.md` §C) getting a real design.
