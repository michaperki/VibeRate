// Harness versioning — the read side of PLAN_HARNESS_VERSIONING.md.
//
// VibeRate spawns the user's real coding-agent CLI (Claude Code today, Codex
// alongside it — src/agent.js). The product stance is "don't pin, auto-grab
// latest" (Mike, 2026-06-23), so this module's job is to make that *observable*:
// answer "what version is this instance running, how far behind upstream is it,
// and is the drift the dangerous kind (permission/tool changes)?" — without a
// live session. That answer feeds the cockpit's harness rail (PLAN_COCKPIT.md
// WS5) and the `vbrt harness` CLI (WS4).
//
// Three version sources, most-authoritative first:
//   1. host CLI  — `claude --version` sampled on this box (what actually runs).
//   2. build file — the version baked into the image at build time (WS2), so we
//      have an answer even before the host binary is ever invoked.
//   3. live init  — the version a running session announced in its system/init
//      event (agent.js), corroborating 1/2 and catching a binary swapped under us.
// "Latest available" comes from the npm registry, cached so we don't hammer it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execFileP = promisify(execFile);

// The two harnesses we track. `bin` mirrors agent.js's env seam so a custom binary
// path is sampled, not the bare name. `pkg` is the npm package "latest" is polled
// from. Codex ships from a different feed (GitHub releases); its npm package is a
// best-effort and may be absent — handled gracefully (see fetchLatest).
const HARNESSES = {
  claude: { label: 'Claude Code', bin: () => process.env.VBRT_CLAUDE_BIN || 'claude', pkg: '@anthropic-ai/claude-code' },
  codex: { label: 'Codex', bin: () => process.env.VBRT_CODEX_BIN || 'codex', pkg: '@openai/codex' },
};

// Where WS2's Dockerfile records the resolved version at image-build time. A small
// JSON map { claude: "2.1.185", codex: "..." }. Overridable for tests / local runs.
const BUILD_FILE = process.env.VBRT_HARNESS_VERSION_FILE || '/opt/vbrt/harness.json';

