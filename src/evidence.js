import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
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

// Resolve Playwright from wherever it actually lives. The skill bundle ships with
// no node_modules, so a bare `import('playwright')` resolves against the *skill
// dir* and never sees a copy the agent installed in the repo — which is exactly
// what sent an earlier run down a NODE_PATH / patch-the-skill rabbit hole. Try the
// normal specifier first (a global/dev install), then resolve from the repo's own
// node_modules. Returns { module, source } so the doctor can report which it used.
async function resolvePlaywright(cwd) {
  // require.resolve() finds the package's CJS entry; importing that file by URL puts
  // its exports under `.default` (CJS interop), while the bare specifier picks the
  // ESM entry where `chromium` is a named export. Normalize so callers always see
  // `.chromium` regardless of which path resolved it.
  const norm = (mod) => (mod && !mod.chromium && mod.default && mod.default.chromium ? mod.default : mod);
  try {
    return { module: norm(await import('playwright')), source: 'global' };
  } catch { /* not resolvable from the skill/global scope — try the repo */ }
  try {
    const req = createRequire(path.join(cwd || process.cwd(), 'package.json'));
    const entry = req.resolve('playwright');
    return { module: norm(await import(pathToFileURL(entry).href)), source: 'repo' };
  } catch {
    return { module: null, source: null };
  }
}

// Portable headless launch args. WSL/Snap/Docker/CI all tend to hang or crash on a
// bare `chromium.launch()` — the sandbox can't initialize and the default /dev/shm is
// too small. This set is the standard fix and is harmless on a normal desktop, so we
// always apply it. Both the probe and the real capture launch through `launchForCapture`
// so a green `vbrt doctor` genuinely predicts that `vbrt shot` will work.
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

