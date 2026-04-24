# 🏢 Exhibitor Extractor

A full-stack web app that intelligently scrapes exhibitor data from event websites — floor plans or directories — and exports to Excel/CSV.

---

## ✨ Features

- **Smart scraping** — Playwright (JS-rendered) + Cheerio (static HTML)
- **Auto URL detection** — detects floor plans vs. exhibitor directories
- **Multi-strategy extraction** — API intercept → embedded JSON → HTML cards → tables → heuristics
- **Pagination handling** — follows "next" buttons and URL-based pages
- **Data table** — search, sort, paginate across all results
- **Export** — Excel (.xlsx) and CSV with event metadata
- **History** — saves past extractions locally, load or delete anytime
- **Batch URLs** — submit multiple URLs for one event, results are merged

---

## 🗂 Project Structure

```
exhibitor-extractor/
├── backend/                  # Node.js + Express API
│   ├── server.js
│   ├── routes/extract.js     # /api/extract, /api/history
│   ├── scrapers/
│   │   └── smartScraper.js   # Playwright + Cheerio engine
│   ├── utils/
│   │   ├── urlDetector.js
│   │   ├── dataNormalizer.js
│   │   └── historyManager.js
│   └── data/history.json     # auto-created on first run
│
└── frontend/                 # React + Vite + Tailwind
    └── src/
        ├── App.jsx
        ├── components/
        │   ├── InputForm.jsx
        │   ├── DataTable.jsx
        │   ├── ExportButtons.jsx
        │   ├── HistoryPanel.jsx
        │   └── StatusBanner.jsx
        └── utils/urlDetector.js
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 18+** — [nodejs.org](https://nodejs.org)

### 1. Install backend dependencies

```bash
cd backend
npm install
npx playwright install chromium
```

> `npx playwright install chromium` downloads the headless browser (~170 MB). Only needed once.

### 2. Install frontend dependencies

```bash
cd frontend
npm install
```

### 3. Start the backend (Terminal 1)

```bash
cd backend
npm start
# → API running at http://localhost:3001
```

### 4. Start the frontend (Terminal 2)

```bash
cd frontend
npm run dev
# → App running at http://localhost:5173
```

### 5. Open the app

Navigate to **http://localhost:5173** in your browser.

---

## 🧪 How to Use

1. Enter your **Event Name** (e.g. "CES 2025")
2. Paste an **Exhibitor Directory URL** or **Floor Plan URL**
3. Optionally add more URLs with **"Add another URL"**
4. Click **Extract Exhibitors**
5. Watch the live progress bar
6. Browse results in the table (search/sort/paginate)
7. Click **Excel** or **CSV** to download

---

## 🔍 What It Extracts

| Field | Source |
|---|---|
| Exhibitor Name | Company/exhibitor name |
| Booth Number | Booth/stand/hall identifier |
| Booth Size | Dimensions if available |
| Category | Industry category if available |
| Website | Company URL if available |
| Description | Short bio if available |

---

## ⚙️ Configuration

| Setting | Default | Where |
|---|---|---|
| Backend port | `3001` | `backend/server.js` |
| Frontend port | `5173` | `frontend/vite.config.js` |
| Max pages scraped | `25` | `backend/scrapers/smartScraper.js` |
| History limit | `50` | `backend/utils/historyManager.js` |
| Delay between pages | `1.2s` | `backend/scrapers/smartScraper.js` |

---

## 🛠 Troubleshooting

**"No exhibitors found"**
- The site may use heavy anti-scraping measures
- Try the exhibitor directory URL instead of the floor plan (usually more data-rich)
- Some event platforms require login — extracting requires being logged in

**Playwright not found**
```bash
cd backend && npx playwright install chromium
```

**CORS error**
- Make sure both backend (`:3001`) and frontend (`:5173`) are running

**Slow scraping**
- Normal — Playwright launches a real browser and waits for JS rendering
- Larger directories with many pages will take longer

---

## 📦 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS |
| Backend | Node.js 18+, Express 4 |
| Scraping | Playwright (Chromium), Cheerio |
| Export | SheetJS (xlsx) |
| Notifications | react-hot-toast |
| Icons | lucide-react |

---

## ⚠️ Usage Notes

- Adds a ~1.2s delay between page requests to avoid aggressive scraping
- Respects page structure — does not bypass authentication walls
- For best results, use the direct exhibitor list/directory URL
- History is stored locally in `backend/data/history.json`
