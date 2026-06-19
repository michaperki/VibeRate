# Context Credit Assignment — Research

**Status:** research only; no implementation decision
**Date:** 2026-06-19

## Question

Would it be useful for VibeRate to show why a memory or brain document mattered to
an agent turn—using signals such as semantic relevance, references, updates,
centrality, outcomes, age, and conflict risk—and do we currently capture enough
data to do this faithfully?

## Conclusion

The feature is worthwhile, but it should begin as **observable activity and
influence signals**, not as one authoritative relevance score.

VibeRate already captures enough information to show useful document-level
maintenance and structural metrics. It does not currently capture the decisive
event needed for true context credit assignment: which exact memory version was
retrieved for a turn, why it was selected, and whether the agent meaningfully used
it. Presenting inferred relevance as measured fact would create false precision,
especially because Claude and Codex expose different memory telemetry.

The recommended product shape is:

1. Brain-node metrics for durable, query-independent importance and maintenance.
2. A selected-turn context trail for observed and inferred influence.
3. A composite retrieval score only after retrieval/use events and feedback exist.

## Conceptual model

A future query-relative score could take the form:

```text
S(memory, query) =
  semantic relevance
  + reference frequency
  + update frequency
  + structural centrality
  + outcome value
  - age decay
  - conflict risk
```

These terms represent different concepts and should remain visible independently:

- **Importance:** durable, query-independent value.
- **Relevance:** usefulness to the current task or turn.
- **Reliability:** confidence that the information remains true.
- **Influence:** evidence that the information affected agent behavior.

Only relevance is inherently query-dependent. On a project dashboard there is no
query until the user selects a prompt or active task, so a global "relevance" value
would be conceptually wrong.

## Data VibeRate already captures

| Signal | Coverage | Current source | Assessment |
|---|---|---|---|
| Age / last update | Strong | Document `mtime`; Git commit timestamps | Ready to aggregate. |
| Update frequency | Strong | Brain-document changes in Git history | Ready, subject to history caps. |
| Structural centrality | Strong | Markdown cross-reference graph | Degree/PageRank-style metrics are cheap to derive. |
| Explicit prompt references | Partial | `.md` names extracted from prompt text | High-confidence but misses implicit references. |
| Direct reads and edits | Partial | Tool calls retained in session transcripts | Direct file tools are clear; shell commands need parsing. |
| Turn outcomes | Partial | Files, edits, commits, commands, test summaries, screenshots, context fullness | Available per turn, but not attributed to a memory. |
| Recall frequency | Uneven | Codex SQLite `usage_count` | Experimental for Codex; unavailable for Claude. |
| Document versions | Strong | Brain time-travel snapshots | Enables age, survival, churn, and supersession heuristics. |
| Live context size | Partial | Claude usage data and hooks | Shows context fullness, not which memories were included. |

### Existing implementation foundations

- `src/workspace.js` normalizes memory into `source`, `authored`, `type`, `body`,
  `mtime`, `loading`, and `recallCount`.
- Claude memory has `recallCount: null`; Codex reads `usage_count` from its
  experimental SQLite memory store.
- `src/docs.js` discovers known brain documents and follows Markdown references.
- `src/git.js` captures document-changing commits and bounded per-document version
  history.
- `public/app.js` already builds graph edges from document references.
- `src/prompts.js` derives prompt-level outcome signals and explicit `.md`
  references.
- `src/parsers.js` retains normalized tool calls, including direct read/edit paths
  when the agent exposes them.
- `src/hooks.js` captures prompt/tool lifecycle events and context size, but not
  memory retrieval identity.

## Metrics possible without new capture

An initial Brain UI could calculate:

- Last changed time.
- Number of changing commits.
- Update cadence and recent churn.
- Inbound and outbound document references.
- Prompt mentions.
- Direct tool reads and edits.
- Number of sessions or turns touching the document.
- Codex recall count where available, explicitly source-badged.
- Survival across later commits.
- A cautious "possibly stale" indicator based on age and newer connected docs.

These are suitable for a node detail panel or hover expansion. They should be
labelled by provenance—for example, **observed read**, **explicit mention**, or
**inferred relationship**—rather than collapsed into a single number.

Historical computation is possible from existing bundles, although accuracy will
vary:

- A direct `Read` tool call is high-confidence.
- `cat`, `sed`, `rg`, or compound shell commands require best-effort command parsing.
- A filename in a prompt is an explicit reference, not proof that the agent used it.
- A document preloaded by the harness may influence a turn without any read event.
- Existing Git-to-turn commit attribution is temporal and therefore approximate.

## Missing pieces for true credit assignment

The required primitive is a durable retrieval/use event:

```text
turn_id
memory_id
memory_version_id
retrieved_at
retrieval_reason
candidate_rank
score_components
use_evidence
```

