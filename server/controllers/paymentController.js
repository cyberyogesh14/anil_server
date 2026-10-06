const Order = require('../models/Order');
const Cart = require('../models/Cart');
const User = require('../models/User');
const emailService = require('../services/emailService');
const razorpayService = require('../services/razorpayService');
const stockService = require('../services/stockService');
const {
  buildOrderFromCart,
  cartFingerprint,
  normaliseAddress,
  validateAddress,
} = require('../services/pricingService');
const { isConfigured, getKeyId } = require('../config/razorpay');
const ApiError = require('../services/ApiError');

// A pending online order older than this is treated as abandoned: its stock
// reservation is released and a fresh order is created on the next attempt.
const PAYMENT_TTL_MINUTES = 30;

const paymentExpiresAt = () =>
  new Date(Date.now() + PAYMENT_TTL_MINUTES * 60 * 1000);

const clearServerCart = async (userId) => {
  const cart = await Cart.findOne({ user: userId });
  if (cart && cart.items.length) {
    cart.items = [];
    await cart.save();
  }
};

const sendConfirmationEmail = async (order) => {
  try {
    // Only the recipient and a display name are needed. Without the projection this
    // pulled the entire user row - including the password hash - across the wire
    // on every single order confirmation.
    const user = await User.findById(order.user).select('email name').lean();
    if (!user) return;

    await emailService.sendOrderConfirmationEmail({
      to: user.email,
      customerName: user.name,
      orderNumber: order.orderNumber,
      orderDate: order.createdAt.toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      items: order.items,
      subtotal: order.subtotal,
      discount: order.discount,
      shippingFee: order.shippingFee,
      gstAmount: order.gstAmount,
      totalAmount: order.totalAmount,
      shippingAddress: order.shippingAddress,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      razorpayPaymentId: order.razorpayPaymentId,
      orderStatus: order.orderStatus,
    });
  } catch (error) {
    console.error('Order confirmation email failed:', error.message);
  }
};

const publicOrder = (order) => ({
  razorpayOrderId: order.razorpayOrderId,
  amount: Math.round(order.totalAmount * 100),
  currency: 'INR',
  keyId: getKeyId(),
  internalOrderId: String(order._id),
  orderNumber: order.orderNumber,
  expiresAt: order.paymentExpiresAt,
});

/**
 * Reuses a still-valid pending online order for the same cart so a cancelled or
 * failed attempt does not litter the orders table. Anything that no longer
 * matches (different cart, different address, expired) is cancelled first and
 * its stock released.
 */
const findReusableOrder = async ({ userId, fingerprint, address }) => {
  const pending = await Order.find({
    user: userId,
    paymentMethod: 'online',
    paymentStatus: 'pending',
    orderStatus: 'pending',
  })
    .sort({ createdAt: -1 })
    .limit(10);

  const stale = [];

  for (const order of pending) {
    const expired =
      order.paymentExpiresAt && new Date(order.paymentExpiresAt) < new Date();
    const sameCart = order.cartFingerprint === fingerprint;
    const sameAddress =
      order.shippingAddress.fullName === address.fullName &&
      order.shippingAddress.addressLine1 === address.addressLine1 &&
      order.shippingAddress.city === address.city &&
      order.shippingAddress.pincode === address.pincode;

    if (expired || !sameCart || !sameAddress) {
      stale.push(order);
      continue;
    }

    // Cancel any other stale siblings so only one pending order survives.
    for (const other of stale) {
      other.paymentStatus = 'failed';
      other.orderStatus = 'cancelled';
      other.paymentFailedAt = new Date();
      other.timeline.push({
        status: 'cancelled',
        date: new Date(),
        note: 'Superseded by a newer payment attempt',
      });
      await other.save();
      await stockService.releaseStock(other);
    }

    return order;
  }

  for (const order of stale) {
    order.paymentStatus = 'failed';
    order.orderStatus = 'cancelled';
    order.paymentFailedAt = new Date();
    order.timeline.push({
      status: 'cancelled',
      date: new Date(),
      note: 'Payment not completed',
    });
    await order.save();
    await stockService.releaseStock(order);
  }

  return null;
};

/**
 * POST /api/payments/razorpay/create-order
 *
 * Recalculates the whole order from MongoDB, creates the internal pending
 * order and only then creates the Razorpay order. The amount sent to Razorpay
 * is always this backend-calculated total.
 */
