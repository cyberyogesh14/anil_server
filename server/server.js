
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

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// CORS: return exactly one matching origin per request.
const allowedOrigins = (
  process.env.CLIENT_URL ||
  'http://localhost:5173'
)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests without an Origin header (e.g. server-to-server).
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.trim().replace(/\/+$/, '');

      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204,
  })
);

// Request logging
const requestLogger = buildLogger();
if (requestLogger) app.use(requestLogger);

// Razorpay webhook must be registered before express.json()
app.use('/api/payments/razorpay', paymentRoutes.webhookRouter);

// Body size limits
const jsonLimit = process.env.JSON_BODY_LIMIT || '1mb';
const urlencodedLimit = process.env.URLENCODED_BODY_LIMIT || '1mb';

app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: urlencodedLimit }));
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health and monitoring endpoints
app.get(['/api/health', '/health'], healthController.health);
app.get(['/api/ready', '/ready'], healthController.ready);
app.get(['/api/diagnostics', '/diagnostics'], healthController.diagnostics);

// Rate limiting
app.use('/api', apiLimiter);

// API routes
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

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Error handler
app.use(errorHandler);

const PORT = config.port;
let server = null;
let shuttingDown = false;

const startServer = async () => {
  const { problems, warnings } = validate();

  if (problems.length) {
    console.error('[config] refusing to start:');
    problems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }

  if (warnings.length) {
    console.warn('[config] warnings:');
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
  }

  console.log(`[config] ${workerTag()} ${JSON.stringify(describe())}`);

  await connectDB();
  configureCloudinary();
  configureMail();
  configureRazorpay();

  server = app.listen(PORT, () => {
    console.log(`AnilKabadi server running on port ${PORT}`);
    console.log(
      `[boot] ${workerTag()} ready (pid ${process.pid}, ${config.instances} worker(s) expected)`
    );
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
};

const SHUTDOWN_TIMEOUT_MS = config.shutdownTimeoutMs;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    `[shutdown] ${signal} received by ${workerTag()} (pid ${process.pid})`
  );

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
    console.error(
      `[shutdown] ${workerTag()} error during shutdown: ${error.message}`
    );
  } finally {
    clearTimeout(forceExit);
    console.log(`[shutdown] ${workerTag()} exiting`);
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error(
    `[${workerTag()}] uncaughtException: ${
      error && error.stack ? error.stack : error
    }`
  );
});

process.on('unhandledRejection', (reason) => {
  console.error(
    `[${workerTag()}] unhandledRejection: ${
      reason && reason.stack ? reason.stack : reason
    }`
  );
});

startServer();

module.exports = app;
module.exports.shutdown = shutdown;
