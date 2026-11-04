const Razorpay = require('razorpay');

let instance = null;

const getKeyId = () => (process.env.RAZORPAY_KEY_ID || '').trim();
const getKeySecret = () => (process.env.RAZORPAY_KEY_SECRET || '').trim();
const getWebhookSecret = () => (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();

const isConfigured = () => Boolean(getKeyId() && getKeySecret());

/** Reports which Razorpay environment the configured key id belongs to. */
const getKeyMode = () => {
  const keyId = getKeyId();
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return keyId ? 'unknown' : 'unconfigured';
};

/**
 * The key id is safe to log in an abbreviated form (it is public), but the
 * secret must never appear in logs. This helper is the only place the id is
 * shortened, so diagnostics cannot accidentally print the full value.
 */
const getKeyIdHint = () => {
  const keyId = getKeyId();
  if (!keyId) return '(missing)';
  return `${keyId.slice(0, 9)}...${keyId.slice(-4)}`;
};

const CREDENTIAL_CHECK_TTL_MS = 5 * 60 * 1000;

let credentialState = 'unverified';
let credentialHttpStatus = 0;
let credentialErrorCode = '';
let credentialCheckedAt = null;
let credentialCheckedAtMs = 0;
let credentialCheckInFlight = null;

const redactSecret = (value) => {
  const secret = getKeySecret();
  const text = String(value || '');
  return secret ? text.split(secret).join('[redacted]') : text;
};

const credentialMessage = (state) => {
  switch (state) {
    case 'verified':
      return 'Online payments are available';
    case 'auth_failed':
      return 'The configured Razorpay credentials were rejected by Razorpay';
    case 'unavailable':
      return 'Razorpay could not be reached; online payments are temporarily unavailable';
    case 'checking':
      return 'Checking Razorpay availability';
    case 'unconfigured':
      return 'Razorpay credentials are not configured';
    default:
      return 'Razorpay availability has not been verified yet';
  }
};

/**
 * Safe, public status for the checkout UI. `available` is only true after the
 * configured key pair has actually authenticated against Razorpay - merely
 * having two non-empty environment variables is not enough.
 */
const getCredentialStatus = () => {
  const configured = isConfigured();
  const state = configured ? credentialState : 'unconfigured';

  return {
    configured,
    available: state === 'verified',
    state,
    mode: getKeyMode(),
    keyIdHint: getKeyIdHint(),
    httpStatus: credentialHttpStatus,
    errorCode: credentialErrorCode,
    checkedAt: credentialCheckedAt,
    message: credentialMessage(state),
  };
};

/**
 * Verifies the key pair once with a lightweight authenticated API call, then
 * caches the result. This deliberately uses `orders.all` (a read) rather than
 * creating a real order, and is not called on every page load.
 */
const validateRazorpayCredentials = async ({ force = false } = {}) => {
  if (!isConfigured()) {
    return getCredentialStatus();
  }

  if (credentialCheckInFlight) {
    return credentialCheckInFlight;
  }

  const cacheIsFresh =
    credentialCheckedAtMs > 0 &&
    Date.now() - credentialCheckedAtMs < CREDENTIAL_CHECK_TTL_MS;

  if (!force && cacheIsFresh) {
    return getCredentialStatus();
  }

  credentialCheckInFlight = (async () => {
    credentialState = 'checking';

    try {
      await getRazorpay().orders.all({ count: 1 });
      credentialState = 'verified';
      credentialHttpStatus = 200;
      credentialErrorCode = '';
      credentialCheckedAt = new Date().toISOString();
      console.log(
        `[razorpay] credential check succeeded (mode=${getKeyMode()}, key=${getKeyIdHint()})`
      );
    } catch (error) {
      const statusCode =
        Number(error?.statusCode) || Number(error?.response?.status) || 0;
      const details = error?.error || error?.response?.data?.error || {};
      const description = redactSecret(
        details.description || error?.message || 'Razorpay credential check failed'
      );
      const code = details.code || error?.code || 'RAZORPAY_ERROR';
      const authFailed =
        statusCode === 401 ||
        statusCode === 403 ||
        /authentication failed|invalid api key|unauthorized/i.test(description);

      credentialState = authFailed ? 'auth_failed' : 'unavailable';
      credentialHttpStatus = statusCode;
      credentialErrorCode = code;
      credentialCheckedAt = new Date().toISOString();

      const authHint = authFailed
        ? ' Check that RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are a matching pair from the same Razorpay mode (test/live); the key may also be expired or revoked.'
        : '';

      console.error(
        '[razorpay] credential check failed ' +
          `(mode=${getKeyMode()}, key=${getKeyIdHint()}, ` +
          `httpStatus=${statusCode || 'n/a'}, code=${code}): ${description}${authHint}`
      );
    } finally {
      credentialCheckedAtMs = Date.now();
      if (!credentialCheckedAt) {
        credentialCheckedAt = new Date().toISOString();
      }
      credentialCheckInFlight = null;
    }

    return getCredentialStatus();
  })();

  return credentialCheckInFlight;
};

/**
 * Lazily builds the single shared Razorpay instance. The key secret stays on
 * the server and is never attached to any API response.
 */
const getRazorpay = () => {
  if (instance) {
    return instance;
  }

  if (!isConfigured()) {
    const error = new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env'
    );
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }

  instance = new Razorpay({
    key_id: getKeyId(),
    key_secret: getKeySecret(),
  });

  return instance;
};

const configureRazorpay = () => {
  if (!isConfigured()) {
    console.warn(
      'Razorpay not configured - online payments are disabled. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'
    );
    return;
  }

  try {
    getRazorpay();
    console.log(
      `Razorpay configuration loaded (mode ${getKeyMode()}, key ${getKeyIdHint()}${
        getWebhookSecret() ? ', webhooks on' : ', webhooks off'
      }); validating credentials in the background`
    );

    if (getKeyMode() === 'unknown') {
      console.warn(
        'Razorpay key id does not start with rzp_test_ or rzp_live_. ' +
          'Check that the key was copied correctly from the Razorpay dashboard.'
      );
    }

    // Warm the cached credential status once at boot. Failures are handled
    // inside the function and must never prevent the server from starting.
    // Tests opt in explicitly via the status endpoint so the suite never makes
    // real gateway calls just because a developer's .env has live keys.
    if (process.env.NODE_ENV !== 'test') {
      validateRazorpayCredentials();
    }
  } catch (error) {
    console.error(`Razorpay initialisation failed: ${error.message}`);
  }
};

module.exports = {
  getRazorpay,
  getKeyId,
  getKeySecret,
  getWebhookSecret,
  getKeyMode,
  getKeyIdHint,
  isConfigured,
  configureRazorpay,
  validateRazorpayCredentials,
  getCredentialStatus,
};
