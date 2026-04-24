import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { normalizeExhibitors, findExhibitorArrayInJson } from '../utils/dataNormalizer.js';

const PAGE_TIMEOUT = 60_000;
const MAX_PAGES    = 25;
const DELAY_MS     = 1200;

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('mapyourshow.com'))  return 'mys';
  if (u.includes('ungerboeck.com'))   return 'ungerboeck';
  if (u.includes('goexposoftware.com')) return 'goexpo';
  if (u.includes('eventscribe.net') || u.includes('eventscribe.com')) return 'eventscribe';
  if (u.includes('expofp.com')) return 'expofp';
  if (u.includes('expocad.com')) return 'expocad';
  if (u.includes('swapcard.com'))     return 'swapcard';
  if (u.includes('cvent.com'))        return 'cvent';
  if (u.includes('a2zinc.net') || u.includes('a2z.com')) return 'a2z';
  // a2zinc EventMap hosted on custom domains (e.g. congress.nsc.org, npe.mapyourshow.com, etc.)
  // The path "/Public/eventmap.aspx" or "/Public/EventMap.aspx" is unique to the a2zinc platform.
  if (u.includes('eventmap.aspx') || u.includes('ebooth.aspx')) return 'a2z';
  if (u.includes('bizzabo.com') || u.includes('bizzabo-reg.')) return 'bizzabo';
  if (u.includes('identiverse.com')) return 'identiverse';
  if (u.includes('electronica.de')) return 'electronica';
  return 'generic';
}

export async function runScraper(url, urlType, onProgress) {
  onProgress('Launching browser...', 5);
  let browser;
  try {
    // In production (Docker/Railway), use the system Chromium pointed to by
    // CHROMIUM_PATH env var.  In local dev, Playwright uses its own bundled browser.
    const launchOptions = {
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',              // required in Docker / CI environments
        '--disable-setuid-sandbox',  // required when running as root
        '--disable-dev-shm-usage',   // Docker /dev/shm is only 64 MB by default
        '--disable-gpu',             // not needed for headless
      ],
    };
    if (process.env.CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.CHROMIUM_PATH;
    }
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    });
    const platform = detectPlatform(url);
    console.log(`  Platform: ${platform}`);
    let raw = [];
    if (platform === 'mys') {
      raw = await scrapeMYS(context, url, onProgress);
    } else if (platform === 'ungerboeck') {
      raw = await scrapeUngerboeck(context, url, onProgress);
    } else if (platform === 'goexpo') {
      raw = await scrapeGoExpo(context, url, onProgress);
    } else if (platform === 'eventscribe') {
      raw = await scrapeEventScribe(context, url, onProgress);
    } else if (platform === 'expofp') {
      raw = await scrapeExpoFP(context, url, onProgress);
    } else if (platform === 'expocad') {
      raw = await scrapeExpoCad(context, url, onProgress);
    } else if (platform === 'bizzabo') {
      raw = await scrapeBizzabo(context, url, onProgress);
    } else if (platform === 'identiverse') {
      raw = await scrapeIdentiverse(context, url, onProgress);
    } else if (platform === 'a2z') {
      raw = await scrapeA2Z(context, url, onProgress);
    } else if (platform === 'electronica') {
      raw = await scrapeElectronica(context, url, onProgress);
    } else if (urlType === 'floor_plan') {
      raw = await scrapeFloorPlan(context, url, onProgress);
    } else {
      raw = await scrapeDirectory(context, url, onProgress);
    }
    onProgress(`Normalising ${raw.length} records...`, 90);
    return normalizeExhibitors(raw);
  } finally {
    if (browser) await browser.close();
  }
}

// =============================================================================
// MAP YOUR SHOW  — REST API approach (reverse-engineered via DevTools)
// Key discovery: MYS uses two same-origin CFM endpoints, NOT GraphQL:
//   1. exh-remote-proxy.cfm?action=GetBoothByHall  → all booths + exhibitor names
//   2. exh-remote-proxy.cfm?action=getExhibitorInfo → website URL + contact info
// Both require the header: X-Requested-With: XMLHttpRequest
// =============================================================================
async function scrapeMYS(context, url, onProgress) {
  // ─────────────────────────────────────────────────────────────────────────────
  // DATA SOURCES (all three run and merge):
  //   1. getExhibitorsByKeyword (paginated) — PRIMARY: what the MYS floor plan app
  //      calls natively. Returns ALL registered exhibitors (819 for BIO 2026) with
  //      name, booth, and often website. Works with ?page=1, 2, 3…
  //   2. GetBoothByHall — adds authoritative booth size (BOOTHDIMS). Only covers
  //      physically placed booths.
  //   3. Alpha search (rows/start pagination) — FALLBACK if keyword search is absent
  //      on a given show. Old show=all was capped ~200; rows/start gets the full set.
  //
  // RELIABILITY: Every context.request.get() call is wrapped in mysGet() which retries
  //   up to 3 times on HTTP 503 (the intermittent overload BIO 2026 returns) with
  //   back-off delays. If all retries fail the caller receives null and falls through.
  //   A final page.evaluate XHR fallback (the old "show=all" approach) is kept so
  //   users never see 0 results from a transient server glitch.
  // ─────────────────────────────────────────────────────────────────────────────

  const page = await context.newPage();
  try {
    // ── Step 1: navigate → session cookies + MYS config ──────────────────────
    onProgress('Loading Map Your Show floor plan...', 5);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForFunction(
      () => window.MYSFloorplan_1_0 && window.MYSFloorplan_1_0.showID,
      { timeout: 20000 }
    ).catch(() => null);

    const config = await page.evaluate(() => {
      const fp = window.MYSFloorplan_1_0;
      if (!fp) return null;
      const appScript = Array.from(document.querySelectorAll('script[src]'))
        .find(s => s.src && (/app\d+\.min\.js/.test(s.src) || /floorplan\.iife\.js/.test(s.src)));
      let proxyBase = null;
      if (appScript) {
        proxyBase = appScript.src.replace(/js\/(?:app\d+\.min|floorplan\.iife)\.js.*$/, '');
      }
      return {
        showID:   fp.showID,
        halls:    fp.halls || ['A'],
        regID:    fp.regID || '0',
        proxyBase,
        origin:   window.location.origin,
        pathname: window.location.pathname,
      };
    }).catch(() => null);

    if (!config || !config.showID) {
      console.log('  [MYS] MYSFloorplan_1_0 not found — falling back to generic scraper');
      await page.close();
      return await scrapeDirectory(context, url, onProgress);
    }

    console.log(`  [MYS] ShowID=${config.showID}  halls=${JSON.stringify(config.halls)}  proxyBase=${config.proxyBase}`);

    // ── Helpers ───────────────────────────────────────────────────────────────
    function unwrapMYS(raw) {
      if (!raw) return null;
      if (raw.COLUMNS && raw.DATA) return raw;
      if (raw.success && raw.data && raw.data.COLUMNS && raw.data.DATA) return raw.data;
      return null;
    }

    function buildProxyCandidates(cfg) {
      const c = [];
      if (cfg.proxyBase) {
        c.push(cfg.proxyBase + 'exh-remote-proxy.cfm');
        c.push(cfg.proxyBase + '_remote-proxy.cfm');
      }
      c.push(cfg.origin + '/8_0/exhview/02/exh-remote-proxy.cfm');
      c.push(cfg.origin + '/8_0/floorplan/remote-proxy.cfm');
      const dir = cfg.pathname.replace(/\/[^/]+$/, '/');
      c.push(cfg.origin + dir + '02/exh-remote-proxy.cfm');
      c.push(cfg.origin + dir + '02/_remote-proxy.cfm');
      return c;
    }

    // Retry-aware GET: retries up to maxRetries times on 503, returns null on failure.
    async function mysGet(reqUrl, timeout = 25000, maxRetries = 3) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const r = await context.request.get(reqUrl, { timeout });
          if (r.ok()) return r;
          if (r.status() === 503 && attempt < maxRetries - 1) {
            await sleep(1500 * (attempt + 1)); // 1.5s, 3s back-off
            continue;
          }
          return null;
        } catch (e) {
          if (attempt < maxRetries - 1) await sleep(1000);
        }
      }
      return null;
    }

    const proxyCandidates = buildProxyCandidates(config);

    // ── Step 2: GetBoothByHall (booth size data) ──────────────────────────────
    onProgress(`Fetching floor plan booths...`, 12);
    const boothMap = new Map(); // key → { name, booth, exhId, dims }
    let workingProxy = null;

    for (const hall of config.halls) {
      for (const proxyUrl of proxyCandidates) {
        try {
          const params = new URLSearchParams({
            showid: config.showID, selectedbooth: '', hallid: hall,
            action: 'GetBoothByHall', method: 'GetBoothByHall',
            regid: config.regID, '_': String(Date.now()),
          });
          const resp = await mysGet(proxyUrl + '?' + params, 25000);
          if (!resp) continue;
          const data = unwrapMYS(await resp.json().catch(() => null));
          if (!data) continue;
          const cols = data.COLUMNS;
          const boothIdx = cols.indexOf('BOOTH'), exhNameIdx = cols.indexOf('EXHNAME');
          const exhIdIdx = cols.indexOf('EXHID'), dimsIdx = cols.indexOf('BOOTHDIMS');
          let found = 0;
          for (const row of data.DATA) {
            const name = (row[exhNameIdx] || '').toString().trim();
            if (!name) continue;
            const exhId = (row[exhIdIdx] || '').toString().trim();
            const key = exhId || name;
            if (!boothMap.has(key)) {
              boothMap.set(key, { name, booth: (row[boothIdx] || '').toString().trim(), exhId, dims: (row[dimsIdx] || '').toString().trim() });
            }
            found++;
          }
          if (found > 0) { workingProxy = proxyUrl; break; }
        } catch (_) {}
      }
    }
    console.log(`  [MYS] GetBoothByHall: ${boothMap.size} named booth records`);

    // ── Step 3: getExhibitorsByKeyword paginated — PRIMARY exhibitor source ───
    // This is the same endpoint the MYS floor plan app calls. Supports page=N.
    // Returns name, booth, website for ALL registered exhibitors.
    onProgress(`Fetching all exhibitors...`, 22);
    const kwMap = new Map(); // key → { name, exhId, booth, dims, website }
    let kwPage = 1, kwTotalPages = 1;

    while (kwPage <= kwTotalPages && kwPage <= 60) { // 60 × 200 = 12,000 cap
      try {
        const kwUrl = config.origin + '/8_0/floorplan/remote-proxy.cfm?' +
          new URLSearchParams({ action: 'getExhibitorsByKeyword', searchsize: '200',
            sort: 'name', alpha: '', categories: '', country: '', pavilion: '',
            page: String(kwPage) });
        const resp = await mysGet(kwUrl, 30000);
        if (!resp) break;
        const d = await resp.json().catch(() => null);
        if (!d) break;

        if (kwPage === 1) {
          kwTotalPages = Number(d.totalPages) || 1;
          const tot = Number(d.totalExhibitors) || 0;
          console.log(`  [MYS] getExhibitorsByKeyword: ${tot} total exhibitors, ${kwTotalPages} pages`);
          onProgress(`Found ${tot} exhibitors — fetching all pages...`, 28);
        }

        const list = d.exhibitors || d.results || [];
        if (list.length === 0) break;

        for (const e of list) {
          // Handle multiple field name variants across MYS versions
          const name = (e.name || e.exhibitorName || e.exhName || '').trim();
          if (!name) continue;
          const exhId   = String(e.exhibitorId || e.exhid || e.id || '').trim();
          const booth   = (e.booth || e.boothNumber || e.boothNum || '').toString().trim();
          const dims    = (e.boothsize || e.boothDims || e.boothdims || '').toString().trim();
          const website = (e.websiteURL || e.website || e.url || '').trim();
          const key = exhId || name;
          if (!kwMap.has(key)) kwMap.set(key, { name, exhId, booth, dims, website });
        }
        kwPage++;
        if (kwPage <= kwTotalPages) await sleep(300);
      } catch (e) {
        console.log(`  [MYS] getExhibitorsByKeyword page ${kwPage} error: ${e.message}`);
        break;
      }
    }
    console.log(`  [MYS] getExhibitorsByKeyword: ${kwMap.size} exhibitors from ${kwPage - 1} page(s)`);

    // ── Step 4: paginated alpha search — fallback if keyword endpoint empty ───
    // Uses the Solr-based search endpoint (/ajax/remote-proxy.cfm) with rows/start
    // pagination to get all pages. The old show=all approach was capped at ~200.
    const alphaMap = new Map();
    if (kwMap.size === 0) {
      onProgress(`Keyword endpoint empty — trying alpha search...`, 35);
      let alphaStart = 0, alphaTotal = Infinity, alphaPage = 0;

      while (alphaStart < alphaTotal && alphaStart < 5000) {
        try {
          const searchUrl = config.origin + '/8_0/ajax/remote-proxy.cfm?' +
            new URLSearchParams({ action: 'search', search: '*',
              searchtype: 'exhibitoralpha', sortfield: 'title_t', sortdirection: 'asc',
              rows: '200', start: String(alphaStart) });
          const resp = await mysGet(searchUrl, 40000);
          if (!resp) break;
          const d = await resp.json().catch(() => null);
          if (!d) break;
          const exhData = d.DATA && d.DATA.results && d.DATA.results.exhibitor;
          if (!exhData) break;
          if (alphaTotal === Infinity) {
            alphaTotal = Number(exhData.found) || 0;
            console.log(`  [MYS] Alpha: ${alphaTotal} total exhibitors`);
            onProgress(`Alpha search: ${alphaTotal} exhibitors — paginating...`, 38);
          }
          const hits = exhData.hit || [];
          if (hits.length === 0) break;
          for (const hit of hits) {
            const f = hit.fields || {};
            const name = (f.exhname_t || '').trim();
            if (!name) continue;
            const exhId = String(f.exhid_l || '').trim();
            const boothRaw = (f.boothsdisplay_la || [])[0] || '';
            const boothMatch = boothRaw.match(/^([A-Z]*\d+)/);
            const key = exhId || name;
            if (!alphaMap.has(key)) alphaMap.set(key, { name, exhId, boothNumber: boothMatch ? boothMatch[1] : '' });
          }
          alphaStart += hits.length;
          alphaPage++;
          if (hits.length < 200) break;
          await sleep(300);
        } catch (e) { console.log(`  [MYS] Alpha page ${alphaPage} error: ${e.message}`); break; }
      }
      console.log(`  [MYS] Alpha: ${alphaMap.size} exhibitors from ${alphaPage} page(s)`);
    }

    // ── Step 4b: page.evaluate fallback — if context.request failed entirely ──
    // The old show=all approach (~200 cap) is kept as a last resort so the scraper
    // never returns 0 from a transient server problem.
    let evaluateFallbackItems = [];
    if (kwMap.size === 0 && alphaMap.size === 0) {
      console.log('  [MYS] Both API paths empty — trying page.evaluate alpha fallback');
      onProgress('Fetching exhibitors via browser search...', 40);
      const alphaRaw = await page.evaluate(async (cfg) => {
        return new Promise((resolve) => {
          const searchUrl = `${cfg.origin}/8_0/ajax/remote-proxy.cfm?action=search&search=*` +
            `&searchtype=exhibitoralpha&sortfield=title_t&sortdirection=asc&show=all`;
          const xhr = new XMLHttpRequest();
          xhr.open('GET', searchUrl, true);
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.timeout = 90000;
          xhr.ontimeout = () => resolve([]);
          xhr.onload = () => {
            try {
              const d = JSON.parse(xhr.responseText);
              const exhData = d.DATA && d.DATA.results && d.DATA.results.exhibitor;
              const hits = (exhData && exhData.hit) || [];
              resolve(hits.map(hit => {
                const f = hit.fields || {};
                const boothRaw = (f.boothsdisplay_la || [])[0] || '';
                const m = boothRaw.match(/^([A-Z]*\d+)/);
                return { name: (f.exhname_t || '').trim(), exhId: String(f.exhid_l || ''), boothNumber: m ? m[1] : '' };
              }).filter(x => x.name));
            } catch { resolve([]); }
          };
          xhr.onerror = () => resolve([]);
          xhr.send();
        });
      }, config).catch(() => []);
      evaluateFallbackItems = alphaRaw || [];
      console.log(`  [MYS] page.evaluate fallback: ${evaluateFallbackItems.length} exhibitors`);
    }

    // ── Step 5: merge all sources ─────────────────────────────────────────────
    // Priority: kwMap (most complete) → alphaMap / evaluateFallback → boothMap (dims)
    const merged = new Map();
    const primarySource = kwMap.size > 0 ? kwMap : alphaMap;

    for (const [key, a] of primarySource) {
      merged.set(key, { name: a.name, exhId: a.exhId, booth: a.booth || a.boothNumber || '', dims: a.dims || '', website: a.website || '' });
    }
    for (const fb of evaluateFallbackItems) {
      const key = fb.exhId || fb.name;
      if (!merged.has(key)) merged.set(key, { name: fb.name, exhId: fb.exhId, booth: fb.boothNumber || '', dims: '', website: '' });
    }
    // Overlay floor plan data (authoritative booth number + dims)
    for (const [key, b] of boothMap) {
      if (merged.has(key)) {
        const m = merged.get(key);
        if (b.booth) m.booth = b.booth;
        m.dims = b.dims;
      } else {
        merged.set(key, { name: b.name, exhId: b.exhId, booth: b.booth, dims: b.dims, website: '' });
      }
    }

    const allExhibitors = Array.from(merged.values());
    console.log(`  [MYS] Merged total: ${allExhibitors.length} unique exhibitors`);
    onProgress(`Merged ${allExhibitors.length} exhibitors — enriching with website info...`, 55);

    // ── Step 6: getExhibitorInfo enrichment for website URLs ──────────────────
    // Skip if keyword search already returned website data for most exhibitors
    const needsEnrich = allExhibitors.filter(e => !e.website && e.exhId).length;
    if (needsEnrich > 0) {
      let infoProxy = null, infoUrlField = null;
      const probeExh = allExhibitors.find(e => e.exhId);
      if (probeExh) {
        for (const proxyUrl of proxyCandidates) {
          try {
            const qs = `action=getExhibitorInfo&exhID=${probeExh.exhId}&showCustID=&_=${Date.now()}`;
            const resp = await mysGet(proxyUrl + '?' + qs, 12000, 2);
            if (!resp) continue;
            const data = await resp.json().catch(() => null);
            if (!Array.isArray(data) || !data.length) continue;
            infoProxy = proxyUrl;
            infoUrlField = data[0].url !== undefined ? 'url' : data[0].website !== undefined ? 'website' : null;
            break;
          } catch (_) {}
        }
      }

      if (infoProxy) {
        const withId = allExhibitors.filter(e => !e.website && e.exhId);
        const BATCH = 15;
        for (let i = 0; i < withId.length; i += BATCH) {
          const pct = 55 + Math.round((i / withId.length) * 38);
          onProgress(`Enriching ${i + 1}–${Math.min(i + BATCH, withId.length)} of ${withId.length}...`, pct);
          await Promise.allSettled(withId.slice(i, i + BATCH).map(async (exh) => {
            try {
              const qs = `action=getExhibitorInfo&exhID=${exh.exhId}&showCustID=&_=${Date.now()}`;
              const resp = await mysGet(infoProxy + '?' + qs, 15000, 1);
              if (!resp) return;
              const info = await resp.json().catch(() => null);
              if (Array.isArray(info) && info.length > 0) {
                const d = info[0];
                exh.website = ((infoUrlField && d[infoUrlField]) || d.url || d.website || '').trim();
              }
            } catch (_) {}
          }));
          if (i + BATCH < withId.length) await sleep(200);
        }
      }
    }

    const results = allExhibitors.map(e => ({
      name:        e.name,
      boothNumber: e.booth   || '',
      boothSize:   e.dims    || '',
      website:     e.website || '',
    }));

    console.log(`  [MYS] Final: ${results.length} exhibitors`);
    onProgress(`Extracted ${results.length} exhibitors!`, 95);
    return results;

  } finally {
    await page.close();
  }
}

