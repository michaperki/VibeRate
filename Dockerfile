# VibeRate hosted server. Debian (glibc) base rather than alpine (musl) because
# the Drive runtime spawns the real `claude` CLI, whose native binary needs glibc.
FROM node:20-slim

# git: driven agents clone/operate on repos under the Drive workdir.
# ca-certificates: TLS for the Anthropic API and git over https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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
