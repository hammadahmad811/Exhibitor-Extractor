// Client-side URL type detection (mirrors backend logic)
const FLOOR_PLAN_SIGNALS = [
  'floor-plan', 'floorplan', 'floor_plan', 'flr-plan',
  'booth-map', 'boothmap', 'hall-map', 'hallmap',
  'interactive-map', 'exhibit-hall', 'floorplan',
];

const DIRECTORY_SIGNALS = [
  'exhibitor', 'directory', 'exhibitors', 'vendor',
  'vendors', 'sponsor', 'sponsors', 'companies',
  'participants', 'catalogue', 'catalog', 'listing',
];

export function detectUrlTypeClient(url) {
  if (!url || !url.includes('.')) return 'unknown';
  const lower = url.toLowerCase();

  let floorScore = 0;
  let dirScore = 0;

  FLOOR_PLAN_SIGNALS.forEach(s => { if (lower.includes(s)) floorScore++; });
  DIRECTORY_SIGNALS.forEach(s => { if (lower.includes(s)) dirScore++; });

  if (floorScore > dirScore) return 'floor_plan';
  if (dirScore > floorScore) return 'directory';
  return 'unknown';
}
