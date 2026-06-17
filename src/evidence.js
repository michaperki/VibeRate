import fs from 'node:fs';
import os from 'node:os';
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
const MAX_CLIP_BYTES = 6 * 1024 * 1024; // motion clips are heavier; still inlined as JSON

// Is system ffmpeg available? It lets us emit a true .gif (renders in <img>);
// without it we keep Playwright's native .webm (renders as a looping <video>).
function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', png: 'image/png',
  webm: 'video/webm', mp4: 'video/mp4',
};

function dataUrl(imgPath) {
  const buf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const cap = mime.startsWith('video/') ? MAX_CLIP_BYTES : MAX_IMG_BYTES;
  if (buf.length > cap) {
    const kind = mime.startsWith('video/') ? 'clip' : 'image';
    throw new Error(`${kind} too large (${Math.round(buf.length / 1024)}KB > ${Math.round(cap / 1024)}KB cap)`);
  }
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

// Record a short motion clip of a URL. Playwright records native webm (no extra
// deps); if system ffmpeg is present we transcode to an animated .gif (smaller,
// renders in a plain <img>), otherwise we keep the webm (renders as <video>).
// Returns a { dataUrl, media } pair so the caller/viewer knows how to render it.
async function captureClip(url, { viewport, seconds = 4, fps = 12 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'Clip capture needs Playwright (`npm i -D playwright`). ' +
        'Or pass `--image <file>` with a gif/clip the agent already captured.',
    );
  }
  const [w, h] = String(viewport || '960x600').split('x').map(Number);
  const width = w || 960;
  const height = h || 600;
  const secs = Math.min(15, Math.max(1, Number(seconds) || 4)); // cap so files stay inline-able
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbrt-clip-'));
  const browser = await chromium.launch();
  let webmPath;
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: tmp, size: { width, height } },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    const video = page.video();
    await page.waitForTimeout(secs * 1000);
    await context.close(); // finalizes the webm; path() resolves after close
    webmPath = video ? await video.path() : null;
  } finally {
    await browser.close();
  }
  if (!webmPath || !fs.existsSync(webmPath)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('clip capture produced no video');
  }

  try {
    if (hasFfmpeg()) {
      const gifPath = path.join(tmp, 'out.gif');
      // Two-pass palette for a clean gif; scale down to keep the inline payload small.
      const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      execFileSync('ffmpeg', ['-y', '-i', webmPath, '-vf', vf, gifPath], { stdio: 'ignore' });
      const buf = fs.readFileSync(gifPath);
      if (buf.length > MAX_CLIP_BYTES) {
        throw new Error(`clip too large (${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_CLIP_BYTES / 1024)}KB cap) — try a shorter --clip or smaller --viewport`);
      }
      return { dataUrl: `data:image/gif;base64,${buf.toString('base64')}`, media: 'image' };
    }
    const buf = fs.readFileSync(webmPath);
    if (buf.length > MAX_CLIP_BYTES) {
      throw new Error(`clip too large (${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_CLIP_BYTES / 1024)}KB cap) — try a shorter --clip or smaller --viewport`);
    }
    return { dataUrl: `data:video/webm;base64,${buf.toString('base64')}`, media: 'video' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Record one screenshot artifact into the repo's evidence sidecar. `target` is an
// image path or http(s) URL; `image` forces an explicit file. Binds to the active
// session so artifacts land on the right conversation even with several running.
export async function recordShot(cwd, { target, image, label = null, note = '', viewport = null, session = null, pair = null, clip = null } = {}) {
  const dir = evidenceDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const isUrl = target && /^https?:\/\//i.test(target);
  // media: 'image' (still or gif) renders in <img>; 'video' renders as <video>.
  const mediaOf = (src) => (/^data:video\//i.test(src) ? 'video' : 'image');
  let img;
  let media;
  if (clip) {
    if (!isUrl) throw new Error('--clip needs a URL to record (pass an http(s) URL)');
    const out = await captureClip(target, { viewport, seconds: clip === true ? 4 : Number(clip) });
    img = out.dataUrl;
    media = out.media;
  } else if (image) {
    img = dataUrl(image);
    media = mediaOf(img);
  } else if (isUrl) {
    img = await captureUrl(target, viewport);
    media = 'image';
  } else if (target) {
    img = dataUrl(target);
    media = mediaOf(img);
  } else {
    throw new Error('nothing to capture: pass a URL, an image path, or --image <file>');
  }

  const sess = session ? { id: session, source: null } : await resolveActiveSession(cwd);
  const ts = new Date().toISOString();
  const id = `ev-${ts.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id,
    ts,
    label: label || null,
    note: note || '',
    viewport: viewport || null,
    media,
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
        id: ev.id, label: ev.label, note: ev.note, image: ev.image, media: ev.media || null,
        ts: ev.ts, viewport: ev.viewport, gitHead: ev.gitHead, pair: ev.pair,
      });
    }
  }
}
