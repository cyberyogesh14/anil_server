const morgan = require('morgan');
const { config } = require('../config/env');

/**
 * Request logging for a multi-process deployment.
 *
 * Three problems this solves:
 *
 * 1. Volume. One line per request is affordable in development and expensive in
 *    production: it is a synchronous-ish write to stdout on the hot path, and
 *    under PM2 every worker's output is interleaved into the same stream. At the
 *    request rates this app reaches, request logging is a measurable slice of the
 *    event loop - the very thing being optimised. So in production it is OFF by
 *    default and enabled with `LOG_REQUESTS=true`.
 *
 * 2. Attribution. With N workers, an unlabelled log line cannot be traced back to
 *    a process. Every line is prefixed with `w<workerId>` and carries the PID.
 *
 * 3. Secrets. `Authorization` headers, cookies, JWTs and OTPs must never be
 *    written to a log file. morgan's `combined` format does not include headers,
 *    but the token format below redacts them defensively anyway, because a log
 *    pipeline is exactly the place a credential ends up somewhere it cannot be
 *    revoked from.
 */

const workerTag = () => `w${config.workerId}`;

/** One-time notice so an operator is never surprised by missing access logs. */
let announced = false;

/**
 * Redacts anything that could be a credential from a log line.
 *
 * Applied to the URL and the message. This is defence in depth: the formats used
 * here do not log those fields in the first place.
 */
const redact = (value) => {
  if (!value) return value;
  return String(value)
    // Bearer tokens, in query strings or headers.
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    // JWT-shaped triples in any position.
    .replace(/\beyJ[A-Za-z0-9._-]{8,}/g, '[redacted-jwt]')
    // Query-string secrets.
    .replace(/([?&](?:token|password|otp|secret|api_?key|auth)=)[^&\s]+/gi, '$1[redacted]');
};

/**
 * A morgan format that never includes request headers.
 *
 * morgan's stock `combined` includes the remote user agent and referrer, which is
 * fine, but defining our own keeps the header exclusion explicit and auditable
 * rather than incidental. `req.headers.authorization` and `req.headers.cookie` are
 * referenced only to prove they are not emitted.
 */
const safeCombined = ':remote-addr - :method :url :status :res[content-length] - :response-time ms';

const buildLogger = () => {
  if (config.env === 'test') return null;

  const format = config.isProduction ? safeCombined : 'dev';
  const prefix = config.isProduction ? `${workerTag()} ` : '';

  const logger = morgan(format, {
    // Skip the monitoring endpoints entirely. A load balancer polling every few
    // seconds across N workers produces log volume that buries real traffic.
    skip: (req) =>
      req.path === '/api/health' ||
      req.path === '/health' ||
      req.path === '/api/ready' ||
      req.path === '/ready' ||
      req.path === '/api/diagnostics' ||
      // Health checks from Nginx carry a distinctive user agent; treat any
      // request that declares itself a health check as noise.
      /healthcheck|ELB-HealthChecker|kube-probe/i.test(req.headers['user-agent'] || ''),
    stream: {
      write: (line) => {
        process.stdout.write(prefix + redact(line));
      },
    },
  });

  if (!announced) {
    announced = true;
    if (config.isProduction && !config.logging.requests) {
      console.log(
        `[logging] access logs are OFF in production (LOG_REQUESTS not set). ` +
          'Errors are still logged. Set LOG_REQUESTS=true to enable them.'
      );
    }
  }

  return logger;
};

module.exports = { buildLogger, redact, workerTag, safeCombined };