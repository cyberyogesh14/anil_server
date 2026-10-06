const crypto = require('crypto');
const {
  getRazorpay,
  getKeyId,
  getKeySecret,
  getWebhookSecret,
  isConfigured,
} = require('../config/razorpay');

const MAX_AMOUNT_PAISE = 100 * 100 * 100 * 100;

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

/** Converts a rupee amount (possibly fractional) into integer INR paise. */
const toPaise = (amountInRupees) => {
  const paise = Math.round(Number(amountInRupees) * 100);
  if (!Number.isFinite(paise) || paise <= 0) {
    throw new Error('Payment amount must be a positive value');
  }
  if (paise > MAX_AMOUNT_PAISE) {
    throw new Error('Payment amount is too large');
  }
  return paise;
};

/**
 * Creates a Razorpay order. The amount is always passed in by the caller using
 * backend-calculated figures - it is never derived from client input.
 */
const createRazorpayOrder = async ({
  amountInRupees,
  receipt,
  notes = {},
  expiresAt,
}) => {
  const razorpay = getRazorpay();
  const amount = toPaise(amountInRupees);

  const payload = {
    amount,
    currency: 'INR',
    receipt: String(receipt).slice(0, 40),
  };

  if (expiresAt) {
    payload.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
  }

  const safeNotes = {};
  for (const [key, value] of Object.entries(notes)) {
    if (value === undefined || value === null || value === '') continue;
    safeNotes[String(key).slice(0, 40)] = String(value).slice(0, 255);
  }
  if (Object.keys(safeNotes).length) {
    payload.notes = safeNotes;
  }

  const order = await razorpay.orders.create(payload);

  return {
    razorpayOrderId: order.id,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    keyId: getKeyId(),
  };
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
