/**
 * Backwards-compatible entry point for the cache.
 *
 * The implementation moved to `sharedCache.js`, which adds a Redis backend so
 * every worker in a PM2 cluster sees the same entries and the same invalidations.
 * This module is kept as the name every existing call site already imports, so
 * nothing above it had to change.
 *
 * Behaviour is deliberately unchanged:
 *   - `get` returns `undefined` for a miss or an expired key.
 *   - `set` takes a TTL in milliseconds and stores the value by reference in the
 *     memory backend (callers must not mutate a cached object afterwards).
 *   - `delByPrefix` removes every key starting with a prefix.
 *
 * One difference callers should know about: with a Redis backend these functions
 * return promises. `await` works on both, so callers that `await` unconditionally
 * are correct under either backend. The two synchronous-only call sites are
 * `categoryController.getCategories` and the catalogue total in
 * `productController.getProducts`, which were updated to `await`.
 */
const sharedCache = require('./sharedCache');

module.exports = {
  get: sharedCache.get,
  set: sharedCache.set,
  del: sharedCache.del,
  delByPrefix: sharedCache.delByPrefix,
  clear: sharedCache.clear,
  status: sharedCache.status,
};