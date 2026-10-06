# Load testing

Isolated performance/load harness for the AnilKabadi API. It measures the single
Node process on this host and reports where it saturates. Nothing here is imported
by the application, and nothing here runs against a real database.

## Safety

The harness owns its own world end to end:

- A disposable single-node `MongoMemoryReplSet`, database name `anilkabadi_loadtest`.
  The runner refuses to start unless the database name ends in `loadtest`.
- A throwaway JWT secret. Tokens are minted directly by the seeder, so the auth rate
  limiter is never in the measurement path.
- The API is launched with `MONGO_URI` and `JWT_SECRET` set explicitly in its
  environment, which takes precedence over anything in `.env`.
- Razorpay, Cloudinary and email variables are blanked, so checkout is COD-only and
  no external provider is reachable even by mistake.
- A dynamically chosen free port, so a dev server on `5002` and the real database on
  `27017` are never disturbed.
- Everything is torn down on exit, including on SIGINT/SIGTERM.

If a run is killed hard and leaves a replica set behind:

```bash
npm run loadtest:teardown
```

That only ever matches a mongod whose command line names this directory, so the real
database is out of reach by construction.

## Running

```bash
# Full progressive sweep, 20s steady state per level after a 5s warmup.
npm run loadtest

# Short sweep for a quick signal.
npm run loadtest:quick

# Only the write-heavy scenarios.
npm run loadtest:checkout
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--only=a,b` | Run only the named scenarios |
| `--levels=1,5,10` | Override the concurrency levels |
| `--seconds=20` | Steady-state measurement window |
| `--warmup=5` | Warmup window, discarded |
| `--size=full\|small` | Dataset size |
| `--port=NNNN` | Pin the API port instead of picking a free one |
| `--quick` | Short levels and windows |
| `--ratelimit=bypass\|production` | Which `apiLimiter` ceiling to run under (see below) |

Results are written to `.loadtest-results.json`; that file and every other generated
artefact are gitignored.

## Rate limiting

The API ships an `apiLimiter` of **100 requests per 15 minutes per IP**, plus much
tighter limiters on auth (20/15min), OTP (10), email (30) and payment (60). None of
them are disabled, bypassed or weakened anywhere in this harness.

`middleware/rateLimitMiddleware.js` already reads its ceiling from
`API_RATE_LIMIT_MAX`. That existing hook is what the harness uses, set only in the
test server's environment:

- `--ratelimit=bypass` (default) raises `API_RATE_LIMIT_MAX` so the limiter is not
  the thing under measurement. The shipped default of 100 is unchanged.
- `--ratelimit=production` pins it to exactly 100, and exists purely to *document*
  what that ceiling does to a load test.

Both modes record the effective ceiling in the results file, so a results file can
never be read without also stating which rate-limit configuration produced it.

The auth/OTP/email/payment limiters are never exercised in either mode, because no
scenario calls login, OTP, email or payment. Tokens are minted during seeding
instead, which is also how real traffic behaves: a user logs in once and then makes
many authenticated requests. `POST /api/auth/login` is therefore *not* load tested,
since at 20 requests per 15 minutes it would measure the limiter, not the
application.

## What it measures

Throughput, latency percentiles (p50/p95/p99, with p95 taken from the real HDR
histogram rather than a nearest-rank approximation), status-code distribution, and
error rate for each scenario and concurrency level.

Alongside those, per level:

- API resident memory and CPU from `/proc`, sampled across the window.
- MongoDB connection count against the configured pool size.
- MongoDB command latency percentiles and per-command averages, via a test-only
  command monitor keyed on `requestId`.
- Node event-loop delay and utilisation.

A run stops escalating concurrency when a limit is breached (see `LIMITS` in
`run.js`), then takes one extra "beyond saturation" measurement at the next level so
the report can show what overload actually looks like rather than stopping at the
edge of it.

## Interpreting a result

Event-loop utilisation, not process CPU, is the saturation signal. A Node process
routinely reports over 100% CPU while its main thread is still mostly idle, because
V8 background compilation and GC run on other cores. When event-loop utilisation
reaches ~0.9, only more CPU or more processes will raise throughput.

Stock validation in order creation is working as intended and will reject orders for
sold-out or inactive products. The seeder therefore builds carts and seeded orders
only from purchasable products, so the checkout scenarios measure checkout rather
than stock exhaustion. Both behaviours are correct; only the dataset needed to change.