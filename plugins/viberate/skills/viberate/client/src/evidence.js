import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverSessions } from './discover.js';
import { parseClaude, parseCodex } from './parsers.js';

// Evidence artifacts (screenshots/gifs) the agent captures alongside its work,
// stored in a repo-local sidecar so `vbrt push`/`watch` bundles them and the
// reader can render them on the prompt that produced them. The capture command
// (`vbrt shot`) is meant to be cheap for an agent to run — one line, no need to
// know its own session/turn — so binding is resolved here, not by the caller.
export const evidenceDir = (cwd) => path.join(cwd, '.vbrt', 'evidence');

const MAX_IMG_BYTES = 1.5 * 1024 * 1024; // ~1.5MB/image; bundles are JSON over the wire

function gitHead(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// The session the agent is "in": among this repo's logs, the one whose file was
// most recently written (the turn that triggered this work). Parses just that one
// file so the id matches exactly what the bundle stores — codex ids aren't the
// filename, so deriving from the path would mis-bind. Returns null if none.
export async function resolveActiveSession(cwd) {
  let sessions;
  try {
    sessions = await discoverSessions(cwd);
  } catch {
    return null;
  }
  let best = null;
  let bestM = -1;
  for (const s of sessions) {
    let m = 0;
    try { m = fs.statSync(s.file).mtimeMs; } catch { /* gone */ }
    if (m > bestM) { bestM = m; best = s; }
  }
  if (!best) return null;
  try {
    const parsed = best.source === 'claude' ? await parseClaude(best.file) : await parseCodex(best.file);
    return { id: `${parsed.source}-${parsed.id}`, source: parsed.source, file: best.file };
  } catch {
    return null;
  }
}

function dataUrl(imgPath) {
  const buf = fs.readFileSync(imgPath);
  if (buf.length > MAX_IMG_BYTES) {
    throw new Error(`image too large (${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_IMG_BYTES / 1024)}KB cap)`);
  }
  const ext = path.extname(imgPath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Capture a URL with Playwright *if it's installed*; otherwise tell the caller to
// pass --image with a screenshot the agent already took. The lazy import keeps the
// pushed skill bundle dependency-free (same pattern as @inquirer/express).
async function captureUrl(url, viewport) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'URL capture needs Playwright (`npm i -D playwright`). ' +
        'Or pass `--image <file>` with a screenshot the agent already captured.',
    );
  }
  const [w, h] = String(viewport || '1280x800').split('x').map(Number);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: w || 1280, height: h || 800 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    const buf = await page.screenshot({ type: 'png' });
    return `data:image/png;base64,${buf.toString('base64')}`;
  } finally {
    await browser.close();
  }
}

// Record one screenshot artifact into the repo's evidence sidecar. `target` is an
// image path or http(s) URL; `image` forces an explicit file. Binds to the active
// session so artifacts land on the right conversation even with several running.
export async function recordShot(cwd, { target, image, label = null, note = '', viewport = null, session = null, pair = null } = {}) {
  const dir = evidenceDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const isUrl = target && /^https?:\/\//i.test(target);
  let img;
  if (image) img = dataUrl(image);
  else if (isUrl) img = await captureUrl(target, viewport);
  else if (target) img = dataUrl(target);
  else throw new Error('nothing to capture: pass a URL, an image path, or --image <file>');

  const sess = session ? { id: session, source: null } : await resolveActiveSession(cwd);
  const ts = new Date().toISOString();
  const id = `ev-${ts.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id,
    ts,
    label: label || null,
    note: note || '',
    viewport: viewport || null,
    gitHead: gitHead(cwd),
    session: sess ? { id: sess.id, source: sess.source } : null,
    pair: pair || null,
    origin: isUrl ? target : image || target,
    image: img,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  return { ...rec, file: path.join(dir, `${id}.json`) };
}

// All recorded artifacts for a repo, oldest→newest (so before/after pair in order),
// image data inline. Cheap: a handful of small JSON files.
export function readEvidence(cwd) {
  const dir = evidenceDir(cwd);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

// Attach artifacts to the prompt unit that produced them: filter to this session,
// then place each on the unit whose [ts, nextTs) window contains the capture time
// (a shot taken after the last prompt lands on the last prompt). Mutates units.
export function attachEvidence(units, evidence, sessionId) {
  if (!evidence || !evidence.length || !units || !units.length) return;
  const mine = evidence.filter((e) => e.image && e.session && e.session.id === sessionId);
  if (!mine.length) return;
  const timed = units.filter((u) => u.ts);
  for (const ev of mine) {
    let target = null;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.ts) continue;
      const next = units.slice(i + 1).find((x) => x.ts);
      if (ev.ts >= u.ts && (!next || ev.ts < next.ts)) { target = u; break; }
    }
    if (!target && timed.length) target = timed[timed.length - 1];
    if (target) {
      (target.evidence ||= []).push({
        id: ev.id, label: ev.label, note: ev.note, image: ev.image,
        ts: ev.ts, viewport: ev.viewport, gitHead: ev.gitHead, pair: ev.pair,
      });
    }
  }
}
