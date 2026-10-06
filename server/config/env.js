/**
 * Central, validated runtime configuration.
 *
 * Everything the process needs to know about its environment is resolved here,
 * once, at import time. Two reasons:
 *
 *   1. Validation is not scattered. `server.js`, `config/db.js`, the rate limiter
 *      and the cache all read the same resolved values, so they cannot disagree
 *      about, say, what the pool size is.
 *   2. Nothing else in the codebase reads `process.env` for these values. That
 *      keeps "is this safe in production?" answerable by reading one file.
 *
 * Nothing here ever returns a secret value through an endpoint, and no function
 * in this module logs. `describe()` returns a redacted summary that is safe to
 * print at boot; that is the only function intended to be called from a logger.
 */

/** Reads an integer, falling back when unset, unparseable or out of range. */
const int = (raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const bool = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
};

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Number of PM2 cluster workers this process expects to be running alongside it.
 *
 * Used to size MongoDB connection pools: `workers x maxPoolSize` is the number of
 * sockets MongoDB will see, and that total has to stay under the deployment's
 * connection ceiling. `PM2_INSTANCES` is what ecosystem.config.js passes to PM2,
 * so reading it here means the pool maths cannot drift from the real worker count.
 */
const instances = int(process.env.PM2_INSTANCES, 1, { min: 1, max: 64 });

const isClustered = () => instances > 1;

/**
 * Redis connection target.
 *
 * `REDIS_URL` wins when present because it is the form every managed provider
 * hands out. The discrete `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` variables
 * exist for a self-hosted Redis, and `REDIS_USER`/`REDIS_TLS` cover ACLs and TLS.
 *
 * Returns null when nothing is configured, which is the signal to use the
 * in-process fallback rather than to attempt a connection that cannot succeed.
 */
const redisTarget = () => {
  const url = (process.env.REDIS_URL || '').trim();
  if (url) return { url, source: 'REDIS_URL' };

  const host = (process.env.REDIS_HOST || '').trim();
  if (!host) return null;

  const port = int(process.env.REDIS_PORT, 6379, { min: 1, max: 65535 });
  const user = (process.env.REDIS_USER || '').trim();
  const password = process.env.REDIS_PASSWORD || '';
  const auth = user || password ? `${user ? encodeURIComponent(user) : ''}:${encodeURIComponent(password)}@` : '';
  const scheme = bool(process.env.REDIS_TLS, false) ? 'rediss' : 'redis';

  return { url: `${scheme}://${auth}${host}:${port}`, source: 'REDIS_HOST' };
};

/** Whether a shared Redis store is configured at all. */
const redisConfigured = () => redisTarget() !== null;

/**
 * Whether a shared Redis store is mandatory for this deployment.
 *
 * The rule is asymmetric on purpose:
 *
 *   - production + MULTIPLE workers -> REQUIRED. This is the case the whole change
 *     exists for. N workers without shared counters means every worker enforces
 *     its own 100/15min, so the effective limit is N x 100, and an edit
 *     invalidates the cache in only one worker. Booting in that state is a
 *     correctness bug, so it is refused rather than logged.
 *   - production + one worker        -> allowed. A single-process deployment is
 *     genuinely correct with in-process counters and cache; refusing to boot it
 *     would break a working minimal install to fix a problem it does not have.
 *     It warns instead.
 *   - development/test -> always optional, so `npm run dev` and the test suite
 *     never need Redis.
 *   - REDIS_REQUIRED=true forces it in every environment, for a deploy where a
 *     Redis outage must be fatal even on one worker.
 */
const redisRequired = () =>
  isProduction() && (isClustered() || bool(process.env.REDIS_REQUIRED, false));

/**
 * MongoDB connection budget, across all workers.
 *
 * This is the number the *provider* counts, and it is the ceiling that actually
 * matters. Atlas Free/Shared allows 100; a dedicated M10+ allows hundreds. It is a
 * separate variable from `maxPoolSize` because they answer different questions:
 * the budget is the provider's limit, `maxPoolSize` is one worker's share of it.
 */
const totalPoolBudget = int(process.env.MONGO_TOTAL_POOL_BUDGET, 100, {
  min: 10,
  max: 10000,
});

/** True when an operator set `MONGO_MAX_POOL_SIZE` by hand. */
const maxPoolSizeExplicit =
  process.env.MONGO_MAX_POOL_SIZE !== undefined &&
  process.env.MONGO_MAX_POOL_SIZE !== '';

