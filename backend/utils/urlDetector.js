/**
 * Detects whether a URL points to a floor plan or exhibitor directory.
 */

const FLOOR_PLAN_SIGNALS = [
  'floor-plan', 'floorplan', 'floor_plan', 'flr-plan',
  'booth-map', 'boothmap', 'hall-map', 'hallmap',
  'interactive-map', 'map', 'floor', 'layout',
  'exhibit-hall', 'exhibithall', 'plan-de',
];

const DIRECTORY_SIGNALS = [
  'exhibitor', 'directory', 'exhibitors', 'vendor',
  'vendors', 'sponsor', 'sponsors', 'company',
  'companies', 'participants', 'participant',
  'attendee', 'attendees', 'search', 'list',
  'catalogue', 'catalog', 'listing', 'listings',
];

export function detectUrlType(url) {
  if (!url) return 'unknown';

  const lower = url.toLowerCase();

  let floorScore = 0;
  let dirScore = 0;

  for (const signal of FLOOR_PLAN_SIGNALS) {
    if (lower.includes(signal)) floorScore++;
  }
  for (const signal of DIRECTORY_SIGNALS) {
    if (lower.includes(signal)) dirScore++;
  }

  if (floorScore > dirScore) return 'floor_plan';
  if (dirScore > floorScore) return 'directory';

  // Tie-break: if URL contains known platforms
  if (lower.includes('a2z') || lower.includes('mapyourshow') || lower.includes('floorplan')) {
    return 'floor_plan';
  }
  if (lower.includes('swapcard') || lower.includes('cvent') || lower.includes('eventbase')) {
    return 'directory';
  }

  // Default to directory (more common)
  return 'directory';
}

export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
