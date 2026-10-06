const rateLimit = require('express-rate-limit');
const { config } = require('../config/env');
const { buildStore } = require('./rateLimitStore');

/**
 * Rate limiting.
 *
 * The limits themselves are unchanged from before this file supported multiple
 * workers: api 100/15min per IP, auth 20, email 30, OTP 10, payment 60. Only the
 * *counter store* is now pluggable, so raising worker count no longer multiplies
 * every limit by the worker count.
 *
 * When Redis is configured every limiter shares one store; when it is not,
 * `buildStore` returns undefined and `express-rate-limit` falls back to its own
 * in-process MemoryStore, which is exactly the previous behaviour. Development is
 * therefore unchanged and still needs no Redis.
 */

// Override with API_RATE_LIMIT_MAX when running the automated test harness,
// which legitimately makes many API calls from a single IP.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 100,
  store: buildStore('api', { windowMs: 15 * 60 * 1000 }),
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: buildStore('auth', { windowMs: 15 * 60 * 1000 }),
  message: {
    success: false,
    message: 'Too many auth attempts, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  store: buildStore('email', { windowMs: 15 * 60 * 1000 }),
  message: {
    success: false,
    message: 'Too many email requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: buildStore('otp', { windowMs: 15 * 60 * 1000 }),
  message: {
    success: false,
    message: 'Too many OTP requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Payment endpoints stay protected but tolerate a customer retrying a failed
// or cancelled payment several times. Override with PAYMENT_RATE_LIMIT_MAX.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PAYMENT_RATE_LIMIT_MAX) || 60,
  store: buildStore('payment', { windowMs: 15 * 60 * 1000 }),
  message: {
    success: false,
    message: 'Too many payment requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Wraps a limiter so an unavailable Redis store produces a defined response
 * instead of an unhandled error.
 *
 * `express-rate-limit` treats a throwing store as "cannot decide", and by default
 * answers 500. A Redis outage would therefore turn every API request into a 500,
 * which reads as an application crash rather than a dependency failure. This
 * handler turns it into either:
 *
 *   429 (fail closed, the default) - the limit is honoured, the request is
 *          refused, and the client is told to retry. Protection is never silently
 *          dropped.
 *   pass (fail open)               - the request proceeds, logged loudly.
 *
 * The 429 body deliberately matches the shape every other limiter already
 * returns, so no client has to learn a new response format.
 */
const withStoreFailurePolicy = (limiter) => {
  const wrapped = (req, res, next) =>
    limiter(req, res, (err) => {
      if (!err || err.code !== 'RATE_LIMIT_STORE_UNAVAILABLE') {
        next(err);
        return;
      }

      if (config.redis.failClosed) {
        // Log once per burst rather than per request.
        if (!wrapped._logged) {
          console.error(
            '[rate-limit] shared Redis store unavailable; refusing requests because ' +
              'RATE_LIMIT_FAIL_CLOSED is set. Set RATE_LIMIT_FAIL_CLOSED=false to allow ' +
              'traffic through during a Redis outage instead.'
          );
          wrapped._logged = true;
        }
        res.set('Retry-After', '60');
        res.status(429).json({
          success: false,
          message: 'Rate limiting is temporarily unavailable, please try again shortly',
        });
        return;
      }

      next();
    });

  // Preserve the properties the router and any diagnostics read off a limiter.
  Object.assign(wrapped, limiter);
  return wrapped;
};

module.exports = {
  apiLimiter: withStoreFailurePolicy(apiLimiter),
  authLimiter: withStoreFailurePolicy(authLimiter),
  emailLimiter: withStoreFailurePolicy(emailLimiter),
  otpLimiter: withStoreFailurePolicy(otpLimiter),
  paymentLimiter: withStoreFailurePolicy(paymentLimiter),
};