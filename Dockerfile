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
# chromium needs; this installs exactly them. The chromium *binary* is baked below
# (post-pivot: Drive is the core, so in-container capture must work out of the box —
# we no longer defer the browser to a per-workspace `vbrt doctor --fix`, which can't
# bootstrap in the sandboxed Drive shell anyway).
RUN npx --yes playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /app

# Where the baked chromium lives (and where evidence.js's launched browser looks at
# runtime — the ENV is inherited by the spawned agent's `vbrt shot`).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install deps first so this layer is cached unless the lockfile changes. `playwright`
# is a regular dependency now, so `evidence.js` resolves it from /app/node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bake the chromium binary into the image (pinned to the installed playwright), so the
# first `vbrt shot` in any Drive workspace captures immediately — no download, no
# per-turn cache wipe, no admin-gated bootstrap.
RUN npx playwright install chromium

# The Claude Code CLI, on PATH as `claude` — what src/agent.js spawns (Fork A).
#
# AUTO-LATEST, DETERMINISTICALLY (PLAN_HARNESS_VERSIONING.md WS2). This `RUN` text
# never changes, so Docker would re-run it only on a cache *miss* — meaning a
# redeploy updates Claude Code nondeterministically (warm cache → old version kept).
# `CLAUDE_CACHE_BUST` makes "I am updating the harness" a deliberate, logged act:
# bump it (via `vbrt harness bump`, WS4) and this layer re-pulls @latest every time.
# We also record the resolved version into the image (/opt/vbrt/harness.json) so the
# server (src/harness.js) and the harness rail know what's installed before any
# session runs — no `claude --version` subprocess needed at boot.
ARG CLAUDE_CACHE_BUST=0
RUN echo "harness cache-bust: ${CLAUDE_CACHE_BUST}" \
  && npm install -g @anthropic-ai/claude-code \
  && mkdir -p /opt/vbrt \
  && printf '{"claude":"%s"}\n' "$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" > /opt/vbrt/harness.json \
  && cat /opt/vbrt/harness.json

# App source (see .dockerignore for what's excluded).
COPY . .

# Put `vbrt` on PATH so a driven agent runs `vbrt shot`/`vbrt doctor` as documented,
# not `node bin/vbrt.js` (past Drive sessions burned turns on this). bin/vbrt.js
# resolves its deps against /app/node_modules via the symlink target.
RUN chmod +x /app/bin/vbrt.js && ln -sf /app/bin/vbrt.js /usr/local/bin/vbrt

# Fly's proxy routes to this port; bin/vbrt.js reads PORT. VBRT_DATA_DIR points
# at the mounted volume (see fly.toml) so pushed projects survive redeploys.
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
