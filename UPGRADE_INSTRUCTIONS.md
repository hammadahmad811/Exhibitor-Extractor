# Exhibitor Extractor → Data Intelligence Platform
## Upgrade Instructions

---

## What you're getting

| File | Destination | Purpose |
|------|------------|---------|
| `database.js` | `backend/database.js` | SQLite schema + all query helpers |
| `historyRoutes.js` | `backend/routes/historyRoutes.js` | REST API for History Intelligence |
| `enrichmentService.js` | `backend/services/enrichmentService.js` | Website enrichment waterfall |
| `history.html` | `frontend/history.html` | History Intelligence page |
| `intelligence.html` | `frontend/intelligence.html` | Data Intelligence / Charts page |

---

## Step 1 — Install new dependencies

Open a terminal in `C:\exhibitor-extractor\` and run:

```bash
npm install better-sqlite3
```

That's the only new required package. `better-sqlite3` is synchronous, fast, and zero-config — the SQLite database file (`exhibitor_history.db`) will be created automatically in your `backend/` folder the first time you start the server.

**Optional** — for Google/Hunter enrichment, add these to your `.env` file (create it if it doesn't exist):
```
GOOGLE_SEARCH_API_KEY=your_key_here
GOOGLE_SEARCH_CX=your_search_engine_id
HUNTER_API_KEY=your_hunter_key
```

---

## Step 2 — Copy the new files

```
Copy database.js         →  C:\exhibitor-extractor\backend\database.js
Copy historyRoutes.js    →  C:\exhibitor-extractor\backend\routes\historyRoutes.js
Copy enrichmentService.js→  C:\exhibitor-extractor\backend\services\enrichmentService.js
Copy history.html        →  C:\exhibitor-extractor\frontend\history.html
Copy intelligence.html   →  C:\exhibitor-extractor\frontend\intelligence.html
```

Create the `routes/` and `services/` folders if they don't already exist.

---

## Step 3 — Patch your server.js

Open `C:\exhibitor-extractor\backend\server.js` and make these changes:

### 3a — Add imports at the top

```js
// Add these near your existing imports:
import historyRouter from './routes/historyRoutes.js';
import { saveExtraction } from './database.js';
import { enrichExtraction } from './services/enrichmentService.js';
```

### 3b — Register the history router

Add this line **after** `app.use(express.json())` and **before** your existing routes:

```js
app.use('/api/history', historyRouter);
```

### 3c — Auto-save extractions to the database

Find your existing scrape endpoint. It will look something like this:

```js
app.post('/api/scrape', async (req, res) => {
  // ...
  const exhibitors = await runScraper(url, urlType, onProgress);
  res.json({ exhibitors });   // ← find this line
});
```

Add the save call **right before** you send the response:

```js
app.post('/api/scrape', async (req, res) => {
  const { url, urlType } = req.body;
  // ... your existing scraping code ...
  
  const exhibitors = await runScraper(url, urlType, onProgress);

  // ── NEW: Auto-save to history database ──────────────────────────
  try {
    const eventName = req.body.eventName || new URL(url).hostname;
    const platform  = detectPlatform(url);   // you already have this function
    saveExtraction({ eventName, sourceUrl: url, platform, exhibitors });
    console.log(`  [DB] Saved ${exhibitors.length} exhibitors to history`);
  } catch (dbErr) {
    console.warn('  [DB] Failed to save extraction:', dbErr.message);
    // Non-fatal — scrape still returns results even if DB save fails
  }
  // ────────────────────────────────────────────────────────────────

  res.json({ exhibitors });
});
```

> **Note:** If your scrape endpoint uses SSE (Server-Sent Events) for progress streaming rather than a plain `res.json()`, just add the `saveExtraction()` call right before you send the final `data: done` event.

### 3d — Add the enrichment endpoint

Add this new route to `server.js`:

```js
// POST /api/history/enrich/:extractionId  — streaming SSE enrichment
app.post('/api/history/enrich/:extractionId', async (req, res) => {
  const extractionId = Number(req.params.extractionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const result = await enrichExtraction(extractionId, (done2, total, name) => {
      res.write(`data: ${JSON.stringify({ done2, total, name })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});
```

---

## Step 4 — Add nav links to your existing pages (optional)

If you want the top navigation bar to appear on your existing extractor page, add this to the top of your main `index.html` (just inside `<body>`):

```html
<nav style="background:#0d1117;border-bottom:1px solid #2d3748;padding:0 24px;display:flex;gap:0;font-family:'Segoe UI',system-ui,sans-serif">
  <a href="index.html"        style="padding:12px 16px;font-size:13px;color:#4299e1;border-bottom:2px solid #4299e1;text-decoration:none">⚡ Extractor</a>
  <a href="history.html"      style="padding:12px 16px;font-size:13px;color:#718096;text-decoration:none">📋 History</a>
  <a href="intelligence.html" style="padding:12px 16px;font-size:13px;color:#718096;text-decoration:none">📊 Intelligence</a>
</nav>
```

---

## Step 5 — Restart the server

```bash
# In C:\exhibitor-extractor\
node backend/server.js
```

or if you use nodemon:
```bash
nodemon backend/server.js
```

The database file `backend/exhibitor_history.db` will be created automatically.

---

## Verify it's working

1. Open your extractor and run any extraction
2. Navigate to `http://localhost:PORT/history.html`
3. You should see the event appear in the sidebar
4. Click it → click the extraction → exhibitor table loads
5. Navigate to `http://localhost:PORT/intelligence.html` → stats appear

---

## How the features work

### History Intelligence (`history.html`)
- **Sidebar** shows all events grouped by URL slug
- **Click an event** to see its extraction timeline
- **Checkboxes** on each timeline row to select 2 extractions → click **Compare**
- **Compare** shows a delta report: new/removed/updated exhibitors, website gain %
- **Enrich** button opens the enrichment panel for any extraction
- **Export CSV** downloads exhibitors for any extraction
- **Rename / Delete** buttons for event and extraction management

### Data Intelligence (`intelligence.html`)
- **Overview cards** — total events, extractions, exhibitors, website coverage %
- **Event selector** — pick any event to see its trend charts
- **4 charts** — count over time, website % over time, platform distribution, stacked completeness
- **Global search** — search exhibitor names/websites across all extractions

### Website Enrichment (`enrichmentService.js`)
Waterfall order:
1. **Clearbit** (free, no key needed) — company domain autocomplete
2. **Google Custom Search** (requires `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX`)
3. **Hunter.io** (requires `HUNTER_API_KEY`) — domain search by company name

Enrichment saves confidence score (0–1) and source per exhibitor. Only saves if confidence ≥ 0.5.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module 'better-sqlite3'` | Run `npm install better-sqlite3` in project root |
| History page shows nothing | Make sure Step 3c is done and you've run at least one extraction |
| `historyRoutes is not a module` | Ensure your `package.json` has `"type": "module"` |
| Charts don't appear | Select an event from the dropdown first |
| Enrichment does nothing | Clearbit requires internet access; Google/Hunter need API keys in `.env` |
| DB file permissions error | Make sure `backend/` folder is writable |
