import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const US = '\x1f'; // unit separator between fields
const SENT = '@@@C@@@'; // record sentinel between commits

// Agent/"brain" doc filenames whose changes we mark on the timeline.
const BRAIN_DOCS = new Set([
  'soul.md', 'agents.md', 'agent.md', 'claude.md', 'claude.local.md', 'seed.md',
  'context.md', 'memory.md', 'backlog.md', 'decisions.md', 'attempts.md',
  'log.md', 'roadmap.md', 'project.md', 'tasks.md',
]);

// Extract commit history for a repo at `cwd`. Returns null if it isn't a git
// repo (or git is unavailable). Commits are newest-first, capped at `max`.
// Each commit also records `docs` — the agent/brain markdown files it changed
// (omitted when none), so the timeline can show when the "brain" changed.
export async function extractGit(cwd, max = 4000) {
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  try {
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'log', `-${max}`, '--no-color', '--name-only', `--pretty=format:${SENT}%H${US}%ct${US}%P${US}%s`],
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
        const files = lines.slice(1).map((s) => s.trim()).filter(Boolean);
        const docs = files.filter((f) => BRAIN_DOCS.has(f.split('/').pop().toLowerCase()));
        const c = {
          hash: hash.slice(0, 8),
          t: Number(ct) * 1000,
          subject,
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
