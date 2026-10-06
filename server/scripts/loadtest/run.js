/**
 * Load-test orchestrator.
 *
 * Everything runs as children of this process: the isolated MongoDB, the real API
 * server, and autocannon. Owning the lifecycle here is deliberate - it means a
 * single command is reproducible end to end and there is no chance of a stale
 * server or a stale database carrying results from a previous run.
 *
 * NOTHING here touches production:
 *   - The database is a throwaway `MongoMemoryReplSet` on an ephemeral port in a
 *     database literally named `anilkabadi_loadtest`.
 *   - The API server is booted with an explicit test-only `MONGO_URI`, so it can
 *     never read the application's `.env` database.
 *   - Razorpay, Cloudinary and SMTP credentials are explicitly left unset, so
 *     those integrations no-op. No payment, upload or email can leave the host.
 *
 * Usage:
 *   node scripts/loadtest/run.js                 # full progressive run
 *   node scripts/loadtest/run.js --quick         # short run, fewer levels
 *   node scripts/loadtest/run.js --only=mixed-ecommerce --levels=10,25,50
 *
 * There is deliberately no --skip-seed option. The database is ephemeral and is
 * destroyed at the end of every run, so there is never a previous dataset to reuse
 * and seeding is the only way to guarantee the run starts from a known state.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
// The monitoring connections use the raw driver rather than mongoose. Mongoose
// keeps its own connection lifecycle, and closing a client obtained from
// `mongoose.createConnection()` leaves that connection object in a half-open
// state, which then throws on teardown. A raw MongoClient is opened and closed
// explicitly, so there is nothing left behind.
const { MongoClient } = require('mongodb');

// autocannon reports a fixed percentile list that stops at p90 and then jumps to
// p97.5, so it cannot answer "what is p95" - which the test plan requires. Those
// figures are all derived from a single HDR histogram via
// `hdr-histogram-percentiles-obj`, so adding 95 to that module's percentile list
// before autocannon builds its results makes it emit an exact p95 (and p99.5) from
// the same histogram. No latency data is re-estimated or interpolated.
const histogramPercentiles = require('hdr-histogram-percentiles-obj');
for (const p of [95, 99.5]) {
  if (!histogramPercentiles.percentiles.includes(p)) histogramPercentiles.percentiles.push(p);
}

const autocannon = require('autocannon');

const HERE = __dirname;
const URI_FILE = path.join(HERE, '.loadtest-db-uri');
const TOKENS_FILE = path.join(HERE, '.loadtest-tokens.json');
const DB_PATH_DIR = path.join(HERE, '.loadtest-dbpath');

const net = require('net');

// The test API listens on an OS-assigned free port rather than a hardcoded one.
// A fixed port was previously colliding with an orphaned server from a previous
// aborted run, and a collision is a confusing failure mode: the run appears to hang
// instead of reporting the real problem. Reserving the port up front also closes
// the window in which something else could take it before the API binds.
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Explicit override, used only when a caller wants a stable port; otherwise the
// kernel picks one and there is nothing to collide with.
const REQUESTED_PORT = process.env.LOADTEST_PORT ? Number(process.env.LOADTEST_PORT) : null;
let SERVER_PORT = REQUESTED_PORT;
let BASE = SERVER_PORT ? `http://127.0.0.1:${SERVER_PORT}` : '';

// One throwaway signing secret, shared by the seeder and the server so that tokens
// minted during seeding verify against the API under test. It is not a real
// credential: it is a constant in a dev-only script, never printed and never
// written to disk. Tokens it produces are worthless outside this throwaway
// database, which is why they do not need to be treated as secrets - but the
// files that hold them are still gitignored (see .gitignore).
const LOADTEST_JWT_SECRET =
  process.env.LOADTEST_JWT_SECRET || 'loadtest-only-not-a-real-secret-0000000000000000';
const LOADTEST_JWT_EXPIRES_IN = '1h';

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(`--${f}`);
const argValue = (f, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${f}=`));
  return hit ? hit.split('=')[1] : dflt;
};

// Where this run's evidence is written. `--out=` lets a second run (for example the
// production-rate-limit measurement) keep its own file instead of overwriting the
// headline results, so a report can cite both without one destroying the other.
//
// The name is reduced to a basename and then required to be dot-prefixed, so a
// results file - which is evidence - can only ever be written inside this directory
// and can never be pointed at application data.
const OUT_NAME = path.basename(argValue('out', '.loadtest-results.json'));
if (!/^\.loadtest-[A-Za-z0-9._-]*\.json$/.test(OUT_NAME)) {
  throw new Error(
    `--out must be a ".loadtest-<name>.json" file inside scripts/loadtest, got "${argValue('out', '')}"`
  );
}
const RESULTS_FILE = path.join(HERE, OUT_NAME);

const QUICK = hasFlag('quick');

// ---------------------------------------------------------------------------
// Saturation / stop conditions (from the test plan)
// ---------------------------------------------------------------------------

const LIMITS = {
  p95Ms: 1000,
  p99Ms: 2000,
  errorPct: 1,
  // Average CPU across the steady-state window, recorded for context.
  cpuPct: 90,
  // Main-thread saturation. 0.90 means the event loop was busy 90% of the window.
  eventLoopUtilization: 0.9,
  // Resident set high-water mark. A Node process that climbs past this while latency
  // is still nominally fine is one GC step away from a stall, so it counts as
  // unhealthy rather than waiting for the latency to show it. 1024MB is comfortably
  // above the ~300MB peak observed across every scenario, so this only fires on a
  // genuine leak rather than on normal heap growth.
  peakRssMb: 1024,
};

// The sweep starts low because the API saturates its event loop early: measured at
// roughly 5 concurrent connections, well below 10. Starting at 10 would have missed
// the knee of the curve entirely.
const ALL_LEVELS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
const LEVELS = argValue('levels', null)
  ? argValue('levels', '').split(',').map(Number)
  : QUICK
    ? [1, 5, 10, 25, 50]
    : ALL_LEVELS;

const MEASURE_SECONDS = Number(argValue('seconds', QUICK ? 8 : 20));
const WARMUP_SECONDS = Number(argValue('warmup', QUICK ? 3 : 5));

// ---------------------------------------------------------------------------
// Rate limiting: measured, never disabled
// ---------------------------------------------------------------------------

/**
 * How the API's `apiLimiter` behaves during a run.
 *
 * `bypass` (default) raises ONLY the existing `API_RATE_LIMIT_MAX` env hook - an
 * override that already ships in `middleware/rateLimitMiddleware.js` and whose
 * production default of 100 is untouched - so that the limiter is not the thing
 * being measured. Nothing in the application is modified to achieve this; the
 * variable is simply set in the child process's environment.
 *
 * `production` pins the limiter to exactly the production default of 100 requests
 * per 15 minutes per IP, and is used to document what that limit does to a load
 * test. It is a measurement of production behaviour, not a way around it.
 *
 * `API_RATE_LIMIT_MAX` is set to the empty string rather than deleted: the
 * middleware evaluates `Number(process.env.API_RATE_LIMIT_MAX) || 100`, and
 * `Number('') === 0` is falsy, so an explicitly empty value yields exactly 100.
 * Setting it to an empty string also stops `dotenv` from supplying a value from
 * the application's own `.env`, which would otherwise make the run
 * non-deterministic depending on local configuration.
 */