// =============================================================================
// UNGERBOECK / MOMENTUS  — Virtual Floor Plan (VFP) platform
//
// Root cause of all previous failures:
//   • Headless Chromium renders 14 Canvas 2D floor-plan tiles in software mode;
//     Fabric.js draw calls block the JS event loop → DOM never populates.
//   • page.route + route.fetch() creates a request-duplication deadlock:
//     the original request stalls waiting for the route handler to fulfill it,
//     while route.fetch() tries to fire a duplicate that also stalls.
//
// Key findings (reverse-engineered via live DevTools):
//   • The floor plan is an Aurelia SPA that renders 14 large Canvas 2D elements
//     using Fabric.js. In headless Chromium (software rendering, no GPU), these
//     canvases block the JS event loop, so the DOM <ul id="exhibitorList"> never
//     gets populated — even after 4+ minutes.
//   • All exhibitor data comes from two API endpoints:
//       POST /prod/api/VFPServer/GetInitialData   → returns exhibitor IDs + show params
//       POST /prod/api/VFPServer/GetExhibitorDetails → returns name/booth/website per ID
//   • Both return HTTP 201 with double-encoded JSON: ["{ \"ReturnObj\": {...} }"]
//   • Request body format: [proto, showId, showCode, ...]  (event-specific values)
//
// Strategy:
//
// Working strategy (two independent capture methods, first-wins):
//   Method A — Playwright request/response EVENTS (no JS involvement, no route):
//     page.on('request')  → capture POST body + headers of GetInitialData
//     page.on('response') → capture response body of GetInitialData
//     Requests pass through the browser normally; we only observe them.
//   Method B — addInitScript fetch patch + exposeFunction (JS-level backup):
//     Patches window.fetch before Aurelia runs; body captured BEFORE _fetch()
//     is called so Request.bodyUsed is false when we clone.
//   GetExhibitorDetails → context.request.post() in Node.js (no page.evaluate).
// =============================================================================
async function scrapeUngerboeck(context, url, onProgress) {
  const page = await context.newPage();

  // Shared store — whichever method fires first populates this
  const vfpData = { headers: null, reqBody: null, respBody: null, ready: false };

  // ── Method A: Playwright request/response events ─────────────────────────────
  // Fires in Node.js via CDP — completely outside the browser JS engine.
  // Requests pass through the browser normally; we only observe them.
  let _pendingReqBody = '';
  let _pendingReqHdrs = {};

  page.on('request', (req) => {
    if (req.url().includes('/VFPServer/GetInitialData')) {
      _pendingReqBody = req.postData() || '';
      _pendingReqHdrs = req.headers();
      console.log('  [Ungerboeck] Method A: GetInitialData request observed');
    }
  });

  page.on('response', async (resp) => {
    try {
      if (!resp.url().includes('/VFPServer/GetInitialData') || vfpData.ready) return;
      const txt = await resp.text();
      if (!txt || txt.length < 5) return;
      vfpData.reqBody  = _pendingReqBody;
      vfpData.headers  = _pendingReqHdrs;
      vfpData.respBody = txt;
      vfpData.ready    = true;
      console.log(`  [Ungerboeck] Method A: response captured (${txt.length} bytes)`);
    } catch (e) {
      console.log('  [Ungerboeck] Method A response error:', e.message);
    }
  });

  // ── Method B: exposeFunction + addInitScript fetch patch ─────────────────────
  await page.exposeFunction('__vfpCapture__', (reqBody, respBody, hdrsJson) => {
    if (vfpData.ready) return;
    try {
      vfpData.reqBody  = reqBody;
      vfpData.respBody = respBody;
      vfpData.headers  = JSON.parse(hdrsJson || '{}');
      vfpData.ready    = true;
      console.log(`  [Ungerboeck] Method B: fetch patch captured (${respBody.length} bytes)`);
    } catch {}
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };

    // Canvas 2D no-op — prevents Fabric.js from monopolising the event loop
    const _getCtx = HTMLCanvasElement.prototype.getContext;
    const NOOP_OPS = new Set([
      'clearRect','fillRect','strokeRect','fill','stroke',
      'beginPath','closePath','moveTo','lineTo','bezierCurveTo',
      'quadraticCurveTo','arc','arcTo','ellipse','rect',
      'scale','rotate','translate','transform','setTransform',
      'resetTransform','drawImage','putImageData','clip',
      'fillText','strokeText','setLineDash',
    ]);
    const STUB_OPS = {
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createConicGradient:  () => ({ addColorStop: () => {} }),
      createPattern:        () => ({}),
      getImageData: (sx, sy, sw, sh) => ({
        data: new Uint8ClampedArray((sw || 1) * (sh || 1) * 4), width: sw || 1, height: sh || 1,
      }),
      measureText: () => ({ width: 0 }),
    };
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = _getCtx.call(this, type, ...rest);
      if (type !== '2d' || !ctx) return ctx;
      return new Proxy(ctx, {
        get(t, p) {
          if (STUB_OPS[p]) return STUB_OPS[p];
          if (NOOP_OPS.has(p)) return () => {};
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) { t[p] = v; return true; },
      });
    };

    // Fetch patch — MUST capture body/headers BEFORE calling _fetch because
    // _fetch() marks Request.bodyUsed = true, preventing later .clone() calls.
    const _fetch = window.fetch;
    window.fetch = function (...args) {
      const isReq  = args[0] instanceof Request;
      const reqUrl = isReq ? args[0].url : String(args[0] || '');
      const opts   = isReq ? {} : (args[1] || {});

      let hdrs = {}, bodyP = Promise.resolve('');
      if (reqUrl.includes('/VFPServer/GetInitialData')) {
        try {
          if (isReq) args[0].headers.forEach((v, k) => { hdrs[k] = v; });
          else if (opts.headers) Object.entries(opts.headers).forEach(([k, v]) => { hdrs[k] = String(v); });
        } catch {}
        if (isReq) {
          try { bodyP = args[0].clone().text().catch(() => ''); } catch { bodyP = Promise.resolve(''); }
        } else {
          bodyP = Promise.resolve(String(opts.body || ''));
        }
      }

      const p = _fetch.apply(this, args);

      if (reqUrl.includes('/VFPServer/GetInitialData')) {
        p.then(r => r.clone().text())
         .then(resp => bodyP.then(body => window.__vfpCapture__(body, resp, JSON.stringify(hdrs))))
         .catch(() => {});
      }
      return p;
    };
  });

  try {
    onProgress('Loading Ungerboeck exhibitor data...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    const pageTitle = await page.title().catch(() => '(no title)');
    console.log(`  [Ungerboeck] Page title: "${pageTitle}"`);

    onProgress('Waiting for Ungerboeck VFP data...', 15);

    // ── Data acquisition: THREE parallel methods, first one wins ─────────────
    //
    // Method A — page.on('request'/'response'): pure CDP observation, already set up above
    // Method B — addInitScript fetch patch: already set up above
    // Method C — page.evaluate() Aurelia viewmodel direct read (most reliable):
    //   After Aurelia boots + GetInitialData returns, the viewmodel holds the
    //   entire parsed response at rootDiv.aurelia.root.viewModel._initialData.
    //   Confirmed live on DAC 2026 (81 exhibitors) and ALA 2026 (488 exhibitors):
    //     _initialData.ExhibitorList  — Array of {Id, Name, BoothNames, ...}
    //     _initialData.ConfigID       — number  (e.g. 176)
    //     _initialData.EventID        — number  (e.g. 5010)
    //     _initialData.ConfigCode     — string  (e.g. "DAC26SM")
    //
    let proto = '17', showId = 0, showCode = '';
    let exhibitorList = [];
    let captureMethod = '';

    for (let i = 0; i < 180; i++) {   // up to 90 seconds
      await sleep(500);

      // ── Method A+B: API response captured ───────────────────────────────────
      if (vfpData.ready && !showCode) {
        const respTrimmed = (vfpData.respBody || '').trimStart();
        if (respTrimmed.startsWith('<') || respTrimmed.startsWith('<!')) {
          // Token already consumed by a prior run — can't recover from API path.
          // Continue polling in case Method C still finds the viewmodel.
          console.log('  [Ungerboeck] Methods A+B: HTML response (stale/used token) — trying Method C');
        } else {
          try {
            const outer  = JSON.parse(vfpData.respBody);
            const inner  = Array.isArray(outer) ? outer[0] : outer;
            const parsed = typeof inner === 'string' ? JSON.parse(inner) : inner;
            const ro     = parsed?.ReturnObj ?? parsed ?? {};

            proto    = String(ro.ConfigID   ?? '17');
            showId   = Number(ro.EventID)   || 0;
            showCode = String(ro.ConfigCode ?? '');

            for (const field of ['ExhibitorList','Exhibitors','Items','BoothList','Data','Booths','Results']) {
              if (Array.isArray(ro[field]) && ro[field].length > 0) {
                exhibitorList = ro[field];
                break;
              }
            }
            if (!exhibitorList.length) {
              for (const [, v] of Object.entries(ro)) {
                if (Array.isArray(v) && v.length > exhibitorList.length && v[0]?.Id !== undefined) {
                  exhibitorList = v;
                }
              }
            }
            if (showCode) {
              captureMethod = 'A+B (API response)';
              console.log(`  [Ungerboeck] ${captureMethod}: proto=${proto} id=${showId} code=${showCode} exhibitors=${exhibitorList.length}`);
              break;
            }
          } catch (e) {
            console.log('  [Ungerboeck] Methods A+B parse error:', e.message);
          }
        }
      }

      // ── Method C: read Aurelia viewmodel directly ────────────────────────────
      // Try every 2 seconds (every 4th iteration)
      if (i % 4 === 3 && !showCode) {
        try {
          const vmData = await page.evaluate(() => {
            try {
              const rootEl = Array.from(document.querySelectorAll('*'))
                               .find(el => el.aurelia);
              if (!rootEl) return null;
              const vm = rootEl.aurelia && rootEl.aurelia.root &&
                         rootEl.aurelia.root.viewModel;
              if (!vm || !vm._initialData) return null;
              const d = vm._initialData;
              if (!d.ConfigCode || !Array.isArray(d.ExhibitorList)) return null;
              return {
                ConfigID:     d.ConfigID,
                EventID:      d.EventID,
                ConfigCode:   d.ConfigCode,
                OrgCode:      d.OrgCode || '',
                ExhibitorList: d.ExhibitorList.map(e => ({
                  Id:        e.Id,
                  Name:      e.Name      || '',
                  BoothNames: Array.isArray(e.BoothNames) ? e.BoothNames : [],
                })),
              };
            } catch { return null; }
          });

          if (vmData && vmData.ConfigCode) {
            proto         = String(vmData.ConfigID ?? '17');
            showId        = Number(vmData.EventID)  || 0;
            showCode      = String(vmData.ConfigCode);
            exhibitorList = vmData.ExhibitorList;
            captureMethod = 'C (viewmodel)';
            console.log(`  [Ungerboeck] ${captureMethod}: proto=${proto} id=${showId} code=${showCode} exhibitors=${exhibitorList.length}`);
            break;
          }
        } catch (e) {
          console.log('  [Ungerboeck] Method C attempt error:', e.message);
        }
      }
    }

    if (!showCode) {
      console.log('  [Ungerboeck] All capture methods failed after 90s');
      const hint = (vfpData.respBody || '').trimStart().startsWith('<')
        ? 'ERROR: This URL\'s aat token has already been used. Please generate a fresh floor-plan URL from the event website and try again.'
        : 'ERROR: Could not load Ungerboeck exhibitor data. Verify the URL is a valid floor-plan link (app85.cshtml?aat=...).';
      onProgress(hint, 0);
      await page.close();
      return [];
    }

    console.log(`  [Ungerboeck] Data captured via ${captureMethod}: ${exhibitorList.length} exhibitors in list`);

    // Normalize the exhibitor list to {id, name, booth}
    const exhibitors = exhibitorList
      .map(e => ({
        id:    e.Id   ?? e.ExhibitorId   ?? e.BoothId   ?? 0,
        name:  e.Name ?? e.ExhibitorName ?? e.Company   ?? '',
        booth: e.BoothNumber ?? e.Booth ??
               (Array.isArray(e.BoothNames) ? e.BoothNames[0] : '') ?? '',
      }))
      .filter(e => e.id);

    console.log(`  [Ungerboeck] ${exhibitors.length} exhibitors to fetch`);
    onProgress(`Found ${exhibitors.length} exhibitors — fetching details...`, 25);

    // ── 3. Call GetExhibitorDetails from Node.js via context.request.post ────
    // This runs entirely in Node.js — no page.evaluate, no JS event loop,
    // no timeout risk regardless of how many exhibitors there are.
    // context.request shares the browser context's cookies, so auth is automatic.
    const origin     = new URL(url).origin;
    const detailsUrl = `${origin}/prod/api/VFPServer/GetExhibitorDetails`;

    // Build safe headers: copy captured GetInitialData headers when available
    // (Methods A+B), or use minimal defaults (Method C / viewmodel path).
    // context.request shares browser cookies so auth is automatic regardless.
    const safeHeaders = { 'content-type': 'application/json', 'accept': 'application/json, text/plain, */*' };
    for (const [k, v] of Object.entries(vfpData.headers || {})) {
      const kl = k.toLowerCase();
      if (['content-length','host','transfer-encoding','content-type'].includes(kl)) continue;
      safeHeaders[k] = v;
    }

    const result  = {};
    const total   = exhibitors.length;

    for (let i = 0; i < total; i++) {
      const { id, name, booth } = exhibitors[i];

      if (i % 20 === 0) {
        const pct = 25 + Math.round((i / total) * 60);
        onProgress(`Fetching exhibitor ${i + 1} of ${total}...`, pct);
      }

      try {
        const resp = await context.request.post(detailsUrl, {
          headers: safeHeaders,
          data:    JSON.stringify([proto, showId, showCode, id, '*']),
          timeout: 30_000,
        });
        const txt   = await resp.text();
        const outer = JSON.parse(txt);
        const inner = Array.isArray(outer) ? outer[0] : outer;
        const ro    = typeof inner === 'string'
          ? JSON.parse(inner)?.ReturnObj
          : inner?.ReturnObj;

        if (ro?.Name) {
          const boothNumber = (Array.isArray(ro.BoothNames) && ro.BoothNames.length)
            ? ro.BoothNames.map(b => String(b).trim()).join(', ')
            : String(ro.Booths ?? booth ?? '').trim();
          const category = (ro.Products ?? [])
            .map(p => p.Desc ?? p.Name ?? '').filter(Boolean).join('; ');
          result[ro.Name] = {
            exhibitorName: ro.Name,
            boothNumber,
            boothSize:   '',
            website:     String(ro.WebsiteURL ?? '').trim(),
            city:        String(ro.CatCity    ?? '').trim(),
            state:       String(ro.CatState   ?? '').trim(),
            country:     String(ro.CatCountry ?? '').trim(),
            description: String(ro.CatDesc    ?? category ?? '').trim(),
          };
        } else if (name) {
          result[name] = {
            exhibitorName: name, boothNumber: String(booth ?? ''), boothSize: '',
            website: '', city: '', state: '', country: '', description: '',
          };
        }
      } catch {
        if (name) result[name] = {
          exhibitorName: name, boothNumber: String(booth ?? ''), boothSize: '',
          website: '', city: '', state: '', country: '', description: '',
        };
      }

      // Light throttle — avoids hammering the server
      if (i < total - 1) await sleep(150);
    }

    const count    = Object.keys(result).length;
    const withSite = Object.values(result).filter(e => e.website).length;
    console.log(`  [Ungerboeck] Done: ${count} exhibitors, ${withSite} with websites`);
    onProgress(`Extracted ${count} exhibitors!`, 92);
    return Object.values(result);

  } finally {
    await page.close();
  }
}

