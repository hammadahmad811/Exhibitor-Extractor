# Deployment Guide — Exhibitor Extractor

## Why Railway (not Vercel alone)

| Your app needs | Vercel | Railway |
|---|---|---|
| Playwright + Chromium (~300 MB) | 50 MB function limit | Full Docker support |
| SQLite persistent database | Stateless (resets on deploy) | Persistent volumes |
| SSE streams (2–10 min scraping) | ~10 s function timeout | Always-on process |
| Scheduler (`setInterval`) | No persistent process | Always-on process |
| Node 24 (`node:sqlite` built-in) | Max Node 22 | Any version |

**Architecture used here:** GitHub + Railway (full stack, single service, one URL).

---

## Step 1 — Push to GitHub

### 1a. Create a GitHub repository

1. Go to https://github.com/new
2. Name it `exhibitor-extractor` (or anything you like)
3. Set it to **Private** (recommended — your scraper logic is proprietary)
4. Do NOT initialise with README (you already have files)
5. Click **Create repository**

### 1b. Initialise git and push (run in your project folder)

Open a terminal / cmd in the `exhibitor-extractor` folder and run these commands one by one:

```bash
git init
git add .
git commit -m "Initial commit — Exhibitor Extractor v2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/exhibitor-extractor.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

After this your code is on GitHub and auto-deploy will trigger on every future `git push`.

---

## Step 2 — Deploy to Railway

### 2a. Create a Railway account

Go to https://railway.app and sign up with your GitHub account (free).

### 2b. Create a new project from GitHub

1. Click **New Project**
2. Choose **Deploy from GitHub repo**
3. Select `exhibitor-extractor`
4. Railway detects the `Dockerfile` automatically

### 2c. Set environment variables

In Railway: **your service → Variables tab → Add variable**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `CHROMIUM_PATH` | `/usr/bin/chromium` |
| `ALLOWED_ORIGINS` | `*` |
| `DATA_DIR` | `/data` |

### 2d. Create a persistent volume for the database

Without a volume, the SQLite database resets on every redeploy.

1. In Railway: **your service → Settings → Volumes**
2. Click **Add Volume**
3. Mount path: `/data`
4. Railway auto-attaches and persists this directory

### 2e. Get your live URL

Railway: **your service → Settings → Networking → Generate Domain**

You'll get a URL like `https://exhibitor-extractor-production.up.railway.app`.

That's your live app. Visit it in the browser — the full UI is served from there.

---

## Step 3 — Auto-Deploy is already configured

Every time you push to the `main` branch:

```bash
git add .
git commit -m "your message"
git push
```

Railway detects the push → rebuilds the Docker image → deploys the new version.
Zero manual steps required.

The GitHub Actions CI workflow (`.github/workflows/ci.yml`) also runs on every push
to confirm the frontend builds successfully before Railway deploys.

---

## Future update workflow

When you ask for a new feature, bug fix, or UI change:

1. Code is updated in the workspace
2. You run:
   ```bash
   git add .
   git commit -m "feat: describe the change"
   git push
   ```
3. Railway auto-deploys within ~3 minutes
4. Your live URL is updated

---

## Optional — Also deploy frontend to Vercel (custom domain / CDN)

If you want a custom domain or Vercel's global CDN for the UI, you can deploy
**only the frontend** to Vercel while keeping the backend on Railway.

### Steps

1. Go to https://vercel.com → **New Project** → import `exhibitor-extractor`
2. Set **Root Directory** to `frontend`
3. Framework: **Vite**
4. Build command: `npm run build`
5. Output directory: `dist`
6. Add environment variable:
   - `VITE_API_URL` = `https://your-app.railway.app` (your Railway URL)

Then in `backend/server.js`, update `ALLOWED_ORIGINS` in Railway variables to:
```
https://your-app.vercel.app
```

Update `frontend/src/App.jsx` line 11:
```js
const API = import.meta.env.VITE_API_URL || '';
```

> Note: With this setup, SSE scraping streams go directly to Railway (not through Vercel),
> which means long extractions will work without any timeout.

---

## Local development (unchanged)

```bash
# Terminal 1 — backend
cd backend
node server.js

# Terminal 2 — frontend  
cd frontend
npm run dev
```

Frontend at http://localhost:5173, backend at http://localhost:3001.
Vite proxies all `/api/*` calls to the backend automatically.
