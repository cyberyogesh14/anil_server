/**
 * PM2 cluster configuration.
 *
 * Run from this directory (`server/`):
 *
 *   npm run pm2:start          start the API
 *   npm run pm2:reload         reload all workers with a rolling restart
 *   npm run pm2:stop           stop, keeping the process list
 *   npm run pm2:delete         stop and remove from the process list
 *   npm run pm2:logs           follow the logs
 *   npm run pm2:status         one-shot status
 *
 * Nothing here reads a secret. `pm2 start --env production` sets NODE_ENV, and
 * every other value - Mongo URI, Redis URL, JWT secret - is loaded by the app from
 * its own environment at boot. That is deliberate: a value baked into this file
 * would be committed, and PM2 dumps its process list to a readable file in
 * ~/.pm2, so anything placed here ends up on disk in plain text.
 *
 * Values below use `process.env` with defaults so the same file works for local
 * runs, and the process list reflects what the app was actually given.
 */

/** How many workers to run. Default matches a 4-vCPU Hostinger KVM plan. */
const instances = parseInt(process.env.PM2_INSTANCES, 10) || 4;

/**
 * PM2's cluster mode forks N processes and the kernel load-balances the listening
 * socket between them, so all workers share one port. Nginx therefore needs a
 * single upstream, not N.
 *
 * `PM2_INSTANCES` must agree with what the app reads to size its MongoDB pool:
 * `config/env.js` uses the same variable to divide MONGO_TOTAL_POOL_BUDGET. If the
 * two ever disagree, the connection maths is wrong - which is why this file and
 * that module both read PM2_INSTANCES rather than hardcoding a number.
 */
module.exports = {
  apps: [
    {
      name: 'anilkabadi-api',
      script: 'server.js',
      cwd: __dirname,

      /**
       * `instances: 'max'` would use every core on whatever host this is deployed
       * to. That is wrong here: this app is I/O bound on MongoDB and Redis, and
       * oversubscribing the vCPUs raises context-switching and memory pressure
       * without adding throughput. A fixed count is also what makes the pool maths
       * above checkable. Raise it deliberately, then re-check MONGO_TOTAL_POOL_BUDGET.
       */
      instances,

      /**
       * Cluster mode, so the OS balances connections across workers. Each worker
       * gets its own event loop, which is the entire point: the single event loop
       * was the measured bottleneck, not the CPU count.
       */
      exec_mode: 'cluster',

      /**
       * Restart on crash, with a backoff. `max_restarts` is bounded so a worker
       * that crashes immediately on boot - a bad config, an unreachable MongoDB -
       * eventually gives up instead of crash-looping forever and filling the disk
       * with logs. `min_uptime` means a process must stay up this long to count as
       * a successful start, which is what distinguishes a crash from a redeploy.
       */
      autorestart: true,
      max_restarts: 10,
      min_uptime: 20_000,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      /**
       * Graceful shutdown.
       *
       * `kill_timeout` must be LONGER than the app's SHUTDOWN_TIMEOUT_MS (30s
       * default), so the app drains its own in-flight requests and closes its
       * database connection itself instead of being killed mid-request. PM2 sends
       * SIGTERM, waits, then SIGKILL - so a kill_timeout that is too short turns
       * every reload into aborted checkouts.
       */
      kill_timeout: 40_000,

      /**
       * PM2 waits for the app to call `process.send('ready')` before considering a
       * worker up. Without it PM2 reports a worker as online the instant the
       * process exists, which is before the HTTP server is listening, so a reload
       * can send traffic to a worker that is not accepting connections yet.
       *
       * `listen_timeout` bounds how long that wait may take. It has to exceed
       * MongoDB's server-selection timeout, because the app connects to MongoDB
       * before it listens.
       */
      wait_ready: true,
      listen_timeout: 15_000,

      /**
       * A slow start needs a generous timeout here too, and it is the counterpart
       * to `min_uptime`: without it a cold start that takes longer than the default
       * 1.6s is treated as a failure.
       */
      startup_timeout: 30_000,

      /**
       * Worker stdout/stderr to PM2's own log files. `merge_logs: false` keeps
       * each worker's output in its own file, which matters when N workers write to
       * the same stream: interleaved lines from different processes are close to
       * useless when you are trying to work out which one threw.
       *
       * Note that PM2 writes to ~/.pm2/logs by default. On a small VPS, an
       * unrotated log is a slow disk-full outage; docs/NGINX_PM2_DEPLOYMENT.md
       * covers rotation.
       */
      merge_logs: false,
      time: false,

      /**
       * Node flags.
       *
       * No --max-old-space-size: the default heap cap is derived from system RAM,
       * and hard-coding it tends to be wrong on the small VPS this targets. If you
       * do set it, remember it applies PER WORKER, so 4 workers x 512MB is a 2GB
       * ceiling, not 512MB total.
       */
      node_args: [],

      env: {
        NODE_ENV: 'development',
      },

      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};