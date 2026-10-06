const mongoose = require('mongoose');
const { config } = require('../config/env');
const redisClient = require('../config/redis');
const cache = require('../utils/sharedCache');

/**
 * Liveness and readiness endpoints.
 *
 * These exist for PM2 and Nginx to poll, so the distinction between them matters:
 *
 *   /health  (liveness)   "is this process running?" It answers the moment the
 *                         event loop can respond. It must NOT touch MongoDB or
 *                         Redis, because a liveness probe that fails on a
 *                         dependency outage tells the supervisor to restart a
 *                         perfectly healthy process - which does nothing to fix
 *                         the outage and drops in-flight requests on the floor.
 *
 *   /ready   (readiness)  "should this process receive traffic?" It verifies the
 *                         process can actually serve, including that MongoDB is
 *                         connected. It is deliberately cheap: `mongoose`'s
 *                         connection readyState is an in-memory integer, so this
 *                         is not a database round trip and cannot itself become a
 *                         source of load. Redis is reported but never required,
 *                         because the app degrades safely without it.
 *
 * Both are registered on the app, not behind the API rate limiter, so a monitoring
 * probe can never be rejected with a 429 while the API is throttling real users.
 */

/** Maps mongoose readyState to something an operator can read. */
const mongoState = () => {
  switch (mongoose.connection.readyState) {
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnected';
    case 0:
      return 'disconnected';
    default:
      return 'unknown';
  }
};

/**
 * Liveness. 200 as long as the process can serve a request at all.
 *
 * Deliberately reports `process.pid` and the PM2 worker id: with N workers behind
 * one Nginx upstream, "is worker 2 alive" is the question an operator actually
 * has, and the PID is what they need to find it.
 */
const health = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AnilKabadi API is running',
    // Existing `message` is preserved byte-for-byte so any existing monitor or
    // health check asserting on it keeps working.
    worker: config.workerId,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    instances: config.instances,
  });
};

/**
 * Readiness. 200 when the process can serve traffic, 503 when it cannot.
 *
 * Returns 503 while MongoDB is not connected so Nginx stops sending it requests.
 * The body reports Redis state but does not gate on it: every Redis consumer in
 * this codebase degrades safely, so failing readiness on a Redis outage would
 * take the whole site down for a degradation that is already handled.
 *
 * No secrets, no connection strings, no credentials - only states and counts.
 */
const ready = (req, res) => {
  const mongo = mongoState();
  const redis = redisClient.status();
  const cacheState = cache.status();

  const readyNow = mongo === 'connected';

  res.status(readyNow ? 200 : 503).json({
    success: readyNow,
    ready: readyNow,
    checks: {
      mongo: {
        // readyState only. The URI can embed a username and password, so it is
        // never included.
        state: mongo,
      },
      redis: {
        // Reported for diagnosis, never used to fail the probe.
        configured: redis.configured,
        connected: redis.connected,
      },
      cache: {
        backend: cacheState.backend,
        shared: cacheState.shared,
      },
    },
    worker: config.workerId,
    pid: process.pid,
    instances: config.instances,
  });
};

/**
 * Extended diagnostics, for humans rather than for a probe.
 *
 * The rate limiter's standard headers already expose the effective limits, so
 * this reports the resolved *configuration* rather than duplicating them. It
 * reports only booleans and counts.
 */
const diagnostics = (req, res) => {
  res.json({
    success: true,
    worker: config.workerId,
    pid: process.pid,
    instances: config.instances,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
    },
    mongo: {
      state: mongoState(),
      // From the resolved config, not from the live driver, so this is safe to
      // expose: it is the tuning an operator chose, not a credential.
      maxPoolSize: config.mongo.maxPoolSize,
      minPoolSize: config.mongo.minPoolSize,
      totalConnectionsAcrossWorkers: config.instances * config.mongo.maxPoolSize,
    },
    redis: redisClient.status(),
    cache: cache.status(),
    rateLimiting: {
      store: config.redis.configured ? 'redis' : 'memory',
      failClosed: config.redis.failClosed,
    },
  });
};

module.exports = { health, ready, diagnostics, mongoState };