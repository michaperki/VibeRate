# VibeRate hosted server — pure Node + Express. The push client needs no build
# step; the server just serves the SPA and the ingest/read API.
FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer is cached unless the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what's excluded).
COPY . .

# Fly's proxy routes to this port; bin/vbrt.js reads PORT. VBRT_DATA_DIR points
# at the mounted volume (see fly.toml) so pushed projects survive redeploys.
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