// =============================================================================
// EVENTSCRIBE / CADMIUM  — AJAX floor plan platform (eventscribe.net)
//
// Key findings (reverse-engineered via DevTools on apco2026.eventscribe.net):
//   • Floor plan page: /exhibitors/floorplan/floorplan.asp
//   • Three AJAX endpoints, all POST:
//       /pages/floorplan/ajax/CreateCompanyList.asp  → all exhibitors (JSON)
//       /pages/floorplan/ajax/CreateBoothDivs.asp    → booth layout
//       /pages/floorplan/ajax/CreateBoothLegend.asp  → legend data
//   • CreateCompanyList.asp response structure:
//       { companyListHeading: [{ bucketHeading: "A", companyList: [{
//           exhibitorName, boothNumber, boothID, boothURL, exhibitorKey, exhibitorLogoImage
//       }] }] }
//   • All POST requests need: EventID, EventClientID, EventKey (from inline script)
//   • EventID and EventClientID are integers; EventKey is an 8-char string (e.g. "JBBFWNZS")
//   • Auth: Session cookie from page load (no extra tokens needed)
//   • Company website: linked via /includes/tracking/exhibitorAssetTracking.asp (encrypted
//     redirect) reached from /ajaxcalls/exhibitorInfo.asp?BoothID=... — enrichment done
//     in batches using Playwright context.request which auto-follows redirects.
//
// Strategy:
//   1. Navigate to page → acquire session cookies + extract inline config
//   2. POST CreateCompanyList.asp → flatten companyListHeading[*].companyList[*]
//   3. Batch-enrich exhibitors with website URLs by following tracking redirects
// =============================================================================
async function scrapeEventScribe(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading EventScribe floor plan...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2000);

    // ── Step 1: extract config from inline <script> ──────────────────────────────
    // The page embeds EventID, EventClientID, EventKey directly in a script block
    // that constructs the AJAX POST body (no obfuscation, plain integer/string values).
    const config = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const idx  = html.indexOf('CreateCompanyList.asp');
      if (idx < 0) return null;
      // Look in a generous window around the endpoint reference
      const chunk = html.substring(Math.max(0, idx - 100), idx + 900);
      const get = (key) => {
        const re = new RegExp(key + '\\s*:\\s*[\'"]?([A-Za-z0-9_-]+)[\'"]?');
        const m  = re.exec(chunk);
        return m ? m[1].trim() : '';
      };
      return {
        EventID:                       get('EventID'),
        EventClientID:                 get('EventClientID'),
        EventKey:                      get('EventKey'),
        ShowLogos:                     get('ShowLogos')                    || '1',
        LogoLocation:                  get('LogoLocation')                 || '1',
        ShowCompanyWithNegativeBalance: get('ShowCompanyWithNegativeBalance') || '1',
      };
    }).catch(() => null);

    if (!config || !config.EventID || !config.EventKey) {
      console.log('  [EventScribe] Could not find EventID/EventKey in page inline script');
      onProgress('ERROR: Could not find EventScribe event config in page. Verify the URL is a valid EventScribe floor plan link.', 0);
      await page.close();
      return [];
    }

    console.log(`  [EventScribe] Config: EventID=${config.EventID} ClientID=${config.EventClientID} Key=${config.EventKey}`);
    onProgress('Fetching exhibitor list (EventScribe CreateCompanyList)...', 20);

    // ── Step 2: POST CreateCompanyList.asp ───────────────────────────────────────
    const origin    = new URL(url).origin;
    const listUrl   = `${origin}/pages/floorplan/ajax/CreateCompanyList.asp`;

    const listResp  = await context.request.post(listUrl, {
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With':'XMLHttpRequest',
        'Referer':         url,
      },
      form: {
        EventID:                       config.EventID,
        EventClientID:                 config.EventClientID,
        EventKey:                      config.EventKey,
        ShowLogos:                     config.ShowLogos,
        LogoLocation:                  config.LogoLocation,
        ShowCompanyWithNegativeBalance: config.ShowCompanyWithNegativeBalance,
        OpenBoothPopupLink:            '/ajaxcalls/companyRequestInfo.asp?',
        RentedBoothPopupLink:          '/ajaxcalls/exhibitorInfo.asp?',
      },
      timeout: 30_000,
    });

    let listData;
    try { listData = await listResp.json(); }
    catch { console.log('  [EventScribe] CreateCompanyList returned non-JSON'); listData = null; }

    if (!listData || !Array.isArray(listData.companyListHeading)) {
      console.log('  [EventScribe] Unexpected CreateCompanyList response structure');
      onProgress('ERROR: EventScribe returned unexpected data. Check the URL is a valid floor plan page.', 0);
      await page.close();
      return [];
    }

    // Flatten alpha-bucket groupings → flat array
    const rawList = [];
    for (const bucket of listData.companyListHeading) {
      for (const company of (bucket.companyList || [])) {
        if (!company.exhibitorName) continue;
        rawList.push({
          exhibitorName: String(company.exhibitorName).trim(),
          boothNumber:   String(company.boothNumber  || '').trim(),
          boothID:       String(company.boothID      || '').trim(),
          boothURL:      String(company.boothURL     || '').trim(), // e.g. /ajaxcalls/exhibitorInfo.asp?BoothID=852742
        });
      }
    }

    console.log(`  [EventScribe] ${rawList.length} exhibitors from CreateCompanyList`);

    if (rawList.length === 0) {
      onProgress('ERROR: No exhibitors found in EventScribe data.', 0);
      await page.close();
      return [];
    }

    onProgress(`Found ${rawList.length} exhibitors — enriching with website URLs...`, 35);

    // ── Step 3: batch-enrich with website URLs ────────────────────────────────────
    // Each exhibitor's boothURL points to /ajaxcalls/exhibitorInfo.asp?BoothID=N
    // which is an HTML page containing an /includes/tracking/exhibitorAssetTracking.asp
    // link that server-redirects to the actual company website.
    // We follow that redirect in Node.js via context.request (auto-follows 302s).
    const BATCH    = 8;
    const infoBase = origin;

    for (let i = 0; i < rawList.length; i += BATCH) {
      const pct   = 35 + Math.round((i / rawList.length) * 50);
      const slice = rawList.slice(i, i + BATCH);
      onProgress(`Fetching profiles ${i + 1}–${Math.min(i + BATCH, rawList.length)} of ${rawList.length}...`, pct);

      await Promise.all(slice.map(async (exh) => {
        if (!exh.boothURL) return;
        try {
          // 1. Fetch the exhibitor info HTML page
          const infoResp = await context.request.get(infoBase + exh.boothURL, { timeout: 12_000 });
          const html     = await infoResp.text();

          // 2. Extract the tracking link (encrypted redirect to company website)
          const match = html.match(/exhibitorAssetTracking\.asp\?assetFP=([^"'\s&]+)/);
          if (!match) return;

          const trackUrl = `${origin}/includes/tracking/exhibitorAssetTracking.asp?assetFP=${match[1]}`;

          // 3. Follow the redirect — context.request follows 302s automatically
          //    The final resp.url() is the actual company website
          const trackResp = await context.request.get(trackUrl, { timeout: 12_000 });
          const finalUrl  = trackResp.url();

          if (finalUrl &&
              !finalUrl.includes('eventscribe') &&
              !finalUrl.includes('cadmium') &&
              !finalUrl.includes('conferenceharvester')) {
            exh.website = finalUrl.replace(/\/$/, '');
          }
        } catch { /* ignore per-exhibitor failures */ }
      }));
    }

    // ── Step 4: assemble output ──────────────────────────────────────────────────
    const output = rawList.map(e => ({
      exhibitorName: e.exhibitorName,
      boothNumber:   e.boothNumber,
      boothSize:     '',
      website:       e.website || '',
      city:          '',
      state:         '',
      country:       '',
      description:   '',
    }));

    const withSite = output.filter(e => e.website).length;
    console.log(`  [EventScribe] Done: ${output.length} exhibitors, ${withSite} with websites`);
    onProgress(`Extracted ${output.length} exhibitors!`, 92);
    return output;

  } finally {
    await page.close();
  }
}

// =============================================================================
// EXPOFP  — in-memory JS API (expofp.com subdomain floor plans)
//
// Key findings (reverse-engineered via DevTools on gbtaconvention26.expofp.com):
//   • Floor plan is a React SPA; all exhibitor data is loaded into memory at init.
//   • The global `window.___fp` (triple underscore) is the FloorPlan instance.
//   • Two methods expose all the data needed without any extra HTTP requests:
//       ___fp.exhibitorsList() → [{id, name, slug, booths:[boothId,...], entity}]
//       ___fp.boothsList()     → [{id, name (booth#), exhibitors:[exhId,...], ...}]
//   • Cross-referencing these two arrays gives exhibitorName + boothNumber.
//   • Website / contact info is behind 403-gated per-exhibitor JSON files —
//     not accessible without an authenticated session. Skipped gracefully.
//   • ___fp becomes available after "Floor plan rendered" GA event fires
//     (typically 2–4 s after DOMContentLoaded on fast connections).
//
// Strategy:
//   1. Navigate to the ExpoFP URL
//   2. Poll for ___fp.exhibitorsList to be a callable function (up to 30 s)
//   3. Call exhibitorsList() + boothsList() via page.evaluate
//   4. Cross-reference in Node.js to produce flat {exhibitorName, boothNumber} rows
// =============================================================================
async function scrapeExpoFP(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading ExpoFP floor plan...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    onProgress('Waiting for ExpoFP data to load...', 15);

    // Poll until ___fp.exhibitorsList is callable (SPA initialises asynchronously)
    const ready = await page.waitForFunction(() => {
      return (
        window.___fp &&
        typeof window.___fp.exhibitorsList === 'function' &&
        typeof window.___fp.boothsList === 'function' &&
        (() => { try { const l = window.___fp.exhibitorsList(); return Array.isArray(l) && l.length > 0; } catch { return false; } })()
      );
    }, { timeout: 30_000 }).catch(() => null);

    if (!ready) {
      console.log('  [ExpoFP] ___fp not ready after 30s');
      onProgress('ERROR: ExpoFP floor plan did not initialise in time. Verify the URL is a valid ExpoFP floor plan.', 0);
      await page.close();
      return [];
    }

    onProgress('Extracting ExpoFP exhibitor data...', 40);

    // Pull both lists in a single page.evaluate call
    const { exhibitors, booths } = await page.evaluate(() => {
      const fp = window.___fp;
      return {
        exhibitors: fp.exhibitorsList().map(e => ({
          id:    e.id,
          name:  e.name  || '',
          slug:  e.slug  || '',
          booths: Array.isArray(e.booths) ? e.booths : [],
        })),
        booths: fp.boothsList().map(b => ({
          id:         b.id,
          name:       b.name       || '',   // booth number string
          exhibitors: Array.isArray(b.exhibitors) ? b.exhibitors : [],
        })),
      };
    });

    console.log(`  [ExpoFP] ${exhibitors.length} exhibitors, ${booths.length} booths`);

    if (exhibitors.length === 0) {
      onProgress('ERROR: ExpoFP returned no exhibitor data.', 0);
      await page.close();
      return [];
    }

    // Build maps in Node.js for fast cross-referencing
    const exhibMap = new Map(exhibitors.map(e => [e.id, e]));
    const boothMap = new Map(booths.map(b => [b.id, b]));

    // Assemble output: one row per exhibitor, booth numbers joined if multi-booth
    const seen   = new Set();
    const output = [];

    // Iterate booths so we get the booth number naturally
    for (const booth of booths) {
      for (const exhId of booth.exhibitors) {
        const exh = exhibMap.get(exhId);
        if (!exh || !exh.name) continue;
        if (seen.has(exhId)) {
          // Multi-booth exhibitor — append extra booth number
          const existing = output.find(r => r._id === exhId);
          if (existing) existing.boothNumber += ', ' + booth.name;
          continue;
        }
        seen.add(exhId);
        output.push({
          _id:          exhId,
          exhibitorName: exh.name,
          boothNumber:   booth.name,
          boothSize:     '',
          website:       '',
          city:          '',
          state:         '',
          country:       '',
          description:   '',
        });
      }
    }

    // Include any exhibitors that didn't appear in boothsList (e.g. unassigned)
    for (const exh of exhibitors) {
      if (!seen.has(exh.id) && exh.name) {
        output.push({
          _id:          exh.id,
          exhibitorName: exh.name,
          boothNumber:   '',
          boothSize:     '',
          website:       '',
          city:          '',
          state:         '',
          country:       '',
          description:   '',
        });
      }
    }

    // Strip internal _id before returning
    const result = output.map(({ _id, ...rest }) => rest);

    console.log(`  [ExpoFP] Done: ${result.length} exhibitors`);
    onProgress(`Extracted ${result.length} exhibitors!`, 92);
    return result;

  } finally {
    await page.close();
  }
}

