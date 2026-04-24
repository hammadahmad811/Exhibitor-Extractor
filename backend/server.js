import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import extractRouter from './routes/extract.js';
import historyRouter from './routes/historyRoutes.js';
import { ensureDataDir } from './utils/historyManager.js';
import { saveExtraction, migrateFromJson } from './database.js';
import { enrichExtraction } from './services/enrichmentService.js';
import { startScheduler } from './services/schedulerService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── CORS ──────────────────────────────────────────────────────────────────────
// In production the frontend is served from the same origin (Railway),
// so CORS is only relevant for local dev.
// Set ALLOWED_ORIGINS=* or a comma-separated list if you add a separate
// frontend domain (e.g. a Vercel custom domain).
const rawOrigins = process.env.ALLOWED_ORIGINS || 'http://localhost:5173';
const allowedOrigins = rawOrigins === '*' ? '*' : rawOrigins.split(',').map(s => s.trim());

app.use(cors({
  origin: allowedOrigins === '*'
    ? '*'
    : (origin, cb) => {
        // Allow same-origin requests (no Origin header) and listed origins
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: ${origin} not allowed`));
      },
  credentials: allowedOrigins !== '*',
}));

app.use(express.json({ limit: '10mb' }));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', extractRouter);
app.use('/api/history', historyRouter);

// ── Enrichment SSE ────────────────────────────────────────────────────────────
app.post('/api/history/enrich/:extractionId', async (req, res) => {
  const extractionId = Number(req.params.extractionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: IS_PROD ? 'production' : 'development', timestamp: new Date().toISOString() });
});

// ── Serve built React frontend (production only) ──────────────────────────────
// In development, the Vite dev server handles the frontend.
// In production (Railway), Express serves the pre-built static files.
if (IS_PROD) {
  const frontendDist = join(__dirname, '..', 'frontend', 'dist');
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    // SPA fallback: serve index.html for any route not matched above
    app.use((_req, res) => {
      res.sendFile(join(frontendDist, 'index.html'));
    });
    console.log(`  [Static] Serving frontend from ${frontendDist}`);
  } else {
    console.warn('  [Static] frontend/dist not found — run "npm run build" first');
  }
}

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
await ensureDataDir();

// One-time migration: import legacy history.json into SQLite
try {
  const historyJsonPath = join(__dirname, 'data', 'history.json');
  const result = migrateFromJson(historyJsonPath);
  if (result.migrated > 0) {
    console.log(`  [DB] Migrated ${result.migrated} historical extraction(s) from history.json`);
  }
} catch (e) {
  console.warn('  [DB] Migration skipped:', e.message);
}

app.listen(PORT, () => {
  console.log(`\n  Exhibitor Extractor running at http://localhost:${PORT}`);
  console.log(`  Health:      http://localhost:${PORT}/health`);
  console.log(`  History API: http://localhost:${PORT}/api/history/stats`);
  if (IS_PROD) console.log(`  Frontend:    http://localhost:${PORT}/\n`);
  startScheduler();
});