// npm registry "latest" is cached this long — version churn is daily at most, and
// the rail re-renders far more often than that. Don't poll upstream per render.
const LATEST_TTL_MS = Number(process.env.VBRT_HARNESS_LATEST_TTL_MS || 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = 8000;

// In-memory state per harness. `host` is sampled lazily + cached (binaries don't
// change under a running server unless someone redeploys, which restarts us).
const state = {
  claude: { host: undefined, live: null, liveAt: 0, latest: null, latestAt: 0 },
  codex: { host: undefined, live: null, liveAt: 0, latest: null, latestAt: 0 },
};

// Pull a bare semver out of a `--version` line. The Claude CLI prints
// "2.1.185 (Claude Code)"; Codex prints "codex-cli 0.x.y" — tolerate both by
// grabbing the first dotted-number run.
function parseVersion(out) {
  const m = String(out || '').match(/\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

// Compare two semver-ish strings (ignoring any pre-release/build tail) → -1/0/1.
// Used both to count "N behind" and to decide outdated/ahead.
export function cmpSemver(a, b) {
  const core = (v) => String(v || '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The build-time version map, read once and memoized (it never changes for the
// life of the image). Missing/unreadable → {} so callers degrade to host sampling.
let buildMap;
function buildVersion(harness) {
  if (buildMap === undefined) {
    try {
      buildMap = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')) || {};
    } catch {
      buildMap = {};
    }
  }
  return buildMap[harness] || null;
}

// Sample the host binary's version (cached). Returns null when the binary isn't
// installed (Codex on a Claude-only box) or errors — never throws.
async function sampleHost(harness) {
  const h = HARNESSES[harness];
  if (!h) return null;
  if (state[harness].host !== undefined) return state[harness].host;
  let version = null;
  try {
    const { stdout } = await execFileP(h.bin(), ['--version'], { timeout: 5000 });
    version = parseVersion(stdout);
  } catch {
    version = null;
  }
  state[harness].host = version;
  return version;
}

// Force a re-sample of the host binary on the next read — call after a deploy /
// staged install swaps the binary so the rail doesn't show a stale version.
export function invalidateHost(harness) {
  if (harness && state[harness]) state[harness].host = undefined;
  else for (const k of Object.keys(state)) state[k].host = undefined;
}

// Record the version a live session announced in its system/init event (agent.js).
// This is corroboration, not the primary source — but it's the only signal that
// catches a binary that changed *while* the server stayed up.
export function recordLiveVersion(harness, version, at = Date.now()) {
  const v = parseVersion(version) || (version ? String(version) : null);
  if (!v || !state[harness]) return;
  state[harness].live = v;
  state[harness].liveAt = at;
}

// Poll the npm registry for the package's latest version + release date, and the
// full version timeline so we can count how many releases we're behind. Cached for
// LATEST_TTL_MS; failures return the last good value (or nulls) so a registry blip
// never breaks the rail. The full doc is large-ish but fetched at most hourly.
async function fetchLatest(harness) {
  const h = HARNESSES[harness];
  if (!h) return null;
  const s = state[harness];
  if (s.latest && Date.now() - s.latestAt < LATEST_TTL_MS) return s.latest;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(h.pkg).replace('%40', '@')}`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const doc = await res.json();
    const latest = (doc['dist-tags'] && doc['dist-tags'].latest) || null;
    const time = doc.time || {};
    // Stable releases only (drop pre-releases and the created/modified meta keys),
    // newest first, so "N behind" counts real shippable versions.
    const releases = Object.keys(time)
      .filter((k) => k !== 'created' && k !== 'modified' && /^\d+\.\d+\.\d+$/.test(k))
      .sort((a, b) => cmpSemver(b, a));
    s.latest = { latest, releaseDate: latest ? time[latest] || null : null, releases, time };
    s.latestAt = Date.now();
  } catch {
    // Keep the stale value if we have one; otherwise a null-shaped result.
    if (!s.latest) s.latest = { latest: null, releaseDate: null, releases: [], time: {} };
  } finally {
    clearTimeout(timer);
  }
  return s.latest;
}

// The installed version we trust most: host sample → build file → last live init.
function installedVersion(harness) {
  return state[harness].host || buildVersion(harness) || state[harness].live || null;
}

// How many stable releases sit strictly between `installed` and `latest`
// (inclusive of latest). 0 = up to date; null = unknown (no data either side).
function behindCount(latestData, installed) {
  if (!latestData || !installed || !latestData.latest) return null;
  if (!Array.isArray(latestData.releases) || !latestData.releases.length) {
    // No timeline — fall back to a coarse "is latest newer at all" signal.
    return cmpSemver(installed, latestData.latest) < 0 ? 1 : 0;
  }
  return latestData.releases.filter((v) => cmpSemver(v, installed) > 0 && cmpSemver(v, latestData.latest) <= 0).length;
}

// Full per-harness status for one harness. `{ installed, source, latest,
// releaseDate, behind, outdated, live, available }`. Never throws.
async function statusFor(harness) {
  await sampleHost(harness);
  const installed = installedVersion(harness);
  const source = state[harness].host ? 'host' : buildVersion(harness) ? 'build' : state[harness].live ? 'live' : null;
  const latestData = await fetchLatest(harness);
  const latest = latestData ? latestData.latest : null;
  const behind = behindCount(latestData, installed);
  return {
    name: harness,
    label: HARNESSES[harness].label,
    installed,
    source,
    available: !!installed,
    latest,
    releaseDate: latestData ? latestData.releaseDate : null,
    installedReleaseDate: installed && latestData && latestData.time ? latestData.time[installed] || null : null,
    behind,
    outdated: behind != null && behind > 0,
    live: state[harness].live,
    liveAt: state[harness].liveAt || null,
  };
}

// The harness rail's payload: every harness we track, with drift computed. Codex
// is included even when absent (available:false) so the rail can show "not
// installed" rather than silently omitting it.
export async function harnessReport() {
  const out = {};
  for (const harness of Object.keys(HARNESSES)) {
    out[harness] = await statusFor(harness);
  }
  return { harnesses: out, sampledAt: Date.now() };
}

// Cheap synchronous snapshot for routes that can't await (or want a fast answer):
// installed version per harness from the already-sampled/cached sources, no
// network. Triggers a background host sample if we've never sampled.
export function harnessSnapshot() {
  const out = {};
  for (const harness of Object.keys(HARNESSES)) {
    if (state[harness].host === undefined) sampleHost(harness).catch(() => {});
    out[harness] = { installed: installedVersion(harness), live: state[harness].live, latest: state[harness].latest ? state[harness].latest.latest : null };
  }
  return out;
}

// The upstream changelog feeds (WS3 bonus / WS4). Claude Code is public-but-closed:
// the repo is an issue tracker + changelog; we read the raw CHANGELOG.md. Codex is
// fully open source with its own changelog.
const CHANGELOG_URL = {
  claude: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  codex: 'https://raw.githubusercontent.com/openai/codex/main/CHANGELOG.md',
};

// The canary words: the changelog trend (§0) says permission-model + tool-name
// changes break what we parse most; these grep targets surface "the dangerous kind
// of drift" before we ship an update.
const CANARY_RE = /\b(permission|breaking|removed?|deprecat|renamed?|tool[\s-]?name|stream[\s-]?json|schema)\b/i;

// Fetch the changelog and pull out the entries strictly newer than `installed` up
// to `latest`, each flagged for canary keywords. Returns { version, lines, canary }
// per release plus a flat `canaries` list, so the bump command can highlight "⚠
// permission changes in 2.1.18x" before a deploy. Best-effort: a network failure
// returns an empty, non-throwing result so the gate still runs on the parser checks.
export async function changelogDrift(harness, installed, latest) {
  const url = CHANGELOG_URL[harness];
  const empty = { entries: [], canaries: [], ok: false };
  if (!url || !installed) return empty;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`changelog ${res.status}`);
    text = await res.text();
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
  // Split on `## <version>` (or `# <version>`) headers; collect bullet lines until
  // the next header. Keep only versions in (installed, latest].
  const entries = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const head = raw.match(/^#{1,3}\s+v?(\d+\.\d+\.\d+)\b/);
    if (head) {
      if (cur) entries.push(cur);
      cur = { version: head[1], lines: [] };
      continue;
    }
    if (cur) {
      const line = raw.trim().replace(/^[-*]\s*/, '');
      if (line) cur.lines.push(line);
    }
  }
  if (cur) entries.push(cur);
  const inRange = entries.filter((e) =>
    cmpSemver(e.version, installed) > 0 && (!latest || cmpSemver(e.version, latest) <= 0));
  const canaries = [];
  for (const e of inRange) {
    e.canary = e.lines.filter((l) => CANARY_RE.test(l));
    for (const l of e.canary) canaries.push({ version: e.version, line: l });
  }
  return { entries: inRange, canaries, ok: true };
}

// Exported for the WS3 smoke gate + WS4 bump command.
export { HARNESSES, parseVersion, installedVersion, behindCount, fetchLatest };