/**
 * The per-worker pool size.
 *
 * `maxPoolSize` is PER PROCESS, so N workers open up to N x maxPoolSize sockets.
 * A single-worker deployment default of 100 is therefore wrong the moment a second
 * worker starts: 4 x 100 = 400, and the provider refuses the surplus connections
 * rather than queueing them.
 *
 * So when `MONGO_MAX_POOL_SIZE` is NOT set, the pool divides the budget by the
 * worker count:
 *
 *   1 worker  -> 100   (identical to the previous default)
 *   2 workers ->  50
 *   3 workers ->  33
 *   4 workers ->  25
 *
 * Safe by construction, and nobody has to remember to divide by hand. An explicit
 * `MONGO_MAX_POOL_SIZE` always wins, because whoever sets it knows their
 * provider's real ceiling - which may be far higher than this budget.
 */
const resolvedMaxPoolSize = maxPoolSizeExplicit
  ? int(process.env.MONGO_MAX_POOL_SIZE, 100, { min: 1, max: 1000 })
  : Math.max(5, Math.min(100, Math.floor(totalPoolBudget / instances)));

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: isProduction(),
  isTest: process.env.NODE_ENV === 'test',
  port: int(process.env.PORT, 5002, { min: 1, max: 65535 }),

  instances,
  isClustered: instances > 1,
  /** The worker id PM2 assigns (0-based), or 0 when running standalone. */
  workerId: int(process.env.NODE_APP_INSTANCE, 0, { min: 0 }),

  mongo: {
    maxPoolSize: resolvedMaxPoolSize,
    /** Whether `maxPoolSize` came from an operator or from the budget split. */
    maxPoolSizeExplicit,
    /** Provider-wide connection ceiling used to derive `maxPoolSize`. */
    totalPoolBudget,
    minPoolSize: Math.min(
      int(process.env.MONGO_MIN_POOL_SIZE, 5, { min: 0, max: 1000 }),
      resolvedMaxPoolSize
    ),
    waitQueueTimeoutMS: int(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS, 10000, { min: 0 }),
    serverSelectionTimeoutMS: int(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10000, { min: 0 }),
    socketTimeoutMS: process.env.MONGO_SOCKET_TIMEOUT_MS
      ? int(process.env.MONGO_SOCKET_TIMEOUT_MS, 0, { min: 0 })
      : null,
    retryWrites: bool(process.env.MONGO_RETRY_WRITES, true),
  },

  redis: {
    target: redisTarget(),
    configured: redisConfigured(),
    required: redisRequired(),
    /** Cache TTL key prefix, so several apps can share one Redis safely. */
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'anilkabadi',
    connectTimeoutMs: int(process.env.REDIS_CONNECT_TIMEOUT_MS, 5000, { min: 100 }),
    commandTimeoutMs: int(process.env.REDIS_COMMAND_TIMEOUT_MS, 500, { min: 50 }),
    maxRetriesPerRequest: process.env.REDIS_MAX_RETRIES
      ? int(process.env.REDIS_MAX_RETRIES, 2, { min: 0, max: 10 })
      : 2,
    /**
     * When Redis is configured but errors, deny the request rather than serving
     * it unchecked. Default true; see `rateLimitStore.js` for why the opposite
     * is the dangerous default.
     */
    failClosed: bool(process.env.RATE_LIMIT_FAIL_CLOSED, true),
  },

  cache: {
    /**
     * Force the in-process cache even when Redis is configured. Escape hatch for
     * operators who want a single worker, and for load tests that must not
     * measure Redis.
     */
    forceLocal: bool(process.env.CACHE_FORCE_LOCAL, false),
  },

  /**
   * How long a worker waits for in-flight requests before exiting anyway.
   *
   * Bounded so a stuck request cannot block a deploy indefinitely. 30s is longer
   * than the slowest legitimate API call (a Razorpay verification round trip) and
   * shorter than most orchestrators' own kill timeout.
   */
  shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 30000, { min: 1000, max: 300000 }),

  logging: {
    /** Log one line per request in production. Off by default (see logging.js). */
    requests: bool(process.env.LOG_REQUESTS, false),
  },
};

/**
 * Checks the resolved configuration.
 *
 * Returns `{ problems, warnings }`, and the distinction is deliberate:
 *
 *   problems  - genuinely unsafe, the process must not serve traffic. Boot fails.
 *   warnings  - unusual but workable. Logged at boot and otherwise ignored.
 *
 * Refusing to boot over a tunable is a worse failure than booting with a warning,
 * so anything an operator might legitimately want to choose belongs in
 * `warnings`. Anything that would silently break a security or correctness
 * guarantee belongs in `problems`.
 *
 * Both come from one function on purpose: a second pass that re-derived the same
 * arithmetic would eventually disagree with the first, which is how a pool-size
 * check ends up validating a value that is no longer the one in use.
 */
