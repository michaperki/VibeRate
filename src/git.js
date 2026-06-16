import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const US = '\x1f'; // unit separator between fields
const SENT = '@@@C@@@'; // record sentinel between commits

// git --name-status status letter → a label the UI can badge (and the brain
// timeline can read as a lifecycle event: born / changed / archived).
const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' };

// Extract commit history for a repo at `cwd`. Returns null if it isn't a git
// repo (or git is unavailable). Commits are newest-first, capped at `max`.
// Each commit records `files` (total changed) and `docs` — the markdown files it
// changed, each `{ name, status }` — so the timeline can show *when* and *how* the
// brain changed (added/modified/deleted). What counts as "brain" is decided in the
// viewer (intersecting with the captured doc graph), so we keep all .md here.
export async function extractGit(cwd, max = 4000) {
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  try {
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'log', `-${max}`, '--no-color', '--name-status', `--pretty=format:${SENT}%H${US}%ct${US}%P${US}%s`],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const commits = stdout
      .split(SENT)
      .map((rec) => rec.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const lines = rec.split('\n');
        const [hash, ct, parents, subject = ''] = lines[0].split(US);
        const parentCount = (parents || '').trim().split(/\s+/).filter(Boolean).length;
        // Each file line: "M\tpath", "A\tpath", or "R100\told\tnew" (use new path).
        const fileLines = lines.slice(1).map((s) => s.trim()).filter(Boolean);
        const docs = [];
        for (const line of fileLines) {
          const parts = line.split('\t');
          const letter = parts[0][0];
          const name = parts[parts.length - 1];
          if (/\.md$/i.test(name)) docs.push({ name, status: STATUS[letter] || 'modified' });
        }
        const c = {
          hash: hash.slice(0, 8),
          t: Number(ct) * 1000,
          subject,
          files: fileLines.length,
          isMerge: parentCount > 1,
          isRevert: /^Revert\b/i.test(subject),
        };
        if (docs.length) c.docs = docs;
        return c;
      })
      .filter((c) => !Number.isNaN(c.t));
    return { cwd, capturedAt: new Date().toISOString(), commits };
  } catch {
    return null;
  }
}
