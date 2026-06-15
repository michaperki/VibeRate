import { slugify } from './paths.js';

// The capture "bundle": one self-contained, serializable object describing a
// project's captured sessions + git + docs. This is the single contract shared
// by both sinks — the local store writes it to disk, and the push client sends
// it verbatim as the hosted API request body. Designing it here = designing the
// upload schema, so keep it free of machine-specific assumptions beyond what the
// viewer already relies on (cwd is used for slug + relative paths).
//
// `schema` lets the server reject/migrate older clients as the format evolves.
export const BUNDLE_SCHEMA = 1;

function summarize(s) {
  return {
    id: `${s.source}-${s.id}`,
    source: s.source,
    title: s.title,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    messageCount: s.messageCount,
  };
}

// Build a bundle from already-parsed pieces. Pure: no I/O, no clock-dependent
// behavior beyond the capture timestamp, so it's trivial to test and to diff.
export function buildBundle(cwd, { sessions = [], git = null, docs = null, memory = null } = {}) {
  const slug = slugify(cwd);
  const capturedAt = new Date().toISOString();
  return {
    schema: BUNDLE_SCHEMA,
    project: {
      slug,
      cwd,
      name: slug,
      capturedAt,
      sessions: sessions.map(summarize),
    },
    sessions, // full parsed session objects (raw ids; sinks derive the file key)
    git: git || null,
    docs: docs && docs.length ? { capturedAt, docs } : null,
    // This repo's cold-start memory (index + notes + adopted). Included by default
    // so shared pages show context; suppressed with `vbrt push --no-memory`.
    memory: memory && memory.ok ? memory : null,
  };
}
