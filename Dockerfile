# ── Exhibitor Extractor — Production Dockerfile ───────────────────────────────
# Builds the React frontend, then serves it from the Express backend.
# Uses system Chromium so Playwright doesn't need to download a browser bundle.
#
# Railway auto-detects this file and builds/runs the container.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-bookworm-slim

# ── System Chromium + headless browser dependencies ────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      wget \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to skip downloading its bundled browser (we use system Chromium)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

# ── 1. Build the React frontend ───────────────────────────────────────────────
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend/ ./frontend/
RUN cd frontend && npm run build
# Result: /app/frontend/dist/  (served as static files by Express)

# ── 2. Install backend production dependencies ────────────────────────────────
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/ ./backend/

# Ensure the data directory exists (Railway volume will be mounted here)
RUN mkdir -p /data

EXPOSE 3001

# Health-check so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "backend/server.js"]
