/**
 * Shiprocket configuration.
 *
 * All credentials stay on the server. Nothing in this module is ever returned
 * through an API response or written to a log.
 *
 * `SHIPROCKET_SHIPPING_MODE` decides whether live Shiprocket rates replace the
 * store's flat delivery fee at checkout:
 *
 *   auto     (default) use Shiprocket when it is fully configured, otherwise
 *                       fall back to the existing Settings-based fee. This keeps
 *                       development and the existing test suite working without
 *                       credentials.
 *   shiprocket           always use Shiprocket rates. If Shiprocket cannot quote,
 *                       the quote is unavailable and the caller falls back to the
 *                       Settings fee (checkout must never be blocked by an
 *                       optional carrier outage).
 *   settings             never call Shiprocket for pricing; the integration is
 *                       still available for shipment creation and tracking.
 */

const str = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
};

const num = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const SHIPROCKET_BASE_URL = str(
  process.env.SHIPROCKET_BASE_URL,
  'https://apiv2.shiprocket.in/v1/external'
).replace(/\/+$/, '');

const SHIPROCKET_EMAIL = str(process.env.SHIPROCKET_EMAIL);
const SHIPROCKET_PASSWORD = str(process.env.SHIPROCKET_PASSWORD);
const SHIPROCKET_WEBHOOK_SECRET = str(process.env.SHIPROCKET_WEBHOOK_SECRET);

/** Registered warehouse name in the Shiprocket panel. */
const SHIPROCKET_PICKUP_LOCATION = str(process.env.SHIPROCKET_PICKUP_LOCATION);

/**
 * Origin postcode used for serviceability checks and rate quotes. This is the
 * pincode of the registered pickup location, NOT an assumed default.
 */
const SHIPROCKET_PICKUP_PINCODE = str(process.env.SHIPROCKET_PICKUP_PINCODE);

const SHIPROCKET_SHIPPING_MODE = str(
  process.env.SHIPROCKET_SHIPPING_MODE,
  'auto'
).toLowerCase();

/**
 * Package fallback used only for products that have no per-product shipping
 * measurements captured. These are deliberately conservative, configurable and
 * never presented as real product data.
 */
const SHIPROCKET_DEFAULT_WEIGHT_KG = num(
  process.env.SHIPROCKET_DEFAULT_WEIGHT_KG,
  0.5,
  { min: 0.01, max: 1000 }
);
const SHIPROCKET_DEFAULT_LENGTH_CM = num(
  process.env.SHIPROCKET_DEFAULT_LENGTH_CM,
  20,
  { min: 1, max: 1000 }
);
const SHIPROCKET_DEFAULT_BREADTH_CM = num(
  process.env.SHIPROCKET_DEFAULT_BREADTH_CM,
  15,
  { min: 1, max: 1000 }
);
const SHIPROCKET_DEFAULT_HEIGHT_CM = num(
  process.env.SHIPROCKET_DEFAULT_HEIGHT_CM,
  10,
  { min: 1, max: 1000 }
);

const SHIPROCKET_TOKEN_TTL_DAYS = num(
  process.env.SHIPROCKET_TOKEN_TTL_DAYS,
  9,
  { min: 1, max: 10 }
);

/** Refresh a cached token this many minutes before its local expiry. */
const SHIPROCKET_TOKEN_SKEW_MINUTES = num(
  process.env.SHIPROCKET_TOKEN_SKEW_MINUTES,
  60,
  { min: 0, max: 1440 }
);

const SHIPROCKET_REQUEST_TIMEOUT_MS = num(
  process.env.SHIPROCKET_REQUEST_TIMEOUT_MS,
  30000,
  { min: 1000, max: 120000 }
);

/** Rate quotes are short, non-mutating calls and should fail fast. */
const SHIPROCKET_RATE_TIMEOUT_MS = num(
  process.env.SHIPROCKET_RATE_TIMEOUT_MS,
  8000,
  { min: 1000, max: 30000 }
);

const SHIPROCKET_AUTO_ASSIGN_AWB = bool(
  process.env.SHIPROCKET_AUTO_ASSIGN_AWB,
  true
);
const SHIPROCKET_AUTO_GENERATE_LABEL = bool(
  process.env.SHIPROCKET_AUTO_GENERATE_LABEL,
  true
);
const SHIPROCKET_AUTO_REQUEST_PICKUP = bool(
  process.env.SHIPROCKET_AUTO_REQUEST_PICKUP,
  false
);

/** How long a claimed shipment creation is considered in-flight. */
const SHIPROCKET_CREATE_LOCK_MS = num(
  process.env.SHIPROCKET_CREATE_LOCK_MS,
  10 * 60 * 1000,
  { min: 30000, max: 60 * 60 * 1000 }
);

const isShiprocketConfigured = () =>
  Boolean(SHIPROCKET_EMAIL && SHIPROCKET_PASSWORD);

/** Whether live Shiprocket pricing may be used. */
const isShiprocketPricingEnabled = () =>
  SHIPROCKET_SHIPPING_MODE !== 'settings' &&
  isShiprocketConfigured() &&
  Boolean(SHIPROCKET_PICKUP_PINCODE);

/**
 * Whether Shiprocket can create a real shipment. A pickup location is required
 * because the adhoc order API rejects an order without a registered warehouse.
 */
const isShiprocketShipmentReady = () =>
  isShiprocketConfigured() && Boolean(SHIPROCKET_PICKUP_LOCATION);

module.exports = {
  SHIPROCKET_BASE_URL,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  SHIPROCKET_WEBHOOK_SECRET,
  SHIPROCKET_PICKUP_LOCATION,
  SHIPROCKET_PICKUP_PINCODE,
  SHIPROCKET_SHIPPING_MODE,
  SHIPROCKET_DEFAULT_WEIGHT_KG,
  SHIPROCKET_DEFAULT_LENGTH_CM,
  SHIPROCKET_DEFAULT_BREADTH_CM,
  SHIPROCKET_DEFAULT_HEIGHT_CM,
  SHIPROCKET_TOKEN_TTL_DAYS,
  SHIPROCKET_TOKEN_SKEW_MINUTES,
  SHIPROCKET_REQUEST_TIMEOUT_MS,
  SHIPROCKET_RATE_TIMEOUT_MS,
  SHIPROCKET_AUTO_ASSIGN_AWB,
  SHIPROCKET_AUTO_GENERATE_LABEL,
  SHIPROCKET_AUTO_REQUEST_PICKUP,
  SHIPROCKET_CREATE_LOCK_MS,
  isShiprocketConfigured,
  isShiprocketPricingEnabled,
  isShiprocketShipmentReady,
};
