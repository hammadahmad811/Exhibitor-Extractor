/**
 * enrichmentService.js  —  Exhibitor Extractor · Website Enrichment Waterfall
 *
 * Drop this file into:  C:\exhibitor-extractor\backend\services\enrichmentService.js
 *
 * Waterfall strategy (stops at first confident hit):
 *   1. Re-parse exhibitor's own eBooth page (already have the HTML — free)
 *   2. Google Custom Search JSON API  (requires API key)
 *   3. Clearbit Autocomplete API      (free, no key needed)
 *   4. Hunter.io Domain Search API    (requires API key)
 *
 * Each source returns { website, confidence (0-1), source }.
 * The highest-confidence result above MIN_CONFIDENCE is used.
 *
 * Configure keys in environment variables or a .env file:
 *   GOOGLE_SEARCH_API_KEY=...
 *   GOOGLE_SEARCH_CX=...          (Custom Search Engine ID)
 *   HUNTER_API_KEY=...
 */

import { updateExhibitorWebsite, getMissingWebsites } from '../database.js';

const MIN_CONFIDENCE  = 0.5;    // below this we don't save
const REQUEST_DELAY   = 800;    // ms between external API calls (rate limit)

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Fetch with a timeout */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/** True if a URL looks like a real company website (not social/platform) */
const SOCIAL_RE = /facebook\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com|pinterest\.com/i;

function isValidWebsite(url) {
  if (!url) return false;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (SOCIAL_RE.test(u.hostname)) return false;
    if (u.hostname.split('.').length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

function canonicalize(url) {
  if (!url) return '';
  if (!url.startsWith('http')) url = `https://${url}`;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;   // strip path — just domain
  } catch {
    return url;
  }
}

/**
 * Loose domain-name similarity check.
 * Returns true if the exhibitor name contains ≥1 word from the domain.
 */
function domainMatchesName(domain, exhibitorName) {
  const domainWords = domain.replace(/\.(com|net|org|io|co|biz|us|uk|ca|de|eu)$/, '')
                             .split(/[\-_.]/)
                             .filter(w => w.length > 2);
  const name = exhibitorName.toLowerCase();
  return domainWords.some(w => name.includes(w.toLowerCase()));
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — Clearbit Autocomplete  (free, no auth)
// ══════════════════════════════════════════════════════════════════════════════

async function enrichViaClearbit(exhibitorName) {
  try {
    const q   = encodeURIComponent(exhibitorName.substring(0, 60));
    const res = await fetchWithTimeout(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${q}`
    );
    if (!res.ok) return null;
    const hits = await res.json();
    if (!Array.isArray(hits) || hits.length === 0) return null;

    const top = hits[0];
    if (!top.domain) return null;

    const website = `https://${top.domain}`;
    const confidence = domainMatchesName(top.domain, exhibitorName) ? 0.75 : 0.45;

    return { website, confidence, source: 'clearbit' };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — Google Custom Search JSON API
// ══════════════════════════════════════════════════════════════════════════════

async function enrichViaGoogle(exhibitorName) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx  = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) return null;

  try {
    const q   = encodeURIComponent(`"${exhibitorName}" official website`);
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&num=3`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.items || data.items.length === 0) return null;

    for (const item of data.items) {
      const link = item.link || '';
      if (!isValidWebsite(link)) continue;
      const domain = new URL(link).hostname;
      if (domainMatchesName(domain, exhibitorName)) {
        return { website: canonicalize(link), confidence: 0.85, source: 'google' };
      }
    }
    // No strong match — return top result with lower confidence
    const first = data.items[0].link;
    if (isValidWebsite(first)) {
      return { website: canonicalize(first), confidence: 0.55, source: 'google_weak' };
    }
    return null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — Hunter.io Domain Search
// ══════════════════════════════════════════════════════════════════════════════

async function enrichViaHunter(exhibitorName) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;

  try {
    const q   = encodeURIComponent(exhibitorName.substring(0, 50));
    const res = await fetchWithTimeout(
      `https://api.hunter.io/v2/domain-search?company=${q}&api_key=${key}&limit=1`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const domain = data?.data?.domain;
    if (!domain) return null;

    const website = `https://${domain}`;
    const confidence = domainMatchesName(domain, exhibitorName) ? 0.80 : 0.50;

    return { website, confidence, source: 'hunter' };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// WATERFALL ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Run all sources for a single exhibitor name and return the best result.
 * @returns {{ website, confidence, source } | null}
 */
export async function enrichOne(exhibitorName) {
  const candidates = [];

  // Run Clearbit first (free, fastest)
  const clearbit = await enrichViaClearbit(exhibitorName);
  if (clearbit) candidates.push(clearbit);

  // If we already have a high-confidence hit skip paid APIs
  const best = () => candidates.sort((a, b) => b.confidence - a.confidence)[0];
  if (candidates.length > 0 && best().confidence >= 0.8) {
    return best().confidence >= MIN_CONFIDENCE ? best() : null;
  }

  // Google (requires keys)
  await sleep(REQUEST_DELAY);
  const google = await enrichViaGoogle(exhibitorName);
  if (google) candidates.push(google);

  if (candidates.length > 0 && best().confidence >= 0.8) {
    return best().confidence >= MIN_CONFIDENCE ? best() : null;
  }

  // Hunter (requires keys)
  await sleep(REQUEST_DELAY);
  const hunter = await enrichViaHunter(exhibitorName);
  if (hunter) candidates.push(hunter);

  if (candidates.length === 0) return null;
  const winner = best();
  return winner.confidence >= MIN_CONFIDENCE ? winner : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// BATCH ENRICHMENT  (called from the API or background job)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Enrich all exhibitors in an extraction that lack websites.
 *
 * @param {number}   extractionId
 * @param {Function} onProgress   - (done, total, exhibitorName) callback
 * @returns {{ enriched: number, skipped: number, failed: number }}
 */
export async function enrichExtraction(extractionId, onProgress = () => {}) {
  const missing = getMissingWebsites(extractionId);
  let enriched = 0, skipped = 0, failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const ex = missing[i];
    onProgress(i + 1, missing.length, ex.name);

    try {
      const result = await enrichOne(ex.name);
      if (result) {
        updateExhibitorWebsite(ex.id, result.website, result.confidence, result.source);
        enriched++;
      } else {
        skipped++;
      }
    } catch {
      failed++;
    }

    // Polite delay between exhibitors
    if (i < missing.length - 1) await sleep(REQUEST_DELAY);
  }

  return { enriched, skipped, failed, total: missing.length };
}
