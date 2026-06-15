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
vbrt push --all                # prints a shareable /p/<id> link
```

Open the link to confirm sessions, git timeline, docs, and memory render.

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
- **Auth:** ingest is anonymous (gist-style) in v1. Before sharing widely,
  consider rate-limiting `POST /api/projects` and the `--dry-run` redaction
  preview so users can see exactly what leaves their machine.