const validate = () => {
  const problems = [];
  const warnings = [];

  if (config.isProduction) {
    if (!process.env.JWT_SECRET) {
      problems.push('JWT_SECRET is required in production');
    } else if (process.env.JWT_SECRET.length < 32) {
      problems.push('JWT_SECRET must be at least 32 characters in production');
    }
    if (!process.env.MONGO_URI) {
      problems.push('MONGO_URI is required in production');
    }
    if (!process.env.CLIENT_URL) {
      problems.push('CLIENT_URL is required in production');
    }
  }

  // The clustered-production case. Failing to boot is the point: the alternative
  // is silently running N independent rate limiters, which is the exact bug this
  // deployment work exists to close.
  if (config.redis.required && !config.redis.configured) {
    problems.push(
      `Redis is required because this is a clustered production deployment ` +
        `(${config.instances} workers), but neither REDIS_URL nor REDIS_HOST is set. ` +
        'Set one, or run a single worker with PM2_INSTANCES=1.'
    );
  }

  if (config.mongo.minPoolSize > config.mongo.maxPoolSize) {
    problems.push(
      `MONGO_MIN_POOL_SIZE (${config.mongo.minPoolSize}) cannot exceed MONGO_MAX_POOL_SIZE (${config.mongo.maxPoolSize})`
    );
  }

  // An explicit pool that exceeds the provider ceiling produces connection errors
  // at runtime, which are slow and confusing to diagnose. Fatal only when the
  // operator opts in, because a real ceiling may legitimately be far higher than
  // the conservative default budget.
  const totalPool = config.instances * config.mongo.maxPoolSize;
  if (totalPool > config.mongo.totalPoolBudget) {
    const message =
      `instances x maxPoolSize = ${config.instances} x ${config.mongo.maxPoolSize} = ` +
      `${totalPool} connections, above the MONGO_TOTAL_POOL_BUDGET of ` +
      `${config.mongo.totalPoolBudget}. Exceeding the provider ceiling causes ` +
      'checkout failures, not queuing.';
    if (bool(process.env.MONGO_POOL_ENFORCE, false)) {
      problems.push(message);
    } else {
      warnings.push(
        `${message} Raise MONGO_TOTAL_POOL_BUDGET if the provider really allows it, ` +
          'or lower MONGO_MAX_POOL_SIZE. Set MONGO_POOL_ENFORCE=true to make this fatal.'
      );
    }
  }

  if (config.isProduction && !config.redis.configured && config.instances === 1) {
    warnings.push(
      'Redis is not configured. With a single worker this is correct, but rate limits ' +
        'and cache are per-process and will not survive adding a second worker.'
    );
  }

  if (config.redis.configured && !config.redis.required && !isProduction()) {
    warnings.push(
      'Redis is configured outside production. If it becomes unreachable the rate ' +
        'limiter falls back to per-process counters, so limits are not shared.'
    );
  }

  if (config.redis.configured && config.redis.failClosed && config.instances > 1) {
    warnings.push(
      'RATE_LIMIT_FAIL_CLOSED is on: if Redis becomes unreachable, requests are ' +
        'refused with 429 until it recovers. This protects the limits at the cost of ' +
        'availability. Set RATE_LIMIT_FAIL_CLOSED=false to trade protection for uptime.'
    );
  }

  if (!config.mongo.maxPoolSizeExplicit) {
    warnings.push(
      `MONGO_MAX_POOL_SIZE is unset, so the pool was derived from the budget: ` +
        `${config.mongo.maxPoolSize} per worker x ${config.instances} worker(s) = ` +
        `${config.instances * config.mongo.maxPoolSize} connections.`
    );
  }

  return { problems, warnings };
};

/**
 * A redacted, log-safe summary of the resolved configuration.
 *
 * Only ever reports whether a secret is *set*, never its value. Redis URLs are
 * reduced to scheme + host, because a URL can carry a password in its userinfo
 * section.
 */
const describe = () => ({
  env: config.env,
  port: config.port,
  workers: config.instances,
  workerId: config.workerId,
  mongo: {
    maxPoolSize: config.mongo.maxPoolSize,
    minPoolSize: config.mongo.minPoolSize,
    // The number the provider counts against its ceiling.
    totalConnections: config.instances * config.mongo.maxPoolSize,
    totalPoolBudget: config.mongo.totalPoolBudget,
    maxPoolSizeExplicit: config.mongo.maxPoolSizeExplicit,
  },
  redis: {
    configured: config.redis.configured,
    required: config.redis.required,
    source: config.redis.target ? config.redis.target.source : null,
    // Host only. The URL may embed a password, which must never be logged.
    host: config.redis.target ? redactUrl(config.redis.target.url) : null,
  },
  cache: {
    shared: config.redis.configured && !config.cache.forceLocal,
  },
  logging: { requests: config.logging.requests },
});

/** Strips any userinfo from a URL so it is safe to log. */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(unparseable)';
  }
}

module.exports = { config, validate, describe, redactUrl, int, bool };