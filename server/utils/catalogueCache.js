const cache = require('./simpleCache');

/**
 * Shared catalogue cache key map and invalidation.
 *
 * This lives apart from `productController` on purpose. Two different code paths
 * change what these endpoints return - an admin editing a product, and a customer
 * checking out and decrementing stock - and the second one is in `stockService`.
 * Keeping the key list in one module means the two cannot drift apart, which is
 * the whole failure mode: a stale key silently serves old data for the length of
 * its TTL.
 *
 * The cached responses are full product documents, which means they carry `stock`.
 * That is why `stockService` calls `invalidateCatalogueCache()` after every stock
 * movement. Caching a rail is only safe because nothing can change the data it
 * serves without dropping it.
 */

const CATEGORIES_KEY = 'categories:all';
const CATALOGUE_TOTAL_KEY = 'catalogue:total:active';

const RAIL_PREFIXES = {
  featured: 'featured:',
  bestDeals: 'bestdeals:',
  tataBs6: 'tata_bs6:',
  condition: 'condition:',
};

/** Cache key for a filtered product rail, e.g. `featured:8`. */
const railKey = (rail, suffix = '') => `${RAIL_PREFIXES[rail]}${suffix}`;

/**
 * Drops every cached whole-catalogue read.
 *
 * Safe to call often: with the memory backend it is a handful of map deletes with
 * no I/O, so calling it on every stock movement costs nothing measurable.
 *
 * Returns a promise with the Redis backend and is awaited by every caller. It is
 * deliberately *not* fire-and-forget: a fire-and-forget DEL can still be in flight
 * when the very next request reads the cache and gets the pre-edit rail back,
 * which is exactly the staleness this function exists to prevent. Callers in a
 * request path `await` it; the cost is one round trip on a mutation that already
 * wrote to MongoDB.
 */
const invalidateCatalogueCache = async () => {
  await cache.del(CATEGORIES_KEY);
  await cache.del(CATALOGUE_TOTAL_KEY);
  await Promise.all(
    Object.values(RAIL_PREFIXES).map((prefix) => cache.delByPrefix(prefix))
  );
};

module.exports = {
  CATEGORIES_KEY,
  CATALOGUE_TOTAL_KEY,
  RAIL_PREFIXES,
  railKey,
  invalidateCatalogueCache,
};