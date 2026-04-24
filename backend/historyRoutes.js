/**
 * historyRoutes.js  —  Exhibitor Extractor · History Intelligence API
 *
 * Drop this file into:  C:\exhibitor-extractor\backend\routes\historyRoutes.js
 *
 * Then in server.js add:
 *   import historyRouter from './routes/historyRoutes.js';
 *   app.use('/api/history', historyRouter);
 */

import { Router } from 'express';
import {
  listEvents,
  getEvent,
  renameEvent,
  deleteEvent,
  getExtraction,
  deleteExtraction,
  compareExtractions,
  searchExhibitors,
  getOverallStats,
  getEventStats,
  updateExhibitorWebsite,
  getMissingWebsites,
} from '../database.js';

const router = Router();

// ══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/history/events — list all events with extraction counts */
router.get('/events', (_req, res) => {
  try {
    res.json(listEvents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/history/events/:id — event details + its extractions */
router.get('/events/:id', (req, res) => {
  try {
    const event = getEvent(Number(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/history/events/:id — rename event */
router.patch('/events/:id', (req, res) => {
  try {
    const { event_name } = req.body;
    if (!event_name) return res.status(400).json({ error: 'event_name required' });
    renameEvent(Number(req.params.id), event_name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/history/events/:id — remove event + all its extractions */
router.delete('/events/:id', (req, res) => {
  try {
    deleteEvent(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/history/events/:id/stats — per-extraction trend data for charts */
router.get('/events/:id/stats', (req, res) => {
  try {
    res.json(getEventStats(Number(req.params.id)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXTRACTIONS
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/history/extractions/:id — full extraction with all exhibitors */
router.get('/extractions/:id', (req, res) => {
  try {
    const ex = getExtraction(Number(req.params.id));
    if (!ex) return res.status(404).json({ error: 'Extraction not found' });
    res.json(ex);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/history/extractions/:id */
router.delete('/extractions/:id', (req, res) => {
  try {
    deleteExtraction(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/history/compare?a=<id>&b=<id>
 * Compare two extractions — returns delta report.
 */
router.get('/compare', (req, res) => {
  try {
    const a = Number(req.query.a);
    const b = Number(req.query.b);
    if (!a || !b) return res.status(400).json({ error: 'Both a and b extraction IDs required' });
    res.json(compareExtractions(a, b));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH & STATS
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/history/search?q=<query>[&eventId=<id>][&limit=<n>] */
router.get('/search', (req, res) => {
  try {
    const { q, eventId, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    res.json(searchExhibitors(q, {
      eventId: eventId ? Number(eventId) : undefined,
      limit:   limit   ? Number(limit)   : 50,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/history/stats — overall platform stats */
router.get('/stats', (_req, res) => {
  try {
    res.json(getOverallStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ENRICHMENT
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/history/extractions/:id/missing-websites */
router.get('/extractions/:id/missing-websites', (req, res) => {
  try {
    res.json(getMissingWebsites(Number(req.params.id)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/history/exhibitors/:id/website
 * Body: { website, confidence, source }
 * Used by the enrichment service to update a single exhibitor's website.
 */
router.patch('/exhibitors/:id/website', (req, res) => {
  try {
    const { website, confidence = 0.5, source = 'manual' } = req.body;
    if (!website) return res.status(400).json({ error: 'website required' });
    updateExhibitorWebsite(Number(req.params.id), website, confidence, source);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
