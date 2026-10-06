/**
 * Starts an ISOLATED, throwaway MongoDB for load testing and keeps it alive.
 *
 * Isolation is the whole point of this file:
 *
 *   - It is a `MongoMemoryReplSet`, so it binds to an ephemeral port, stores data
 *     in a temp directory and is destroyed on exit. It cannot reach, read or
 *     damage a production database - it does not even read `MONGO_URI`.
 *   - The database name is `anilkabadi_loadtest`, never the application name.
 *   - It uses the SAME database name convention as the app's own test suites, but
 *     a separate instance, so the two can never collide.
 *
 * Why a REPLICA SET rather than a standalone:
 *
 * `services/transactionRunner.js` uses real MongoDB transactions when the
 * deployment supports them and falls back to guarded atomic updates when it does
 * not. Order creation is one of the endpoints under test, and on a standalone the
 * app would silently take the fallback path - so the load test would be measuring
 * different code than production runs. A single-member replica set exercises the
 * transactional path that a real deployment uses.
 *
 * Why the cache is pinned small:
 *
 * WiredTiger defaults its cache to roughly half of system RAM. This host has a
 * modest amount of free memory and the load generator, the API process and the
 * data all compete for it, so the cache is pinned well below the default. A
 * smaller cache is less forgiving than production hardware, which is a limitation
 * recorded in the report rather than hidden.
 */

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const DB_NAME = 'anilkabadi_loadtest';
const URI_FILE = path.join(__dirname, '.loadtest-db-uri');
const DB_PATH = path.join(__dirname, '.loadtest-dbpath');

async function main() {
  // The data directory is set explicitly instead of letting mongodb-memory-server
  // pick os.tmpdir(). On this host /tmp is a 3.6 GB tmpfs, which is RAM-backed and
  // is also where the API's page cache and the load generator compete for space. A
  // default temporary directory filled the tmpfs during an earlier run and started
  // failing index builds with "available disk space ... less than the required
  // minimum". Putting the data on the real filesystem avoids both problems.
  // This directory is removed on shutdown and by the orchestrator on teardown.
  fs.rmSync(DB_PATH, { recursive: true, force: true });
  fs.mkdirSync(DB_PATH, { recursive: true });

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [
      {
        dbName: DB_NAME,
        dbPath: DB_PATH,
        args: [
          '--wiredTigerCacheSizeGB',
          process.env.LOADTEST_WT_CACHE_GB || '0.35',
          '--setParameter',
          'diagnosticDataCollectionEnabled=false',
        ],
      },
    ],
  });

  // `getUri()` returns something like `mongodb://127.0.0.1:PORT/?replicaSet=testset`.
  // The database name has to be spliced in BEFORE the query string - appending it
  // to the end produces `...?replicaSet=testsetanilkabadi_loadtest`, which is both
  // a different replica set name and an empty database.
  const baseUri = replSet.getUri();
  const qIndex = baseUri.indexOf('?');
  const uri = qIndex === -1
    ? `${baseUri.replace(/\/$/, '')}/${DB_NAME}`
    : `${baseUri.slice(0, qIndex).replace(/\/$/, '')}/${DB_NAME}${baseUri.slice(qIndex)}`;

  fs.writeFileSync(URI_FILE, uri, 'utf8');

  // The orchestrator waits for this exact line before doing anything else.
  process.stdout.write(`__LOADTEST_DB_READY__${uri}\n`);

  const shutdown = async () => {
    try {
      await replSet.stop();
    } catch {
      // best effort
    }
    for (const f of [URI_FILE, DB_PATH]) {
      try {
        fs.rmSync(f, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  process.stderr.write(`[loadtest-db] ${error.stack}\n`);
  process.exit(1);
});