/**
 * In-memory TTL cache.
 *
 * Replaces the `'use cache'` + cacheLife() pair the profile queries relied on
 * under Next. Nothing about that was Next-specific except the syntax: hold the
 * value, hold the time it was written, hand it back until it is stale.
 *
 * Deliberately a Map, not Redis. One process, one hour, a handful of usernames
 * — a network hop to fetch a cached GitHub response would cost more than it
 * saved, and a second moving part is not what this needs before Saturday.
 *
 * The cache is lost on restart. That is fine: the worst case is one profile
 * refetched at its ordinary 12-request cost.
 */

export const ONE_HOUR_MS = 60 * 60 * 1000;

interface Entry {
  value: unknown;
  /** epoch ms after which this entry is dead */
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** The live value, or undefined when absent or stale. */
export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;

  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return undefined;
  }

  return entry.value as T;
}

export function setCached(
  key: string,
  value: unknown,
  ttlMs: number = ONE_HOUR_MS,
): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function dropCached(key: string): void {
  store.delete(key);
}

/** Live entries only — stale ones are dropped on the way past. */
export function cacheSize(): number {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
  return store.size;
}
