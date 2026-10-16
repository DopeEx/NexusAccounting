// Persistent memory for the attack planner. For one (bonus fingerprint, zone,
// enemy fleet, ship type) it keeps the bounds learned from simulator runs:
//   lo = largest quantity known NOT to win cleanly (0 = unknown)
//   hi = smallest quantity known to win cleanly   (NEVER = unknown)
// Clean wins are monotonic in the quantity, so the bounds answer any later
// question about the same enemy, whatever the planet's ship count is.

export const NEVER = Number.MAX_SAFE_INTEGER;
export const CACHE_KEY = 'pirate_plan_cache';
export const CACHE_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 60 * 24 * 3600 * 1000;

export function newRecord() {
  return { lo: 0, hi: NEVER, scaled: false, at: Date.now() };
}

export function recordResult(rec, quantity, clean, scaled = false) {
  return {
    lo: clean ? rec.lo : Math.max(rec.lo, quantity),
    hi: clean ? Math.min(rec.hi, quantity) : rec.hi,
    scaled: rec.scaled || scaled,
    at: Date.now(),
  };
}

export function enemySignature(fleetIntel) {
  return [...fleetIntel]
    .map(s => `${s.shipDefId}x${s.quantity}`)
    .sort()
    .join(',');
}

export function cacheKey({ fingerprint, zone, signature, shipDefId }) {
  return `${CACHE_VERSION}|${fingerprint}|${zone}|${signature}|${shipDefId}`;
}

// Stable short hash of a JSON-serialisable value.
export function fingerprintOf(value) {
  const text = JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v));
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Drops stale entries and keeps the newest MAX_ENTRIES.
export function pruneCache(entries, now = Date.now()) {
  const fresh = Object.entries(entries || {})
    .filter(([, r]) => r && now - r.at <= MAX_AGE_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(fresh);
}

export async function loadCache() {
  const stored = await browser.storage.local.get(CACHE_KEY);
  return pruneCache(stored[CACHE_KEY]);
}

export async function saveCache(entries) {
  await browser.storage.local.set({ [CACHE_KEY]: pruneCache(entries) });
}
