#!/usr/bin/env node
/**
 * Emergency cleanup for an interrupted load-test run.
 *
 * The normal path is that `run.js` tears everything down itself on exit, including
 * on SIGINT/SIGTERM. This script exists for the case where the process was killed
 * hard (SIGKILL, power loss, a container restart) and left a mongod holding the
 * disposable replica set plus its data directory behind. Those leftovers hold file
 * handles and consume a few hundred megabytes each, which on a shared host is the
 * difference between a load test that runs and one that fails to start.
 *
 * SAFETY: this script is deliberately paranoid. It only ever considers a mongod
 * whose command line mentions the load-test marker, so the real database is out of
 * reach by construction. It never matches on port alone, because the real database
 * also listens on a port.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HERE = __dirname;

// Both of these are the load test's own. The real database lives outside this
// directory and is never named by either, which is what makes the matching safe.
const LOADTEST_MARKERS = ['scripts/loadtest/.loadtest-dbpath', '.loadtest-dbpath'];
const REAL_DB_MARKERS = ['anilkabadi-mongo'];

const isRealDatabase = (cmdline) => REAL_DB_MARKERS.some((m) => cmdline.includes(m));

const log = (msg) => process.stdout.write(`[teardown] ${msg}\n`);

const listMongodProcesses = () => {
  let output = '';
  try {
    output = execSync('ps -eo pid,args', { encoding: 'utf8' });
  } catch {
    log('could not read the process list; skipping process cleanup');
    return [];
  }

  const found = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2];
    if (!/\bmongod\b/.test(args)) continue;
    if (isRealDatabase(args)) continue;
    if (!LOADTEST_MARKERS.some((m) => args.includes(m))) continue;
    found.push({ pid, args: args.slice(0, 160) });
  }
  return found;
};

const killLoadTestMongods = () => {
  const processes = listMongodProcesses();
  if (!processes.length) {
    log('no leftover load-test mongod processes');
    return;
  }
  for (const { pid, args } of processes) {
    try {
      process.kill(pid, 'SIGKILL');
      log(`killed pid ${pid}: ${args}`);
    } catch (err) {
      log(`could not kill pid ${pid}: ${err.message}`);
    }
  }
};

// Stale replica-set directories from runs that used the system temp directory. Older
// revisions of db.js put the data path there; current runs keep it beside this script.
const removeOrphanTempDirs = () => {
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('mongo-mem-')) continue;
    const full = path.join(tmp, name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isDirectory()) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* a directory still held open by a surviving process; the kill above is what
         actually frees it, so a failure here is not itself a problem */
    }
  }
  log(removed ? `removed ${removed} stale ${tmp}/mongo-mem-* director${removed === 1 ? 'y' : 'ies'}` : 'no stale temp replica-set directories');
};

const removeLocalArtefacts = () => {
  const targets = ['.loadtest-dbpath', '.loadtest-db-uri', '.loadtest-tokens.json', '.loadtest-raw.json'];
  for (const name of targets) {
    const full = path.join(HERE, name);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      log(`removed ${name}`);
    } catch (err) {
      log(`could not remove ${name}: ${err.message}`);
    }
  }
  // .loadtest-results.json is deliberately kept: it is the evidence the report cites.
};

const warnIfRealDatabaseUnaffected = () => {
  let output = '';
  try {
    output = execSync('ps -eo pid,args', { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of output.split('\n')) {
    if (!/\bmongod\b/.test(line)) continue;
    if (!isRealDatabase(line)) continue;
    const pid = line.trim().split(/\s+/)[0];
    log(`real database left untouched (pid ${pid})`);
    return;
  }
  log('no real database process was running');
};

killLoadTestMongods();
removeOrphanTempDirs();
removeLocalArtefacts();
warnIfRealDatabaseUnaffected();
log('done');