// =============================================================================
// GOEXPO / N2A  — GeFpServer.php API (XML-based floor plan platform)
//
// Key findings (reverse-engineered via DevTools on n2a.goexposoftware.com):
//   • Floor plan page: viewFloorPlan.php?ai=N
//   • API server:      GeFpServer.php (same directory as viewFloorPlan.php)
//   • Exhibitor list:  GET GeFpServer.php?request=9
//     → Returns XML: <exhibitors><totalExhibitors>N</totalExhibitors>
//                    <exhibitor><exhibitorId>...<boothNumber>...<company>...<categories>...
//   • Auth:            Session cookie set on page load — no extra params needed
//   • Profile pages:   viewExhibitorProfile.php?__id=<exhibitorId>
//     → Contains website URL (scraped selectively for enrichment)
//
// Strategy:
//   1. Navigate to the floor plan URL to acquire session cookies
//   2. XHR-fetch GeFpServer.php?request=9 from within page context
//   3. Parse XML response via browser DOMParser
//   4. Batch-enrich up to MAX_PROFILE_ENRICHMENT exhibitors with website URLs
//      by fetching their profile pages (stays polite, respects server load)
// =============================================================================
const GOEXPO_MAX_ENRICH = 500;  // cap profile fetches to keep runtime reasonable