// Launch the first browser that actually starts, trying portable candidates in order:
// Playwright's bundled chromium first (most reproducible across machines), then a
// system Chrome channel if one is installed. Returns the live browser + which won, so
// the probe can report it. Throws the last error if nothing launches.
async function launchForCapture(pw) {
  const candidates = [
    { which: 'bundled chromium', opts: { args: LAUNCH_ARGS, chromiumSandbox: false } },
    { which: 'system chrome', opts: { channel: 'chrome', args: LAUNCH_ARGS, chromiumSandbox: false } },
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      return { browser: await pw.chromium.launch(c.opts), which: c.which };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no working chromium');
}

// One message for the "no headless capture available" case — tells the agent the
// two things that actually work and the two things that don't (so it stops trying
// to patch NODE_PATH or the skill install, the costly detour we saw in practice).
const PW_HELP =
  'Headless capture needs Playwright + a browser. Easiest: run `vbrt doctor --fix`\n' +
  '  (installs Playwright + chromium in THIS repo), then re-run the same `vbrt shot`.\n' +
  '  Manual equivalent: `npm i -D playwright && npx playwright install chromium`.\n' +
  '  Or skip headless capture entirely: take the screenshot/clip yourself and register the\n' +
  '  file with `vbrt shot ./shot.png --label after` (also accepts .gif / .webm).\n' +
  '  Do NOT edit NODE_PATH or the skill install — that is never the fix.';

// Probe what capture can actually do from here, for `vbrt doctor`. Resolves
// Playwright and (if found) launches a browser the SAME way capture will — the
// browser binary is a separate install, and a bare launch can hang where a hardened
// one works, so "module present" (or even "default launch") isn't enough to trust.
export async function captureCapabilities(cwd) {
  const out = { playwright: false, source: null, chromium: false, browser: null, ffmpeg: hasFfmpeg(), error: null };
  const { module: pw, source } = await resolvePlaywright(cwd);
  if (!pw) return out;
  out.playwright = true;
  out.source = source;
  try {
    const { browser, which } = await launchForCapture(pw);
    await browser.close();
    out.chromium = true;
    out.browser = which;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

// `doctor --fix`: install Playwright (as a repo dev-dep) and the chromium binary when
// capture isn't ready. Explicit and opt-in — never runs as a side effect of `shot`.
// Streams install output through `log`; returns a fresh probe so the caller can
// confirm capture now works. Resolves Playwright from the repo afterward, matching
// where `captureUrl`/`captureClip` look.
export async function installCapture(cwd, log = () => {}) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
  const before = await captureCapabilities(cwd);
  if (!before.playwright) {
    log('• installing Playwright (repo dev dependency)…');
    run('npm', ['i', '-D', 'playwright']);
  } else {
    log(`• Playwright already present (${before.source})`);
  }
  log('• installing the chromium browser binary…');
  run('npx', ['--yes', 'playwright', 'install', 'chromium']);
  return captureCapabilities(cwd);
}

function gitHead(cwd) {
  try {
    // stderr ignored: before the first commit, `rev-parse HEAD` prints
    // "fatal: Needed a single revision" — expected, not an error to surface.
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Keep runtime evidence out of git without making the agent think about it: ensure
// the whole `.vbrt/` dir is ignored the first time we write a capture. Idempotent.
function ensureGitignore(cwd) {
  const gi = path.join(cwd, '.gitignore');
  try {
    let body = '';
    try { body = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
    if (/^\.vbrt\/?\s*$/m.test(body)) return; // already ignored
    const prefix = body && !body.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gi, `${prefix}# VibeRate runtime evidence (screenshots, clips, watch lock)\n.vbrt/\n`);
  } catch {
    /* best-effort: a missing .gitignore just means evidence may show as untracked */
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

// Drive the page to the state we actually want to capture before shooting: click
// selectors in order (Playwright auto-waits for each to be actionable), then wait
// for a final selector — or a bare millisecond delay if `wait` is all digits. This
// is a thin pass-through to page.click / page.waitForSelector, the cheap way to
// reach a state a URL alone can't (open a modal, click into a view) without the
// agent hand-rolling a browser script. `click` may be a single selector or a list
// (applied in sequence, e.g. open a menu → pick an item).
async function applyInteractions(page, { click, wait } = {}) {
  const clicks = (click == null ? [] : Array.isArray(click) ? click : [click]).filter((s) => s && s !== true);
  for (const sel of clicks) {
    await page.click(String(sel), { timeout: 10000 });
    await page.waitForTimeout(250); // small settle so the next click / the shot sees the result
  }
  if (wait != null && wait !== true) {
    const w = String(wait);
    if (/^\d+$/.test(w)) await page.waitForTimeout(Number(w));
    else await page.waitForSelector(w, { timeout: 10000 });
  }
}

// In a Drive container, the public preview route (VBRT_PREVIEW_BASE) is admin-gated,
// and a headless browser carries no admin cookie → 403. The same route admits loopback
// peers, so rewrite a target that points at this session's public preview base to the
// loopback mirror the runtime injected (VBRT_PREVIEW_LOOPBACK). The bytes are identical
// (both read the same workspace off the shared volume). No-op outside Drive, or for any
// other URL (localhost, the deployed app, etc.).
function toCaptureUrl(url) {
  const base = process.env.VBRT_PREVIEW_BASE;
  const loop = process.env.VBRT_PREVIEW_LOOPBACK;
  if (base && loop && typeof url === 'string' && url.startsWith(base)) {
    return loop + url.slice(base.length);
  }
  return url;
}

// Capture a URL with Playwright *if it's installed*; otherwise tell the caller to
// pass --image with a screenshot the agent already took. The lazy import keeps the
// pushed skill bundle dependency-free (same pattern as @inquirer/express).
async function captureUrl(url, viewport, cwd, interact = null) {
  const { module: pw } = await resolvePlaywright(cwd);
  if (!pw) throw new Error(PW_HELP);
  const [w, h] = String(viewport || '1280x800').split('x').map(Number);
  const { browser } = await launchForCapture(pw);
  try {
    const page = await browser.newPage({ viewport: { width: w || 1280, height: h || 800 } });
    await page.goto(toCaptureUrl(url), { waitUntil: 'networkidle' });
    if (interact) await applyInteractions(page, interact);
    const buf = await page.screenshot({ type: 'png' });
    return `data:image/png;base64,${buf.toString('base64')}`;
  } finally {
    await browser.close();
  }
}

// Record a motion clip of a URL — **length tracks the actual motion**, not a fixed
// timer. We record from first paint and auto-stop once the page holds still, so a
// button toggle yields a ~1s loop and a long simulation runs out to the cap, with no
// per-app speed tuning (the failure mode that left 5s of static maze in a 6s clip).
// `seconds` is the upper bound. Playwright records native webm; with system ffmpeg we
// transcode to an animated gif. Returns { dataUrl, media, durationMs }.
async function captureClip(url, { viewport, seconds = 8, fps = 12, cwd, click = null, wait = null } = {}) {
  const { module: pw } = await resolvePlaywright(cwd);
  if (!pw) throw new Error(PW_HELP);
  const [w, h] = String(viewport || '960x600').split('x').map(Number);
  const width = w || 960;
  const height = h || 600;
  const capMs = Math.min(20, Math.max(1, Number(seconds) || 8)) * 1000; // hard upper bound
  const POLL_MS = 200;   // how often we compare frames for motion
  const STILL_MS = 700;  // "settled" once this long passes with no visible change
  const MIN_MS = 800;    // floor so even a quick toggle leaves a watchable loop
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbrt-clip-'));
  const { browser } = await launchForCapture(pw);
  let webmPath;
  let durationMs = 0;
  let settled = false;
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: tmp, size: { width, height } },
    });
    const page = await context.newPage();
    await page.goto(toCaptureUrl(url), { waitUntil: 'load' }); // start near first paint, not network-idle
    if (click || wait) await applyInteractions(page, { click, wait }); // e.g. click "play", then record the motion it triggers
    const video = page.video();
    // Compare successive frames; a small fixed-quality JPEG is byte-identical for
    // identical pixels, so equal buffers ⇒ nothing moved. Stop once the page has held
    // still for STILL_MS (past the MIN_MS floor), or at the cap for endless motion.
    const startedAt = Date.now();
    let prev = await page.screenshot({ type: 'jpeg', quality: 40 });
    let stillFor = 0;
    while (Date.now() - startedAt < capMs) {
      await page.waitForTimeout(POLL_MS);
      const frame = await page.screenshot({ type: 'jpeg', quality: 40 });
      stillFor = frame.equals(prev) ? stillFor + POLL_MS : 0;
      prev = frame;
      if (Date.now() - startedAt >= MIN_MS && stillFor >= STILL_MS) { settled = true; break; }
    }
    durationMs = Date.now() - startedAt;
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
      return { dataUrl: `data:image/gif;base64,${buf.toString('base64')}`, media: 'image', durationMs, settled };
    }
    const buf = fs.readFileSync(webmPath);
    if (buf.length > MAX_CLIP_BYTES) {
      throw new Error(`clip too large (${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_CLIP_BYTES / 1024)}KB cap) — try a shorter --clip or smaller --viewport`);
    }
    return { dataUrl: `data:video/webm;base64,${buf.toString('base64')}`, media: 'video', durationMs, settled };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Record one screenshot artifact into the repo's evidence sidecar. `target` is an
// image path or http(s) URL; `image` forces an explicit file. Binds to the active
// session so artifacts land on the right conversation even with several running.
export async function recordShot(cwd, { target, image, label = null, note = '', viewport = null, session = null, pair = null, clip = null, click = null, wait = null } = {}) {
  const dir = evidenceDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  ensureGitignore(cwd);

  const isUrl = target && /^https?:\/\//i.test(target);
  // media: 'image' (still or gif) renders in <img>; 'video' renders as <video>.
  const mediaOf = (src) => (/^data:video\//i.test(src) ? 'video' : 'image');
  let img;
  let media;
  let durationMs = null;
  let settled = false;
  if (clip) {
    if (!isUrl) throw new Error('--clip needs a URL to record (pass an http(s) URL)');
    const out = await captureClip(target, { viewport, seconds: clip === true ? 8 : Number(clip), cwd, click, wait });
    img = out.dataUrl;
    media = out.media;
    durationMs = out.durationMs;
    settled = out.settled;
  } else if (image) {
    img = dataUrl(image);
    media = mediaOf(img);
  } else if (isUrl) {
    img = await captureUrl(target, viewport, cwd, { click, wait });
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
  return { ...rec, file: path.join(dir, `${id}.json`), durationMs, settled };
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
