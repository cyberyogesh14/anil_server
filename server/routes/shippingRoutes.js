const express = require('express');
const {
  getConfig,
  getQuote,
  getOrderShipping,
  trackOrder,
  listShipments,
  getAdminOrderShipping,
  createShipment,
  assignAWB,
  generateLabel,
  generateManifest,
  requestPickup,
  cancelShipment,
  trackShipment,
  getPickupLocations,
  testConnection,
  handleWebhook,
} = require('../controllers/shippingController');
const protect = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const {
  shippingLimiter,
  shippingWebhookLimiter,
} = require('../middleware/rateLimitMiddleware');

const router = express.Router();

/**
 * The webhook authenticates with a shared secret/HMAC, not a user JWT, and must
 * read the raw request bytes. It is mounted on its own router in server.js
 * *before* express.json(), exactly like the Razorpay webhook. Never add
 * `protect` or JSON parsing here.
 */
const webhookRouter = express.Router();
webhookRouter.post(
  '/webhook',
  shippingWebhookLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  handleWebhook
);

// Public, non-sensitive capability flags for the checkout UI.
router.get('/config', getConfig);

router.use(protect);

router.post('/quote', shippingLimiter, getQuote);
router.get('/orders/:id', shippingLimiter, getOrderShipping);
router.get('/orders/:id/track', shippingLimiter, trackOrder);

// Staff + admin: shipping operations
const staff = requireRole('admin', 'staff');
router.get('/admin/shipments', shippingLimiter, staff, listShipments);
router.get('/admin/orders/:id', shippingLimiter, staff, getAdminOrderShipping);
router.post('/admin/orders/:id/create', shippingLimiter, staff, createShipment);
router.post('/admin/orders/:id/awb', shippingLimiter, staff, assignAWB);
router.post('/admin/orders/:id/label', shippingLimiter, staff, generateLabel);
router.post(
  '/admin/orders/:id/manifest',
  shippingLimiter,
  staff,
  generateManifest
);
router.post('/admin/orders/:id/pickup', shippingLimiter, staff, requestPickup);
router.post('/admin/orders/:id/cancel', shippingLimiter, staff, cancelShipment);
router.post('/admin/orders/:id/track', shippingLimiter, staff, trackShipment);
router.get(
  '/admin/pickup-locations',
  shippingLimiter,
  staff,
  getPickupLocations
);

// Admin only: credential and pickup configuration diagnostics.
router.get(
  '/admin/connection',
  shippingLimiter,
  requireRole('admin'),
  testConnection
);

module.exports = router;
module.exports.webhookRouter = webhookRouter;
