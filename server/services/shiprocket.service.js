const axios = require('axios');

const {
  SHIPROCKET_BASE_URL,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  SHIPROCKET_REQUEST_TIMEOUT_MS,
  SHIPROCKET_RATE_TIMEOUT_MS,
  SHIPROCKET_TOKEN_TTL_DAYS,
  SHIPROCKET_TOKEN_SKEW_MINUTES,
  isShiprocketConfigured,
} = require('../config/shiprocket');

const api = axios.create({
  baseURL: SHIPROCKET_BASE_URL,
  timeout: SHIPROCKET_REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/**
 * The HTTP transport used for every Shiprocket call.
 *
 * Kept behind a variable so the automated test harness can inject a fake
 * transport and prove the integration without touching the real Shiprocket
 * account. Production always uses the axios instance above; the setter refuses
 * to run outside NODE_ENV=test.
 */
let transport = api;

const setTransportForTests = (fakeTransport) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Shiprocket transport can only be replaced in tests');
  }
  transport = fakeTransport;
};

// Shiprocket tokens are valid for 240 hours (10 days). Keep a slightly shorter
// local cache and refresh once more if the API rejects the token early.
let cachedToken = null;
let tokenExpiresAt = 0;
let authenticationPromise = null;

const resetAuthForTests = () => {
  if (process.env.NODE_ENV !== 'test') return;
  cachedToken = null;
  tokenExpiresAt = 0;
  authenticationPromise = null;
};

const tokenLifetimeMs = () => {
  const ttlMs = SHIPROCKET_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const skewMs = SHIPROCKET_TOKEN_SKEW_MINUTES * 60 * 1000;
  return Math.max(60 * 1000, ttlMs - skewMs);
};

const getShiprocketToken = async (forceRefresh = false) => {
  if (!isShiprocketConfigured()) {
    const error = new Error(
      'Shiprocket is not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD.'
    );
    error.statusCode = 503;
    error.code = 'SHIPROCKET_NOT_CONFIGURED';
    throw error;
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  // Avoid multiple simultaneous login requests.
  if (authenticationPromise) {
    return authenticationPromise;
  }

  authenticationPromise = (async () => {
    try {
      const response = await transport.post(
        `${SHIPROCKET_BASE_URL}/auth/login`,
        {
          email: SHIPROCKET_EMAIL,
          password: SHIPROCKET_PASSWORD,
        },
        {
          timeout: SHIPROCKET_REQUEST_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const token = response.data?.token;

      if (!token) {
        const error = new Error(
          'Shiprocket authentication did not return a token'
        );
        error.statusCode = 502;
        error.code = 'SHIPROCKET_AUTH_FAILED';
        throw error;
      }

      cachedToken = token;
      tokenExpiresAt = Date.now() + tokenLifetimeMs();

      return cachedToken;
    } catch (error) {
      cachedToken = null;
      tokenExpiresAt = 0;

      if (error.code === 'SHIPROCKET_AUTH_FAILED') throw error;

      const authError = new Error(
        error.response?.data?.message ||
          error.message ||
          'Shiprocket authentication failed'
      );
      authError.statusCode = error.response?.status === 401 ? 502 : 502;
      authError.code = 'SHIPROCKET_AUTH_FAILED';
      throw authError;
    } finally {
      authenticationPromise = null;
    }
  })();

  return authenticationPromise;
};

const normalizeError = (error) => {
  const status = Number(error.response?.status) || Number(error.statusCode) || 502;
  const message =
    error.response?.data?.message ||
    error.response?.data?.errors?.message ||
    error.response?.data?.error ||
    error.message ||
    'Shiprocket API request failed';

  const normalized = new Error(String(message).slice(0, 500));
  normalized.statusCode = status >= 400 && status < 600 ? status : 502;
  normalized.code = error.response?.data?.code || error.code || 'SHIPROCKET_ERROR';
  // The raw response is kept for server-side diagnostics only. Controllers never
  // forward it directly; they return a safe message.
  normalized.details = error.response?.data || null;
  normalized.isShiprocketError = true;
  return normalized;
};

const shiprocketRequest = async ({
  method = 'GET',
  endpoint,
  data,
  params,
  timeout,
}) => {
  let token = await getShiprocketToken();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await transport.request({
        method,
        url: endpoint,
        data,
        params,
        timeout: timeout || SHIPROCKET_REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error) {
      const status = Number(error.response?.status);

      // Refresh the token once if Shiprocket rejects it. This covers a token
      // revoked in the panel before our local TTL ran out.
      if (status === 401 && attempt === 0) {
        cachedToken = null;
        tokenExpiresAt = 0;
        token = await getShiprocketToken(true);
        continue;
      }

      throw normalizeError(error);
    }
  }

  const error = new Error('Shiprocket request failed after retry');
  error.statusCode = 502;
  error.code = 'SHIPROCKET_RETRY_EXHAUSTED';
  throw error;
};

/* ========================================================================== *
 * Shipping serviceability / rates
 * ========================================================================== */

const checkServiceability = ({
  pickupPostcode,
  deliveryPostcode,
  weight,
  cod = false,
  declaredValue,
}) =>
  shiprocketRequest({
    method: 'GET',
    endpoint: '/courier/serviceability/',
    timeout: SHIPROCKET_RATE_TIMEOUT_MS,
    params: {
      pickup_postcode: pickupPostcode,
      delivery_postcode: deliveryPostcode,
      // Shiprocket expects 1/0.
      cod: cod ? 1 : 0,
      weight,
      ...(declaredValue !== undefined && declaredValue !== null
        ? { declared_value: declaredValue }
        : {}),
    },
  });

/* ========================================================================== *
 * Orders / shipments
 * ========================================================================== */

const createAdhocOrder = (payload) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/orders/create/adhoc',
    data: payload,
  });

const getOrder = (shiprocketOrderId) =>
  shiprocketRequest({
    method: 'GET',
    endpoint: `/orders/show/${encodeURIComponent(shiprocketOrderId)}`,
  });

const assignAWB = ({ shipmentId, courierId }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/courier/assign/awb',
    data: {
      shipment_id: Number(shipmentId) || shipmentId,
      ...(courierId ? { courier_id: Number(courierId) || courierId } : {}),
    },
  });

