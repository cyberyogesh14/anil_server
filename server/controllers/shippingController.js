const crypto = require('crypto');
const mongoose = require('mongoose');

const Order = require('../models/Order');
const { ORDER_PUBLIC_FIELDS } = require('../models/Order');
const shippingService = require('../services/shipping.service');
const shiprocket = require('../services/shiprocket.service');
const ApiError = require('../services/ApiError');
const { buildOrderFromCart } = require('../services/pricingService');
const {
  SHIPROCKET_WEBHOOK_SECRET,
  SHIPROCKET_PICKUP_PINCODE,
  SHIPROCKET_PICKUP_LOCATION,
  isShiprocketConfigured,
  isShiprocketPricingEnabled,
  isShiprocketShipmentReady,
} = require('../config/shiprocket');

const sendError = (error, res, next) => {
  if (error && error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }
  return next(error);
};

const isStaff = (user) => ['admin', 'staff'].includes(user?.role);

const assertOrderAccess = async (orderId, user) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }

  const order = await Order.findById(orderId)
    .select('_id user orderNumber orderStatus paymentStatus paymentMethod shippingAddress shipping subtotal discount shippingFee gstAmount totalAmount createdAt')
    .lean();

  if (!order) throw new ApiError(404, 'Order not found');

  if (!isStaff(user) && String(order.user) !== String(user?._id)) {
    throw new ApiError(403, 'Not authorized to view this order');
  }

  return order;
};

const isValidPincode = (value) => /^\d{6}$/.test(String(value || '').trim());

/* ========================================================================== *
 * Public / customer
 * ========================================================================== */

exports.getConfig = (req, res) => {
  res.json({
    success: true,
    data: {
      provider: 'shiprocket',
      configured: isShiprocketConfigured(),
      pricingEnabled: isShiprocketPricingEnabled(),
      shipmentReady: isShiprocketShipmentReady(),
      pickupPincodeConfigured: Boolean(SHIPROCKET_PICKUP_PINCODE),
      pickupLocationConfigured: Boolean(SHIPROCKET_PICKUP_LOCATION),
    },
  });
};

/**
 * POST /api/shipping/quote
 *
 * Rates the caller's own server-side cart for a delivery pincode. The client
 * sends only a pincode and a payment method: prices, weights and item totals all
 * come from MongoDB. If Shiprocket cannot quote, the response still contains the
 * Settings-based fallback fee so checkout can proceed.
 */
