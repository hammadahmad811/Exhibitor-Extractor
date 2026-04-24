import { v4 as uuidv4 } from 'uuid';

/**
 * Normalizes raw exhibitor records into a consistent shape.
 */

// Booth number patterns (e.g. 1234, A-12, 4A, B102, SB-14)
const BOOTH_PATTERN = /\b([A-Z]{0,3}-?\d{1,5}[A-Z]?|[A-Z]\d{1,4})\b/i;

// Known noise strings to filter out
const NOISE_NAMES = new Set([
  '', 'n/a', 'na', 'tbd', 'tba', 'none', 'null', 'undefined',
  'exhibitor name', 'company name', 'name', 'booth', 'stand',
]);

export function normalizeExhibitors(rawList) {
  const seen = new Set();
  const results = [];

  for (const raw of rawList) {
    const exhibitor = normalizeOne(raw);
    if (!exhibitor) continue;

    const key = exhibitor.name.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    results.push(exhibitor);
  }

  // Sort by booth number, then by name
  return results.sort((a, b) => {
    if (a.boothNumber && b.boothNumber) {
      return a.boothNumber.localeCompare(b.boothNumber, undefined, { numeric: true });
    }
    if (a.boothNumber) return -1;
    if (b.boothNumber) return 1;
    return a.name.localeCompare(b.name);
  });
}

function normalizeOne(raw) {
  // Name
  const name = cleanText(raw.name || raw.companyName || raw.exhibitorName || raw.title || '');
  if (!name || NOISE_NAMES.has(name.toLowerCase())) return null;
  if (name.length < 2 || name.length > 200) return null;

  // Booth number
  let boothNumber = cleanText(
    raw.boothNumber || raw.booth || raw.boothNum || raw.stand ||
    raw.standNumber || raw.boothId || raw.exhibitorBooth || ''
  );
  // Try to extract from name if booth number looks like it was concatenated
  if (!boothNumber) {
    const match = name.match(BOOTH_PATTERN);
    if (match) boothNumber = match[0];
  }
  boothNumber = boothNumber.replace(/^(booth|stand|#)\s*/i, '').trim();

  // Booth size
  const boothSize = cleanText(
    raw.boothSize || raw.size || raw.boothDimensions || raw.dimensions || ''
  );

  // Website
  let website = cleanText(
    raw.website || raw.url || raw.websiteUrl || raw.companyUrl ||
    raw.siteUrl || raw.web || ''
  );
  website = normalizeUrl(website);

  // Description
  const description = cleanText(raw.description || raw.summary || raw.bio || '').substring(0, 300);

  // Category
  const category = cleanText(raw.category || raw.categories || raw.type || '');

  return {
    id: uuidv4(),
    name,
    boothNumber: boothNumber || '',
    boothSize: boothSize || '',
    website: website || '',
    description: description || '',
    category: category || '',
  };
}

function cleanText(val) {
  if (!val) return '';
  if (Array.isArray(val)) val = val.join(', ');
  return String(val)
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeUrl(url) {
  if (!url) return '';
  url = url.trim();
  if (!url) return '';
  if (url === '#' || url === '/' || url.startsWith('javascript:')) return '';
  if (!url.startsWith('http')) {
    if (url.includes('.') && !url.startsWith('/')) {
      url = 'https://' + url;
    } else {
      return '';
    }
  }
  try {
    new URL(url);
    return url;
  } catch {
    return '';
  }
}

/**
 * Try to parse JSON-like structure and find exhibitor arrays inside it.
 */
export function findExhibitorArrayInJson(json) {
  const EXHIBITOR_KEYS = ['name', 'companyName', 'exhibitorName', 'company', 'title'];
  const BOOTH_KEYS = ['boothNumber', 'booth', 'boothNum', 'stand', 'standNumber'];

  function looksLikeExhibitor(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
    const keys = Object.keys(obj).map(k => k.toLowerCase());
    const hasName = EXHIBITOR_KEYS.some(k => keys.includes(k.toLowerCase()));
    const hasBooth = BOOTH_KEYS.some(k => keys.includes(k.toLowerCase()));
    return hasName || hasBooth;
  }

  function search(node, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(node) && node.length > 0 && looksLikeExhibitor(node[0])) {
      return node;
    }
    if (typeof node === 'object' && node !== null) {
      for (const val of Object.values(node)) {
        const found = search(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return search(json);
}
