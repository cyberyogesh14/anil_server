const crypto = require('crypto');
const {
  getRazorpay,
  getKeyId,
  getKeySecret,
  getWebhookSecret,
  getKeyMode,
  getKeyIdHint,
  isConfigured,
} = require('../config/razorpay');

const MAX_AMOUNT_PAISE = 100 * 100 * 100 * 100;
const MIN_AMOUNT_PAISE = 100;

/**
 * Constant-time string comparison. `timingSafeEqual` throws when buffer
 * lengths differ, so a length mismatch is compared against a same-length dummy
 * buffer first to keep the timing profile flat.
 */
const safeCompare = (a = '', b = '') => {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
};

const hmacSha256 = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

const amountError = (message) => {
  const error = new Error(message);
  error.code = 'INVALID_PAYMENT_AMOUNT';
  error.statusCode = 400;
  return error;
};

/** Converts a rupee amount (possibly fractional) into integer INR paise. */
const toPaise = (amountInRupees) => {
  const amount = Number(amountInRupees);
  const paise = Math.round(amount * 100);

  if (!Number.isFinite(amount) || !Number.isFinite(paise) || paise < MIN_AMOUNT_PAISE) {
    throw amountError('Payment amount must be at least INR 1.00');
  }
  if (!Number.isSafeInteger(paise)) {
    throw amountError('Payment amount must be a whole number of paise');
  }
  if (paise > MAX_AMOUNT_PAISE) {
    throw amountError('Payment amount is too large');
  }
  return paise;
};

const redact = (value) => {
  let text = String(value || '');
  const secret = getKeySecret();
  if (secret) text = text.split(secret).join('[redacted]');
  return text;
};

/**
 * The Razorpay Node SDK rejects with a plain object (`{ statusCode, error }`)
 * rather than an Error, so a normal `error.message` lookup produces `undefined`
 * and the controller had no way to tell a credentials problem from a transient
 * outage. This converts it into a typed Error carrying only the diagnostic
 * fields that are safe to log.
 */
const normalizeRazorpayError = (error) => {
  const statusCode =
    Number(error?.statusCode) || Number(error?.response?.status) || 0;
  const details =
    error?.error || error?.response?.data?.error || error?.response?.data || {};
  const description = redact(
    details.description || error?.message || 'Razorpay request failed'
  );
  const code = details.code || error?.code || 'RAZORPAY_ERROR';
  const isAuthError =
    statusCode === 401 ||
    statusCode === 403 ||
    /authentication failed|invalid api key|unauthorized/i.test(description);

  const normalized = new Error(description);
  normalized.name = 'RazorpayAPIError';
  normalized.code = code;
  normalized.statusCode = statusCode;
  normalized.razorpayStatus = statusCode;
  normalized.razorpayReason = details.reason || '';
  normalized.razorpayField = details.field || '';
  normalized.isRazorpayError = true;
  normalized.isAuthError = isAuthError;
  return normalized;
};

/**
 * Creates a Razorpay order. The amount is always passed in by the caller using
 * backend-calculated figures - it is never derived from client input.
 */
const createRazorpayOrder = async ({
  amountInRupees,
  receipt,
  notes = {},
}) => {
  const razorpay = getRazorpay();
  const amount = toPaise(amountInRupees);

  const payload = {
    amount,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
  };

  const safeNotes = {};
  for (const [key, value] of Object.entries(notes)) {
    if (value === undefined || value === null || value === '') continue;
    safeNotes[String(key).slice(0, 40)] = String(value).slice(0, 255);
  }
  if (Object.keys(safeNotes).length) {
    payload.notes = safeNotes;
  }

  try {
    const order = await razorpay.orders.create(payload);

    if (!order || !order.id) {
      const error = new Error('Razorpay returned an order without an id');
      error.code = 'RAZORPAY_INVALID_RESPONSE';
      error.statusCode = 502;
      error.isRazorpayError = true;
      throw error;
    }

    return {
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      keyId: getKeyId(),
    };
  } catch (error) {
    const normalized = error.isRazorpayError
      ? error
      : normalizeRazorpayError(error);

    // Safe diagnostics only: no key secret, request headers, notes or payment
    // instrument data are ever logged. The key id is public and abbreviated.
    const authHint = normalized.isAuthError
      ? ' Check that RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are a matching pair from the same Razorpay mode (test/live); the key may also be expired or revoked.'
      : '';

    console.error(
      '[razorpay] orders.create failed ' +
        `(mode=${getKeyMode()}, key=${getKeyIdHint()}, ` +
        `httpStatus=${normalized.razorpayStatus || 'n/a'}, ` +
        `code=${normalized.code}, field=${normalized.razorpayField || 'n/a'}, ` +
        `amountPaise=${amount}, currency=INR): ${normalized.message}${authHint}`
    );

    throw normalized;
  }
};

/**
 * Verifies the signature Razorpay returns to Checkout.js:
 * HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 */
const verifyPaymentSignature = ({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: signature,
}) => {
  if (!orderId || !paymentId || !signature) {
    return { valid: false, reason: 'Missing payment verification details' };
  }

  if (!isConfigured()) {
    return { valid: false, reason: 'Razorpay is not configured' };
  }

  const expected = hmacSha256(getKeySecret(), `${orderId}|${paymentId}`);

  if (!safeCompare(expected, signature)) {
    return { valid: false, reason: 'Payment signature verification failed' };
  }

  return { valid: true, reason: 'Signature verified' };
};

/**
 * Webhook signature: HMAC_SHA256(raw_request_body, webhook_secret).
 * `rawBody` must be the untouched request payload - any re-serialisation would
 * change the bytes and break the digest.
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!getWebhookSecret()) {
    return { valid: false, reason: 'Webhook secret is not configured' };
  }

  if (!signature || typeof rawBody !== 'string' || rawBody.length === 0) {
    return { valid: false, reason: 'Missing webhook signature or body' };
  }

  const expected = hmacSha256(getWebhookSecret(), rawBody);

  if (!safeCompare(expected, signature)) {
    return { valid: false, reason: 'Webhook signature verification failed' };
  }

  return { valid: true, reason: 'Webhook signature verified' };
};

/** Confirms with Razorpay that a payment was actually captured server-side. */
const fetchPayment = async (paymentId) => {
  const razorpay = getRazorpay();
  return razorpay.payments.fetch(paymentId);
};

module.exports = {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
  toPaise,
  safeCompare,
  hmacSha256,
};
