# Deploying VibeRate to Fly.io

The server is a stateful Express app: it stores each pushed project as JSON files
under `VBRT_DATA_DIR`. On Fly that path is a **persistent volume**, so projects
survive redeploys. Config lives in [`Dockerfile`](./Dockerfile) and
[`fly.toml`](./fly.toml).

> These commands are tied to your Fly account, so run them yourself. In this
> Claude Code session you can prefix a command with `!` to run it inline.

## 1. Install flyctl + log in

```bash
# WSL / Linux / macOS:
curl -L https://fly.io/install.sh | sh
# (Windows PowerShell alternative:  iwr https://fly.io/install.ps1 -useb | iex)

fly auth login          # opens a browser
```

## 2. Create the app

`app` in `fly.toml` is `viberate`; app names are globally unique on Fly. If it's
taken, edit `app = "..."` to something free (your URL becomes `<app>.fly.dev`).

```bash
fly apps create vbrt     # use the same name as in fly.toml (URL: vbrt.fly.dev)
```

## 3. Create the persistent volume

Must match `[mounts].source` in `fly.toml` and the app's `primary_region`.

```bash
fly volumes create viberate_data --region fra --size 1   # 1 GB; resize later
```

## 4. Set secrets

Secrets are encrypted and injected as env vars (separate from the non-sensitive
`[env]` block in `fly.toml`). Setting any secret triggers a redeploy.

```bash
# Session signing + OAuth sign-in (hosted mode gates the dashboard + Drive):
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
fly secrets set GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...

# Haiku prompt classifier (also the API-billing fallback for Drive):
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
```

**Drive auth (admin-only).** Drive — the RCE control plane — is gated to the
emails in `VBRT_ADMIN_EMAILS` (set in `fly.toml`). By default a hosted Drive turn
bills the `ANTHROPIC_API_KEY` above. To instead run Drive on **your Claude
subscription**, seed your local login as a secret: `src/agent.js`
(`ensureSubscriptionCredentials`) writes it into `CLAUDE_CONFIG_DIR`
(`/data/claude`, on the volume so a refreshed token survives restarts) at boot,
and strips the API key from Drive turns so the OAuth login wins.

```bash
fly secrets set CLAUDE_CREDENTIALS_JSON="$(cat ~/.claude/.credentials.json)"
```

This is a full-account bearer token — **operator-only**; never collect it from
other users (multi-user Drive should use per-user API keys).

When the seeded token goes invalid (Drive turns fail with `401 Invalid
authentication credentials`), re-seed from a fresh `claude login` — just rotate
the secret:

```bash
fly secrets set CLAUDE_CREDENTIALS_JSON="$(cat ~/.claude/.credentials.json)"
```

The seed is **self-healing** (`ensureSubscriptionCredentials`): on boot it
overwrites the on-disk copy whenever the secret's token is fresher (higher
`expiresAt`), so a rotated secret takes over on the next restart — no manual
`rm /data/claude/.credentials.json` needed. (It never overwrites a *newer*
on-disk token, i.e. one the CLI refreshed in place.) `fly secrets set` triggers a
machine restart, which is what runs the re-seed.

**Why this keeps happening:** the OAuth refresh token is single-use/rotating, so
using the *same* Max account locally (or anywhere else) invalidates the hosted
instance's copy. To stop fighting it long-term, give the hosted instance its own
dedicated login (a separate account or a BYO `ANTHROPIC_API_KEY`) so local use
can't knock it offline.

**Drive workspaces (per-project checkouts).** Driving "in project X" runs the agent
in X's **git checkout on the volume** (`PLAN_DRIVE_WORKSPACES.md`). The first time
you Drive a project, the UI's *Set up workspace* step clones its repo into
`VBRT_WORKSPACES_DIR` (default `/data/workspaces/<slug>`, on the volume so it
survives restarts) — once, not per conversation. For **private** repos — and to let
the Drive agent **push** the branches it produces — set a GitHub token secret:

```bash
fly secrets set GITHUB_TOKEN=ghp_...   # repo-scoped PAT (or a fine-grained token)
```

At boot, `ensureGitAuth` (`src/agent.js`) registers a global git **credential
helper** that serves this token for any `github.com` https operation, so both
`git clone` (private repos) and `git push` (the agent landing its own work)
authenticate — without the token ever being written to a repo's `.git/config` or
any file; only the helper-script reference lives in `~/.gitconfig`. It also sets a
default commit identity (`VibeRate Drive <drive@viberate.local>`, override with
`VBRT_GIT_AUTHOR_NAME` / `VBRT_GIT_AUTHOR_EMAIL`) so the agent's commits don't fail
with *"Author identity unknown"*. Without the secret it's a no-op — local/loopback
Drive uses your own git config. This is a distinct secret from
`CLAUDE_CREDENTIALS_JSON`; the two are seeded separately on purpose.

## 5. Deploy

```bash
fly deploy
```

Then verify:

```bash
fly open                       # opens https://<app>.fly.dev
curl https://<app>.fly.dev/healthz     # -> {"ok":true,"schema":1}
```

## 6. Point the push client at it + do a real push

From any repo with captured sessions:

```bash
export VBRT_API_URL=https://<app>.fly.dev
vbrt push --all
```

The first push to a host **mints an owner token**, saves it to
`~/.viberate/credentials.json`, and prints:

- a shareable `/p/<id>` link (public — anyone with it can view), and
- `Your projects: https://<app>.fly.dev/app` — the token-scoped dashboard.

Every later push sends that saved token, so all your projects group under one
owner. Open `/app` and paste the token (or visit `/app#<token>`) to list them.

## Hosted vs local mode

`VBRT_HOSTED=1` (set in `fly.toml`) makes the server multi-tenant:

| | `/` | project list | who can enumerate |
|---|---|---|---|
| **Hosted** (`VBRT_HOSTED=1`) | public landing page | `/app`, token-scoped | only the owner |
| **Local** (`vbrt serve`) | workspace home (SPA) | everything on the machine | n/a |

Single-project pages (`/p/<id>`) are always public — the unguessable id is the
share secret.

## Notes & next steps

- **One machine only.** A Fly volume can't be shared, so keep a single machine
  (don't `fly scale count 2`). Scaling horizontally later means moving the store
  off the local filesystem (e.g. a DB or object storage).
- **Always-on, single machine.** `auto_stop_machines = "off"` with
  `min_machines_running = 1`: Drive holds interactive session state (resume ids,
  in-flight `ask` round-trips) in memory, so the machine must not scale to zero
  mid-conversation. Switch back to scale-to-zero only if you run share-only (no
  Drive).
- **Backups:** `fly volumes` snapshots the disk daily by default; verify with
  `fly volumes list` / `fly volumes snapshots list <vol-id>`.
- **Custom domain** (when ready): `fly certs add viberate.app`, then point DNS
  per the instructions `fly certs show viberate.app` prints.
- **Pre-`VBRT_HOSTED` pushes have no owner** and won't appear in any dashboard
  (still reachable by their `/p/<id>` link). Re-push to bring them under your token.
- **Before sharing widely:** consider rate-limiting `POST /api/projects` and a
  `vbrt push --dry-run` redaction preview so users see exactly what leaves their
  machine. A real account system (e.g. GitHub OAuth) can later bind an owner
  hash to an identity without reshaping storage.
