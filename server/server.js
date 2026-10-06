const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

dotenv.config();

const { config, validate, describe } = require('./config/env');
const connectDB = require('./config/db');
const { configureCloudinary } = require('./config/cloudinary');
const { configureMail } = require('./config/mail');
const { configureRazorpay } = require('./config/razorpay');
const errorHandler = require('./middleware/errorMiddleware');
const { apiLimiter } = require('./middleware/rateLimitMiddleware');
const { buildLogger, workerTag } = require('./middleware/requestLogger');
const healthController = require('./controllers/healthController');
const redisClient = require('./config/redis');

const paymentRoutes = require('./routes/paymentRoutes');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const cartRoutes = require('./routes/cartRoutes');
const wishlistRoutes = require('./routes/wishlistRoutes');
const orderRoutes = require('./routes/orderRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const emailRoutes = require('./routes/emailRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  })
);

/**
 * Request logging.
 *
 * Moved into `middleware/requestLogger.js`, which is aware of the worker id and
 * of the health endpoints, and keeps access logs off the hot path in production
 * unless LOG_REQUESTS is set. The previous behaviour - a line per request in
 * production, plus a line for every health probe - is covered by that module's
 * comments.
 */
const requestLogger = buildLogger();
if (requestLogger) app.use(requestLogger);

/**
 * Razorpay webhook - MUST be registered before express.json().
 * The signature is an HMAC of the exact request bytes, so the payload has to
 * reach the handler untouched. express.raw() on this router captures the raw
 * buffer; JSON parsing anywhere earlier would destroy it.
 *
 * This stays above the body parsers no matter how the limits below are tuned -
 * moving it would break webhook signature verification.
 */
app.use('/api/payments/razorpay', paymentRoutes.webhookRouter);

/**
 * Body size limits.
 *
 * Both parsers previously accepted 10 MB on every route, so a single request
 * could make the process buffer 10 MB of JSON before validation ever ran. The
 * largest legitimate payload is an email campaign's HTML body, which is orders of
 * magnitude smaller than this; product and category images go through `multer`
 * as multipart and are unaffected. Overridable per deployment via
 * `JSON_BODY_LIMIT` / `URLENCODED_BODY_LIMIT`.
 */
const jsonLimit = process.env.JSON_BODY_LIMIT || '1mb';
const urlencodedLimit = process.env.URLENCODED_BODY_LIMIT || '1mb';

app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: urlencodedLimit }));
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/**
 * Monitoring endpoints, registered BEFORE the rate limiter.
 *
 * A load balancer polling every few seconds must never be answered with a 429
 * because real users are being throttled, and these endpoints are how the
 * balancer decides whether to send traffic here at all. Both the `/api`-prefixed
 * and bare paths are served, so Nginx can use either.
 *
 * `/api/health` keeps its exact previous response shape plus extra fields, so any
 * existing monitor asserting on `success` or `message` is unaffected.
 */
app.get(['/api/health', '/health'], healthController.health);
app.get(['/api/ready', '/ready'], healthController.ready);
app.get(['/api/diagnostics', '/diagnostics'], healthController.diagnostics);

// Everything below this line is subject to rate limiting.
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', reviewRoutes);

app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

app.use(errorHandler);

const PORT = config.port;

/** The live HTTP server, kept so shutdown can stop accepting connections. */
let server = null;

/** True once SIGTERM/SIGINT has arrived. Health reports not-ready during drain. */
let shuttingDown = false;

const startServer = async () => {
  /**
   * Refuse to start on an unsafe configuration rather than serving traffic with
   * it. A missing JWT secret or an unreachable Redis in production is a security
   * or correctness problem that should be a loud boot failure, not a surprise
   * discovered later.
   */
  const { problems, warnings } = validate();
  if (problems.length) {
    console.error('[config] refusing to start:');
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }
  if (warnings.length) {
    console.warn('[config] warnings:');
    warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  // Log the resolved configuration (redacted) before connecting, so a boot log
  // records which worker count and pool size the process actually came up with.
  console.log(`[config] ${workerTag()} ${JSON.stringify(describe())}`);

  await connectDB();
  configureCloudinary();
  configureMail();
  configureRazorpay();

  server = app.listen(PORT, () => {
    // The load-test harness waits for this exact string.
    console.log(`AnilKabadi server running on port ${PORT}`);
    console.log(`[boot] ${workerTag()} ready (pid ${process.pid}, ${config.instances} worker(s) expected)`);
  });

  // Under PM2 cluster mode every worker shares one port and the OS load-balances
  // the connections between them. Binding explicitly to all interfaces would be
  // wrong here; `listen(port)` without a host already binds 0.0.0.0.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
};

/**
 * Graceful shutdown.
 *
 * The sequence matters and is the whole point:
 *
 *   1. `/ready` starts reporting 503, so Nginx and any load balancer stop sending
 *      new requests here. This is what makes a reload invisible rather than a
 *      burst of connection errors.
 *   2. `server.close()` stops accepting NEW connections. Existing keep-alive
 *      connections are still served.
 *   3. Keep-alive sockets are closed once idle, so a client holding a connection
 *      open does not hold shutdown open indefinitely.
 *   4. Wait for in-flight requests to finish, bounded by SHUTDOWN_TIMEOUT_MS so a
 *      stuck request cannot block a deploy forever.
 *   5. Close MongoDB and Redis so no handle keeps the process alive.
 *
 * Without step 1 a reload drops requests that Nginx was mid-way through sending.
 * Without step 4 the process can be killed mid-checkout.
 */
const SHUTDOWN_TIMEOUT_MS = config.shutdownTimeoutMs;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received by ${workerTag()} (pid ${process.pid})`);

  const forceExit = setTimeout(() => {
    console.error(
      `[shutdown] ${workerTag()} still had work after ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        // Let in-flight requests finish, but do not wait forever for idle
        // keep-alive sockets to be reaped on their own.
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
      });
    }

    const mongoose = require('mongoose');
    await mongoose.connection.close(false);
    console.log(`[shutdown] ${workerTag()} MongoDB connection closed`);

    await redisClient.quit();
    console.log(`[shutdown] ${workerTag()} Redis connection closed`);
  } catch (error) {
    console.error(`[shutdown] ${workerTag()} error during shutdown: ${error.message}`);
  } finally {
    clearTimeout(forceExit);
    console.log(`[shutdown] ${workerTag()} exiting`);
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash in one worker must not take the process down silently. PM2 restarts the
// process and restarts are logged with the worker id so the cause is traceable.
process.on('uncaughtException', (error) => {
  console.error(`[${workerTag()}] uncaughtException: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(
    `[${workerTag()}] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`
  );
});

startServer();

module.exports = app;
module.exports.shutdown = shutdown;
