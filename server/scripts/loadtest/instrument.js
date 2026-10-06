/**
 * Load-test-only runtime instrumentation.
 *
 * This file is loaded into the API process with `NODE_OPTIONS="--require ..."`
 * during a load test and at no other time. It deliberately does NOT live inside
 * the application: it monkey-patches the `mongoose` module *inside the test
 * process* so that no production source file has to change to be measurable.
 * That constraint matters - adding a `/metrics` route to `server.js` would mean
 * shipping instrumentation in production, so instead we attach to the process
 * from outside and read what we need.
 *
 * What it records:
 *   - A duration histogram for every MongoDB command the app issues, plus which
 *     command it was. This is the only honest way to separate "MongoDB is slow"
 *     from "the app is slow", because it times the wire round trip per command
 *     rather than inferring it from request latency.
 *   - Connection-pool saturation, read from the driver's topology.
 *   - Event-loop delay and event-loop utilisation. For a single-threaded Node
 *     server these are the saturation signal that matters: the process can show
 *     150%+ CPU across several cores purely from V8 background compilation
 *     threads while its main thread still has idle time, so CPU alone is not a
 *     reliable "is it full" measure. Event-loop utilisation answers it directly.
 *
 * It is inert until a connection is made, so requiring it is harmless.
 */

const { monitorEventLoopDelay, performance } = require('perf_hooks');

const state = {
  started: false,
  commands: new Map(), // commandName -> {count, totalMs, maxMs, over100ms, over50ms}
  poolSamples: [],
  commandFailures: 0,
  attachedClients: 0,
  configuredMaxPoolSize: null,
  eluSamples: [],
};

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

let durations = [];

function recordCommand(name, durationMs, ok) {
  let bucket = state.commands.get(name);
  if (!bucket) {
    bucket = { count: 0, totalMs: 0, maxMs: 0, over50ms: 0, over100ms: 0, failures: 0 };
    state.commands.set(name, bucket);
  }
  bucket.count += 1;
  bucket.totalMs += durationMs;
  if (durationMs > bucket.maxMs) bucket.maxMs = durationMs;
  if (durationMs > 50) bucket.over50ms += 1;
  if (durationMs > 100) bucket.over100ms += 1;
  if (!ok) bucket.failures += 1;

  durations.push(durationMs);
  // Bound the sample set. Keeping every duration for a multi-thousand-RPS test
  // would grow without limit and the histogram itself would become the memory
  // problem we are trying to measure.
  if (durations.length > 200000) durations = durations.slice(-100000);
}

// Driver v6 emits three DISTINCT event objects for one command (CommandStartedEvent,
// CommandSucceededEvent, CommandFailedEvent) - they are not the same object, so a
// property stashed on the start event is invisible on the success event. That
// silently recorded zero commands until the start time was keyed by requestId.
const inFlight = new Map();

function attach(client) {
  if (!client || typeof client.on !== 'function') return;
  if (client.__loadTestInstrumented) return;
  client.__loadTestInstrumented = true;
  state.attachedClients += 1;

  client.on('commandStarted', (event) => {
    inFlight.set(event.requestId, process.hrtime.bigint());
  });

  client.on('commandSucceeded', (event) => {
    const started = inFlight.get(event.requestId);
    if (started === undefined) return;
    inFlight.delete(event.requestId);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    recordCommand(event.commandName, ms, true);
  });

  // A failed command is not a connection problem. The same event fires for a duplicate
  // key aborting a transaction and for a genuine pool timeout, and conflating the two
  // made ordinary application errors look like infrastructure saturation. They are
  // counted and reported separately, and never used as a saturation signal.
  client.on('commandFailed', (event) => {
    const started = inFlight.get(event.requestId);
    if (started === undefined) return;
    inFlight.delete(event.requestId);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    recordCommand(event.commandName, ms, false);
    state.commandFailures += 1;
  });

  // The configured pool size is a stable, public driver option. Live in-use counts are
  // not: in driver v6 they live behind `client.topology`, which is private and whose
  // shape differs between major versions. The orchestrator therefore measures pool
  // usage as the rise in mongod connections above an idle baseline, which answers the
  // same question without depending on private internals.
  state.configuredMaxPoolSize =
    (client.options && (client.options.maxPoolSize || client.options.poolSize)) || null;
}

function samplePool() {
  // Intentionally empty. See the note above: pool pressure is measured by the
  // orchestrator from `serverStatus` rather than from driver internals, so this hook
  // is kept only as the documented place where such sampling would go.
}

// Event-loop health. `monitorEventLoopDelay` reports how long a timer actually
// waited versus how long it asked to wait: the gap is time the loop was too busy
// to service it, which is exactly the latency a queued HTTP request experiences.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
if (loopDelay.enable) loopDelay.enable();

let eluCursor = performance.eventLoopUtilization();
const eluTimer = setInterval(() => {
  const next = performance.eventLoopUtilization(eluCursor);
  eluCursor = performance.eventLoopUtilization();
  state.eluSamples.push({ t: Date.now(), utilization: next.utilization, active: next.active, idle: next.idle });
}, 500);
if (eluTimer.unref) eluTimer.unref();

