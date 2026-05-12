# ── Exhibitor Extractor — Production Dockerfile ───────────────────────────────
# Builds the React frontend, then serves it from the Express backend.
# Playwright installs its own bundled Chromium during the Docker build.
#
# Railway auto-detects this file and builds/runs the container.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-bookworm-slim

# ── Minimal system packages needed before npx can run ────────────────────────
# npx playwright install --with-deps (step 3) installs all browser dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      wget \
    && rm -rf /var/lib/apt/lists/*

ENV PORT=3001
# NOTE: NODE_ENV is intentionally NOT set here.
# Setting NODE_ENV=production before "npm ci" causes npm to skip devDependencies
# (including vite), which breaks the frontend build.
# NODE_ENV=production is set at runtime via Railway environment variables instead.

WORKDIR /app

# ── 1. Build the React frontend ───────────────────────────────────────────────
# Run npm ci WITHOUT NODE_ENV=production so devDependencies (vite, tailwind, etc.)
# are installed and the build can complete successfully.
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend/ ./frontend/
RUN cd frontend && npm run build
# Result: /app/frontend/dist/  (served as static files by Express)

# ── 2. Install backend production dependencies ────────────────────────────────
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# ── 3. Install Playwright's bundled Chromium + all its system dependencies ────
# This downloads the exact Chromium build Playwright expects and installs
# all required OS libraries — far more reliable than using system Chromium.
RUN cd backend && npx playwright install chromium --with-deps

COPY backend/ ./backend/

# Ensure the data directory exists (Railway volume will be mounted here)
RUN mkdir -p /data

EXPOSE 3001

# Health-check so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "backend/server.js"]