The larger missing pieces are:

### Stable identity and versioning

Memory notes and brain documents need stable IDs independent of display names and
paths, plus version IDs so an outcome is attributed to the information that existed
at that time.

### Retrieval telemetry

VibeRate needs the candidate set, selected memories, rank, and reason. Current hooks
observe tool activity, not opaque retrieval performed inside an agent harness.

### Turn linkage

Every retrieval/read event must be attached to a project, session, prompt unit, and
memory version. Aggregate `usage_count` is insufficient for explaining one turn.

### Semantic infrastructure

No embedding/indexing layer exists yet. Embeddings are already deferred in
`PROJECT_VIEW_PLAN.md` until search and cross-project lineage can share the same
infrastructure. That remains the efficient sequencing: vectors should support
multiple features rather than only this score.

### Outcome attribution

VibeRate has turn-level outcome proxies, but not evidence that a particular memory
caused the result. Stronger signals would include:

- Tests passing after use.
- Code surviving later commits.
- Explicit user approval or correction.
- Rework and reversion around the affected files.
- Whether the memory was quoted, cited, or operationalized in an edit.

### Conflict and supersession

Conflict risk requires relationships such as `supersedes`, `contradicts`,
`deprecated_by`, or a semantic comparison against newer evidence. Age alone is not
enough: old architectural principles may remain reliable while a recent experiment
may already be obsolete.

### Meaningful-use feedback

Counting every retrieval creates a self-reinforcing loop: a frequently retrieved
memory is ranked higher, causing it to be retrieved more often. Counts should increase
only for meaningful use, use diminishing returns, and preserve an exploration budget
for neglected candidates.

## Agent-specific limitations

### Claude Code

- Curated memory files, timestamps, and loading mode are visible.
- Direct reads can often be recovered from transcript tool calls.
- Recall count and the harness's hidden candidate/ranking process are not exposed.
- Always-loaded instructions can influence a turn without producing a read event.

### Codex

- Distilled memory can expose aggregate `usage_count` through an experimental reader.
- The reader is feature-gated and may have no data.
- Aggregate usage does not identify the exact turn, candidate set, or meaningful use.

Cross-agent comparisons must therefore show coverage and provenance. A raw recall
count would otherwise make Codex memories appear more measurable—and potentially more
important—simply because its store exposes a field Claude does not.

## Product value

The strongest user value is explanatory rather than gamified:

- Diagnose stale or conflicting context.
- Find foundational documents that are heavily depended upon.
- Identify active documents that produce churn but weak outcomes.
- Find neglected documents that should be maintained, linked, or archived.
- Explain why an agent likely behaved a certain way on a selected turn.
- Audit whether the project brain is actually shaping implementation.

The weakest version is an unexplained score on every node. It would be difficult to
trust, easy to game, and hard to distinguish from decorative analytics.

## Recommended product sequence

### Phase 1 — Brain activity and health

Use only existing data. Add component metrics to node details, with provenance and
coverage labels. Do not call the result "relevance."

Estimated difficulty: **low to medium**. Most work is aggregation, path
normalization, command parsing, deduplication, and UI presentation.

### Phase 2 — Selected-turn context trail

When a prompt is selected, show:

- Explicitly mentioned docs.
- Observed reads and edits.
- Preloaded instruction docs.
- Structurally adjacent docs.
- Semantically related docs once embeddings exist.
- Outcome evidence from that turn.

Each relationship should be labelled **observed** or **inferred**, with confidence.

Estimated difficulty: **medium** for a useful inferred trail; **medium to high** for
consistent historical coverage.

### Phase 3 — Instrumented retrieval and feedback

Capture stable retrieval events, memory versions, rank/reason, and meaningful-use
feedback. Add conflict/supersession relationships and outcome linkage. Only then
consider a composite dynamic score or retrieval reranker.

Estimated difficulty: **high**, primarily because retrieval inside external agent
harnesses may not be observable or extensible.

## UI placement

Two placements match the semantics:

- **Brain UI node detail:** query-independent importance, reliability, maintenance,
  and structural metrics.
- **Prompt reader context-credit panel:** query-relative relevance and evidence of
  influence for the selected turn.

This keeps "what is foundational?" separate from "what mattered right now?" and
fits VibeRate's existing split between the project Brain and prompt-level outcome
rails.

## Recommendation

Proceed with Phase 1 when Brain UI metrics become a product priority. Treat it as a
low-risk use of existing capture data and a foundation for search/lineage work.

Do not ship the proposed weighted formula as a user-facing score yet. Preserve it as
a future retrieval/reranking model, and first establish stable identity, per-turn
retrieval telemetry, semantic infrastructure, conflict relationships, and meaningful
outcome feedback.