exports.createRazorpayOrder = async (req, res, next) => {
  try {
    if (!isConfigured()) {
      throw new ApiError(
        503,
        'Online payments are not available right now. Please choose Cash on Delivery.'
      );
    }

    const address = normaliseAddress(req.body.shippingAddress);
    validateAddress(address);

    const notes = String(req.body.notes || '').slice(0, 500);

    const { orderItems, totals } = await buildOrderFromCart({
      userId: req.user._id,
    });

    const fingerprint = cartFingerprint(orderItems, totals.totalAmount);

    const reusable = await findReusableOrder({
      userId: req.user._id,
      fingerprint,
      address,
    });

    let order = reusable;

    if (order) {
      order.shippingAddress = address;
      if (notes) order.notes = notes;
      order.paymentExpiresAt = paymentExpiresAt();
      await order.save();
    } else {
      order = await Order.create({
        user: req.user._id,
        items: orderItems,
        shippingAddress: address,
        subtotal: totals.subtotal,
        discount: totals.discount,
        shippingFee: totals.shippingFee,
        gstAmount: totals.gstAmount,
        totalAmount: totals.totalAmount,
        paymentMethod: 'online',
        paymentStatus: 'pending',
        orderStatus: 'pending',
        cartFingerprint: fingerprint,
        paymentExpiresAt: paymentExpiresAt(),
        notes,
      });

      // Reserve stock while the customer completes the payment so the same
      // units cannot be sold twice. Released again if the payment fails.
      const reserved = await stockService.reserveStock(order);
      if (!reserved) {
        order.orderStatus = 'cancelled';
        order.paymentStatus = 'failed';
        await order.save();
        throw new ApiError(
          409,
          'Some items just went out of stock. Please review your cart and try again.'
        );
      }

      order = await Order.findById(order._id);
    }

    let razorpayOrder;
    try {
      razorpayOrder = await razorpayService.createRazorpayOrder({
        amountInRupees: order.totalAmount,
        receipt: order.orderNumber,
        expiresAt: order.paymentExpiresAt,
        notes: {
          internalOrderId: String(order._id),
          orderNumber: order.orderNumber,
        },
      });
    } catch (error) {
      console.error('Razorpay order creation failed:', error.message);
      if (!reusable) {
        order.orderStatus = 'cancelled';
        order.paymentStatus = 'failed';
        await order.save();
        await stockService.releaseStock(order);
      }
      throw new ApiError(
        502,
        'Could not start the payment. Please try again in a moment.'
      );
    }

    if (order.razorpayOrderId !== razorpayOrder.razorpayOrderId) {
      order.razorpayOrderId = razorpayOrder.razorpayOrderId;
      order.razorpayPaymentId = '';
      order.razorpaySignature = '';
      await order.save();
    }

    // The cart is intentionally left untouched here. It is only emptied by the
    // verify step, once the payment is actually confirmed.
    res.status(201).json({
      success: true,
      data: publicOrder(order),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    next(error);
  }
};

/**
 * POST /api/payments/razorpay/verify
 *
 * The only place an online order becomes "paid". The frontend popup saying
 * "success" proves nothing on its own - the HMAC signature produced by Razorpay
 * is checked here, against the order id we stored, with the server-side secret.
 */
exports.verifyRazorpayPayment = async (req, res, next) => {
  try {
    const {
      internalOrderId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    } = req.body;

    if (!internalOrderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw new ApiError(400, 'Incomplete payment verification details');
    }

    const order = await Order.findById(internalOrderId);

    if (!order) {
      throw new ApiError(404, 'Order not found');
    }

    if (String(order.user) !== String(req.user._id)) {
      throw new ApiError(403, 'Not authorized to verify this order');
    }

    // Idempotent: a replayed verify returns the already-paid order as success
    // instead of charging or emailing again.
    if (order.paymentStatus === 'paid') {
      return res.json({
        success: true,
        alreadyVerified: true,
        message: 'Payment already verified',
        data: order,
      });
    }

    if (order.orderStatus === 'cancelled') {
      throw new ApiError(
        409,
        'This order was cancelled. Please start a new payment attempt.'
      );
    }

    if (order.paymentMethod !== 'online') {
      throw new ApiError(400, 'This order is not an online payment');
    }

    if (!order.razorpayOrderId || order.razorpayOrderId !== razorpayOrderId) {
      throw new ApiError(400, 'Payment reference does not match this order');
    }

    const result = razorpayService.verifyPaymentSignature({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    });

    if (!result.valid) {
      // Deliberately not marking the order failed here: a bad or tampered
      // signature tells us nothing about whether real money arrived.
      console.warn(
        `Payment signature rejected for order ${order.orderNumber}`
      );
      throw new ApiError(400, 'Payment verification failed. Please try again.');
    }

    // Conditional update makes concurrent/repeated verifies safe.
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: 'paid' } },
      {
        $set: {
          paymentStatus: 'paid',
          razorpayPaymentId,
          razorpaySignature,
          paymentVerifiedAt: new Date(),
          orderStatus: 'confirmed',
        },
        $push: {
          timeline: {
            status: 'confirmed',
            date: new Date(),
            note: 'Payment verified via Razorpay',
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      const latest = await Order.findById(order._id);
      return res.json({
        success: true,
        alreadyVerified: true,
        message: 'Payment already verified',
        data: latest,
      });
    }

    await stockService.ensureStockDeducted(updated);
    await clearServerCart(updated.user);
    await sendConfirmationEmail(updated);

    res.json({
      success: true,
      message: 'Payment verified successfully',
      data: updated,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    next(error);
  }
};

/**
 * POST /api/payments/razorpay/webhook
 *
 * Server-to-server safety net for `payment.captured` / `payment.failed` /
 * `order.paid`. Verified with the webhook secret over the raw request body and
 * idempotent per event id, so Razorpay's retries are harmless.
 */
exports.handleRazorpayWebhook = async (req, res, next) => {
  const signature = req.get('x-razorpay-signature');

  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : req.rawBody;

    const result = razorpayService.verifyWebhookSignature(rawBody, signature);

    if (!result.valid) {
      console.warn(`Razorpay webhook rejected: ${result.reason}`);
      return res.status(400).json({ success: false, message: result.reason });
    }

    // Only now, once the signature is proven against the untouched bytes, is it
    // safe to parse. `req.body` is a Buffer here (express.raw), so the event
    // payload must be read from the raw string - never from req.body directly.
    let body = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }

    if (!body || typeof body !== 'object') {
      return res
        .status(200)
        .json({ success: true, message: 'Webhook ignored: unreadable body' });
    }

    const event = body.event;
    const payload = body.payload || {};

    if (!event) {
      return res
        .status(200)
        .json({ success: true, message: 'Webhook ignored: no event' });
    }

    // Razorpay nests the entity one level down: payload.payment.entity for
    // payment.* events and payload.order.entity for order.* events. The
    // *_entity aliases are accepted so a differently shaped sender still works.
    const paymentEntity = payload.payment?.entity || payload.payment_entity || null;
    const orderEntity = payload.order?.entity || payload.order_entity || null;
    const entity = paymentEntity || orderEntity || {};

    const razorpayOrderId =
      entity.order_id || orderEntity?.id || entity.id || null;
    const razorpayPaymentId = paymentEntity?.id || null;

    if (!razorpayOrderId) {
      return res
        .status(200)
        .json({ success: true, message: 'Webhook ignored: no order reference' });
    }

    const order = await Order.findOne({ razorpayOrderId });
    if (!order) {
      return res
        .status(200)
        .json({ success: true, message: 'Webhook ignored: unknown order' });
    }

    // Claim the event id first so a retry cannot run the handler twice.
    const eventId = req.get('x-razorpay-event-id') || `${event}:${razorpayPaymentId || razorpayOrderId}`;
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, razorpayWebhookEvents: { $ne: eventId } },
      { $push: { razorpayWebhookEvents: eventId } },
      { new: false }
    );

    if (!claimed) {
      return res
        .status(200)
        .json({ success: true, message: 'Webhook already processed' });
    }

    if (event === 'payment.captured' || event === 'order.paid') {
      await markOrderPaidFromWebhook(order, razorpayPaymentId);
    } else if (event === 'payment.failed') {
      await markOrderFailedFromWebhook(order, paymentEntity?.error_description);
    }

    return res.json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    return next(error);
  }
};