async function scrapeGoExpo(context, url, onProgress) {
  // ── Build base URLs from the floor plan URL ──────────────────────────────────
  // Floor plan URL pattern:  .../goExpo/floorPlan/viewFloorPlan.php?ai=N
  // API URL pattern:         .../goExpo/floorPlan/GeFpServer.php?request=9&pg=N&rpp=500
  // Profile URL pattern:     .../goExpo/exhibitor/viewExhibitorProfile.php?__id=N
  //
  // CRITICAL: request=9 REQUIRES pg and rpp params — without them the server
  // returns an empty response (0 bytes). This was the root cause of "NO EXHIBITORS
  // FOUND". We use rpp=500 and paginate until all exhibitors are collected.
  const pageUrl     = new URL(url);
  const dirPath     = pageUrl.pathname.replace(/\/[^/]+\.php$/, '/');
  const apiBase     = `${pageUrl.origin}${dirPath}GeFpServer.php`;
  // Profile pages live under exhibitor/ not floorPlan/
  const exhibitorDir = dirPath.replace(/\/[^/]+\/$/, '/exhibitor/');
  const profileBase = `${pageUrl.origin}${exhibitorDir}viewExhibitorProfile.php?__id=`;

  const page = await context.newPage();
  try {
    onProgress('Loading GoExpo floor plan...', 5);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(1500);  // let session cookies settle

    // ── Helper: parse GoExpo XML response into exhibitor objects ────────────────
    function parseGoExpoXml(xmlText) {
      const items = [];
      const re = /<exhibitor>([\s\S]*?)<\/exhibitor>/g;
      let m;
      while ((m = re.exec(xmlText)) !== null) {
        const block = m[1];
        const tag   = (t) => { const r = new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`); const x = r.exec(block); return x ? x[1].trim() : ''; };
        const company = tag('company');
        if (!company) continue;
        const w = parseInt(tag('width'),  10) || 0;
        const h = parseInt(tag('height'), 10) || 0;
        items.push({
          exhibitorId: tag('exhibitorId'),
          boothNumber: tag('boothNumber'),
          company,
          categories:  tag('categories'),
          boothSize:   (w > 0 && h > 0) ? `${w}x${h}` : '',
        });
      }
      return items;
    }

    // ── Step 1: fetch page 1 to learn total count ────────────────────────────────
    onProgress('Fetching GoExpo exhibitor list (page 1)...', 12);
    const RPP = 500;
    const page1Url = `${apiBase}?request=9&pg=1&rpp=${RPP}`;
    console.log(`  [GoExpo] API: ${page1Url}`);

    let page1Resp = await context.request.get(page1Url, { timeout: 30000 }).catch(() => null);
    let page1Text = page1Resp && page1Resp.ok() ? await page1Resp.text() : '';

    if (!page1Text || !page1Text.includes('<exhibitor>')) {
      // Fallback: try via page.evaluate XHR (same-origin cookies)
      console.log('  [GoExpo] context.request failed, trying page.evaluate XHR...');
      page1Text = await page.evaluate(async (u) => {
        return new Promise(resolve => {
          const x = new XMLHttpRequest();
          x.open('GET', u, true);
          x.withCredentials = true;
          x.timeout = 30000;
          x.onload = () => resolve(x.responseText);
          x.onerror = () => resolve('');
          x.ontimeout = () => resolve('');
          x.send();
        });
      }, page1Url).catch(() => '');
    }

    if (!page1Text || !page1Text.includes('<exhibitor>')) {
      console.log('  [GoExpo] request=9 returned no exhibitor data');
      onProgress('ERROR: GoExpo API returned no exhibitor data.', 0);
      return [];
    }

    // Read total from first response
    const totalMatch = page1Text.match(/<totalExhibitors>(\d+)<\/totalExhibitors>/);
    const totalCount = totalMatch ? parseInt(totalMatch[1], 10) : 0;
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / RPP) : 1;
    console.log(`  [GoExpo] Total exhibitors: ${totalCount}, pages: ${totalPages}`);

    // ── Step 2: paginate through all remaining pages ─────────────────────────────
    let allItems = parseGoExpoXml(page1Text);
    onProgress(`Found ${totalCount} exhibitors — fetching all pages...`, 20);

    for (let pg = 2; pg <= Math.min(totalPages, MAX_PAGES); pg++) {
      const pct     = 20 + Math.round(((pg - 1) / totalPages) * 40);
      const pageUrl2 = `${apiBase}?request=9&pg=${pg}&rpp=${RPP}`;
      onProgress(`Fetching page ${pg} of ${totalPages}...`, pct);
      console.log(`  [GoExpo] Fetching page ${pg}: ${pageUrl2}`);

      let resp = await context.request.get(pageUrl2, { timeout: 30000 }).catch(() => null);
      let text = resp && resp.ok() ? await resp.text() : '';

      if (!text || !text.includes('<exhibitor>')) {
        // fallback to page.evaluate
        text = await page.evaluate(async (u) => {
          return new Promise(resolve => {
            const x = new XMLHttpRequest();
            x.open('GET', u, true);
            x.withCredentials = true;
            x.timeout = 30000;
            x.onload = () => resolve(x.responseText);
            x.onerror = () => resolve('');
            x.ontimeout = () => resolve('');
            x.send();
          });
        }, pageUrl2).catch(() => '');
      }

      if (text && text.includes('<exhibitor>')) {
        allItems = allItems.concat(parseGoExpoXml(text));
      }
      await sleep(300);
    }

    console.log(`  [GoExpo] Collected ${allItems.length} exhibitors across all pages`);

    if (allItems.length === 0) {
      onProgress('ERROR: No exhibitors found in GoExpo data.', 0);
      return [];
    }

    onProgress(`Found ${allItems.length} exhibitors — enriching with website URLs...`, 62);

    // ── Step 3: enrich with website URLs from profile pages ──────────────────────
    // Profile pages live at .../exhibitor/viewExhibitorProfile.php?__id=N
    // Website URLs are shown only to logged-in users; for anonymous sessions the
    // field will be empty. We still attempt enrichment so logged-in users benefit.
    const toEnrich  = allItems.slice(0, GOEXPO_MAX_ENRICH);
    const websiteMap = {};

    const BATCH = 10;
    for (let i = 0; i < toEnrich.length; i += BATCH) {
      const pct   = 62 + Math.round((i / toEnrich.length) * 28);
      const slice = toEnrich.slice(i, i + BATCH);
      onProgress(`Fetching profiles ${i + 1}–${Math.min(i + BATCH, toEnrich.length)} of ${toEnrich.length}...`, pct);

      await Promise.allSettled(slice.map(async (e) => {
        try {
          const profUrl = profileBase + e.exhibitorId;
          const r = await context.request.get(profUrl, { timeout: 15000 });
          if (!r.ok()) return;
          const html = await r.text();
          // Website selectors in order of specificity
          const selectors = [
            /class="[^"]*website[^"]*"[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/i,
            /class="[^"]*Website[^"]*"[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"/i,
            /<a[^>]+href="(https?:\/\/(?!(?:[^"]*goexposoftware|[^"]*shotshow\.org|[^"]*core-apps\.com))[^"]+)"/i,
          ];
          for (const re of selectors) {
            const m = re.exec(html);
            if (m) { websiteMap[e.exhibitorId] = m[1].replace(/\/$/, ''); return; }
          }
        } catch { /* ignore per-exhibitor errors */ }
      }));
    }

    // ── Step 4: assemble final output ───────────────────────────────────────────
    const output = allItems.map(e => ({
      exhibitorName: e.company,
      boothNumber:   e.boothNumber,
      boothSize:     e.boothSize,
      website:       websiteMap[e.exhibitorId] || '',
      city:          '',
      state:         '',
      country:       '',
      description:   e.categories,
    }));

    const withSite = output.filter(e => e.website).length;
    console.log(`  [GoExpo] Done: ${output.length} exhibitors, ${withSite} with websites`);
    onProgress(`Extracted ${output.length} exhibitors!`, 95);
    return output;

  } finally {
    await page.close();
  }
}

// =============================================================================
// GENERIC DIRECTORY + FLOOR PLAN SCRAPERS
// =============================================================================
const CARD_SELECTORS = [
  '[class*="exhibitor-card"]','[class*="exhibitorCard"]','[class*="exhibitor-item"]',
  '[class*="exhibitor-row"]','[class*="vendor-card"]','[class*="company-card"]',
  '[class*="booth-card"]','[class*="sponsor-card"]','.exhibitor','.vendor','.sponsor',
];
const NAME_SELECTORS = [
  '[class*="company-name"]','[class*="companyName"]','[class*="exhibitor-name"]',
  '[class*="exhibitorName"]','h1','h2','h3','h4','.name','.title',
];
// =============================================================================
// EXPOCAD FX  — 3D/2D interactive floor plan platform
//
// Key findings (reverse-engineered via DevTools on Black Hat USA 2026):
//   • Platform loads several XML files:
//       config_{event}.xml  — show configuration (bUseApi, eventTitle, etc.)
//       ex_{event}.xml      — booth/exhibitor data (names XOR-encoded, contact fields empty)
//       26bhusa.xml         — floor plan geometry
//   • After XML parsing, all exhibitor data is decoded and stored in memory at:
//       window.expocadfx.fxData.exhibitors        — one entry per booth (may have dupes per company)
//       window.expocadfx.fxData.displayExhibitors — one entry per unique company (deduplicated)
//   • displayExhibitors[i].arBoothNumbers = array of ALL booth numbers for that company
//   • fxData.booths[i] has physical size: dimF ("20' x 30'"), areaF ("600 SqFt")
//     Cross-referenced via displayExhibitors[i].arBoothIndexes → boothByIdx[String(index)]
//   • Contact fields (website, city, etc.) may be empty if not populated by the show organiser
//     but names + booth numbers + sizes are always present once the XML is parsed
//   • URL pattern:  https://www.expocad.com/host/fx/{organiser}/{event}/exfx.html
// =============================================================================
async function scrapeExpoCad(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading ExpoCad FX floor plan...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // Wait for the JS to parse the exhibitor XML and populate fxData
    onProgress('Waiting for ExpoCad exhibitor data to parse...', 20);
    await page.waitForFunction(() => {
      return window.expocadfx &&
        window.expocadfx.fxData &&
        Array.isArray(window.expocadfx.fxData.displayExhibitors) &&
        window.expocadfx.fxData.displayExhibitors.length > 0;
    }, { timeout: 45_000 }).catch(() => null);

    onProgress('Extracting exhibitor records...', 55);
    const exhibitors = await page.evaluate(() => {
      const fx = window.expocadfx;
      if (!fx || !fx.fxData) return [];

      // displayExhibitors = one entry per unique company (booths already aggregated)
      const display = fx.fxData.displayExhibitors || [];

      // exhibitors = one entry per booth; used for contact fields
      const byId = {};
      for (const e of (fx.fxData.exhibitors || [])) {
        if (!byId[e.exhId]) byId[e.exhId] = e;
      }

      // booths = floor plan booths with physical size data (dimF, areaF, etc.)
      // Index by String(b.index) because arBoothIndexes stores string values like "0","1"
      const boothByIdx = {};
      for (const b of (fx.fxData.booths || [])) {
        boothByIdx[String(b.index)] = b;
      }

      const results = [];
      for (const de of display) {
        const e = byId[de.exhId] || {};

        // arBoothNumbers / arBoothIndexes are arrays when company has multiple booths
        const booths  = (de.arBoothNumbers && de.arBoothNumbers.length)
          ? de.arBoothNumbers
          : [de.boothNumber || e.boothNumber || ''];
        const indexes = (de.arBoothIndexes && de.arBoothIndexes.length)
          ? de.arBoothIndexes
          : [de.boothIndex  || e.boothIndex  || '0'];

        // Booth size: sum area across all booths this company occupies
        let totalAreaSqFt = 0;
        let primaryDim    = '';
        for (const idx of indexes) {
          const b = boothByIdx[String(idx)];
          if (!b) continue;
          // areaF is like "600 SqFt" — parse the number
          const m = (b.areaF || '').match(/[\d,]+/);
          if (m) totalAreaSqFt += parseInt(m[0].replace(',', ''), 10);
          if (!primaryDim && b.dimF) primaryDim = b.dimF;
        }
        const boothSize = totalAreaSqFt > 0
          ? (indexes.length > 1 ? `${totalAreaSqFt} SqFt (combined)` : `${primaryDim} · ${totalAreaSqFt} SqFt`)
          : primaryDim;

        results.push({
          exhibitorName: de.name  || e.name     || '',
          boothNumber:   booths[0],
          allBooths:     booths.join(', '),
          boothSize,
          website:       e.website || e.url    || '',
          email:         e.email               || '',
          phone:         e.phone               || '',
          city:          e.city                || '',
          state:         e.state               || '',
          country:       e.country             || '',
          description:   e.profile            || '',
          category:      e.category            || '',
        });
      }
      return results;
    }).catch(() => []);

    if (!exhibitors || exhibitors.length === 0) {
      // fxData may not have loaded — fall back to parsing the exhibitor XML directly
      console.log('  [ExpoCad] fxData empty — trying XML fallback');
      onProgress('Trying XML fallback...', 60);
      return await scrapeExpoCadXml(page, url, onProgress);
    }

    console.log(`  [ExpoCad] ${exhibitors.length} unique exhibitors extracted`);
    onProgress(`Extracted ${exhibitors.length} exhibitors!`, 92);
    return exhibitors;

  } finally {
    await page.close();
  }
}

// XML fallback: parse ex_{event}.xml directly and decode XOR-encoded names
// Used when the JS hasn't populated window.expocadfx in time
async function scrapeExpoCadXml(page, url, onProgress) {
  // Derive the event name from the URL path, e.g. .../26bhusa/exfx.html → "26bhusa"
  const eventMatch = url.match(/\/host\/fx\/[^/]+\/([^/]+)\/exfx\.html/i);
  if (!eventMatch) return [];
  const eventName = eventMatch[1];
  const baseUrl   = url.replace(/\/exfx\.html.*$/i, '');
  const exXmlUrl  = `${baseUrl}/ex_${eventName}.xml`;
  const fpXmlUrl  = `${baseUrl}/${eventName}.xml`;   // floor plan XML — has booth size <B> nodes

  const result = await page.evaluate(async ({ exXmlUrl, fpXmlUrl }) => {
    function fetchXml(url) {
      return new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.timeout = 20_000;
        x.ontimeout = () => resolve(null);
        x.onload  = () => resolve(x.responseXML || null);
        x.onerror = () => resolve(null);
        x.send();
      });
    }

    // Fetch both XMLs in parallel
    const [exDoc, fpDoc] = await Promise.all([fetchXml(exXmlUrl), fetchXml(fpXmlUrl)]);
    if (!exDoc) return [];

    // Build booth-size lookup from floor plan XML
    // <B bID="4735" aF="600 SqFt" dF="20' x 30'" ...> (actual attribute names may vary)
    const sizeByBooth = {};
    if (fpDoc) {
      const KEY = [2, 5, 8, 7, 2, 3, 6, 9, 10, 4];
      // Floor plan booths appear as <B> nodes or inside <BO> nodes
      for (const tag of ['B', 'BO', 'BOOTH']) {
        for (const node of fpDoc.querySelectorAll(tag)) {
          const bID = node.getAttribute('bID') || node.getAttribute('n') || '';
          const dF  = node.getAttribute('dF')  || node.getAttribute('dimF') || '';
          const aF  = node.getAttribute('aF')  || node.getAttribute('areaF') || '';
          if (bID && (dF || aF)) sizeByBooth[bID] = `${dF}${dF && aF ? ' · ' : ''}${aF}`.trim();
        }
      }
    }

    // Parse exhibitor XML
    const KEY  = [2, 5, 8, 7, 2, 3, 6, 9, 10, 4];
    const seen = new Set();
    const out  = [];
    for (const node of exDoc.querySelectorAll('E')) {
      const cID  = node.getAttribute('cID') || '';
      const bID  = node.getAttribute('bID') || '';
      const nRaw = node.getAttribute('n')   || '';
      let name = '';
      if (nRaw) {
        const codes = nRaw.split(',').map(Number);
        name = codes.map((c, i) => String.fromCharCode(c - KEY[i % KEY.length])).join('');
      }
      if (!name || seen.has(cID)) continue;
      seen.add(cID);
      out.push({
        exhibitorName: name,
        boothNumber:   bID,
        boothSize:     sizeByBooth[bID] || '',
        website:       node.getAttribute('w')  || node.getAttribute('url') || '',
        city:          node.getAttribute('c')  || '',
        state:         node.getAttribute('s')  || '',
        country:       node.getAttribute('cr') || '',
        email:         node.getAttribute('e')  || '',
        phone:         node.getAttribute('p')  || '',
        description:   node.getAttribute('pf') || '',
        category:      node.getAttribute('cg') || '',
      });
    }
    return out;
  }, { exXmlUrl, fpXmlUrl });

  console.log(`  [ExpoCad] XML fallback: ${result.length} exhibitors`);
  onProgress(`Extracted ${result.length} exhibitors!`, 92);
  return result || [];
}

const BOOTH_SELECTORS = [
  '[class*="booth-number"]','[class*="boothNumber"]','[class*="booth-num"]',
  '[class*="boothNum"]','[class*="booth"]','[class*="stand"]','[data-booth]',
];

// =============================================================================
// IDENTIVERSE  — custom WordPress sponsor directory
// Pattern: each sponsor tile is an <a class="popuptrigger" data-popup="popup-ID">
//   company name</a> whose text IS the company name (hidden via CSS).
//   The matching popup overlay (id="popup-ID") contains
//   <a class="popuplink" href="https://company.com/">Visit Website</a>.
// This popup-trigger/overlay pattern also appears on other custom event sites,
// so extractPopupTriggerData() is reused as a generic heuristic fallback in
// scrapeDirectory() as well.
// =============================================================================
async function scrapeIdentiverse(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading Identiverse sponsors page...', 10);
    await navigateSafe(page, url);
    await waitForContent(page);
    onProgress('Extracting Identiverse sponsor data...', 50);
    return await extractPopupTriggerData(page);
  } finally {
    await page.close();
  }
}

// Generic popup-trigger extractor — works for any site where:
//   a[data-popup] text = company name, document.getElementById(data-popup) = detail popup
//   popup contains a link with the company website
async function extractPopupTriggerData(page) {
  return page.evaluate(() => {
    const triggers = Array.from(document.querySelectorAll('a[data-popup]'));
    if (triggers.length === 0) return [];
    const host = location.hostname;
    return triggers
      .map(a => {
        const name = a.textContent.trim();
        if (!name || name.length < 2) return null;
        const popupId = a.getAttribute('data-popup');
        const popup = popupId ? document.getElementById(popupId) : null;
        // Prefer .popuplink; fall back to any external link inside the popup
        const websiteLink = popup
          ? (popup.querySelector('a.popuplink') ||
             popup.querySelector(`a[href^="http"]:not([href*="${host}"])`))
          : null;
        return {
          name,
          website:     websiteLink ? websiteLink.href : '',
          boothNumber: '',
          boothSize:   '',
        };
      })
      .filter(r => r && r.name.length > 0);
  });
}

// =============================================================================
// BIZZABO  — sponsors/partners page embedded as inline JSON in a <script> tag
// Data structure: an HTML-entity-encoded JSON array of page sections;
// the section with type "sponsors" has a .sponsors.entities[] array with
// { companyName, websiteUrl, partnerType, ... }
// Handles two cases:
//   1. Direct Bizzabo URL  (events.bizzabo.com or custom bizzabo-reg. subdomain)
//   2. Non-Bizzabo page that embeds a Bizzabo iframe (e.g. customercontactweek.com)
//      → the iframe page shows a preview + a "View All Sponsors" link to the full page
// =============================================================================
async function scrapeBizzabo(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading Bizzabo sponsors page...', 12);
    await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });

    // If this is a preview/embed page (has a "View All Sponsors" link), follow it
    const sponsorsLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const link = links.find(a =>
        (a.href.includes('/sponsors') || a.textContent.toLowerCase().includes('all sponsor')) &&
        (a.href.includes('bizzabo.com') || a.href.includes('bizzabo-reg.') || a.href.includes('bizzabo'))
      );
      return link ? link.href : null;
    }).catch(() => null);

    if (sponsorsLink) {
      onProgress('Following to full sponsors listing...', 25);
      await page.goto(sponsorsLink, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
    }

    onProgress('Extracting Bizzabo sponsor data...', 50);

    const results = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script:not([src])'))
        .map(s => s.textContent || '')
        .filter(t => t.length > 50000)       // only large data-bearing scripts
        .sort((a, b) => b.length - a.length); // largest first

      for (const raw of scripts) {
        try {
          const decoded = raw
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'");

          const data = JSON.parse(decoded);
          if (!Array.isArray(data)) continue;

          for (const section of data) {
            // Primary path: section.sponsors.entities (confirmed on CCW 2026)
            let entities = section.sponsors?.entities;

            // Fallback: section.elements[n].entities
            if (!entities?.length && Array.isArray(section.elements)) {
              for (const el of section.elements) {
                if (el.entities?.length > 0) { entities = el.entities; break; }
              }
            }

            if (!entities?.length) continue;

            const mapped = entities
              .filter(e => e.visible !== false && e.companyName)
              .map(e => ({
                name:        (e.companyName || '').trim(),
                website:     e.websiteUrl || '',
                boothNumber: '',
                boothSize:   '',
              }))
              .filter(e => e.name.length > 0);

            if (mapped.length > 0) return mapped;
          }
        } catch { continue; }
      }
      return [];
    });

    return results;
  } finally {
    await page.close();
  }
}

// =============================================================================
// A2ZINC  — floor plan SPA (e.g. a2zinc.net EventMap.aspx)
// Strategy waterfall:
//   1. Intercept XML/JSON responses the SPA makes on load
//   2. Try plain HTML exhibitor list page (Exhibitors.aspx)
//   3. WCF service endpoint  (a2zExpoService2.svc – server-side, no CORS)
//   4. XMLSearch.aspx with various parameter sets
//   5. BoothXMLDoc.aspx (complete floor plan XML – can be slow)
// Config globals read from the page: strRootApplicationID, intRootEventID,
//   intRootMapID, strRootExpoService2Url, strPublicSiteUrl
// =============================================================================
async function scrapeA2Z(context, url, onProgress) {
  // ─── Key discoveries (verified live against SUPERZOO 2026) ────────────────
  // 1. The EventMap SPA embeds all exhibitors in the sidebar HTML on page load:
  //      tr[data-boothid] > td.companyName > a.exhibitorName  ← company name
  //      tr[data-boothid] > td.boothLabel                     ← booth number
  //    data-boothid attribute on the TR holds the internal BoothID.
  // 2. Booth size is NOT published by this platform in list or detail views.
  // 3. Website URL lives in the eBooth detail page body text:
  //      eBooth.aspx?BoothID={id}&EventID={eventId}
  //    context.request (server-side) reuses the browser session cookies set
  //    during step 1, so the page is accessible without re-authentication.
  //    We batch-fetch 10 pages at a time to keep total time reasonable.
  // ─────────────────────────────────────────────────────────────────────────
  const page = await context.newPage();
  try {
    onProgress('Loading a2zinc event map...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    onProgress('Waiting for a2zinc exhibitor list to render...', 18);
    await page.waitForSelector('.exhibitorName', { timeout: 25_000 }).catch(() => null);
    await waitForContent(page);

    // ── Step 1: extract name + booth + boothId from sidebar table ────────────
    onProgress('Extracting exhibitors from a2zinc DOM...', 35);
    const domResults = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('tr[data-boothid]').forEach(tr => {
        const nameEl  = tr.querySelector('.exhibitorName');
        const boothEl = tr.querySelector('.boothLabel');
        if (!nameEl) return;
        const name    = nameEl.textContent.trim();
        const booth   = (boothEl?.textContent || '').trim();
        const boothId = tr.getAttribute('data-boothid') || '';
        if (name.length > 1) items.push({ name, boothNumber: booth, boothId });
      });
      return items;
    });

    if (domResults.length === 0) {
      // ── Fallback for non-EventMap a2zinc pages (service / XML endpoints) ──
      console.log('  [a2z] DOM extraction empty — trying API fallback');
      const cfg = await page.evaluate(() => ({
        appId:      (window.strRootApplicationID || '').trim(),
        eventId:    String(window.intRootEventID  || '').trim(),
        mapId:      String(window.intRootMapID    || '').trim(),
        serviceUrl: (window.strRootExpoService2Url || '').trim(),
        pubSiteUrl: (window.strPublicSiteUrl       || '').trim(),
      })).catch(() => ({}));

      const { appId, eventId, mapId, serviceUrl, pubSiteUrl } = cfg;
      const urlObj  = new URL(url);
      const pubBase = pubSiteUrl
        ? (pubSiteUrl.endsWith('/') ? pubSiteUrl : pubSiteUrl + '/')
        : `${urlObj.origin}${urlObj.pathname.replace(/\/[^/]+$/, '/')}`;

      if (serviceUrl && eventId) {
        const appEnc = encodeURIComponent(appId);
        for (const ep of [
          `${serviceUrl}/GetExhibitorsByEventID?eventId=${eventId}&applicationID=${appEnc}`,
          `${serviceUrl}/GetAllExhibitorsByEventID?eventId=${eventId}&applicationID=${appEnc}`,
        ]) {
          try {
            const resp = await context.request.get(ep, { headers: { Accept: 'application/json, text/xml, */*' }, timeout: 30_000 });
            if (resp.ok()) {
              const ct = resp.headers()['content-type'] || '';
              if (ct.includes('json')) {
                const data = await resp.json().catch(() => null);
                if (data) { const arr = findExhibitorArrayInJson(data); if (arr?.length > 0) return arr; }
              } else {
                const parsed = parseA2ZXml(await resp.text());
                if (parsed.length > 0) return parsed;
              }
            }
          } catch { /* try next */ }
        }
      }
      if (pubBase && appId && eventId) {
        const appEnc = encodeURIComponent(appId);
        for (const ep of [
          `${pubBase}XMLSearch.aspx?AppID=${appEnc}&EventID=${eventId}&SearchMode=ExhibitorList&MaxRows=9999`,
          `${pubBase}BoothXMLDoc.aspx?AppID=${appEnc}&EventID=${eventId}${mapId ? `&MapID=${mapId}` : ''}`,
        ]) {
          try {
            const resp = await context.request.get(ep, { timeout: 60_000 });
            if (resp.ok()) { const p = parseA2ZXml(await resp.text()); if (p.length > 0) return p; }
          } catch { /* try next */ }
        }
      }
      return [];
    }

    // ── Step 2: get page globals needed for both booth-size and website steps ──
    // IMPORTANT: pubBase is derived from the actual page URL, NOT strPublicSiteUrl.
    // strPublicSiteUrl omits the "Public/" subdirectory on many shows (e.g. CEDIA),
    // causing every eBooth.aspx fetch to 404.
    const cfg = await page.evaluate(() => ({
      eventId: String(window.intRootEventID  || '').trim(),
      mapId:   String(window.intRootMapID    || '').trim(),
      appId:   (window.strRootApplicationID  || '').trim(),
    })).catch(() => ({}));

    const urlObj  = new URL(url);
    const pubBase = `${urlObj.origin}${urlObj.pathname.replace(/\/[^/]+$/, '/')}`;
    const eventId = cfg.eventId;

    // ── Step 3: fetch booth sizes from img14.a2zinc.net/api/exhibitor ────────
    // The floor plan API returns every booth with "dimension" ("20 x 30") and
    // "unit" ("sq ft").  The "id" field matches the TR's data-boothid value.
    // baseUrl = '//img14.a2zinc.net' is hardcoded in tile-tile-2.js.
    const boothSizeMap = {};  // boothId → "20 x 30 sq ft"
    if (cfg.mapId && cfg.mapId !== '0' && cfg.eventId && cfg.appId) {
      try {
        const fpUrl = `https://img14.a2zinc.net/api/exhibitor?mapId=${cfg.mapId}&eventId=${cfg.eventId}&appId=${encodeURIComponent(cfg.appId)}&floorplanViewType=VIEW4&langId=1&boothId=&shMode=&minLblSize=2&maxLblSize=10&minCnSize=2&maxCnSize=11`;
        onProgress('Fetching booth sizes from floor plan API...', 42);
        console.log(`  [a2z] Floor plan API: ${fpUrl}`);
        const fpResp = await context.request.get(fpUrl, { timeout: 20_000 });
        if (fpResp.ok()) {
          const fpData = await fpResp.json().catch(() => null);
          if (Array.isArray(fpData)) {
            for (const b of fpData) {
              if (b.id && b.dimension) {
                const unit = b.unit ? ` ${b.unit}` : '';
                boothSizeMap[String(b.id)] = `${b.dimension}${unit}`;
              }
            }
            console.log(`  [a2z] Got booth sizes for ${Object.keys(boothSizeMap).length} booths`);
          }
        }
      } catch (e) {
        console.log('  [a2z] Booth size fetch failed (non-fatal):', e.message);
      }
    }

    // ── Step 4: batch-fetch eBooth pages for website URLs ────────────────────
    if (pubBase && eventId) {
      const BATCH = 10;
      const total = domResults.length;
      onProgress(`Fetching website URLs for ${total} exhibitors...`, 50);

      for (let i = 0; i < total; i += BATCH) {
        if (i > 0 && i % 100 === 0) {
          onProgress(`Fetching websites ${i}/${total}...`, 50 + Math.round((i / total) * 35));
        }
        const batch = domResults.slice(i, i + BATCH);
        const fetches = await Promise.allSettled(
          batch.map(exh =>
            exh.boothId
              ? context.request.get(
                  `${pubBase}eBooth.aspx?BoothID=${exh.boothId}&EventID=${eventId}`,
                  { timeout: 15_000 }
                )
                  .then(r => (r.ok() ? r.text() : ''))
                  .then(html => extractA2ZWebsite(html))
                  .catch(() => '')
              : Promise.resolve('')
          )
        );
        fetches.forEach((r, idx) => {
          if (r.status === 'fulfilled' && r.value) {
            domResults[i + idx].website = r.value;
          }
        });
        if (i + BATCH < total) await sleep(200);
      }
    }

    onProgress(`Extracted ${domResults.length} a2zinc exhibitors`, 90);
    // Strip internal boothId and attach boothSize + website
    return domResults.map(({ boothId, ...rest }) => ({
      ...rest,
      boothSize: boothSizeMap[String(boothId)] || '',
      website: rest.website || '',
    }));
  } finally {
    await page.close();
  }
}

// Extract exhibitor website URL from eBooth.aspx HTML.
//
// PRIMARY path (works on all known a2zinc eBooth pages):
//   <a id="BoothContactUrl" href="javascript:void(0)">https://www.example.com/</a>
//   The href is "javascript:void(0)" — the URL lives in the TEXT CONTENT.
//
// FALLBACK: scan body text (scripts/styles stripped first to avoid picking up
//   infrastructure URLs that appear in <script> tags before the exhibitor URL).
function extractA2ZWebsite(html) {
  if (!html || html.length < 200) return '';
  try {
    const $ = cheerio.load(html);

    // ── PRIMARY: a#BoothContactUrl text content ──────────────────────────────
    const contactText = $('#BoothContactUrl').text().trim();
    if (contactText && /^https?:\/\//i.test(contactText)) {
      return contactText.replace(/[.,;)>'"]+$/, '').trim();
    }

    // ── FALLBACK: body text scan (strip scripts/styles first) ────────────────
    // Without removing <script> tags, infrastructure URLs embedded in JS
    // (e.g. emeraldx.com, mya2zevents.com) appear before the exhibitor URL
    // and get returned incorrectly.
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ');

    // Exclude platform/show-infrastructure domains (never an exhibitor site)
    const EXCLUDE = /a2zinc\.net|a2z\.com|a2zevents|mya2zevents|emeraldx\.com|facebook\.com|twitter\.com|youtube\.com|instagram\.com|linkedin\.com\/company|libs\.|analytics\.|ssl\.google|fonts\.google|windows\.microsoft|smallworldlabs/i;
    const match = text.match(
      /https?:\/\/[a-zA-Z0-9][a-zA-Z0-9\-\.]{1,60}\.[a-zA-Z]{2,}[^\s,;)>'"<]*/
    );
    if (match && !EXCLUDE.test(match[0])) {
      return match[0].replace(/[.,;)>'"]+$/, '').trim();
    }
  } catch { /* ignore */ }
  return '';
}

// Parse a2zinc XML responses (NewDataSet/Table pattern or Exhibitor/Company elements)
function parseA2ZXml(xmlText) {
  if (!xmlText || !xmlText.trim().startsWith('<')) return [];
  try {
    const $ = cheerio.load(xmlText, { xmlMode: true });
    const results = [];

    // Try common a2zinc element names — tag matching is case-sensitive in xmlMode
    const tagCandidates = [
      'Table', 'table', 'Exhibitor', 'exhibitor',
      'Company', 'company', 'Row', 'row', 'Item', 'item',
    ];
    for (const tag of tagCandidates) {
      const els = $(tag);
      if (els.length === 0) continue;
      els.each((_, el) => {
        const $el = $(el);
        // Company name — try several child element names
        const name = (
          $el.find('CompanyName').text() ||
          $el.find('companyName').text() ||
          $el.find('company_name').text() ||
          $el.find('ExhibitorName').text() ||
          $el.find('exhibitorName').text() ||
          $el.find('Name').text() ||
          $el.find('name').text() ||
          $el.attr('companyName') || $el.attr('name') || ''
        ).trim();
        if (!name || name.length < 2 || name.length > 300) return;

        const booth = (
          $el.find('BoothNumber').text() ||
          $el.find('boothNumber').text() ||
          $el.find('BoothNum').text() ||
          $el.find('Booth').text() ||
          $el.find('booth').text() ||
          $el.find('StandNumber').text() ||
          $el.attr('boothNumber') || $el.attr('booth') || ''
        ).trim();

        const boothSize = (
          $el.find('BoothSize').text() ||
          $el.find('boothSize').text() ||
          $el.find('Boothsize').text() ||
          $el.find('Size').text() ||
          ''
        ).trim();

        const website = (
          $el.find('URL').text() ||
          $el.find('url').text() ||
          $el.find('Website').text() ||
          $el.find('website').text() ||
          $el.find('WebsiteURL').text() ||
          $el.attr('url') || $el.attr('website') || ''
        ).trim();

        results.push({ name, boothNumber: booth, boothSize, website });
      });
      if (results.length > 2) return results;
      results.length = 0; // reset if we found no usable elements
    }
    return results;
  } catch {
    return [];
  }
}

// =============================================================================
// ELECTRONICA  — ColdFusion-based exhibitor portal (exhibitors.electronica.de)
// List page: GET initial page, then POST to ?neuesuche for pagination
// Cards: div.ct_le > h2 = company name; link href contains nc2= for detail page
// sb_rpp controls records per page; seite = page number
// Website URLs are only on detail pages (page.cfm?nc2=XXXXXX) — we paginate
// the list only and fetch websites for a sample to avoid timeouts.
// =============================================================================
async function scrapeElectronica(context, url, onProgress) {
  const page = await context.newPage();
  try {
    onProgress('Loading Electronica exhibitor directory...', 8);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await sleep(2000);

    // Extract total count and all form fields for POST pagination
    const pageState = await page.evaluate(() => {
      // German: "1606 Aussteller" or "1606 Ergebnisse"
      const bodyText = document.body.innerText || '';
      const totalMatch = bodyText.match(/(\d[\d.,]+)\s*(?:Aussteller|exhibitor|Ergebnis(?:se)?|result)/i);
      const total = totalMatch ? parseInt(totalMatch[1].replace(/[.,]/g, '')) : 0;

      const form = document.querySelector('form');
      const fields = {};
      if (form) {
        Array.from(form.querySelectorAll('input[name], select[name]')).forEach(el => {
          if (el.type !== 'submit' && el.type !== 'image' && el.type !== 'button') {
            fields[el.name] = el.value || '';
          }
        });
      }
      // Also harvest any standalone hidden inputs outside the form
      Array.from(document.querySelectorAll('input[type="hidden"][name]')).forEach(el => {
        if (!fields[el.name]) fields[el.name] = el.value || '';
      });

      return { total, fields };
    }).catch(() => ({ total: 0, fields: {} }));

    console.log(`  [Electronica] total=${pageState.total} fields=${Object.keys(pageState.fields).join(',')}`);

    const allExhibitors = [];

    // Extract exhibitors from the already-loaded first page HTML
    const firstHtml = await page.content();
    allExhibitors.push(...parseElectronicaHtml(firstHtml));

    const total = pageState.total || 1700; // fallback estimate
    const rpp   = 60; // records per page (large values timeout on the server)
    const totalPages = Math.min(Math.ceil(total / rpp), 50);

    const urlObj  = new URL(url);
    const postUrl = `${urlObj.origin}${urlObj.pathname}?neuesuche`;

    // Base fields — add/override pagination params
    const baseFields = {
      ...pageState.fields,
      sb_rpp:     String(rpp),
      neuesuche:  '1',
      sb_sortorder: pageState.fields.sb_sortorder || 'A-Z',
    };

    onProgress(`Paginating ${totalPages} pages (${total} exhibitors)...`, 20);

    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
      if (pageNum % 5 === 0) {
        onProgress(`Fetching Electronica page ${pageNum}/${totalPages}...`,
          20 + Math.round((pageNum / totalPages) * 60));
      }
      const formData = new URLSearchParams({ ...baseFields, seite: String(pageNum) });

      try {
        const resp = await context.request.post(postUrl, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': url,
          },
          data: formData.toString(),
          timeout: 35_000,
        });
        if (!resp.ok()) { console.log(`  [Electronica] page ${pageNum} status ${resp.status()}`); break; }
        const html = await resp.text();
        const batch = parseElectronicaHtml(html);
        if (batch.length === 0) break; // no more data
        allExhibitors.push(...batch);
      } catch (e) {
        console.log(`  [Electronica] page ${pageNum} error: ${e.message}`);
        await sleep(2000);
      }
      await sleep(400); // be polite to the server
    }

    onProgress(`Extracted ${allExhibitors.length} Electronica exhibitors`, 85);
    return allExhibitors;
  } finally {
    await page.close();
  }
}

