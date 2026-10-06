const mongoose = require('mongoose');
const { config, describe } = require('./env');

/**
 * Connection pool and driver tuning.
 *
 * Every value has a production-sane default and can be overridden by an
 * environment variable, so nothing here requires a `.env` change to work.
 *
 * Why these matter under load:
 *
 *   maxPoolSize        The driver's default (100) is the ceiling on *concurrent*
 *                      MongoDB operations per process. Left at the default it is
 *                      also easy to exceed, at which point requests queue in the
 *                      driver and latency climbs instead of throughput.
 *   minPoolSize        Keeps warm sockets so the first requests after an idle
 *                      period do not pay a TCP + TLS handshake each.
 *   waitQueueTimeoutMS Fails fast instead of letting requests pile up in the
 *                      queue behind a saturated pool.
 *   serverSelectionTimeoutMS
 *                      Fails fast when the primary is unreachable rather than
 *                      holding a request open for the 30s driver default.
 *
 * Deliberately NOT set: `idleTimeoutMS` and `maxIdleTimeMS`. The pinned driver
 * (mongodb 6.x, via Mongoose 8) rejects `idleTimeoutMS` outright with
 * "option idletimeoutms is not supported" and fails the whole connection, so
 * tuning those belongs with a driver upgrade rather than here.
 */
/**
 * Pool sizing under multiple workers.
 *
 * `maxPoolSize` is PER PROCESS, so N workers open up to N x maxPoolSize sockets
 * and that total - not maxPoolSize - is what the provider counts against its
 * ceiling. The size itself is resolved once in `config/env.js`, which divides
 * MONGO_TOTAL_POOL_BUDGET by the worker count when MONGO_MAX_POOL_SIZE is unset,
 * so this module only reads the answer rather than recomputing it and risking a
 * disagreement with the validation that ran at boot.
 *
 * The derivation and the reasoning behind it live in env.js. In short:
 * 1 worker -> 100, 4 workers -> 25, total always <= budget.
 */
const poolOptions = {
  maxPoolSize: config.mongo.maxPoolSize,
  minPoolSize: config.mongo.minPoolSize,
  waitQueueTimeoutMS: config.mongo.waitQueueTimeoutMS,
  serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMS,
  // The driver default. Left explicit because it is the setting that decides how
  // transparently a write survives a primary election: with it on, a single write
  // is retried once on the newly elected primary instead of surfacing as a
  // user-visible error mid-checkout.
  retryWrites: config.mongo.retryWrites,
};

const buildConnectionOptions = () => {
  const options = { ...poolOptions };

  // `MONGO_URI` already carries its own query string, so any driver option given
  // as `?key=value` in the URI wins - the same precedence the driver itself uses.
  if (config.mongo.socketTimeoutMS !== null) {
    options.socketTimeoutMS = config.mongo.socketTimeoutMS;
  }

  return options;
};

/**
 * Builds the declared indexes for every loaded model.
 *
 * `createIndexes()` only creates what the schema declares - unlike
 * `syncIndexes()` it never drops anything - so this is safe to run on every boot.
 * Doing it explicitly (instead of relying on Mongoose's implicit per-model
 * auto-build) means index construction happens once, at startup, where it is
 * visible and logged, rather than lazily racing the first requests.
 */
const ensureIndexes = async () => {
  const models = mongoose.modelNames().map((name) => mongoose.model(name));

  const results = await Promise.allSettled(models.map((model) => model.createIndexes()));

  const failures = results
    .map((result, i) => (result.status === 'rejected' ? models[i].modelName : null))
    .filter(Boolean);

  if (failures.length) {
    console.error(`Index build reported failures for: ${failures.join(', ')}`);
  }
};

const connectDB = async () => {
  const options = buildConnectionOptions();

  // Logged before connecting so the boot record shows the pool sizing decision
  // even if the connection then fails. Host only - a URI can embed a password.
  console.log(
    `[mongo] pool ${options.minPoolSize}-${options.maxPoolSize} per worker x ` +
      `${config.instances} worker(s) = up to ` +
      `${options.maxPoolSize * config.instances} connections`
  );

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, options);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    console.log('MongoDB disconnected');
  });

  mongoose.connection.on('error', (err) => {
    console.error(`MongoDB error: ${err}`);
  });

  // Never fatal: a failed index build must not stop the API from serving traffic.
  await ensureIndexes();
};

module.exports = connectDB;
module.exports.poolOptions = poolOptions;
module.exports.ensureIndexes = ensureIndexes;
module.exports.buildConnectionOptions = buildConnectionOptions;