const markOrderPaidFromWebhook = async (order, razorpayPaymentId) => {
  if (order.paymentStatus === 'paid') {
    return;
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'paid' } },
    {
      $set: {
        paymentStatus: 'paid',
        ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
        paymentVerifiedAt: order.paymentVerifiedAt || new Date(),
        orderStatus:
          order.orderStatus === 'pending' || order.orderStatus === 'cancelled'
            ? 'confirmed'
            : order.orderStatus,
      },
      $push: {
        timeline: {
          status: 'confirmed',
          date: new Date(),
          note: 'Payment captured (Razorpay webhook)',
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    return;
  }

  await stockService.ensureStockDeducted(updated);
  await clearServerCart(updated.user);
  await sendConfirmationEmail(updated);
};

const markOrderFailedFromWebhook = async (order, reason) => {
  if (order.paymentStatus === 'paid') {
    return;
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'paid' } },
    {
      $set: {
        paymentStatus: 'failed',
        orderStatus: 'cancelled',
        paymentFailedAt: new Date(),
      },
      $push: {
        timeline: {
          status: 'cancelled',
          date: new Date(),
          note: reason ? `Payment failed: ${reason}` : 'Payment failed',
        },
      },
    },
    { new: true }
  );

  if (updated) {
    await stockService.releaseStock(updated);
  }
};
