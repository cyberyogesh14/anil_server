/**
 * Shared-state tests for the multi-worker deployment work.
 *
 * These cover the behaviours that only exist once more than one worker is running,
 * and which a single-process suite structurally cannot observe:
 *
 *   1. Rate limit counters are genuinely SHARED - two independent processes
 *      accumulate into one bucket instead of each getting a fresh allowance.
 *   2. Rate limit namespaces cannot leak into each other.
 *   3. The atomic Lua script does not lose increments under concurrency.
 *   4. A Redis outage in production fails CLOSED and never hands out a fresh
 *      unlimited allowance.
 *   5. Fail-open (development) still limits, just per-process.
 *   6. The catalogue cache is shared and an invalidation in one process is visible
 *      to another - the cross-worker staleness this change removes.
 *   7. No secret ever reaches a log line, an error message or a key name.
 *
 * A scratch Redis is started on a free port with persistence off, and every key is
 * namespaced by REDIS_KEY_PREFIX, so this cannot disturb an existing Redis.
 *
 * Run with `npm run test:shared`.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

const section = (title) => console.log(`\n${title}`);

/** Asks the OS for a free port so parallel runs cannot collide. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `redis-cli ping` answers PONG. */
const waitForRedis = async (port, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const child = spawn('redis-cli', ['-p', String(port), 'ping'], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
};

/**
 * Runs a script in a real child process.
 *
 * Real processes, not objects in one process, for two reasons. The config modules
 * read `process.env` once at import time, so a test cannot flip NODE_ENV and expect
 * the same module instance to notice. And "two workers" is a property of separate
 * heaps - two store instances in one process would share nothing that matters and
 * could not catch a module-level singleton or a per-process cache.
 */
const runInChild = (script, env, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // A child that hangs must fail its test rather than wedge the suite. A live
    // ioredis socket holds the Node event loop open, so a script that forgets to
    // exit would otherwise block forever.
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n(child timed out - did the script forget process.exit?)`,
        json: null,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      let json;
      try {
        json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
      } catch {
        json = undefined;
      }
      resolve({ code, stdout, stderr, json });
    });
  });

/** Runs a child, failing loudly with its stderr attached. */
const runOk = async (script, env, timeoutMs) => {
  const result = await runInChild(script, env, timeoutMs);
  if (result.code !== 0) {
    throw new Error(
      `child exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );
  }
  return result;
};

/**
 * Wraps a body so the child always exits.
 *
 * A script that talks to Redis keeps a socket open, which holds the event loop
 * alive indefinitely. Every script below ends with this so a finished child exits
 * instead of being killed by the watchdog.
 */
const exiting = (body) => `
(async () => {
${body}
})().then(() => process.exit(0), (error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exit(1);
});`;

/** Prints a value the parent can parse, then the wrapper exits the child. */
const emit = (value) => `console.log(JSON.stringify(${value}));`;

const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** Reads one Redis key in a child of its own, so the test never holds a client. */
const readKey = (redisEnv, key) =>
  runOk(
    exiting(`
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL);
      // Awaited, not .then()'d: the exiting() wrapper calls process.exit as soon as
      // the async body settles, so an un-awaited promise would be cut off.
      const value = await client.get(process.env.REDIS_KEY_PREFIX + ${JSON.stringify(key)});
      console.log(JSON.stringify(value === null ? null : value));
      await client.quit();
    `),
    redisEnv
  ).then((r) => r.json);