// Hook mongoose.connect so instrumentation is installed the moment the app
// connects, without the app knowing it happened.
try {
  // eslint-disable-next-line global-require
  const mongoose = require('mongoose');
  const originalConnect = mongoose.connect.bind(mongoose);

  // `mongoose.connect()` resolves to a Mongoose Connection, and it is that object
  // which exposes `getClient()`. Reaching through `conn.connection` is wrong and
  // silently attaches nothing, which is why command counts stayed at zero until
  // this was corrected.
  const clientOf = (conn) => {
    if (conn && typeof conn.getClient === 'function') return conn.getClient();
    if (conn && conn.connection && typeof conn.connection.getClient === 'function') {
      return conn.connection.getClient();
    }
    return null;
  };

  mongoose.connect = async (...args) => {
    // MongoDB Node driver v6 does NOT emit `commandStarted`/`commandSucceeded` unless
    // the client is built with `monitorCommands: true` - verified directly: with the
    // default options, a client that issued an insert and a find produced zero
    // monitoring events. That is why per-command latency was unavailable until this.
    //
    // The option is injected HERE, in test-only code, rather than in the
    // application's own connect call, so production source is untouched. It is only
    // ever active because this file is preloaded with `--require` during a load test.
    const patched = args.slice();
    if (typeof patched[1] !== 'object' || patched[1] === null) patched[1] = {};
    patched[1] = { ...patched[1], monitorCommands: true };

    const conn = await originalConnect(...patched);
    state.started = true;
    attach(clientOf(conn));
    // Listen for reconnects too, otherwise pool stats silently go stale.
    if (conn && typeof conn.on === 'function') {
      conn.on('connected', () => attach(clientOf(conn)));
    }
    return conn;
  };

  /**
   * Dumps measurements on demand. Registered as a process signal rather than an
   * HTTP route so that nothing is added to the Express app.
   */
  process.on('SIGUSR2', () => {
    const sorted = durations.slice().sort((a, b) => a - b);
    const commands = {};
    for (const [name, b] of state.commands) {
      commands[name] = {
        count: b.count,
        avgMs: Number((b.totalMs / b.count).toFixed(3)),
        maxMs: Number(b.maxMs.toFixed(3)),
        over50ms: b.over50ms,
        over100ms: b.over100ms,
        failures: b.failures,
      };
    }

    const hasLoopDelay = state.eluSamples.length > 0;

    const payload = {
      instrumented: state.started,
      attachedClients: state.attachedClients,
      sampleCount: sorted.length,
      commandLatencyMs: {
        p50: percentile(sorted, 50) === null ? null : Number(percentile(sorted, 50).toFixed(3)),
        p95: percentile(sorted, 95) === null ? null : Number(percentile(sorted, 95).toFixed(3)),
        p99: percentile(sorted, 99) === null ? null : Number(percentile(sorted, 99).toFixed(3)),
        max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
        // Arithmetic mean of every sampled command, used to express what share of
        // a request's latency is attributable to the database.
        mean: sorted.length
          ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3))
          : null,
      },
      perCommand: commands,
      pool: {
        // Configured client-side pool size. Whether it was exhausted is inferred
        // from the server-side connection count the orchestrator samples.
        configuredMaxPoolSize: state.configuredMaxPoolSize || null,
      },
      commandFailures: state.commandFailures,
      eventLoop: {
        // Delay percentiles in ms: the gap between when a timer was due and when
        // it actually ran. Zero when nothing was sampled in the window.
        delayMs: hasLoopDelay
          ? {
              p50: Number((loopDelay.percentile(50) / 1e6).toFixed(2)),
              p95: Number((loopDelay.percentile(95) / 1e6).toFixed(2)),
              p99: Number((loopDelay.percentile(99) / 1e6).toFixed(2)),
              max: Number((loopDelay.max / 1e6).toFixed(2)),
            }
          : null,
        avgUtilization: state.eluSamples.length
          ? Number((state.eluSamples.reduce((a, b) => a + b.utilization, 0) / state.eluSamples.length).toFixed(3))
          : null,
        peakUtilization: state.eluSamples.length
          ? Number(Math.max(...state.eluSamples.map((s) => s.utilization)).toFixed(3))
          : null,
        samples: state.eluSamples.length,
      },
    };

    process.stdout.write(`__LOADTEST_METRICS__${JSON.stringify(payload)}\n`);

    // Reset immediately after dumping so each measured level reports only its own
    // window. Without this, percentiles and counters would be cumulative across
    // every level and could not be attributed to any one of them.
    durations = [];
    state.commands = new Map();
    state.poolSamples = [];
    state.commandFailures = 0;
    state.eluSamples = [];
    loopDelay.reset();
  });
} catch (error) {
  process.stderr.write(`[loadtest-instrument] failed to attach: ${error.message}\n`);
}