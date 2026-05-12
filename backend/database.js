/**
 * database.js  —  Exhibitor Extractor · History Intelligence
 *
 * Uses Node.js built-in SQLite (node:sqlite) — available in Node 22.5+ / 23.4+ / 24+
 * NO npm install needed — zero external dependencies.
 *
 * Location: C:\exhibitor-extractor\backend\database.js
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR lets you point the database at a Railway persistent volume (/data)
// or any other writable directory.  Defaults to the backend folder for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH  = path.join(DATA_DIR, 'exhibitor_history.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  initSchema(_db);
  return _db;
}

// ── Schema ─────────────────────────────────────────────────────────────────────
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name  TEXT    NOT NULL,
      slug        TEXT    UNIQUE,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS extractions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      extraction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_url      TEXT    NOT NULL,
      platform        TEXT,
      total_count     INTEGER DEFAULT 0,
      website_count   INTEGER DEFAULT 0,
      notes           TEXT
    );

    CREATE TABLE IF NOT EXISTS exhibitors (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      extraction_id      INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
      name               TEXT    NOT NULL,
      normalized_name    TEXT,
      booth_number       TEXT,
      booth_size         TEXT,
      website            TEXT,
      website_confidence REAL    DEFAULT 0,
      website_source     TEXT,
      categories         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_exhibitors_extraction ON exhibitors(extraction_id);
    CREATE INDEX IF NOT EXISTS idx_exhibitors_norm_name  ON exhibitors(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_extractions_event     ON extractions(event_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name   TEXT    NOT NULL,
      source_url   TEXT    NOT NULL,
      freq_type    TEXT    NOT NULL,  -- 'hourly' | 'daily' | 'weekly'
      freq_day     INTEGER,           -- 0=Sun..6=Sat (weekly only)
      freq_hour    INTEGER DEFAULT 9,
      freq_minute  INTEGER DEFAULT 0,
      freq_every_n INTEGER DEFAULT 1, -- hourly: every N hours
      is_active    INTEGER DEFAULT 1,
      last_run     DATETIME,
      next_run     DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ── Name normalisation ─────────────────────────────────────────────────────────
export function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[,\.&\/\\()\[\]'"!?@#$%^*+=~`|<>{}:;]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|the|and|of|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Slug from URL ──────────────────────────────────────────────────────────────
// Produces a unique, stable key for each event URL so that two different shows
// on the same platform (e.g. nacs26.mapyourshow.com vs nbaa26.mapyourshow.com)
// never collide even though their URL paths are identical.
export function slugFromUrl(url) {
  try {
    const u         = new URL(url);
    const hostParts = u.hostname.split('.');
    const subdomain = hostParts[0].toLowerCase();

    // For subdomain-per-show platforms (MapYourShow, a2zinc, etc.) the subdomain
    // IS the show identifier — use it directly so every show gets its own slug.
    // Skip generic subdomains like "www", "web", "app", "events".
    const genericSubdomains = new Set(['www', 'web', 'app', 'events', 'event', 'm', 'api']);
    if (subdomain && !genericSubdomains.has(subdomain) && subdomain.length > 2) {
      return subdomain; // e.g. 'nacs26', 'nbaa26', 'ces2026'
    }

    // For www-based platforms use a meaningful path segment, but skip common
    // platform path tokens that would collide across shows.
    const skipTokens = /^(public|eventmap|aspx|php|exhview|index|cfm|html|htm|default|home|shows|show|exhibitors|exhibitor|floorplan|sponsors|directory|8_0|6_0|7_0|v2|api)$/i;
    const parts = u.pathname.split('/').filter(Boolean);
    const cand  = parts.find(p => p.length > 3 && !skipTokens.test(p));

    // Prefix with hostname base to guarantee cross-domain uniqueness
    const hostBase = hostParts.slice(0, -1).join('-').toLowerCase(); // 'www-a2zinc'
    return cand ? `${hostBase}-${cand}` : hostBase || subdomain;
  } catch {
    return 'unknown';
  }
}

// ── Transaction helper ─────────────────────────────────────────────────────────
function runTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════════════════════════════

export function upsertEvent(eventName, sourceUrl) {
  const db   = getDb();
  const slug  = slugFromUrl(sourceUrl);

  // First try: match by slug — only reuse if the event name also matches
  // (prevents two different shows from being collapsed under the same slug)
  const bySlug = db.prepare('SELECT id, event_name FROM events WHERE slug = ?').get(slug);
  if (bySlug) {
    if (bySlug.event_name.toLowerCase() === eventName.toLowerCase()) return bySlug.id;
    // Slug collision with a different event — create a new event with a URL-specific slug
    const uniqueSlug = `${slug}-${Date.now()}`;
    const info2 = db.prepare('INSERT INTO events (event_name, slug) VALUES (?, ?)').run(eventName, uniqueSlug);
    return Number(info2.lastInsertRowid);
  }

  // Second try: match by exact event name (handles re-extractions with different URLs)
  const byName = db.prepare('SELECT id FROM events WHERE LOWER(event_name) = LOWER(?)').get(eventName);
  if (byName) return byName.id;

  const info = db.prepare('INSERT INTO events (event_name, slug) VALUES (?, ?)').run(eventName, slug);
  return Number(info.lastInsertRowid);
}

export function listEvents() {
  return getDb().prepare(`
    SELECT e.id, e.event_name, e.slug, e.created_at,
           COUNT(x.id)            AS extraction_count,
           MAX(x.extraction_date) AS last_extracted
    FROM events e
    LEFT JOIN extractions x ON x.event_id = e.id
    GROUP BY e.id
    ORDER BY last_extracted DESC
  `).all();
}

export function getEvent(id) {
  const db    = getDb();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!event) return null;
  event.extractions = db.prepare(`
    SELECT id, extraction_date, source_url, platform, total_count, website_count, notes
    FROM extractions WHERE event_id = ? ORDER BY extraction_date DESC
  `).all(id);
  return event;
}

export function renameEvent(id, newName) {
  return getDb().prepare('UPDATE events SET event_name = ? WHERE id = ?').run(newName, id);
}

export function deleteEvent(id) {
  return getDb().prepare('DELETE FROM events WHERE id = ?').run(id);
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTRACTIONS
// ══════════════════════════════════════════════════════════════════════════════

export function saveExtraction({ eventName, sourceUrl, platform, exhibitors }) {
  const db           = getDb();
  const eventId      = upsertEvent(eventName, sourceUrl);
  const websiteCount = exhibitors.filter(e => e.website && e.website.trim()).length;

  const xInfo = db.prepare(`
    INSERT INTO extractions (event_id, source_url, platform, total_count, website_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventId, sourceUrl, platform || 'unknown', exhibitors.length, websiteCount);

  const extractionId = Number(xInfo.lastInsertRowid);

  const insertEx = db.prepare(`
    INSERT INTO exhibitors
      (extraction_id, name, normalized_name, booth_number, booth_size,
       website, website_confidence, website_source, categories)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runTransaction(db, () => {
    for (const ex of exhibitors) {
      insertEx.run(
        extractionId,
        ex.name               || '',
        normalizeName(ex.name),
        ex.boothNumber        || ex.booth_number || '',
        ex.boothSize          || ex.booth_size   || '',
        ex.website            || '',
        ex.websiteConfidence  || 0,
        ex.websiteSource      || '',
        Array.isArray(ex.categories) ? JSON.stringify(ex.categories) : (ex.categories || '')
      );
    }
  });

  return { extractionId, eventId, total: exhibitors.length, websiteCount };
}

export function getExtraction(id) {
  const db         = getDb();
  const extraction = db.prepare(`
    SELECT x.*, e.event_name, e.slug
    FROM extractions x JOIN events e ON e.id = x.event_id
    WHERE x.id = ?
  `).get(id);
  if (!extraction) return null;
  extraction.exhibitors = db.prepare(
    'SELECT * FROM exhibitors WHERE extraction_id = ? ORDER BY name'
  ).all(id);
  return extraction;
}

export function deleteExtraction(id) {
  return getDb().prepare('DELETE FROM extractions WHERE id = ?').run(id);
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPARISON ENGINE
// ══════════════════════════════════════════════════════════════════════════════

export function compareExtractions(idA, idB) {
  const db = getDb();
  const xA = db.prepare('SELECT * FROM extractions WHERE id = ?').get(idA);
  const xB = db.prepare('SELECT * FROM extractions WHERE id = ?').get(idB);
  if (!xA || !xB) throw new Error('One or both extraction IDs not found');

  const exA = db.prepare('SELECT * FROM exhibitors WHERE extraction_id = ?').all(idA);
  const exB = db.prepare('SELECT * FROM exhibitors WHERE extraction_id = ?').all(idB);

  const mapA = new Map(exA.map(e => [e.normalized_name, e]));
  const mapB = new Map(exB.map(e => [e.normalized_name, e]));

  const newExhibitors = [], removedExhibitors = [], updatedExhibitors = [], unchanged = [];

  for (const [key, eb] of mapB) {
    if (!mapA.has(key)) {
      newExhibitors.push(eb);
    } else {
      const changes = diffExhibitor(mapA.get(key), eb);
      if (changes.length) updatedExhibitors.push({ before: mapA.get(key), after: eb, changes });
      else unchanged.push(eb);
    }
  }
  for (const [key, ea] of mapA) {
    if (!mapB.has(key)) removedExhibitors.push(ea);
  }

  const websiteA = exA.filter(e => e.website).length;
  const websiteB = exB.filter(e => e.website).length;

  return {
    extractionA: { id: idA, date: xA.extraction_date, total: xA.total_count, platform: xA.platform },
    extractionB: { id: idB, date: xB.extraction_date, total: xB.total_count, platform: xB.platform },
    delta: {
      totalChange:    exB.length - exA.length,
      newCount:       newExhibitors.length,
      removedCount:   removedExhibitors.length,
      updatedCount:   updatedExhibitors.length,
      unchangedCount: unchanged.length,
      websiteGain:    websiteB - websiteA,
      completenessA:  exA.length ? Math.round((websiteA / exA.length) * 100) : 0,
      completenessB:  exB.length ? Math.round((websiteB / exB.length) * 100) : 0,
    },
    newExhibitors, removedExhibitors, updatedExhibitors, unchanged,
  };
}

function diffExhibitor(a, b) {
  const changes = [];
  for (const f of ['booth_number', 'booth_size', 'website']) {
    const av = (a[f] || '').trim(), bv = (b[f] || '').trim();
    if (av !== bv) changes.push({ field: f, before: av, after: bv });
  }
  return changes;
}

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH & STATS
// ══════════════════════════════════════════════════════════════════════════════

export function searchExhibitors(query, { limit = 50, eventId } = {}) {
  const db = getDb();
  const q  = `%${query.toLowerCase()}%`;

  if (eventId) {
    return db.prepare(`
      SELECT ex.*, x.extraction_date, x.source_url, e.event_name
      FROM exhibitors ex
      JOIN extractions x ON x.id = ex.extraction_id
      JOIN events e ON e.id = x.event_id
      WHERE (LOWER(ex.name) LIKE ? OR LOWER(ex.website) LIKE ?) AND e.id = ?
      ORDER BY ex.name LIMIT ?
    `).all(q, q, eventId, limit);
  }

  return db.prepare(`
    SELECT ex.*, x.extraction_date, x.source_url, e.event_name
    FROM exhibitors ex
    JOIN extractions x ON x.id = ex.extraction_id
    JOIN events e ON e.id = x.event_id
    WHERE LOWER(ex.name) LIKE ? OR LOWER(ex.website) LIKE ?
    ORDER BY ex.name LIMIT ?
  `).all(q, q, limit);
}

export function getOverallStats() {
  const db = getDb();
  return {
    totalEvents:      db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    totalExtractions: db.prepare('SELECT COUNT(*) AS n FROM extractions').get().n,
    totalExhibitors:  db.prepare('SELECT COUNT(*) AS n FROM exhibitors').get().n,
    withWebsite:      db.prepare("SELECT COUNT(*) AS n FROM exhibitors WHERE website != ''").get().n,
    recentActivity:   db.prepare(`
      SELECT e.event_name, x.extraction_date, x.total_count, x.platform
      FROM extractions x JOIN events e ON e.id = x.event_id
      ORDER BY x.extraction_date DESC LIMIT 10
    `).all(),
  };
}

export function getEventStats(eventId) {
  return getDb().prepare(`
    SELECT id, extraction_date, total_count, website_count, platform
    FROM extractions WHERE event_id = ? ORDER BY extraction_date ASC
  `).all(eventId).map(x => ({
    ...x,
    completeness: x.total_count ? Math.round((x.website_count / x.total_count) * 100) : 0,
  }));
}

export function updateExhibitorWebsite(id, website, confidence, source) {
  return getDb().prepare(
    'UPDATE exhibitors SET website = ?, website_confidence = ?, website_source = ? WHERE id = ?'
  ).run(website, confidence, source, id);
}

export function getMissingWebsites(extractionId) {
  return getDb().prepare(`
    SELECT * FROM exhibitors
    WHERE extraction_id = ? AND (website IS NULL OR website = '')
    ORDER BY name
  `).all(extractionId);
}

// ══════════════════════════════════════════════════════════════════════════════
// ONE-TIME MIGRATION: import legacy history.json into SQLite
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';

export function migrateFromJson(historyJsonPath) {
  // No longer uses a one-time flag — runs incrementally every boot,
  // importing only history.json entries that are not yet in SQLite.
  // This ensures extractions added to history.json after the original
  // migration (or on any restart) are always picked up.

  if (!existsSync(historyJsonPath)) return { skipped: true, reason: 'no history.json' };

  let items = [];
  try {
    items = JSON.parse(readFileSync(historyJsonPath, 'utf-8'));
  } catch {
    return { skipped: true, reason: 'could not parse history.json' };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return { migrated: 0 };
  }

  const db = getDb();
  let migrated = 0;

  // Check if an extraction with the same source_url + date already exists
  const checkDuplicate = db.prepare(`
    SELECT id FROM extractions WHERE source_url = ? AND extraction_date = ? LIMIT 1
  `);

  // Insert with preserved original extraction date
  const insertExtraction = db.prepare(`
    INSERT INTO extractions (event_id, source_url, platform, total_count, website_count, extraction_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertExhibitor = db.prepare(`
    INSERT INTO exhibitors
      (extraction_id, name, normalized_name, booth_number, booth_size, website, categories)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Process oldest-first so timeline order is correct
  const sorted = [...items].reverse();

  for (const item of sorted) {
    try {
      const exhibitors   = item.data || [];
      const platform     = item.urlType || 'unknown';
      const date         = item.extractedAt || new Date().toISOString();
      const sourceUrl    = (item.urls || [''])[0];

      // Skip if already in SQLite (deduplication for incremental runs)
      if (checkDuplicate.get(sourceUrl, date)) continue;

      const eventId      = upsertEvent(item.eventName || 'Unknown Event', sourceUrl);
      const websiteCount = exhibitors.filter(e => e.website && e.website.trim()).length;

      const xInfo = insertExtraction.run(eventId, sourceUrl, platform, exhibitors.length, websiteCount, date);
      const extractionId = Number(xInfo.lastInsertRowid);

      runTransaction(db, () => {
        for (const ex of exhibitors) {
          insertExhibitor.run(
            extractionId,
            ex.name        || '',
            normalizeName(ex.name),
            ex.boothNumber || '',
            ex.boothSize   || '',
            ex.website     || '',
            ex.category    || ''
          );
        }
      });

      migrated++;
    } catch (e) {
      console.warn(`  [DB Migration] Skipped "${item.eventName}": ${e.message}`);
    }
  }

  return { migrated };
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULES
// ══════════════════════════════════════════════════════════════════════════════

export function calcNextRun({ freq_type, freq_day, freq_hour, freq_minute, freq_every_n }) {
  const now = new Date();
  const next = new Date(now);

  if (freq_type === 'hourly') {
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + (freq_every_n || 1));
  } else if (freq_type === 'daily') {
    next.setHours(freq_hour || 9, freq_minute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (freq_type === 'weekly') {
    const targetDay = freq_day ?? 1; // default Monday
    const daysAhead = (targetDay - now.getDay() + 7) % 7 || 7;
    next.setDate(now.getDate() + daysAhead);
    next.setHours(freq_hour || 9, freq_minute || 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 7);
  }

  return next.toISOString();
}

export function createSchedule({ event_name, source_url, freq_type, freq_day, freq_hour, freq_minute, freq_every_n }) {
  const db       = getDb();
  const next_run = calcNextRun({ freq_type, freq_day, freq_hour, freq_minute, freq_every_n });
  const info = db.prepare(`
    INSERT INTO schedules (event_name, source_url, freq_type, freq_day, freq_hour, freq_minute, freq_every_n, next_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(event_name, source_url, freq_type, freq_day ?? null, freq_hour ?? 9, freq_minute ?? 0, freq_every_n ?? 1, next_run);
  return { id: Number(info.lastInsertRowid), next_run };
}

export function listSchedules() {
  return getDb().prepare(`SELECT * FROM schedules ORDER BY next_run ASC`).all();
}

export function getSchedulesDue() {
  const now = new Date().toISOString();
  return getDb().prepare(`SELECT * FROM schedules WHERE is_active = 1 AND next_run <= ?`).all(now);
}

export function updateScheduleAfterRun(id, freq_type, freq_day, freq_hour, freq_minute, freq_every_n) {
  const next_run = calcNextRun({ freq_type, freq_day, freq_hour, freq_minute, freq_every_n });
  return getDb().prepare(`
    UPDATE schedules SET last_run = CURRENT_TIMESTAMP, next_run = ? WHERE id = ?
  `).run(next_run, id);
}

export function toggleSchedule(id, is_active) {
  return getDb().prepare(`UPDATE schedules SET is_active = ? WHERE id = ?`).run(is_active ? 1 : 0, id);
}

export function deleteSchedule(id) {
  return getDb().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
}