const main = async () => {
  // A hard ceiling, so a hang surfaces as a failure rather than a stuck terminal.
  const suiteWatchdog = setTimeout(() => {
    console.error('\nSuite exceeded 8 minutes; aborting.');
    process.exit(1);
  }, 8 * 60 * 1000);
  suiteWatchdog.unref();

  const redisPort = await freePort();
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const keyPrefix = `test:shared:${process.pid}`;

  console.log(`Starting a scratch Redis on port ${redisPort} (prefix ${keyPrefix})`);

  const redis = spawn(
    'redis-server',
    ['--port', String(redisPort), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'],
    {
      stdio: 'ignore',
      // redis-server refuses to start when the locale is unset or unknown
      // ("Failed to configure LOCALE"), so pin a C locale rather than inheriting
      // whatever the developer happens to have exported.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }
  );

  const cleanup = () => {
    try {
      redis.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(1);
  });

  if (!(await waitForRedis(redisPort))) {
    console.error('Could not start redis-server. Is it installed?');
    cleanup();
    process.exit(1);
  }
  console.log('Redis is up.\n');

  /** Production-shaped environment pointing at the scratch Redis. */
  const prodEnv = {
    NODE_ENV: 'production',
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: keyPrefix,
    RATE_LIMIT_FAIL_CLOSED: 'true',
    MONGO_URI: 'mongodb://127.0.0.1:1/unused',
    JWT_SECRET: 'x'.repeat(40),
    CLIENT_URL: 'https://example.test',
  };

  /** Environment for cache tests: the cache is never gated on NODE_ENV. */
  const cacheEnv = {
    NODE_ENV: 'development',
    REDIS_URL: redisUrl,
    REDIS_KEY_PREFIX: keyPrefix,
    RATE_LIMIT_FAIL_CLOSED: 'false',
  };

  /**
   * An environment pointing at a port with nothing listening.
   *
   * `extra` is spread FIRST so the dead URL cannot be overridden by a caller that
   * happens to pass a full environment in - which would silently point the test at
   * the live Redis and make it pass for the wrong reason.
   */
  const deadEnv = async (extra = {}) => ({
    ...extra,
    NODE_ENV: extra.NODE_ENV || 'development',
    REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    REDIS_KEY_PREFIX: keyPrefix,
    REDIS_CONNECT_TIMEOUT_MS: '300',
    REDIS_COMMAND_TIMEOUT_MS: '200',
  });

  // --------------------------------------------------------------- config ---
  section('Configuration');

  await check('clustered production without Redis refuses to boot', async () => {
    const r = await runOk(
      exiting(`const {validate}=require('./config/env'); ${emit('validate().problems.length > 0')}`),
      { ...prodEnv, PM2_INSTANCES: '4', REDIS_URL: '', REDIS_HOST: '' }
    );
    assert.strictEqual(r.json, true, 'boot must be blocked');
  });

  await check('the refusal names Redis as the reason', async () => {
    const r = await runOk(
      exiting(`const {validate}=require('./config/env'); ${emit('validate().problems')}`),
      { ...prodEnv, PM2_INSTANCES: '4', REDIS_URL: '', REDIS_HOST: '' }
    );
    assert.ok(
      r.json.some((p) => /Redis is required/.test(p)),
      `expected a Redis-required problem, got ${JSON.stringify(r.json)}`
    );
  });

  await check('single-worker production without Redis is allowed, with a warning', async () => {
    const r = await runOk(
      exiting(`
        const {validate}=require('./config/env');
        ${emit('validate()')}
      `),
      { ...prodEnv, PM2_INSTANCES: '1', REDIS_URL: '', REDIS_HOST: '' }
    );
    assert.deepStrictEqual(r.json.problems, [], 'must not block a valid single-worker deploy');
    assert.ok(
      r.json.warnings.some((w) => /Redis is not configured/.test(w)),
      'must still warn that limits and cache are per-process'
    );
  });

  await check('the pool divides the budget across workers', async () => {
    const r = await runOk(
      exiting(`const {describe}=require('./config/env'); ${emit('describe().mongo')}`),
      { PM2_INSTANCES: '4', MONGO_MAX_POOL_SIZE: '', MONGO_TOTAL_POOL_BUDGET: '100' }
    );
    assert.strictEqual(r.json.maxPoolSize, 25);
    assert.strictEqual(r.json.totalConnections, 100);
  });

  await check('one worker keeps the historical pool size of 100', async () => {
    const r = await runOk(
      exiting(`const {describe}=require('./config/env'); ${emit('describe().mongo')}`),
      { PM2_INSTANCES: '1', MONGO_MAX_POOL_SIZE: '', MONGO_TOTAL_POOL_BUDGET: '100' }
    );
    assert.strictEqual(r.json.maxPoolSize, 100, 'a single-process deploy must not change behaviour');
  });

  await check('an explicit pool size is never silently divided', async () => {
    const r = await runOk(
      exiting(`const {describe}=require('./config/env'); ${emit('describe().mongo')}`),
      { PM2_INSTANCES: '4', MONGO_MAX_POOL_SIZE: '40', MONGO_TOTAL_POOL_BUDGET: '400' }
    );
    assert.strictEqual(r.json.maxPoolSize, 40);
    assert.strictEqual(r.json.maxPoolSizeExplicit, true);
  });

  await check('a pool above the budget warns instead of blocking', async () => {
    const r = await runOk(
      exiting(`
        const {validate}=require('./config/env');
        ${emit('validate()')}
      `),
      { PM2_INSTANCES: '4', MONGO_MAX_POOL_SIZE: '250', MONGO_TOTAL_POOL_BUDGET: '100' }
    );
    assert.deepStrictEqual(r.json.problems, [], 'a tunable must not refuse to boot');
    assert.ok(
      r.json.warnings.some((w) => /MONGO_TOTAL_POOL_BUDGET/.test(w)),
      'it must explain the ceiling'
    );
  });

  // ------------------------------------------------------- shared counters ---
  section('Rate limiting across processes');

  /** Hits `times` times in the given namespace and key, then exits. */
  const hammer = (namespace, key, times) =>
    exiting(`
      const {buildStore}=require('./middleware/rateLimitStore');
      const store=buildStore(${JSON.stringify(namespace)});
      store.init({windowMs:60000,prefix:'rl:'});
      let last=null;
      for(let i=0;i<${times};i++){ last=await store.increment(${JSON.stringify(key)}); }
      ${emit('last')}
    `);

  await check('two processes accumulate into ONE counter', async () => {
    // This is the core multi-worker claim. With a per-process store these would be
    // 3 and 3; with a shared store the key ends at 6.
    const a = await runOk(hammer('api', 'shared-client', 3), prodEnv);
    const b = await runOk(hammer('api', 'shared-client', 3), prodEnv);
    assert.strictEqual(a.json.totalHits, 3, 'worker A should see a running total of 3');
    assert.strictEqual(b.json.totalHits, 6, 'worker B must continue worker A count, not restart it');

    const stored = await readKey(prodEnv, ':rl:api:shared-client');
    assert.strictEqual(Number(stored), 6, 'Redis must hold the combined total');
  });

  await check('a flood in one namespace cannot exhaust another', async () => {
    await runOk(hammer('payment', 'iso-key', 5), prodEnv);
    const stored = await readKey(prodEnv, ':rl:auth:iso-key');
    assert.strictEqual(
      stored,
      null,
      'five payment hits must not create or touch an auth counter'
    );
  });

  await check('concurrent increments are not lost', async () => {
    // 10 processes x 25 hits = 250. Any read-modify-write race in the counter
    // shows up here as a lower number.
    await Promise.all(
      Array.from({ length: 10 }, () => runOk(hammer('api', 'race-key', 25), prodEnv))
    );
    const stored = await readKey(prodEnv, ':rl:api:race-key');
    assert.strictEqual(
      Number(stored),
      250,
      'every increment must be counted exactly once, with no lost updates'
    );
  });

  await check('the window TTL is set on first use and not reset by later hits', async () => {
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        await store.increment('ttl-key');
        const second=await store.increment('ttl-key');
        const Redis=require('ioredis');
        const client=new Redis(process.env.REDIS_URL);
        const ttl=await client.pttl(process.env.REDIS_KEY_PREFIX+':rl:api:ttl-key');
        ${emit('{total:second.totalHits,ttl,resetInFuture:second.resetTime>Date.now()}')}
      `),
      prodEnv
    );
    assert.strictEqual(r.json.total, 2, 'hits must accumulate inside the window');
    assert.ok(
      r.json.ttl > 0 && r.json.ttl <= 60000,
      `a 60s window must leave a positive TTL no larger than 60s, got ${r.json.ttl}`
    );
    assert.ok(r.json.resetInFuture, 'resetTime must be in the future');
  });

  await check('each limiter reports its own independent count', async () => {
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const api=buildStore('api');api.init({windowMs:60000,prefix:'rl:'});
        const auth=buildStore('auth');auth.init({windowMs:60000,prefix:'rl:'});
        for(let i=0;i<2;i++)await api.increment('same-key');
        for(let i=0;i<7;i++)await auth.increment('same-key');
        const apiTotal=(await api.increment('same-key')).totalHits;
        const authTotal=(await auth.increment('same-key')).totalHits;
        ${emit('{api:apiTotal,auth:authTotal}')}
      `),
      prodEnv
    );
    assert.strictEqual(r.json.api, 3, 'api bucket must hold only its own hits');
    assert.strictEqual(r.json.auth, 8, 'auth bucket must hold only its own hits');
  });

  // ------------------------------------------------------ outage behaviour ---
  section('Redis outage behaviour');

  await check('production fails closed: every request is refused', async () => {
    const env = await deadEnv({ ...prodEnv, NODE_ENV: 'production', RATE_LIMIT_FAIL_CLOSED: 'true' });
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        let refused=0, allowed=0, wrongError=null;
        for(let i=0;i<5;i++){
          try { await store.increment('dead-key'); allowed++; }
          catch (error) {
            if (error.code === 'RATE_LIMIT_STORE_UNAVAILABLE') refused++;
            else wrongError = error.code || error.message;
          }
        }
        ${emit('{refused,allowed,wrongError}')}
      `),
      env
    );
    assert.strictEqual(r.json.allowed, 0, 'no request may be served unchecked while Redis is down');
    assert.strictEqual(r.json.refused, 5);
    assert.strictEqual(r.json.wrongError, null, 'the failure must be a recognisable code');
  });

  await check('the refusal is identified by code, not by message text', async () => {
    const env = await deadEnv({ ...prodEnv, RATE_LIMIT_FAIL_CLOSED: 'true' });
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        let observed = null;
        try {
          await store.increment('code-key');
        } catch (error) {
          observed = { code: error.code, isError: error instanceof Error };
        }
        ${emit('observed')}
      `),
      env
    );
    assert.strictEqual(r.json.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
    assert.strictEqual(r.json.isError, true, 'the middleware checks .code, so it must be a real Error');
  });

  await check('a refused error never carries the Redis password', async () => {
    const deadPort = await freePort();
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        try {
          await store.increment('leak-key');
          ${emit("{leaked:false}")}
        } catch (error) {
          const text = String(error.message) + ' ' + String(error.stack);
          const leaked = text.includes('hunter2') || text.includes('someuser');
          ${emit('{leaked}')}
        }
      `),
      {
        ...prodEnv,
        REDIS_URL: `redis://someuser:hunter2@127.0.0.1:${deadPort}`,
        REDIS_CONNECT_TIMEOUT_MS: '300',
      }
    );
    assert.strictEqual(r.json.leaked, false, 'credentials must not appear in the error');
  });

  await check('Redis connection errors are logged without credentials', async () => {
    const deadPort = await freePort();
    const r = await runInChild(
      exiting(`
        const redis=require('./config/redis');
        redis.run(() => 'unused', null);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      `),
      {
        NODE_ENV: 'production',
        REDIS_URL: `redis://someuser:hunter2@127.0.0.1:${deadPort}`,
        REDIS_CONNECT_TIMEOUT_MS: '300',
      }
    );
    assert.ok(
      !/hunter2/.test(r.stdout) && !/someuser/.test(r.stdout),
      `the connection warning leaked credentials:\n${r.stdout}`
    );
    assert.ok(
      /connection refused/i.test(r.stderr),
      `expected a classified, readable warning, got:\n${r.stderr}`
    );
  });

  await check('fail-open keeps limiting, just per-process', async () => {
    const env = await deadEnv({ RATE_LIMIT_FAIL_CLOSED: 'false' });
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        const first=await store.increment('open-key');
        const second=await store.increment('open-key');
        ${emit('{first:first.totalHits,second:second.totalHits}')}
      `),
      env
    );
    assert.strictEqual(r.json.first, 1);
    assert.strictEqual(r.json.second, 2, 'the local store must still accumulate hits');
  });

  await check('two fail-open workers do not share a counter', async () => {
    // Documents the trade-off explicitly: fail-open is per-process, which is why
    // production refuses to start in this state rather than allowing it.
    const env = await deadEnv({ RATE_LIMIT_FAIL_CLOSED: 'false' });
    const a = await runOk(hammer('api', 'open-shared', 3), env);
    const b = await runOk(hammer('api', 'open-shared', 3), env);
    assert.strictEqual(a.json.totalHits, 3);
    assert.strictEqual(b.json.totalHits, 3, 'fail-open is explicitly per-process');
  });

  await check('no Redis configured leaves the library default MemoryStore in place', async () => {
    const r = await runOk(
      exiting(`
        const {buildStore}=require('./middleware/rateLimitStore');
        const absent = buildStore('api') === undefined;
        ${emit('{absent}')}
      `),
      { NODE_ENV: 'development', REDIS_URL: '', REDIS_HOST: '' }
    );
    assert.strictEqual(r.json.absent, true, 'development must not need Redis at all');
  });

  // -------------------------------------------------------- shared cache ---
  section('Shared cache across processes');

  await check('a write in one process is readable from another', async () => {
    await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        await cache.set('x:key',{name:'Sarees',n:3},60000);
      `),
      cacheEnv
    );
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        const value = await cache.get('x:key');
        ${emit('value')}
      `),
      cacheEnv
    );
    assert.deepStrictEqual(
      r.json,
      { name: 'Sarees', n: 3 },
      'a second process must see the first process write - this is the cross-worker cache'
    );
  });

  await check('the TTL lives in Redis, not only in the writer', async () => {
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        const Redis=require('ioredis');
        await cache.set('x:ttl',1,45000);
        const client=new Redis(process.env.REDIS_URL);
        const ttl=await client.pttl(process.env.REDIS_KEY_PREFIX+':cache:x:ttl');
        ${emit('{ttl}')}
      `),
      cacheEnv
    );
    assert.ok(
      r.json.ttl > 40000 && r.json.ttl <= 45000,
      `expected the ~45s TTL to be stored in Redis, got ${r.json.ttl}`
    );
  });

  await check('catalogue invalidation in one process clears another process cache', async () => {
    // The regression this guards: with a per-process cache, editing a product
    // invalidates only the worker that served the edit, so the others keep serving
    // the pre-edit rail - stock included - until the TTL expires.
    const seeded = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        const {RAIL_PREFIXES,railKey,CATEGORIES_KEY,CATALOGUE_TOTAL_KEY}
          =require('./utils/catalogueCache');
        await cache.set(CATEGORIES_KEY,[{n:'Stale'}],60000);
        await cache.set(CATALOGUE_TOTAL_KEY,999,60000);
        for(const name of Object.keys(RAIL_PREFIXES)){
          await cache.set(railKey(name,'8'),[{rail:name,stale:true}],60000);
        }
        ${emit('{rails:Object.keys(RAIL_PREFIXES),seeded:true}')}
      `),
      cacheEnv
    );
    assert.ok(seeded.json.seeded, 'the seeder must have populated the cache');

    // A THIRD process does the invalidation, standing in for the admin editing a
    // product on one worker while shoppers are served by the others.
    await runOk(
      exiting(`
        const {invalidateCatalogueCache}=require('./utils/catalogueCache');
        await invalidateCatalogueCache();
      `),
      cacheEnv
    );

    const observer = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        const {RAIL_PREFIXES,railKey,CATEGORIES_KEY,CATALOGUE_TOTAL_KEY}
          =require('./utils/catalogueCache');
        const names=Object.keys(RAIL_PREFIXES);
        const rails={};
        for(const name of names){ rails[name]=await cache.get(railKey(name,'8')) ?? null; }
        ${emit(`{
          categories: await cache.get(CATEGORIES_KEY) ?? null,
          total: await cache.get(CATALOGUE_TOTAL_KEY) ?? null,
          rails,
        }`)}
      `),
      cacheEnv
    );

    assert.strictEqual(observer.json.categories, null, 'categories must be gone');
    assert.strictEqual(observer.json.total, null, 'the catalogue total must be gone');
    // Every rail the app actually renders, not a hand-written subset: a rail added
    // to catalogueCache later must be covered by this test automatically.
    assert.deepStrictEqual(Object.keys(observer.json.rails).sort(), seeded.json.rails.sort());
    assert.ok(seeded.json.rails.length >= 4, 'expected the four catalogue rails to be seeded');
    Object.entries(observer.json.rails).forEach(([name, value]) => {
      assert.strictEqual(value, null, `rail "${name}" survived an invalidation from another process`);
    });
  });

  await check('prefix deletion is scoped to its own rail', async () => {
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        await cache.set('featured:8','F',60000);
        await cache.set('bestdeals:8','D',60000);
        const removed=await cache.delByPrefix('featured:');
        ${emit(`{
          removed,
          featured: await cache.get('featured:8') ?? null,
          deals: await cache.get('bestdeals:8') ?? null,
        }`)}
      `),
      cacheEnv
    );
    assert.ok(r.json.removed >= 1, 'the scoped key must be removed');
    assert.strictEqual(r.json.featured, null);
    assert.strictEqual(
      r.json.deals,
      'D',
      'deleting one rail prefix must not take the others with it'
    );
  });

  await check('CACHE_FORCE_LOCAL bypasses Redis even when it is configured', async () => {
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        await cache.set('local-only',7,60000);
        const value = await cache.get('local-only');
        ${emit('{value,status:cache.status()}')}
      `),
      { ...cacheEnv, CACHE_FORCE_LOCAL: 'true' }
    );
    assert.strictEqual(r.json.value, 7);
    assert.strictEqual(r.json.status.backend, 'memory');
    assert.strictEqual(r.json.status.shared, false);
  });

  await check('an unreachable Redis makes the cache a miss, never a failure', async () => {
    // A cache must never be able to take a request down: Redis unreachable -> reads
    // miss -> the controller queries MongoDB, which is the correct answer.
    const env = await deadEnv();
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        await cache.set('unreachable',1,60000);
        ${emit(`{
          got: (await cache.get('unreachable')) ?? null,
          removed: await cache.delByPrefix('anything:'),
        }`)}
      `),
      env
    );
    assert.strictEqual(r.json.got, null, 'a failed read must look exactly like a miss');
    assert.strictEqual(r.json.removed, 0);
  });

  await check('every cache key stays inside the configured namespace', async () => {
    const r = await runOk(
      exiting(`
        const cache=require('./utils/sharedCache');
        const {buildStore}=require('./middleware/rateLimitStore');
        await cache.set('probe',1,60000);
        const store=buildStore('api');
        store.init({windowMs:60000,prefix:'rl:'});
        await store.increment('probe');
        const Redis=require('ioredis');
        const client=new Redis(process.env.REDIS_URL);
        ${emit('{keys:await client.keys(process.env.REDIS_KEY_PREFIX+"*")}')}
      `),
      cacheEnv
    );
    assert.ok(r.json.keys.length >= 2, 'the probe should have written keys');
    r.json.keys.forEach((key) => {
      assert.ok(key.startsWith(keyPrefix), `key "${key}" escaped the configured namespace`);
      assert.ok(
        !/hunter2|password|secret/i.test(key),
        `key "${key}" appears to contain a secret`
      );
    });
  });

  // --------------------------------------------------------- key hygiene ---
  section('Secret hygiene');

  await check('describe() never echoes Redis credentials', async () => {
    const r = await runOk(
      exiting(`
        const {describe}=require('./config/env');
        const text=JSON.stringify(describe());
        const hasSecret = text.includes('hunter2') || text.includes('someuser');
        ${emit('{hasSecret,config:describe()}')}
      `),
      { NODE_ENV: 'development', REDIS_URL: 'redis://someuser:hunter2@127.0.0.1:6379' }
    );
    assert.strictEqual(r.json.hasSecret, false, 'describe() is printed at boot, so it must be safe');
    assert.strictEqual(r.json.config.redis.host, 'redis://127.0.0.1:6379');
  });

  await check('redis.status() reports state without the target credentials', async () => {
    const r = await runOk(
      exiting(`
        const redis=require('./config/redis');
        ${emit('redis.status()')}
      `),
      {
        NODE_ENV: 'development',
        REDIS_URL: 'redis://someuser:hunter2@127.0.0.1:6379',
        REDIS_KEY_PREFIX: keyPrefix,
      }
    );
    assert.ok(!/hunter2/.test(JSON.stringify(r.json)), 'status() feeds /ready and must be safe');
    assert.strictEqual(r.json.configured, true);
  });

  await check('the cached-config summary reports the endpoint host only', async () => {
    const r = await runOk(
      exiting(`
        const {describe}=require('./config/env');
        ${emit('describe().redis')}
      `),
      { NODE_ENV: 'development', REDIS_URL: 'redis://someuser:hunter2@127.0.0.1:6379' }
    );
    assert.strictEqual(r.json.host, 'redis://127.0.0.1:6379');
    assert.strictEqual(r.json.source, 'REDIS_URL');
  });

  // ----------------------------------------------------------------- done ---
  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log(`${'-'.repeat(56)}\n`);

  cleanup();
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});