exports.getQuote = async (req, res, next) => {
  try {
    const pincode = String(req.body.pincode || req.query.pincode || '').trim();
    const paymentMethod = ['cod', 'online'].includes(req.body.paymentMethod)
      ? req.body.paymentMethod
      : 'cod';

    if (!isValidPincode(pincode)) {
      throw new ApiError(400, 'Enter a valid 6-digit delivery pincode');
    }

    const { totals, shippingQuote, orderItems } = await buildOrderFromCart({
      userId: req.user._id,
      shippingAddress: { pincode },
      paymentMethod,
    });

    res.json({
      success: true,
      data: {
        available: Boolean(shippingQuote?.available),
        used: Boolean(shippingQuote?.used),
        reason: shippingQuote?.reason || '',
        shippingFee: totals.shippingFee,
        freeDelivery: totals.shippingFee === 0,
        courier: shippingQuote?.courierName
          ? {
              name: shippingQuote.courierName,
              id: shippingQuote.courierCompanyId || null,
              estimatedDeliveryDays: shippingQuote.estimatedDeliveryDays || '',
              estimatedDeliveryDate: shippingQuote.estimatedDeliveryDate || null,
            }
          : null,
        package: shippingQuote?.package || null,
        itemCount: orderItems.reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0
        ),
        totals,
      },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.getOrderShipping = async (req, res, next) => {
  try {
    const order = await assertOrderAccess(req.params.id, req.user);

    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        shipping: order.shipping,
      },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

/**
 * GET /api/shipping/orders/:id/track
 *
 * Fetches the latest scan history from Shiprocket and persists it on the order.
 * The customer sees the same tracking data the admin and webhooks maintain.
 */
exports.trackOrder = async (req, res, next) => {
  try {
    await assertOrderAccess(req.params.id, req.user);

    const { tracking } = await shippingService.trackShipmentForOrder(
      req.params.id,
      { persist: true }
    );

    res.json({
      success: true,
      data: tracking,
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

/* ========================================================================== *
 * Admin
 * ========================================================================== */

exports.listShipments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const result = await shippingService.listShipments({
      page,
      limit,
      status: req.query.status,
      search: req.query.search,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.getAdminOrderShipping = async (req, res, next) => {
  try {
    const order = await assertOrderAccess(req.params.id, req.user);

    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        shippingAddress: order.shippingAddress,
        amounts: {
          subtotal: order.subtotal,
          discount: order.discount,
          shippingFee: order.shippingFee,
          gstAmount: order.gstAmount,
          totalAmount: order.totalAmount,
        },
        shipping: order.shipping,
      },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.createShipment = async (req, res, next) => {
  try {
    const result = await shippingService.createShipmentForOrder(req.params.id);

    res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.created
        ? 'Shipment created'
        : 'Shipment already exists for this order',
      data: {
        order: result.order,
        shipping: result.shipping,
        warnings: result.warnings || [],
      },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.assignAWB = async (req, res, next) => {
  try {
    const result = await shippingService.assignAWBForOrder(req.params.id, {
      courierId: req.body.courierId,
    });

    res.json({
      success: true,
      message: result.alreadyExists
        ? 'AWB already assigned'
        : 'AWB assigned',
      data: result.shipping,
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.generateLabel = async (req, res, next) => {
  try {
    const result = await shippingService.generateLabelForOrder(req.params.id);

    res.json({
      success: true,
      message: result.alreadyExists
        ? 'Label already generated'
        : 'Label generated',
      data: { labelUrl: result.labelUrl, shipping: result.shipping },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.generateManifest = async (req, res, next) => {
  try {
    const result = await shippingService.generateManifestForOrder(req.params.id);

    res.json({
      success: true,
      message: result.alreadyExists
        ? 'Manifest already generated'
        : 'Manifest generated',
      data: { manifestUrl: result.manifestUrl, shipping: result.shipping },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.requestPickup = async (req, res, next) => {
  try {
    const result = await shippingService.requestPickupForOrder(req.params.id);

    res.json({
      success: true,
      message: result.alreadyExists
        ? 'Pickup already scheduled'
        : 'Pickup requested',
      data: result,
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.cancelShipment = async (req, res, next) => {
  try {
    const result = await shippingService.cancelShipmentForOrder(req.params.id, {
      reason: req.body.reason,
    });

    res.json({
      success: true,
      message: result.alreadyExists
        ? 'Shipment is already cancelled'
        : 'Shipment cancelled',
      data: result.shipping,
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.trackShipment = async (req, res, next) => {
  try {
    // Admin sync always persists; the response adds the freshly read order state.
    const { tracking } = await shippingService.trackShipmentForOrder(
      req.params.id,
      { persist: true }
    );

    const order = await Order.findById(req.params.id)
      .select(ORDER_PUBLIC_FIELDS)
      .lean();

    res.json({
      success: true,
      data: { tracking, shipping: order?.shipping || null },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.getPickupLocations = async (req, res, next) => {
  try {
    const response = await shiprocket.getPickupLocations();
    const data = response?.data || response || {};
    const locations = Array.isArray(data.data?.shipping_address)
      ? data.data.shipping_address
      : Array.isArray(data.shipping_address)
        ? data.shipping_address
        : [];

    res.json({
      success: true,
      data: locations.map((location) => ({
        pickupLocation: location.pickup_location || location.name || '',
        city: location.city || '',
        state: location.state || '',
        pincode: location.pin_code || location.pincode || '',
        isDefault: Boolean(location.is_default || location.default),
      })),
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

exports.testConnection = async (req, res, next) => {
  try {
    const result = await shiprocket.testShiprocketConnection();

    res.json({
      success: true,
      data: {
        ...result,
        pickupLocationConfigured: Boolean(SHIPROCKET_PICKUP_LOCATION),
        pickupPincodeConfigured: Boolean(SHIPROCKET_PICKUP_PINCODE),
        shipmentReady: isShiprocketShipmentReady(),
      },
    });
  } catch (error) {
    sendError(error, res, next);
  }
};

/* ========================================================================== *
 * Webhook
 * ========================================================================== */

const timingSafeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const extractSecret = (req) =>
  req.get('x-shiprocket-webhook-secret') ||
  req.get('x-webhook-secret') ||
  req.get('x-api-key') ||
  req.query.token ||
  req.query.secret ||
  '';

const verifyHmac = (rawBody, signature) => {
  if (!signature || !SHIPROCKET_WEBHOOK_SECRET) return false;
  const provided = String(signature).trim().replace(/^sha256=/i, '');
  const expected = crypto
    .createHmac('sha256', SHIPROCKET_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(provided.toLowerCase(), expected.toLowerCase());
};

/**
 * POST /api/shipping/webhook
 *
 * Raw-body route, mounted before express.json(). Authentication happens first:
 * a shared secret header/query parameter, or an HMAC-SHA256 signature over the
 * untouched bytes. Only then is the payload parsed and handed to the shipping
 * service, which claims each event id exactly once.
 */
exports.handleWebhook = async (req, res, next) => {
  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : String(req.rawBody || '');

    if (!SHIPROCKET_WEBHOOK_SECRET) {
      console.warn(
        '[shiprocket] webhook rejected: SHIPROCKET_WEBHOOK_SECRET is not configured'
      );
      return res.status(503).json({
        success: false,
        message: 'Webhook authentication is not configured',
      });
    }

    const secretOk = timingSafeEqual(
      extractSecret(req),
      SHIPROCKET_WEBHOOK_SECRET
    );
    const signature =
      req.get('x-shiprocket-signature') || req.get('x-hub-signature-256');
    const hmacOk = verifyHmac(rawBody, signature);

    if (!secretOk && !hmacOk) {
      console.warn('[shiprocket] webhook rejected: invalid authentication');
      return res.status(401).json({
        success: false,
        message: 'Invalid webhook authentication',
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Authenticated but unreadable: acknowledge so Shiprocket does not retry
      // a body it can never deliver successfully.
      return res.status(200).json({
        success: true,
        message: 'Webhook ignored: unreadable body',
      });
    }

    const result = await shippingService.processWebhook(payload, {
      rawBody,
      eventId: req.get('x-shiprocket-event-id') || req.get('x-webhook-event-id'),
    });

    return res.json({ success: true, message: 'Webhook processed', data: result });
  } catch (error) {
    return sendError(error, res, next);
  }
};
