const { config } = require('./env');

/**
 * Optional Redis connection, shared by the rate-limit store and the cache.
 *
 * Design rules, in priority order:
 *
 *   1. Development never requires Redis. With nothing configured, `getClient()`
 *      returns null and every caller falls back to in-process behaviour, so
 *      `npm run dev` works on a laptop with no Redis installed.
 *
 *   2. A Redis failure is never allowed to become an unhandled rejection or a
 *      crash. ioredis emits `error` on every reconnect attempt; without a listener
 *      that is an unhandled 'error' event, which kills the process. That is the
 *      single most common way a Redis outage takes down an app that was working
 *      fine a second earlier.
 *
 *   3. Commands have a short timeout. A TCP socket that has silently half-opened
 *      would otherwise block a request indefinitely, which is worse than an error.
 *
 *   4. Secrets are never logged. `safeEndpoint()` reduces a connection target to
 *      scheme + host.
 *
 * The client is created lazily and memoised, so importing this module costs
 * nothing and does not open a socket.
 */

let client = null;
let clientAttempted = false;
let unavailableReason = null;

/** Listeners registered to be told when connectivity changes. */
const stateListeners = new Set();

/** Set once the client has successfully issued a command. */
let everConnected = false;
let lastErrorAt = 0;
let consecutiveFailures = 0;

/**
 * How long a single command may take before it is treated as a failure.
 *
 * Deliberately short. A rate-limit check sits in front of every request, so a
 * slow Redis is multiplied across the whole request rate; failing fast and
 * applying the configured fail-closed policy is faster than making every shopper
 * wait.
 */
const COMMAND_TIMEOUT_MS = config.redis.commandTimeoutMs || 500;

const safeEndpoint = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(unparseable redis target)';
  }
};

/**
 * Turns a driver error into something safe to write to a log file.
 *
 * NOT `error.message`. Provider errors are notoriously leaky: ioredis includes the
 * command it was running, a managed provider may echo the connection string back,
 * and AUTH failures quote the credentials it was given. A log file is exactly the
 * place a credential must never end up, because logs get shipped, indexed and
 * retained. So only the error's own name and a coarse classification are kept, and
 * the endpoint is printed separately via `safeEndpoint`.
 */
const safeError = (error) => {
  if (!error) return 'unknown error';
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const known = {
    ECONNREFUSED: 'connection refused (is Redis running on that host/port?)',
    ENOTFOUND: 'host not found (check REDIS_HOST / REDIS_URL)',
    ETIMEDOUT: 'connection timed out (firewall, or Redis is not listening)',
    ECONNRESET: 'connection reset by peer',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
    NOAUTH: 'authentication required (REDIS_PASSWORD is missing or wrong)',
    WRONGPASS: 'authentication failed (REDIS_PASSWORD is wrong)',
    WRONGPASS_INVALID_USERNAME: 'ACL username or password rejected',
    READONLY: 'Redis is in read-only mode (replica or failover in progress)',
    LOADING: 'Redis is still loading its dataset',
  };
  return known[error.code] ? `${name}(${error.code}): ${known[error.code]}` : name;
};

const notifyState = (up) => {
  for (const listener of stateListeners) {
    try {
      listener(up);
    } catch {
      // A misbehaving listener must not break the app.
    }
  }
};

/**
 * Returns the memoised client, or null when Redis is not configured or the
 * `ioredis` module is not installed.
 *
 * A missing module is treated as "Redis unavailable" rather than a crash, but it
 * is a configuration error in production and `config.validate()` reports it.
 */
