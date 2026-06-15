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

## 4. Deploy

```bash
fly deploy
```

Then verify:

```bash
fly open                       # opens https://<app>.fly.dev
curl https://<app>.fly.dev/healthz     # -> {"ok":true,"schema":1}
```

## 5. Point the push client at it + do a real push

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
- **Scale-to-zero** is on (`min_machines_running = 0`) to save money; the first
  request after idle cold-starts the machine. Set it to `1` for always-on.
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
