const Razorpay = require('razorpay');

let instance = null;

const getKeyId = () => process.env.RAZORPAY_KEY_ID || '';
const getKeySecret = () => process.env.RAZORPAY_KEY_SECRET || '';
const getWebhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET || '';

const isConfigured = () => Boolean(getKeyId() && getKeySecret());

/**
 * Lazily builds the single shared Razorpay instance. The key secret stays on
 * the server and is never attached to any API response.
 */
const getRazorpay = () => {
  if (instance) {
    return instance;
  }

  if (!isConfigured()) {
    throw new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env'
    );
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
      `Razorpay online payments enabled (key ${getKeyId().slice(0, 6)}...${
        getWebhookSecret() ? ', webhooks on' : ', webhooks off'
      })`
    );
  } catch (error) {
    console.error(`Razorpay initialisation failed: ${error.message}`);
  }
};

module.exports = {
  getRazorpay,
  getKeyId,
  getKeySecret,
  getWebhookSecret,
  isConfigured,
  configureRazorpay,
};