// Parse a single page of Electronica HTML — extracts div.ct_le cards
function parseElectronicaHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  $('div.ct_le').each((_, el) => {
    const $el = $(el);
    const name = $el.find('h2').first().text().trim();
    if (!name || name.length < 2) return;

    // Hall/booth info sometimes appears in a .ct_le sub-element
    const subText = $el.find('.ct_le_details, .ct_le_info, .hall, [class*="booth"], [class*="stand"]')
      .first().text().trim();
    const allText  = $el.text();
    const boothMatch = (subText || allText).match(
      /(?:hall|halle|stand|booth)\s*[:\.]?\s*([A-Z]?\d[\d.]*(?:\s*[/\\]\s*[A-Z]?\d+)?)/i
    );
    const booth = boothMatch ? boothMatch[1].trim() : '';

    // nc2 ID for detail page — preserved as a note but we don't follow by default
    results.push({ name, boothNumber: booth, boothSize: '', website: '' });
  });
  return results;
}

async function scrapeDirectory(context, url, onProgress) {
  const allRaw = [];
  const page   = await context.newPage();
  try {
    await setupInterception(page, allRaw);
    onProgress('Loading page...', 10);
    await navigateSafe(page, url);
    await waitForContent(page);

    // Check if page embeds a Bizzabo widget (sponsors in an iframe)
    const bizzaboIframeSrc = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[id*="Bizzabo"], iframe[src*="bizzabo"]');
      return iframe ? iframe.src : null;
    }).catch(() => null);
    if (bizzaboIframeSrc) {
      onProgress('Detected Bizzabo embed — extracting sponsors...', 20);
      return await scrapeBizzabo(context, bizzaboIframeSrc, onProgress);
    }

    // Check for popup-trigger sponsor tiles (e.g. Identiverse-style custom sites)
    const popupData = await extractPopupTriggerData(page);
    if (popupData.length > 2) {
      onProgress(`Found ${popupData.length} sponsors via popup-trigger pattern`, 60);
      return popupData;
    }

    if (allRaw.length > 0) return allRaw;
    const jsonData = await extractEmbeddedJson(page);
    if (jsonData.length > 0) return jsonData;
    let pageNum = 1, hasMore = true, currentUrl = url;
    while (hasMore && pageNum <= MAX_PAGES) {
      onProgress(`Parsing page ${pageNum}...`, 30 + (pageNum / MAX_PAGES) * 40);
      const pageRaw    = await extractFromHtml(page);
      const sizeBefore = allRaw.length;
      allRaw.push(...pageRaw);
      if (allRaw.length === sizeBefore) break;
      const nextUrl = await findNextPage(page, currentUrl, pageNum);
      if (!nextUrl) { hasMore = false; }
      else { await sleep(DELAY_MS); currentUrl = nextUrl; try { await navigateSafe(page, nextUrl); await waitForContent(page); pageNum++; } catch { hasMore = false; } }
    }
    if (allRaw.length === 0) allRaw.push(...await extractFromTable(page));
    if (allRaw.length === 0) allRaw.push(...await heuristicExtraction(page));
    return allRaw;
  } finally { await page.close(); }
}