const generateLabel = ({ shipmentIds }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/courier/generate/label',
    data: { shipment_id: shipmentIds },
  });

const generateManifest = ({ shipmentIds }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/manifests/generate',
    data: { shipment_id: shipmentIds },
  });

const requestPickup = ({ shipmentIds }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/courier/generate/pickup',
    data: { shipment_id: shipmentIds },
  });

const cancelOrder = ({ shiprocketOrderIds }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/orders/cancel',
    data: { ids: shiprocketOrderIds },
  });

const cancelShipmentsByAWB = ({ awbs }) =>
  shiprocketRequest({
    method: 'POST',
    endpoint: '/orders/cancel/shipment/awbs',
    data: { awbs },
  });

/* ========================================================================== *
 * Tracking
 * ========================================================================== */

const trackByAWB = (awbCode) =>
  shiprocketRequest({
    method: 'GET',
    endpoint: `/courier/track/awb/${encodeURIComponent(awbCode)}`,
  });

const trackByShipmentId = (shipmentId) =>
  shiprocketRequest({
    method: 'GET',
    endpoint: `/courier/track/shipment/${encodeURIComponent(shipmentId)}`,
  });

/* ========================================================================== *
 * Diagnostics
 * ========================================================================== */

const getPickupLocations = () =>
  shiprocketRequest({
    method: 'GET',
    endpoint: '/settings/company/pickup',
  });

const testShiprocketConnection = async () => {
  const token = await getShiprocketToken();

  return {
    success: Boolean(token),
    message: 'Shiprocket authentication successful',
  };
};

module.exports = {
  getShiprocketToken,
  shiprocketRequest,
  testShiprocketConnection,
  checkServiceability,
  createAdhocOrder,
  getOrder,
  assignAWB,
  generateLabel,
  generateManifest,
  requestPickup,
  cancelOrder,
  cancelShipmentsByAWB,
  trackByAWB,
  trackByShipmentId,
  getPickupLocations,
  // Test-only hooks. Both refuse to run outside NODE_ENV=test.
  setTransportForTests,
  resetAuthForTests,
};