const getClient = () => {
  if (clientAttempted) return client;
  clientAttempted = true;

  if (!config.redis.configured) {
    unavailableReason = 'not configured';
    return null;
  }

  let Redis;
  try {
    // eslint-disable-next-line global-require
    Redis = require('ioredis');
  } catch {
    unavailableReason = 'ioredis module is not installed';
    return null;
  }

  const { url } = config.redis.target;

  try {
    client = new Redis(url, {
      // Fail the connect attempt instead of retrying forever in the background:
      // a caller that needs Redis right now should be told now.
      connectTimeout: config.redis.connectTimeoutMs || 5000,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest ?? 2,
      // Backoff capped so a long outage does not leave the first retry minutes
      // away.
      retryStrategy: (times) => Math.min(times * 200, 5000),
      // Queue commands while reconnecting rather than rejecting them, but only
      // briefly - `maxRetriesPerRequest` above bounds how long that lasts.
      enableOfflineQueue: true,
      lazyConnect: true,
    });
  } catch (error) {
    unavailableReason = `could not create client: ${safeError(error)}`;
    client = null;
    return null;
  }

  client.on('error', (error) => {
    lastErrorAt = Date.now();
    consecutiveFailures += 1;

    // Log the endpoint, never the URL (which can embed a password) and never the
    // error verbatim if a provider echoes credentials back in it.
    if (consecutiveFailures === 1) {
      console.warn(
        `[redis] connection to ${safeEndpoint(url)} failed: ${safeError(error)}. ` +
          (config.redis.required
            ? 'Redis is required here, so requests will be refused until it recovers.'
            : 'Falling back to the configured degraded behaviour until it recovers.')
      );
    } else if (consecutiveFailures % 50 === 0) {
      // Still report ongoing outages occasionally, without a line per retry.
      console.warn(
        `[redis] ${safeEndpoint(url)} still unreachable after ${consecutiveFailures} attempts ` +
          `(${safeError(error)})`
      );
    }
    notifyState(false);
  });

  client.on('ready', () => {
    if (!everConnected) {
      everConnected = true;
      console.log(`[redis] connected to ${safeEndpoint(url)}`);
    }
    consecutiveFailures = 0;
    notifyState(true);
  });

  client.on('end', () => notifyState(false));

  return client;
};

/**
 * Runs `fn` with a hard timeout, resolving to `fallback` if Redis is slow or
 * throws. This is the only way callers should touch the client.
 *
 * @template T
 * @param {(redis: import('ioredis').Redis) => Promise<T>} fn
 * @param {T} fallback returned when Redis cannot answer
 * @returns {Promise<T>}
 */
const run = async (fn, fallback) => {
  const redis = getClient();
  if (!redis) return fallback;

  try {
    if (redis.status === 'wait') await redis.connect();

    return await Promise.race([
      fn(redis),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), COMMAND_TIMEOUT_MS);
        // Do not hold the event loop open for a pending timer.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch {
    return fallback;
  }
};

/**
 * True when Redis is configured but not currently usable.
 *
 * Distinct from `configured`: the rate-limit store needs to tell "no Redis here,
 * use the in-process store" apart from "Redis was expected and is down", because
 * the second one must fail closed.
 */
const isUnavailable = () => {
  if (!config.redis.configured) return false;
  if (!client) return true;
  return client.status !== 'ready' && client.status !== 'connecting';
};

/** Diagnostics for /ready and the boot log. Contains no secrets. */
const status = () => ({
  configured: config.redis.configured,
  connected: Boolean(client && client.status === 'ready'),
  /** Expectation, from env: false in dev, true for a clustered production boot. */
  required: config.redis.required,
  unavailable: isUnavailable(),
  // Connection state, never the target's credentials.
  status: client ? client.status : 'disabled',
  endpoint: config.redis.target ? safeEndpoint(config.redis.target.url) : null,
  everConnected,
  consecutiveFailures,
  lastErrorAt: lastErrorAt || null,
  reason: unavailableReason,
});

/** Closes the connection. Used by the graceful-shutdown path. */
const quit = async () => {
  if (!client) return;
  const redis = client;
  client = null;
  clientAttempted = false;
  try {
    await redis.quit();
  } catch {
    try {
      redis.disconnect();
    } catch {
      // already gone
    }
  }
};

/** Subscribes to connectivity transitions. Returns an unsubscribe function. */
const onStateChange = (listener) => {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
};

module.exports = {
  getClient,
  run,
  status,
  isUnavailable,
  quit,
  onStateChange,
  safeEndpoint,
  safeError,
  COMMAND_TIMEOUT_MS,
};