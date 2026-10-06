const express = require('express');
const {
  createRazorpayOrder,
  verifyRazorpayPayment,
  handleRazorpayWebhook,
} = require('../controllers/paymentController');
const protect = require('../middleware/authMiddleware');
const { paymentLimiter } = require('../middleware/rateLimitMiddleware');

const router = express.Router();

/**
 * The webhook authenticates with its own HMAC signature rather than a user
 * JWT, and must see the untouched request bytes. It is therefore mounted on its
 * own router in server.js *before* express.json() runs, with express.raw()
 * providing the raw buffer. Never add `protect` or JSON parsing to it.
 */
const webhookRouter = express.Router();
webhookRouter.post(
  '/webhook',
  paymentLimiter,
  express.raw({ type: '*/*', limit: '1mb' }),
  handleRazorpayWebhook
);

router.post('/razorpay/create-order', protect, paymentLimiter, createRazorpayOrder);
router.post('/razorpay/verify', protect, paymentLimiter, verifyRazorpayPayment);

module.exports = router;
module.exports.webhookRouter = webhookRouter;