async function scrapeFloorPlan(context, url, onProgress) {
  const page = await context.newPage();
  const intercepted = [];
  try {
    await setupInterception(page, intercepted);
    onProgress('Loading floor plan...', 10);
    await navigateSafe(page, url);
    await waitForContent(page);
    await sleep(2000);
    if (intercepted.length > 0) return intercepted;
    const jsonData = await extractEmbeddedJson(page);
    if (jsonData.length > 0) return jsonData;
    const svgData = await extractFromSvg(page);
    if (svgData.length > 0) return svgData;
    return await extractFromHtml(page);
  } finally { await page.close(); }
}

async function setupInterception(page, bucket) {
  page.on('response', async (response) => {
    try {
      if (response.status() !== 200) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (/analytics|tracking|gtm|segment|mixpanel|hotjar/i.test(response.url())) return;
      const json = await response.json().catch(() => null);
      if (!json) return;
      const arr = findExhibitorArrayInJson(json);
      if (arr?.length > 0) { console.log(`  API: ${response.url()} -> ${arr.length}`); bucket.push(...arr); }
    } catch { /* ignore */ }
  });
}

async function extractMYSDom(page) {
  return page.evaluate(() => {
    const items = [];
    const TILES = [
      '.exh-tile','.exhibitor-tile','.gallery-tile','[class*="exh-tile"]',
      '[class*="exhibitor-tile"]','[ng-repeat*="exhibitor"]','[data-exhibitor-id]',
      '.exh-card','[class*="exh-card"]','[class*="exhibitor-list"] li',
      '[class*="exhibitor-list"] > div',
    ];
    const NAMES  = ['.exh-name','.exh-name-txt','[class*="exh-name"]','.company-name','.exhibitor-name','h2','h3','h4','.name'];
    const BOOTHS = ['.booth-num','.exh-booth','.booth-number','[class*="booth"]','[class*="stand"]'];

    for (const sel of TILES) {
      const tiles = document.querySelectorAll(sel);
      if (tiles.length < 3) continue;
      tiles.forEach(tile => {
        let name = '';
        for (const ns of NAMES) { const el = tile.querySelector(ns); if (el?.textContent?.trim()) { name = el.textContent.trim(); break; } }
        name = name || tile.getAttribute('data-name') || '';
        if (!name || name.length < 2) return;
        let booth = '';
        for (const bs of BOOTHS) { const el = tile.querySelector(bs); if (el?.textContent?.trim()) { booth = el.textContent.trim(); break; } }
        booth = booth || tile.getAttribute('data-booth') || tile.getAttribute('data-booth-id') || '';
        items.push({ name, boothNumber: booth, boothSize: '', website: tile.querySelector('a[href^="http"]')?.href || '' });
      });
      if (items.length > 2) return items;
      items.length = 0;
    }
    return items;
  });
}

