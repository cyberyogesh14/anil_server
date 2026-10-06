const { config } = require('../config/env');
const redisClient = require('../config/redis');

/**
 * Cache abstraction with two interchangeable backends.
 *
 * The public surface is byte-for-byte what `simpleCache.js` already exposed -
 * `set`, `get`, `del`, `delByPrefix`, `clear` with the same TTL semantics - so
 * every existing call site is unchanged. What is new is that in production with
 * Redis configured, those operations are shared across workers instead of
 * per-process.
 *
 * Why it matters under clustering
 * ------------------------------
 * With N workers, a process-local cache means:
 *   - the first request to each of the N workers misses and does the DB work, so a
 *     cold start costs N queries instead of 1;
 *   - a product edit invalidates only the worker that served it, so the other
 *     N-1 workers keep serving the pre-edit rail for the length of its TTL. With
 *     a 120s featured-products TTL that is a two-minute window of a shopper being
 *     offered a product an admin just took down.
 *
 * Both disappear when the cache is shared.
 *
 * Values are stored as JSON, which is what the controllers already produce (they
 * all `.lean()` before caching), so there is no serialisation surprise. Values are
 * treated as immutable once cached - the previous in-process implementation stored
 * by reference and documented that callers must not mutate, and that contract is
 * unchanged.
 *
 * Deliberate non-goals: no cache stampede protection, no LRU eviction, no
 * namespacing beyond a fixed prefix. There are a fixed, small number of keys, each
 * with a TTL, so Redis evicts them itself and a memory bound is automatic.
 */

/** In-process fallback. Identical behaviour and TTL handling to the old Map. */
const local = new Map();

const localBackend = {
  name: 'memory',
  shared: false,

  get(key) {
    const entry = local.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      local.delete(key);
      return undefined;
    }
    return entry.value;
  },

  set(key, value, ttlMs) {
    local.set(key, { value, expiresAt: Date.now() + ttlMs });
  },

  del(key) {
    local.delete(key);
  },

  /**
   * Removes every key beginning with `prefix`.
   *
   * For the shared backend this is done server-side with SCAN, never `KEYS`,
   * which blocks Redis for the whole keyspace.
   */
  delByPrefix(prefix) {
    let removed = 0;
    for (const key of [...local.keys()]) {
      if (key.startsWith(prefix)) {
        local.delete(key);
        removed += 1;
      }
    }
    return removed;
  },

  clear() {
    local.clear();
  },
};

const redisKey = (key) => `${config.redis.keyPrefix}:cache:${key}`;

const redisBackend = {
  name: 'redis',
  shared: true,

  /**
   * @returns the value, or `undefined` on a miss *and* on a Redis failure.
   *
   * Collapsing the two is deliberate: a cache must never be able to fail a
   * request. If Redis is unreachable the caller simply recomputes from MongoDB,
   * which is the pre-cluster behaviour and always correct.
   */
  async get(key) {
    const raw = await redisClient.run((redis) => redis.get(redisKey(key)), null);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      // A value that is not valid JSON cannot have come from `set`. Treat it as a
      // miss and let it be overwritten rather than failing the request.
      return undefined;
    }
  },

  async set(key, value, ttlMs) {
    await redisClient.run(
      (redis) => redis.set(redisKey(key), JSON.stringify(value), 'PX', ttlMs),
      null
    );
  },

  async del(key) {
    await redisClient.run((redis) => redis.del(redisKey(key)), null);
  },

  async delByPrefix(prefix) {
    return redisClient.run(
      async (redis) => {
        const pattern = `${config.redis.keyPrefix}:cache:${prefix}*`;
        let cursor = '0';
        let removed = 0;
        do {
          // SCAN, never KEYS: KEYS blocks the Redis event loop for the entire
          // keyspace, which on a shared instance is a self-inflicted outage.
          const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = next;
          if (found.length) {
            await redis.del(...found);
            removed += found.length;
          }
        } while (cursor !== '0');
        return removed;
      },
      0
    );
  },

  async clear() {
    return this.delByPrefix('');
  },
};

/**
 * The active backend, chosen once at import time.
 *
 * Selection is by configuration, not by probing, so the choice is predictable and
 * can be asserted in a test:
 *   - `CACHE_FORCE_LOCAL=true`          -> memory, always
 *   - Redis configured                  -> shared
 *   - nothing configured                -> memory
 */
const backend = (() => {
  if (config.cache.forceLocal) return localBackend;
  if (config.redis.configured) return redisBackend;
  return localBackend;
})();

/**
 * Reads a key.
 *
 * Synchronous for the memory backend, a promise for Redis. Callers that must work
 * with both `await` the result unconditionally - `await` on a non-promise is
 * free, and it means a single code path serves both backends. This is what allows
 * `simpleCache`'s consumers to be swapped without touching them.
 */
const get = (key) => backend.get(key);

/** @param {*} value plain JSON-ready value; callers must not mutate it afterwards */
const set = (key, value, ttlMs) => backend.set(key, value, ttlMs);

const del = (key) => backend.del(key);

/** @returns {number} how many entries were removed */
const delByPrefix = (prefix) => backend.delByPrefix(prefix);

/** Test/diagnostic helper. Intentionally not wired to any endpoint. */
const clear = () => backend.clear();

/** Diagnostics for /ready and the boot log. */
const status = () => ({
  backend: backend.name,
  shared: backend.shared,
  forcedLocal: config.cache.forceLocal,
});

module.exports = { get, set, del, delByPrefix, clear, status, backend };