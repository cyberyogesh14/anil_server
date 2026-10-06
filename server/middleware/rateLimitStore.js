const { MemoryStore } = require('express-rate-limit');
const { config } = require('../config/env');
const redisClient = require('../config/redis');

/**
 * A `express-rate-limit` Store backed by Redis.
 *
 * Why this exists: `express-rate-limit`'s built-in MemoryStore keeps its counters
 * in the process that ran the middleware. Under PM2 cluster mode with N workers,
 * every worker keeps its own counter, so the *effective* limit is N x `max` - the
 * limit silently weakens in proportion to how much you scale out, which is
 * precisely the wrong direction. A shared store makes the limit global again.
 *
 * `express-rate-limit` is kept as the enforcement library. Only the counter store
 * is replaced, so the existing limits, headers, key generation and 429 response
 * bodies are all unchanged.
 *
 * The counter is a single atomic Lua script rather than a GET then a SET. A
 * read-modify-write in two round trips loses increments whenever two workers hit
 * the same key at the same moment, which is the normal case under load. The
 * script does INCR, applies the TTL on first write, and returns the count and the
 * reset time in one round trip.
 *
 * Failure policy
 * --------------
 * When Redis cannot answer, the store must not quietly start allowing traffic.
 * The two available behaviours are:
 *
 *   fail closed (default, RATE_LIMIT_FAIL_CLOSED=true)
 *       Report the store as unavailable so the limiter blocks the request. The
 *       limit is never exceeded. Availability suffers while Redis is down, but
 *       an unreachable Redis is an infrastructure incident, not a licence to
 *       remove the protection.
 *
 *   fail open (RATE_LIMIT_FAIL_CLOSED=false)
 *       Allow the request. The site stays up under a Redis outage, at the cost of
 *       not rate limiting during the outage. Opt-in, and logged loudly.
 *
 * Neither path silently substitutes a fresh in-process counter: doing so would
 * hand every worker a brand new, empty allowance of `max` requests the moment
 * Redis blipped, which is unlimited traffic in aggregate.
 */

/**
 * INCR, set the window TTL if this is the first hit, and return the new count.
 *
 * KEYS[1] = counter key
 * ARGV[1] = window length in milliseconds
 * ARGV[2] = now in milliseconds (passed in so the script is deterministic and
 *           does not depend on server clock agreement between workers)
 *
 * Returns [totalHits, resetTimeMs]
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  -- Window expired between the INCR and the PTTL (or the key had no TTL).
  -- Re-apply it so the key cannot become permanent.
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, tonumber(ARGV[2]) + ttl }
`;

/** express-rate-limit prefixes its keys, so ours only needs to be unique per limiter. */
const limiterKey = (namespace, key) => `${config.redis.keyPrefix}:rl:${namespace}:${key}`;

class RedisRateLimitStore {
  /**
   * @param {object} options
   * @param {string} options.namespace short limiter name, keeps limiters isolated
   * @param {import('express-rate-limit').Options} [options.limiterOptions]
   */
  constructor({ namespace = 'api', limiterOptions = {} } = {}) {
    this.namespace = namespace;
    this.windowMs = limiterOptions.windowMs || 15 * 60 * 1000;
    /** Set when the last Redis error happened, for /ready. */
    this.lastError = null;

    /**
     * Used only when `RATE_LIMIT_FAIL_CLOSED=false`, which in practice means
     * development.
     *
     * Development gets a working limiter even when it has been configured with a
     * Redis that is not running yet - a very easy local state to be in, and not a
     * reason to have `npm run dev` return 429-everything. Because this store is
     * per-process, limits are not shared across workers while it is in use, which
     * is exactly why production refuses to start in this configuration instead.
     */
    this.memoryFallback = new MemoryStore();
  }

  /** express-rate-limit calls this once with the fully resolved options. */
  init(options) {
    this.windowMs = options.windowMs || this.windowMs;
    // Record the prefix express-rate-limit chose so keys are consistent with the
    // library's own view of the world.
    this.prefix = options.prefix;
    this.memoryFallback.init(options);
  }