async function extractEmbeddedJson(page) {
  const KEYS = ['__NEXT_DATA__','__NUXT__','__INITIAL_STATE__','window.exhibitors','window.boothData','window.exhList','appData','exhibitorData'];
  for (const key of KEYS) {
    try {
      const data = await page.evaluate((k) => { try { return eval(k); } catch { return null; } }, key); // eslint-disable-line
      if (data) { const f = findExhibitorArrayInJson(data); if (f?.length > 0) return f; }
    } catch { /* continue */ }
  }
  try {
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent || '').filter(t => t.length > 100)
    );
    for (const script of scripts) {
      for (const match of (script.match(/\[\s*\{[^]*?\}\s*\]/g) || [])) {
        try {
          if (match.length > 50_000) continue;
          const parsed = JSON.parse(match);
          if (Array.isArray(parsed) && parsed.length > 2) { const f = findExhibitorArrayInJson(parsed); if (f?.length > 0) return f; }
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  return [];
}

async function extractFromHtml(page) {
  const $ = cheerio.load(await page.content());
  const results = [];
  for (const selector of CARD_SELECTORS) {
    const cards = $(selector);
    if (cards.length < 2) continue;
    cards.each((_, el) => { const item = extractCardData($, $(el)); if (item?.name) results.push(item); });
    if (results.length > 2) return results;
    results.length = 0;
  }
  return results;
}

function extractCardData($, card) {
  let name = '';
  for (const sel of NAME_SELECTORS) { const el = card.find(sel).first(); if (el.length && el.text().trim().length > 1) { name = el.text().trim(); break; } }
  if (!name) name = card.attr('data-name') || card.attr('aria-label') || '';
  let boothNumber = '';
  for (const sel of BOOTH_SELECTORS) { const el = card.find(sel).first(); if (el.length && el.text().trim()) { boothNumber = el.text().trim(); break; } }
  if (!boothNumber) { const m = card.text().match(/(?:booth|stand|#)\s*([A-Z]{0,3}-?\d{1,5}[A-Z]?)/i); if (m) boothNumber = m[1]; }
  const sizeMatch = card.text().match(/(\d+)\s*[x*]\s*(\d+)/i);
  return { name, boothNumber, boothSize: sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}` : '', website: card.find('a[href*="http"]').first().attr('href') || '' };
}

async function extractFromTable(page) {
  const $ = cheerio.load(await page.content());
  const results = [];
  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    if (rows.length < 2) return;
    const headers = [];
    $(rows[0]).find('th,td').each((_, th) => headers.push($(th).text().toLowerCase().trim()));
    const nameIdx  = headers.findIndex(h => /name|company|exhibitor|vendor/.test(h));
    const boothIdx = headers.findIndex(h => /booth|stand|number/.test(h));
    if (nameIdx === -1) return;
    rows.slice(1).each((_, row) => {
      const cells = $(row).find('td');
      const name  = cells.eq(nameIdx).text().trim();
      if (name) results.push({ name, boothNumber: boothIdx >= 0 ? cells.eq(boothIdx).text().trim() : '', boothSize: '', website: '' });
    });
  });
  return results;
}

async function extractFromSvg(page) {
  return page.evaluate(() => {
    const results = [], bp = /^([A-Z]{0,3}-?\d{1,5}[A-Z]?)$/i;
    document.querySelectorAll('[data-booth],[data-boothid],[data-company],[id^="booth"]').forEach(el => {
      const name  = el.getAttribute('data-company') || el.getAttribute('data-name') || el.querySelector('text,title')?.textContent?.trim() || '';
      const booth = el.getAttribute('data-booth') || el.getAttribute('data-boothid') || '';
      if (name?.length > 1) results.push({ name, boothNumber: booth, boothSize: '', website: '' });
    });
    if (results.length > 0) return results;
    const bMap = new Map();
    document.querySelectorAll('svg text, svg tspan').forEach(el => {
      const c = el.textContent?.trim() || '';
      if (bp.test(c)) {
        const siblings = Array.from(el.parentElement?.querySelectorAll('text,tspan') || []);
        const nm = siblings.find(s => s !== el && s.textContent?.trim().length > 2 && !bp.test(s.textContent.trim()))?.textContent?.trim() || '';
        bMap.set(c, nm);
      }
    });
    bMap.forEach((name, booth) => results.push({ name: name || `Booth ${booth}`, boothNumber: booth, boothSize: '', website: '' }));
    return results;
  });
}

async function heuristicExtraction(page) {
  const $ = cheerio.load(await page.content());
  const results = [];
  const re = /(?:booth|stand|#)\s*([A-Z]{0,3}\d{1,5}[A-Z]?)/gi;
  $('li,div,p,td,span').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 200 || text.length < 3) return;
    const m = re.exec(text);
    if (m) { const name = text.replace(m[0], '').trim(); if (name.length > 1) results.push({ name, boothNumber: m[1], boothSize: '', website: '' }); }
    re.lastIndex = 0;
  });
  return results;
}

async function findNextPage(page, currentUrl, num) {
  const btn = await page.$('a[aria-label*="next" i],a[rel="next"],[class*="next-page"] a,.pagination-next a');
  if (btn) {
    const href = await btn.getAttribute('href');
    if (href && href !== '#') { try { return new URL(href, currentUrl).href; } catch { return null; } }
    try { await btn.click(); await page.waitForLoadState('networkidle', { timeout: 10_000 }); return page.url() !== currentUrl ? page.url() : null; } catch { return null; }
  }
  const u = new URL(currentUrl);
  if (u.searchParams.has('page')) { u.searchParams.set('page', num + 1); return u.href; }
  if (u.searchParams.has('p'))    { u.searchParams.set('p',    num + 1); return u.href; }
  if (/\/page\/\d+/i.test(currentUrl)) return currentUrl.replace(/\/page\/\d+/i, `/page/${num + 1}`);
  return null;
}

async function navigateSafe(page, url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }); }
async function waitForContent(page) { try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); } catch { /* ok */ } await sleep(1500); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
