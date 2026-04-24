import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { detectUrlType } from '../utils/urlDetector.js';
import { runScraper } from '../scrapers/smartScraper.js';
import { saveHistory, loadHistory, deleteHistory } from '../utils/historyManager.js';
import { saveExtraction } from '../database.js';

const router = Router();

// In-memory job store
const jobs = new Map();

// ─── Start Extraction Job ─────────────────────────────────────────────────────
router.post('/extract', async (req, res) => {
  const { eventName, urls } = req.body;

  if (!eventName || !urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'eventName and urls[] are required.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'pending',
    progress: 0,
    message: 'Job queued...',
    data: [],
    error: null,
    eventName,
    urls,
  });

  // Kick off async scraping
  runJob(jobId, eventName, urls).catch((err) => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
  });

  res.json({ jobId });
});

// ─── SSE Progress Stream ──────────────────────────────────────────────────────
router.get('/extract/stream/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!jobs.has(jobId)) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const interval = setInterval(() => {
    const job = jobs.get(jobId);
    if (!job) {
      send({ type: 'error', message: 'Job disappeared.' });
      clearInterval(interval);
      res.end();
      return;
    }

    send({
      type: job.status === 'error' ? 'error' : job.status === 'done' ? 'complete' : 'progress',
      message: job.message,
      progress: job.progress,
      data: job.status === 'done' ? job.data : undefined,
      error: job.error,
    });

    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      setTimeout(() => res.end(), 500);
      // Clean up job after 5 min
      setTimeout(() => jobs.delete(jobId), 300_000);
    }
  }, 500);

  req.on('close', () => clearInterval(interval));
});

// ─── History ──────────────────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const history = await loadHistory();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/history/:id', async (req, res) => {
  try {
    await deleteHistory(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal Job Runner ──────────────────────────────────────────────────────
async function runJob(jobId, eventName, urls) {
  const job = jobs.get(jobId);
  job.status = 'running';

  const allExhibitors = [];
  const seenNames = new Set();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i].trim();
    if (!url) continue;

    const urlType = detectUrlType(url);
    const urlLabel = urls.length > 1 ? ` (URL ${i + 1}/${urls.length})` : '';

    job.message = `Detecting URL type${urlLabel}: ${urlType}`;
    job.progress = Math.round(((i / urls.length) * 80));

    try {
      const results = await runScraper(url, urlType, (msg, pct) => {
        job.message = `${msg}${urlLabel}`;
        job.progress = Math.round((i / urls.length) * 80 + (pct / 100) * (80 / urls.length));
      });

      // Deduplicate across URLs
      for (const exhibitor of results) {
        const key = exhibitor.name.toLowerCase().trim();
        if (!seenNames.has(key)) {
          seenNames.add(key);
          allExhibitors.push(exhibitor);
        }
      }
    } catch (err) {
      console.error(`Error scraping ${url}:`, err.message);
      job.message = `⚠️ Error on URL ${i + 1}: ${err.message}`;
    }
  }

  job.progress = 90;
  job.message = 'Saving to history...';

  if (allExhibitors.length > 0) {
    const historyItem = {
      id: jobId,
      eventName,
      urls,
      urlType: detectUrlType(urls[0]),
      extractedAt: new Date().toISOString(),
      count: allExhibitors.length,
      data: allExhibitors,
    };
    await saveHistory(historyItem);

    // ── Save to SQLite history database ──────────────────────────────────────
    try {
      const platform = detectUrlType(urls[0]);
      saveExtraction({ eventName, sourceUrl: urls[0], platform, exhibitors: allExhibitors });
      console.log(`  [DB] Saved ${allExhibitors.length} exhibitors to history DB`);
    } catch (dbErr) {
      console.warn('  [DB] Non-fatal: failed to save to history DB:', dbErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  job.progress = 100;
  job.data = allExhibitors;
  job.status = 'done';
  job.message = `Done! Extracted ${allExhibitors.length} exhibitor(s).`;
}

export default router;