  /**
   * Routes a request to the in-process store.
   *
   * Deliberately reached only when `failClosed` is false. The production path
   * never gets here.
   *
   * The result is copied rather than returned as-is, and that is not defensive
   * padding: `MemoryStore.increment` resolves with the store's own internal client
   * record, which it then mutates on the next increment. Handing that object to a
   * caller means two callers holding "the same" result observe the *later* count,
   * so a request can be allowed using a number that belongs to a different
   * request. A plain object copy removes the aliasing.
   */
  async incrementLocally(key) {
    const result = await this.memoryFallback.increment(key);
    return { totalHits: result.totalHits, resetTime: result.resetTime };
  }

  /**
   * @param {string} key
   * @returns {Promise<{totalHits: number, resetTime: number}>}
   */
  async increment(key) {
    const fullKey = limiterKey(this.namespace, key);
    const now = Date.now();

    const result = await redisClient.run(
      async (redis) => redis.eval(INCREMENT_SCRIPT, 1, fullKey, String(this.windowMs), String(now)),
      null
    );

    if (result === null) {
      this.lastError = new Error('redis unavailable');

      // Development convenience: keep limiting, just per-process.
      if (!config.redis.failClosed) return this.incrementLocally(key);

      // Production: refuse. Never substitute a fresh counter here - every worker
      // would be handed a brand new `max` allowance, which is unlimited traffic
      // in aggregate while looking like rate limiting.
      const error = new Error('RATE_LIMIT_STORE_UNAVAILABLE');
      // Distinguishable by code as well as message, so the failure policy in
      // rateLimitMiddleware.js does not depend on string comparison.
      error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
      throw error;
    }

    this.lastError = null;
    const [totalHits, resetTime] = result;
    return { totalHits: Number(totalHits), resetTime: Number(resetTime) };
  }

  /** express-rate-limit calls this when a request is allowed after being rejected. */
  async decrement(key) {
    const result = await redisClient.run(
      async (redis) => redis.decr(limiterKey(this.namespace, key)),
      null
    );
    // `null` means Redis could not answer; mirror the decrement into the local
    // store too so a fail-open request that later succeeds does not leak a count.
    if (result === null) await this.memoryFallback.decrement(key);
  }

  async resetKey(key) {
    await redisClient.run(async (redis) => redis.del(limiterKey(this.namespace, key)), null);
    await this.memoryFallback.resetKey(key);
  }

  /** Never called in normal operation - `resetAll` needs a key scan. */
  async resetAll() {
    await redisClient.run(
      async (redis) => {
        // SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
        // keyspace, which on a shared instance is an outage.
        let cursor = '0';
        do {
          const [next, found] = await redis.scan(
            cursor,
            'MATCH',
            `${config.redis.keyPrefix}:rl:${this.namespace}:*`,
            'COUNT',
            100
          );
          cursor = next;
          if (found.length) await redis.del(...found);
        } while (cursor !== '0');
      },
      null
    );
  }
}

/**
 * Chooses the store for a limiter.
 *
 * Returns a Redis store when Redis is configured, and `undefined` otherwise so
 * express-rate-limit uses its own MemoryStore. Returning `undefined` rather than
 * constructing a MemoryStore ourselves keeps the library's default behaviour,
 * including its periodic sweep of expired keys.
 *
 * @param {string} namespace
 * @param {import('express-rate-limit').Options} options
 */
const buildStore = (namespace, options) => {
  if (!config.redis.configured) return undefined;
  return new RedisRateLimitStore({ namespace, limiterOptions: options });
};

/**
 * Diagnostics for the boot log and /diagnostics.
 *
 * Reports the store kind rather than any configuration value, so it is safe to
 * expose.
 */
const storeStatus = () => ({
  store: config.redis.configured ? 'redis' : 'memory',
  configured: config.redis.configured,
  failClosed: config.redis.failClosed,
  namespaces: ['api', 'auth', 'email', 'otp', 'payment'],
});

module.exports = {
  RedisRateLimitStore,
  buildStore,
  storeStatus,
  INCREMENT_SCRIPT,
  limiterKey,
};