const RATE_LIMIT_MODE = argValue('ratelimit', 'bypass');
if (!['bypass', 'production'].includes(RATE_LIMIT_MODE)) {
  throw new Error(`--ratelimit must be "bypass" or "production", got "${RATE_LIMIT_MODE}"`);
}
const API_RATE_LIMIT_VALUE = RATE_LIMIT_MODE === 'production' ? '' : process.env.LOADTEST_API_RATE_LIMIT_MAX || '10000000';

// autocannon can spawn load-generating workers, but worker options are passed
// through `workerData`, which is structured-cloned - and a structured clone cannot
// carry functions. Every authenticated scenario needs a per-request `setupRequest`
// to attach a rotating Bearer token, so worker mode is incompatible with the
// scenarios and is disabled by default.
//
// That matters for validity, so the generator's own CPU is measured for every run
// (`generatorCpu`). autocannon's workers are worker_threads in this same process, so
// /proc/self/stat covers the generator and its workers. If that figure stays well
// below 100%, the generator had headroom and the reported ceiling belongs to the
// API rather than to the load generator.
const WORKERS = Number(argValue('workers', 0));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...a) => console.log('[loadtest]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { ...opts, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// /proc based resource sampling for the API process
// ---------------------------------------------------------------------------

function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field can contain spaces and parentheses, so split after it.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(after[11]); // field 14
    const stime = Number(after[12]); // field 15
    const rssPages = Number(after[21]); // field 24
    const pageSize = 4096;
    return {
      cpuSeconds: (utime + stime) / 100, // USER_HZ is 100 on Linux
      rssBytes: rssPages * pageSize,
    };
  } catch {
    return null;
  }
}

