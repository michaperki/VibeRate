# VibeRate hosted server. Debian (glibc) base rather than alpine (musl) because
# the Drive runtime spawns the real `claude` CLI, whose native binary needs glibc.
FROM node:20-slim

# Drive runtime toolbelt. git: driven agents clone/operate on repos under the
# Drive workdir. ca-certificates: TLS for the Anthropic API and git over https.
# curl + jq: HTTP/JSON probing (agents reflexively reach for these — without them
# every server check 127s and gets rewritten as inline node). ffmpeg: `vbrt shot
# --clip` encodes gifs (falls back to webm without it). gh: lets driven agents
# watch CI / open PRs instead of hand-rolling background poll loops. gh isn't in
# Debian's default repos, so add its apt source (curl, installed just above, fetches
# the key).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl jq ffmpeg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Headless-capture system libraries (chromium's shared .so deps + fonts) so `vbrt
# shot` can screenshot/clip agent-built UI in Drive — the deepest gap for a tool
# whose whole job is visual dashboards. node:20-slim lacks the libs a launched
# chromium needs; this installs exactly them. The chromium *binary* and the
# playwright npm package are installed per-workspace on demand by `vbrt doctor
# --fix` (evidence.js resolves playwright from the workspace's own node_modules) —
# we deliberately don't bake a ~150MB browser into every image layer here. Isolated
# layer: drop it if the image must slim down (capture then falls back to having the
# agent register a file with `vbrt shot ./shot.png`).
RUN npx --yes playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /app

# Install deps first so this layer is cached unless the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The Claude Code CLI, on PATH as `claude` — what src/agent.js spawns (Fork A).
RUN npm install -g @anthropic-ai/claude-code

# App source (see .dockerignore for what's excluded).
COPY . .

# Fly's proxy routes to this port; bin/vbrt.js reads PORT. VBRT_DATA_DIR points
# at the mounted volume (see fly.toml) so pushed projects survive redeploys.
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