function createSampler(pid, mongoUri) {
  let lastCpuSample = 0;
  let lastAt = Date.now();
  const rssSamples = [];
  const cpuSamples = [];
  let stop = false;

  // Prime the baseline with a real reading so the first interval measures a genuine
  // delta rather than the process's entire lifetime.
  const initial = readProcStat(pid);
  if (initial) lastCpuSample = initial.cpuSeconds;

  const interval = setInterval(async () => {
    const now = Date.now();
    const s = readProcStat(pid);
    if (!s) return;
    const dt = (now - lastAt) / 1000;
    lastAt = now;
    rssSamples.push(s.rssBytes);

    // Only sample over windows long enough to be meaningful. A timer that fires
    // twice in quick succession yields a tiny dt, and dividing a small CPU delta by
    // it produced a meaningless 113,532% reading. 250ms is a long way below the
    // 500ms interval but still wide enough for the ratio to be stable.
    if (dt < 0.25) return;
    // %CPU relative to ONE core. A single-threaded request handler tops out near
    // 100%; higher values come from V8 background compilation and GC threads, which
    // is why this is reported as context and not used as a saturation signal.
    const pct = ((s.cpuSeconds - lastCpuSample) / dt) * 100;
    cpuSamples.push(pct);
    lastCpuSample = s.cpuSeconds;
  }, 500);

  return {
    async stop() {
      if (stop) return { avgCpu: null, peakCpu: null, peakRssMb: null };
      stop = true;
      clearInterval(interval);
      await sleep(100);
      return {
        avgCpu: cpuSamples.length ? Number((cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length).toFixed(1)) : null,
        peakCpu: cpuSamples.length ? Number(Math.max(...cpuSamples).toFixed(1)) : null,
        avgRssMb: rssSamples.length ? Number((rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length / 1048576).toFixed(1)) : null,
        peakRssMb: rssSamples.length ? Number((Math.max(...rssSamples) / 1048576).toFixed(1)) : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB server-side sampling (separate monitoring connection)
// ---------------------------------------------------------------------------

async function sampleMongo(uri) {
  const client = new MongoClient(uri, { maxPoolSize: 2 });
  await client.connect();
  const admin = client.db().admin();

  const read = async () => {
    try {
      const status = await admin.serverStatus();
      const cmdMetrics = status.metrics && status.metrics.commands;
      return {
        connectionsCurrent: status.connections ? status.connections.current : null,
        connectionsAvailable: status.connections ? status.connections.available : null,
        totalOpCounters: status.opcounters ? { ...status.opcounters } : null,
        cmdTotalTimeMs: cmdMetrics ? cmdMetrics.total : { totalTimeMs: 0, totalOps: 0 },
      };
    } catch (error) {
      return { error: error.message };
    }
  };

  const first = await read();
  const second = await read(); // immediately, to establish a delta baseline
  await client.close();

  return { first, second };
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

const children = [];

function startDb() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'db.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    children.push(child);

    let buf = '';
    const timer = setTimeout(() => reject(new Error('db.js did not become ready in 120s')), 120000);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/__LOADTEST_DB_READY__(mongodb:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(`[db] ${c}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!buf.includes('__LOADTEST_DB_READY__')) reject(new Error(`db.js exited early (${code}): ${buf}`));
    });
  });
}

function startServer(uri) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, '..', '..', 'server.js')], {
      cwd: path.join(HERE, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,

        // Point the API at the throwaway database. MONGO_URI is set explicitly so
        // dotenv cannot override it with a real one from server/.env... note that
        // dotenv does NOT override existing env vars by default, so this wins.
        MONGO_URI: uri,

        // Test-only rate-limit configuration.
        //
        // `API_RATE_LIMIT_MAX` is an EXISTING, already documented env hook in
        // rateLimitMiddleware.js - no production code was changed to make this
        // possible. It is raised here only so the limiter is not the thing being
        // measured; `--ratelimit=production` instead pins it to the shipped
        // default of 100 to document that limit's effect.
        //
        // The OTHER limiters (auth 20/15min, OTP 10, email 30, payment 60) are NOT
        // overridden and NOT disabled in either mode; they are simply never
        // exercised, because login/OTP/email/payment endpoints are not part of any
        // scenario.
        API_RATE_LIMIT_MAX: API_RATE_LIMIT_VALUE,

        // A throwaway JWT secret, shared with the seeder so pre-minted tokens
        // verify. See LOADTEST_JWT_SECRET above.
        JWT_SECRET: LOADTEST_JWT_SECRET,
        JWT_EXPIRES_IN: LOADTEST_JWT_EXPIRES_IN,

        // Deliberately UNSET so no external service is reachable:
        //   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
        //   CLOUDINARY_*  -> uploads and image handling no-op
        //   EMAIL_*       -> nodemailer transporter is never configured, so
        //                    sendEmail() logs and returns false
        RAZORPAY_KEY_ID: '',
        RAZORPAY_KEY_SECRET: '',
        RAZORPAY_WEBHOOK_SECRET: '',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_API_KEY: '',
        CLOUDINARY_API_SECRET: '',
        EMAIL_HOST: '',
        EMAIL_PORT: '',
        EMAIL_USER: '',
        EMAIL_PASS: '',

        NODE_ENV: 'test',
        PORT: String(SERVER_PORT),

        // Attach the test-only MongoDB instrumentation to this process
        // only. The path is quoted because the repository path contains spaces,
        // and NODE_OPTIONS is re-parsed by node using shell-like splitting.
        NODE_OPTIONS: `--require "${path.join(HERE, 'instrument.js')}"`,
      },
    });
    children.push(child);

    let metricsBuffer = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      metricsBuffer += text;
      process.stdout.write(`[api] ${text}`);
      if (text.includes('server running on port')) resolve(child);
    });
    child.stderr.on('data', (c) => process.stderr.write(`[api!] ${c}`));

    setTimeout(() => reject(new Error('server did not start in 60s')), 60000);
  });
}

function dumpServerMetrics(server) {
  return new Promise((resolve) => {
    server.stdout.once('data', (chunk) => {
      const match = chunk.toString().match(/__LOADTEST_METRICS__(.+)/);
      if (!match) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch {
        resolve(null);
      }
    });
    // Reset (and dump) instrumentation for this measurement window.
    server.kill('SIGUSR2');
    setTimeout(() => resolve(null), 5000);
  });
}

async function teardown() {
  // SIGTERM first, then SIGKILL only if the child refuses to exit. Killing with
  // SIGKILL straight away skips the child's own cleanup handlers, which is what
  // left ~200 MB orphaned MongoDB data directories behind on earlier runs until
  // they exhausted the tmpfs.
  const doomed = children.splice(0, children.length);

  await Promise.all(
    doomed.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const force = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }, 8000);
          child.once('exit', () => {
            clearTimeout(force);
            resolve();
          });
          try {
            child.kill('SIGTERM');
          } catch {
            clearTimeout(force);
            resolve();
          }
        })
    )
  );

  // Remove every artefact regardless of how the children exited.
  for (const f of [URI_FILE, TOKENS_FILE, DB_PATH_DIR]) {
    try {
      fs.rmSync(f, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// One measurement
// ---------------------------------------------------------------------------

// The load generator's own CPU cost across the measurement window, as a
// percentage of one core. autocannon runs in this process (its workers are
// worker_threads), so this is the generator's true cost. Values below ~100 mean
// the generator was not the limiting factor and the measured rps ceiling is the
// API's.
function generatorCpu() {
  const startedAt = Date.now();
  const start = readProcStat(process.pid);
  return {
    start,
    sample: () => {
      const end = readProcStat(process.pid);
      if (!start || !end) return null;
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed <= 0) return null;
      return Number((((end.cpuSeconds - start.cpuSeconds) / elapsed) * 100).toFixed(1));
    },
  };
}

async function measure(scenario, connections) {
  const scenarioDef = scenario.def;
  const maxAllowed = scenarioDef.maxConcurrency || Infinity;
  const conns = Math.min(connections, maxAllowed);

  // The warmup runs as a separate, discarded autocannon run rather than autocannon's
  // built-in `warmup` option. The built-in option hides warmup inside the same call,
  // which makes it impossible to start the CPU/RAM sampler *after* warmup - and the
  // first moments of a freshly started API are the least representative (lazy module
  // loading, V8 JIT compilation on background threads, MongoDB filling its cache).
  // Sampling across those moments produced a 268% "peak" at one connection, which is
  // not physically meaningful for a single-threaded request handler.
  const runOnce = (duration) =>
    new Promise((resolve, reject) => {
      const instance = autocannon({
        url: BASE,
        connections: conns,
        duration,
        requests: scenarioDef.requests,
        headers: { 'content-type': 'application/json' },
        timeout: 20,
        // Per-connection scratchpad for scenarios that need request-to-request state
        // (see the checkout pairing note in scenarios.js). autocannon deep-clones
        // this once per connection.
        ...(scenarioDef.initialContext ? { initialContext: scenarioDef.initialContext } : {}),
        ...(WORKERS > 0 ? { workers: WORKERS } : {}),
      });
      instance.on('done', resolve);
      instance.on('error', reject);
    });

  // Reset instrumentation and MongoDB counters, warm up, then reset again so the
  // measurement window contains steady state only.
  server.kill('SIGUSR2');
  await sleep(300);
  if (WARMUP_SECONDS > 0) {
    log(`  warming up ${scenario.key} @${conns} for ${WARMUP_SECONDS}s...`);
    await runOnce(WARMUP_SECONDS);
  }
  server.kill('SIGUSR2');
  await sleep(300);
  const mongoBefore = await sampleMongo(mongoUri);

  log(`  measuring ${scenario.key} @${conns} for ${MEASURE_SECONDS}s...`);
  const sampler = createSampler(server.pid, mongoUri);
  const gen = generatorCpu();
  const result = await runOnce(MEASURE_SECONDS);

  // Diagnostics for harness debugging. The raw result holds a live HDR histogram,
  // which does not serialise, so only the shape and the scalar fields are kept.
  if (process.env.LOADTEST_DEBUG) {
    fs.writeFileSync(
      path.join(HERE, '.loadtest-raw.json'),
      JSON.stringify(
        {
          topLevelKeys: Object.keys(result),
          latencyKeys: result.latency ? Object.keys(result.latency) : null,
          hasLatenciesHistogram: typeof (result.latencies && result.latencies.getValueAtPercentile) === 'function',
          latenciesCount: result.latencies && typeof result.latencies.totalCount === 'function' ? result.latencies.totalCount() : null,
          duration: result.duration,
          finish: result.finish,
          start: result.start,
          samples: result.samples,
          connections: result.connections,
          requests: result.requests,
          latency: result.latency,
          errors: result.errors,
          non2xx: result.non2xx,
          statusCodeStats: result.statusCodeStats,
          warmupTotal: result.warmup ? result.warmup.requests : null,
        },
        null,
        2
      )
    );
  }

  const resources = await sampler.stop();
  const generatorCpuPct = gen.sample();
  const mongoAfter = await sampleMongo(mongoUri);
  const appMetrics = await dumpServerMetrics(server);

  // Percentiles come from autocannon's own HDR histogram (see the
  // `hdr-histogram-percentiles-obj` patch at the top of this file). p95 and p99.5
  // are genuine histogram percentiles, not interpolations.
  const lat = result.latency || {};
  const pct = (p) => (typeof lat[`p${String(p).replace('.', '_')}`] === 'number' ? lat[`p${String(p).replace('.', '_')}`] : null);

  const totalReq = result.requests.total || 0;
  const errorCount = (result.errors || 0) + (result.timeouts || 0) + (result.non2xx || 0);
  const errorPct = totalReq ? (errorCount / totalReq) * 100 : 0;

  // MongoDB's own `serverStatus().metrics.commands.total` is not populated on this
  // server build, so the database-side average is taken from the command
  // histogram the app process collects, which measures the real wire round trip.
const opsDelta = (() => {
  if (!mongoBefore.first?.cmdTotalTimeMs || !mongoAfter.first?.cmdTotalTimeMs) return null;
  const ops = mongoAfter.first.cmdTotalTimeMs.totalOps - mongoBefore.first.cmdTotalTimeMs.totalOps;
  const time = mongoAfter.first.cmdTotalTimeMs.totalTimeMs - mongoBefore.first.cmdTotalTimeMs.totalTimeMs;
  return { ops, avgOpMs: ops ? Number((time / ops).toFixed(3)) : null };
})();

const appCommandMean =
  appMetrics && appMetrics.commandLatencyMs ? appMetrics.commandLatencyMs.mean : null;

  const row = {
    scenario: scenario.key,
    connections: conns,
    requestedConnections: connections,
    cappedByScenario: connections > maxAllowed,
    // How many distinct request templates this scenario cycles through. Reported so
    // the request mix behind each rps figure is explicit rather than implied.
    requestMixSize: scenarioDef.requests.length,
    rps: Number(result.requests.average.toFixed(1)),
    latencyMs: {
      p50: pct(50),
      p75: pct(75),
      p90: pct(90),
      p95: pct(95),
      p99: pct(99),
      p99_5: pct(99.5),
      max: typeof lat.max === 'number' ? lat.max : null,
      avg: typeof lat.average === 'number' ? Number(lat.average.toFixed(1)) : null,
    },
    throughputBytesPerSec: result.throughput.average,
    requests: {
      total: totalReq,
      sent: result.requests.sent,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
      status2xx: result['2xx'],
      status3xx: result['3xx'],
      status4xx: result['4xx'],
      status5xx: result['5xx'],
      // Exact per-status breakdown, so a 4xx rate can be attributed to 404s versus
      // 400s rather than guessed at.
      statusCodes: result.statusCodeStats || {},
    },
    errorPct: Number(errorPct.toFixed(2)),
    cpu: { avgPct: resources.avgCpu, peakPct: resources.peakCpu },
    generatorCpuPct,
    ram: { avgMb: resources.avgRssMb, peakMb: resources.peakRssMb },
    mongo: {
      connectionsCurrent: mongoAfter.first?.connectionsCurrent ?? null,
      connectionsBefore: mongoBefore.first?.connectionsCurrent ?? null,
      // The application's own share of those sockets: the rise above the idle
      // baseline taken before any load, which strips out this harness's monitoring
      // connection and the replica set's internal ones. Note this is pool connections
      // OPEN, not checked out - the driver grows its pool to fit the busiest moment it
      // has seen and never shrinks it, so this ratchets up and stays up.
      idleBaselineConnections: mongoIdleBaseline,
      appPoolOpenConnections:
        mongoAfter.first?.connectionsCurrent !== null && mongoAfter.first?.connectionsCurrent !== undefined
          ? Math.max(0, mongoAfter.first.connectionsCurrent - mongoIdleBaseline)
          : null,
      // Average MongoDB command round trip as seen by the app.
      avgOpMs: appCommandMean !== null ? appCommandMean : opsDelta ? opsDelta.avgOpMs : null,
      commandsInWindow: appMetrics ? appMetrics.sampleCount : null,
    },
    appMongoLatencyMs: appMetrics ? appMetrics.commandLatencyMs : null,
    appPool: appMetrics ? appMetrics.pool : null,
    eventLoop: appMetrics ? appMetrics.eventLoop : null,
    instrumentedCommands: appMetrics ? appMetrics.sampleCount : null,
    instrumentedClients: appMetrics ? appMetrics.attachedClients : null,
    slowestCommands: appMetrics
      ? Object.entries(appMetrics.perCommand)
          .sort((a, b) => b[1].avgMs - a[1].avgMs)
          .slice(0, 5)
          .map(([name, v]) => ({ command: name, count: v.count, avgMs: v.avgMs, maxMs: v.maxMs }))
      : null,
  };

  const breaches = [];
  if (row.latencyMs.p95 !== null && row.latencyMs.p95 > LIMITS.p95Ms) breaches.push(`p95 ${row.latencyMs.p95}ms > ${LIMITS.p95Ms}ms`);
  if (row.latencyMs.p99 !== null && row.latencyMs.p99 > LIMITS.p99Ms) breaches.push(`p99 ${row.latencyMs.p99}ms > ${LIMITS.p99Ms}ms`);
  if (row.errorPct > LIMITS.errorPct) breaches.push(`errors ${row.errorPct}% > ${LIMITS.errorPct}%`);
  // Process CPU is recorded per run and printed in the log, but it is deliberately
  // NOT a stop condition: on this host a Node process shows 150%+ average CPU at a
  // single connection while its main thread is still mostly idle, because V8
  // background compilation and GC work runs on other cores. Event-loop utilisation
  // below is the signal that actually corresponds to being unable to serve more.
  // Event-loop utilisation is the saturation signal for a single-threaded Node
  // server. At 1.0 the main thread has no idle time left and only more CPU (or more
  // processes) can raise throughput. Process CPU is still recorded, but it is
  // reported as context rather than used to decide saturation, because V8 background
  // compilation and GC threads push a Node process well past 100% of one core while
  // the main thread is still mostly idle.
  const elu = row.eventLoop && row.eventLoop.avgUtilization;
  if (elu !== null && elu !== undefined && elu >= LIMITS.eventLoopUtilization) {
    breaches.push(`event loop ${(elu * 100).toFixed(0)}% utilised >= ${LIMITS.eventLoopUtilization * 100}%`);
  }
  if (row.status5xx > 0) breaches.push(`${row.status5xx} 5xx responses`);

  // Memory pressure. Latency is a lagging signal for this: a heap that has run away
  // shows up as perfectly good response times right up until the moment it does not,
  // so it is checked directly rather than inferred from latency.
  const peakRss = row.ram && row.ram.peakMb;
  if (peakRss !== null && peakRss !== undefined && peakRss > LIMITS.peakRssMb) {
    breaches.push(`peak RSS ${peakRss}MB > ${LIMITS.peakRssMb}MB`);
  }

  // Pool pressure.
  //
  // The mongod's own `connections.current` is the only pool figure available from
  // outside the app, and it is a poor one to threshold on for two independent
  // reasons:
  //
  //   1. It counts every socket the mongod has open, including this harness's monitor
  //      and the replica set's internal connections. The raw number reported the app
  //      holding "105/100" connections, which is not a state the driver's pool can
  //      even reach.
  //   2. Subtracting an idle baseline fixes that, but the result is monotonic. The
  //      driver opens connections opportunistically and keeps them open for the life
  //      of the process, so once the catalogue sweep grows the pool to ~92 sockets it
  //      never shrinks back. Every later scenario then reads ~92 "in use" at a
  //      concurrency of 1, which is simply false.
  //
  // So this is recorded as a high-water observation rather than a per-level stop
  // condition: the driver has no public in-use counter in v6, and the honest reading
  // is that the pool grows to roughly its configured ceiling at the same point the
  // event loop saturates, rather than that the pool is exhausted at every level.
  const poolOpen = row.mongo && row.mongo.appPoolOpenConnections;
  const configuredPool = row.appPool && row.appPool.configuredMaxPoolSize;
  if (configuredPool && poolOpen !== null && poolOpen !== undefined) {
    row.mongo.poolOpenPct = Number(((poolOpen / configuredPool) * 100).toFixed(1));
  }
  row.breaches = breaches;
  row.healthy = breaches.length === 0;

  return row;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server;
let mongoUri;
// Idle mongod connection count, captured once the API is up but before any load is
// applied. Used as the floor for "how many connections is the application itself
// holding" - see the pool-pressure note in buildRow.
let mongoIdleBaseline = 0;
let results = [];
let seedSize = null;

async function main() {
  log('='.repeat(72));
  log('ANILKABADI LOAD TEST - isolated environment only');
  log('='.repeat(72));

  if (!SERVER_PORT) {
    SERVER_PORT = await reserveFreePort();
    BASE = `http://127.0.0.1:${SERVER_PORT}`;
  }

  const envInfo = {
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    totalMemMb: Number((os.totalmem() / 1048576).toFixed(0)),
    freeMemMbAtStart: Number((os.freemem() / 1048576).toFixed(0)),
    autocannon: require('autocannon/package.json').version,
  };
  log(`host: ${envInfo.cpus} cores, ${envInfo.totalMemMb} MB RAM, node ${envInfo.node}`);
  log(
    `apiLimiter: ${Number(API_RATE_LIMIT_VALUE) || 100} requests / 15 min per IP ` +
      `(mode=${RATE_LIMIT_MODE})`
  );

  // 1. isolated database
  log('starting isolated MongoDB replica set...');
  mongoUri = await startDb();
  log(`database up: ${mongoUri.replace(/\/\/[^@]*@/, '//')}`);

  // 2. seed
  {
    log('seeding dataset (this takes a while)...');
    const seedArgs = [path.join(HERE, 'seed.js')];
    // Seed size is overridable so a smoke run can validate the harness in a
    // couple of minutes instead of a full-size seed.
    const sizes = QUICK
      ? { users: '8000', products: '3000', orders: '6000', reviews: '1', wishlists: '3000' }
      : { users: '50000', products: '12000', orders: '40000', reviews: '20', wishlists: '20000' };
    for (const [k, v] of Object.entries(sizes)) {
      const override = argValue(k, null);
      if (override !== null) sizes[k] = override;
      seedArgs.push(`--${k}`, sizes[k]);
    }
    results = null;
    seedSize = { ...sizes };
    await run(process.execPath, seedArgs, {
      cwd: path.join(HERE, '..', '..'),
      env: {
        ...process.env,
        JWT_SECRET: LOADTEST_JWT_SECRET,
        JWT_EXPIRES_IN: LOADTEST_JWT_EXPIRES_IN,
      },
    });
  }

  if (!fs.existsSync(TOKENS_FILE)) throw new Error(`missing ${TOKENS_FILE} - run the seed first`);
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  log(`tokens ready: ${tokens.customers.length} customers, ${tokens.admin ? '1 admin' : 'NO ADMIN'}`);

  // 3. server
  log('starting API server against the isolated database...');
  server = await startServer(mongoUri);
  log(`server up on ${BASE}`);

  // sanity check that it really is our throwaway DB
  const probe = new MongoClient(mongoUri, { maxPoolSize: 1 });
  await probe.connect();
  const dbName = probe.db().databaseName;
  await probe.close();
  if (!dbName.endsWith('loadtest')) {
    throw new Error(`ABORT: server is connected to "${dbName}", not a loadtest database`);
  }
  log(`verified: server database is "${dbName}"`);

  // Idle baseline for pool accounting. Taken after the API is connected and before
  // any traffic, so it captures the mongod's standing connections (this harness's
  // monitor, the replica set's internals) that have nothing to do with the app.
  {
    const idle = await sampleMongo(mongoUri);
    mongoIdleBaseline = idle.first?.connectionsCurrent ?? 0;
    log(`mongo idle baseline: ${mongoIdleBaseline} connections before any load`);
  }

  // 4. scenarios
  const buildScenarios = require('./scenarios');
  const all = buildScenarios(tokens);
  const only = argValue('only', null);
  const scenarioKeys = only ? only.split(',') : Object.keys(all);

  results = {
    startedAt: new Date().toISOString(),
    env: envInfo,
    limits: LIMITS,
    measureSeconds: MEASURE_SECONDS,
    warmupSeconds: WARMUP_SECONDS,
    workers: WORKERS,
    rateLimitMode: RATE_LIMIT_MODE,
    // The effective ceiling `apiLimiter` was running with for this run. Recorded so
    // a results file can never be read without also stating which rate-limit
    // configuration produced it.
    effectiveApiRateLimitMax: Number(API_RATE_LIMIT_VALUE) || 100,
    seedSize,
    dataset: {},
    runs: [],
    stopLevel: null,
    stopReason: null,
  };

  // record dataset size
  {
    const client = new MongoClient(mongoUri, { maxPoolSize: 2 });
    await client.connect();
    const db = client.db();
    for (const c of ['users', 'products', 'categories', 'orders', 'reviews', 'carts', 'wishlists', 'settings']) {
      results.dataset[c] = await db.collection(c).countDocuments();
    }
    await client.close();
  }
  log(`dataset: ${JSON.stringify(results.dataset)}`);

for (const key of scenarioKeys) {
      const scenario = { key, def: all[key] };
      if (!scenario.def) throw new Error(`unknown scenario ${key}`);
      log('-'.repeat(72));
      log(`SCENARIO: ${key} - ${scenario.def.description}`);
  
      let stopIndex = -1;
  
      // A scenario that declares `maxConcurrency` (checkout, admin) is only
      // meaningful up to that level. Without this filter the sweep would clamp
      // every remaining level down to the same number and re-measure the identical
      // configuration four more times - four wasted windows that all report the
      // same rps, and the last of which could trip a stop condition and be
      // misread as saturation at a level that was never actually applied.
      const scenarioLevels = LEVELS.filter(
        (l) => l <= (scenario.def.maxConcurrency || Infinity)
      );
      if (scenarioLevels.length !== LEVELS.length) {
        log(
          `  scenario caps concurrency at ${scenario.def.maxConcurrency}; ` +
            `levels under test: ${scenarioLevels.join(', ')}`
        );
      }
  
      for (let i = 0; i < scenarioLevels.length; i++) {
        const level = scenarioLevels[i];
        let row;
        try {
          row = await measure(scenario, level);
        } catch (error) {
          log(`  ERROR at ${level}: ${error.message}`);
          row = { scenario: key, connections: level, rps: 0, error: error.message, healthy: false, breaches: [`harness error: ${error.message}`] };
        }
        results.runs.push(row);
  
        log(
          `  @${String(row.connections).padStart(4)}  rps=${String(row.rps).padStart(7)}  ` +
            `p50=${row.latencyMs ? row.latencyMs.p50 : '-'}ms  p95=${row.latencyMs ? row.latencyMs.p95 : '-'}ms  ` +
            `p99=${row.latencyMs ? row.latencyMs.p99 : '-'}ms  err=${row.errorPct}%  ` +
            `cpu=${row.cpu ? row.cpu.avgPct : '-'}% (peak ${row.cpu ? row.cpu.peakPct : '-'}%)  rss=${row.ram ? row.ram.peakMb : '-'}MB  ` +
            `gen=${row.generatorCpuPct}%  elu=${row.eventLoop && row.eventLoop.avgUtilization !== null ? row.eventLoop.avgUtilization : '-'}  ` +
            `mongoAvgOp=${row.mongo ? row.mongo.avgOpMs : '-'}ms  ${row.healthy ? 'OK' : 'UNHEALTHY: ' + row.breaches.join(', ')}`
        );
  
        if (!row.healthy) {
          // A harness failure is not a saturation signal, so it must not stop the sweep.
          if (row.error) {
            log(`  (harness error - continuing sweep)`);
          } else {
            stopIndex = i;
            results.stopLevel = row.connections;
            results.stopReason = `${key}: ${row.breaches.join('; ')}`;
            log(`  >>> STOP CONDITION MET at concurrency ${row.connections}: ${results.stopReason}`);
            break;
          }
        }
      }
  
      // Beyond-saturation probe.
      //
      // Stopping the moment the stop conditions trip tells us the safe capacity, but
      // not what happens past it - whether the server degrades gracefully or collapses
      // into timeouts and errors. One extra level above the stop point is measured so
      // the report can describe the failure mode, and is flagged so it is never
      // mistaken for a supported level.
      if (stopIndex >= 0 && stopIndex + 1 < scenarioLevels.length) {
        const probeLevel = scenarioLevels[stopIndex + 1];
        log(`  --- beyond-saturation probe at ${probeLevel} (not a supported level) ---`);
        let row;
        try {
          row = await measure(scenario, probeLevel);
        } catch (error) {
          row = { scenario: key, connections: probeLevel, rps: 0, error: error.message, healthy: false, breaches: [`harness error: ${error.message}`] };
        }
        row.beyondSaturation = true;
        results.runs.push(row);
        log(
          `  @${String(row.connections).padStart(4)}  rps=${String(row.rps).padStart(7)}  ` +
            `p50=${row.latencyMs ? row.latencyMs.p50 : '-'}ms  p95=${row.latencyMs ? row.latencyMs.p95 : '-'}ms  ` +
            `p99=${row.latencyMs ? row.latencyMs.p99 : '-'}ms  err=${row.errorPct}%  ` +
            `rss=${row.ram ? row.ram.peakMb : '-'}MB  (probe)`
        );
      }
    }
  
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  log('='.repeat(72));
  log(`results written to ${RESULTS_FILE}`);
}

main()
  .then(async () => {
    await teardown();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[loadtest] FATAL:', error.stack);
    await teardown();
    process.exit(1);
  });

process.on('SIGINT', async () => {
  log('interrupted - tearing down');
  await teardown();
  process.exit(130);
});

// Last-resort safety net. If this process dies without reaching teardown (an
// uncaught exception, SIGKILL from outside, a power loss), the disposable artefacts
// are still removed. This is intentionally synchronous because an async handler
// would not be allowed to finish during process exit. It only ever removes the
// three dot-prefixed load-test paths inside scripts/loadtest - never anything
// outside that directory.
process.on('exit', () => {
  for (const f of [URI_FILE, TOKENS_FILE, DB_PATH_DIR]) {
    try {
      fs.rmSync(f, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});