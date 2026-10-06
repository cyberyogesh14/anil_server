const Order = require('../models/Order');
const { ORDER_PUBLIC_FIELDS } = require('../models/Order');
const Product = require('../models/Product');
const emailService = require('../services/emailService');
const stockService = require('../services/stockService');
const ApiError = require('../services/ApiError');
const { runInTransaction } = require('../services/transactionRunner');
const generateOrderId = require('../utils/generateOrderId');
const { invalidateCatalogueCache } = require('../utils/catalogueCache');
const {
  buildOrderFromCart,
  normaliseAddress,
  validateAddress,
} = require('../services/pricingService');

/**
 * Turns `cartLines` into the shape `restoreStockForOrder` expects for a failed-order
 * compensation.
 *
 * Nothing outside this request has touched these products, so the pre-order state is
 * exactly what should be restored. Visibility is re-derived from the restored stock,
 * which is why a line is allowed to bring the product back: the only thing that
 * changed is the stock this request itself took.
 */
const compensationLines = (cartLines) =>
  cartLines.map((line) => ({
    product: line.product,
    quantity: line.quantity,
    restoreVisibility: true,
  }));

/**
 * Inserts the order document with an already-allocated order number.
 *
 * The number is allocated *before* the transaction opens (see `createOrder`), so
 * nothing about numbering can abort an order transaction, and the insert itself
 * needs no retry: allocation is an atomic counter, so it cannot collide.
 *
 * The unique index on `orderNumber` is still the real guarantee, and is not
 * relaxed. If it ever fires anyway (a manually seeded duplicate), the error is
 * surfaced unchanged rather than retried, because a duplicate-key error inside a
 * transaction aborts that transaction and an in-transaction retry would fail with
 * `NoSuchTransaction` (code 251). Verified against a real replica set.
 *
 * No other duplicate-key error is retried either. A collision on
 * `cartFingerprint` (double submit) or any other unique field must surface exactly
 * as it did before.
 */
const createOrderWithUniqueNumber = async (orderData, session) => {
  const [created] = await Order.create(
    [orderData],
    session ? { session } : {}
  );
  return created;
};

exports.createOrder = async (req, res, next) => {
  try {
    const { paymentMethod, notes } = req.body;

    if (!paymentMethod || !['cod', 'online'].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: 'Valid payment method is required (cod or online)',
      });
    }

    if (paymentMethod === 'online') {
      return res.status(400).json({
        success: false,
        message:
          'Online payments must be completed through the Razorpay checkout',
      });
    }

    const shippingAddress = normaliseAddress(req.body.shippingAddress);
    validateAddress(shippingAddress);

    const { cart, orderItems, cartLines, totals } = await buildOrderFromCart({
      userId: req.user._id,
    });

    /**
     * Audit finding F-02. Creating the order, decrementing the stock and emptying
     * the cart happen as one unit of work: on a replica set that is a real MongoDB
     * transaction, and anywhere else it is still race-free because the stock is
     * claimed by a single guarded atomic update rather than an unguarded `$inc`
     * based on a value read earlier in the request.
     *
     * Ordering matters for the no-transaction fallback. The stock is claimed
     * FIRST and the order is created second, so a request that loses the race
     * fails before it has written anything. Creating the order first would leave
     * an orphan order behind on every rejected request, because there is nothing
     * to roll it back with.
     *
     * The order number is reserved BEFORE the transaction opens. A counter write
     * inside the transaction would be abortable by a duplicate-key error on the
     * day's counter document, and aborting a transaction is not recoverable from
     * inside it. Reserving first makes that impossible. It also means a request
     * that goes on to lose the stock race leaves a gap in the day's sequence,
     * which is harmless: order numbers only have to be unique, never contiguous.
     */
    const orderNumber = await generateOrderId();

    const populatedOrder = await runInTransaction(async (session) => {
      const claimed = await stockService.decrementStockForOrder(cartLines, { session });

      if (!claimed) {
        // The guard did not match on at least one line, so another order took
        // the units while this request was in flight.
        throw new ApiError(
          409,
          'Some items just went out of stock. Please review your cart and try again.'
        );
      }

      let order;
      try {
        order = await createOrderWithUniqueNumber(
          {
            user: req.user._id,
            orderNumber,
            items: orderItems,
            shippingAddress,
            subtotal: totals.subtotal,
            discount: totals.discount,
            shippingFee: totals.shippingFee,
            gstAmount: totals.gstAmount,
            totalAmount: totals.totalAmount,
            paymentMethod,
            paymentStatus: 'cod',
            orderStatus: 'pending',
            notes: notes || '',
          },
          session
        );
      } catch (error) {
        // With a session the throw above rolls this back anyway; without one the
        // claimed stock has to be handed back explicitly.
        if (!session) await stockService.restoreStockForOrder(compensationLines(cartLines));
        throw error;
      }

      try {
        cart.items = [];
        await cart.save(session ? { session } : {});
      } catch (error) {
        if (session) throw error;
        await Promise.all([
          stockService.restoreStockForOrder(compensationLines(cartLines)),
          Order.deleteOne({ _id: order._id }),
        ]);
        throw error;
      }

      // The re-read MUST join the transaction. Without the session it runs on a
      // different connection, which cannot see the order this transaction has
      // created but not yet committed, and returns null.
      //
      // `.session()` rather than findById(id, { session }): the two-argument form
      // treats its second argument as a projection, not options, and Mongoose then
      // fails trying to serialise the session into BSON.
      let freshOrder = Order.findById(order._id);
      if (session) freshOrder = freshOrder.session(session);

      return freshOrder.populate('user', 'name email');
    })
.finally(async () => {
        // Covers the transactional branch, where `stockService` deliberately does
        // not invalidate on its own because the write is not committed yet. Runs on
        // failure too: a rolled-back transaction still means the rails may have been
        // warmed by an earlier read in this request.
        await invalidateCatalogueCache();
      });

    try {
      await emailService.sendOrderConfirmationEmail({
        to: req.user.email,
        customerName: req.user.name,
        orderNumber: populatedOrder.orderNumber,
        orderDate: populatedOrder.createdAt.toLocaleString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        items: orderItems,
        subtotal: totals.subtotal,
        discount: totals.discount,
        shippingFee: totals.shippingFee,
        gstAmount: totals.gstAmount,
        totalAmount: totals.totalAmount,
        shippingAddress,
        paymentMethod,
        paymentStatus: populatedOrder.paymentStatus,
        razorpayPaymentId: '',
        orderStatus: populatedOrder.orderStatus,
      });
    } catch (error) {
      console.error('Order confirmation email failed:', error.message);
    }

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: populatedOrder,
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
 * A customer's own order list.
 *
 * `ORDER_PUBLIC_FIELDS` is mandatory here, not an optimisation: `.lean()` skips
 * the schema's `toJSON` transform, and that transform is what keeps
 * `razorpaySignature` and `razorpayWebhookEvents` out of responses. The projection
 * restores that guarantee explicitly.
 */
exports.getOrders = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
    const skip = (page - 1) * limit;
    const filter = { user: req.user._id };

    // Independent reads, issued together instead of one after the other.
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .select(ORDER_PUBLIC_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getOrderById = async (req, res, next) => {
  try {
    // Same reasoning as `getOrders`: the projection is what replaces `toJSON`.
    const order = await Order.findById(req.params.id)
      .select(ORDER_PUBLIC_FIELDS)
      .populate('user', 'name email phone')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (
      order.user._id.toString() !== req.user._id.toString() &&
      !['admin', 'staff'].includes(req.user.role)
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this order',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

exports.trackOrder = async (req, res, next) => {
  try {
    const { orderNumber } = req.params;

    if (!orderNumber || !orderNumber.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Order number is required',
      });
    }

    const order = await Order.findOne({
      orderNumber: orderNumber.trim().toUpperCase(),
    })
      .select(
        'orderNumber orderStatus paymentStatus createdAt updatedAt shippingAddress.fullName items'
      )
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        customerName: order.shippingAddress?.fullName,
        itemCount: order.items?.length || 0,
        placedAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.cancelOrder = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this order',
      });
    }

    if (!['pending', 'confirmed'].includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Order cannot be cancelled at this stage',
      });
    }

    order.orderStatus = 'cancelled';
    order.timeline.push({ status: 'cancelled', date: new Date() });

    /**
     * Audit finding F-07. This used to be:
     *
     *   $inc: { stock: qty }, $set: { isActive: true }
     *
     * The stock restore is right, but the unconditional `$set` meant cancelling any
     * order republished a product an admin had deliberately unpublished - a hidden
     * product reappearing on the storefront because one customer changed their mind.
     *
     * Now the stock comes back, and the product is only brought back online when
     * *these units* are why it went offline: `restoreStockForOrder` re-derives
     * visibility from the restored stock and leaves a product that is inactive for any
     * other reason alone. An admin-unpublished product stays unpublished whether the
     * unpublish happened before the order or while it was in flight.
     */
    await stockService.restoreStockForOrder(
      order.items.map((item) => ({
        product: item.product,
        quantity: item.quantity,
        restoreVisibility: item.deactivatedByStockOut === true,
      }))
    );

    await order.save();

    res.json({
      success: true,
      message: 'Order cancelled',
      data: order,
    });
  } catch (error) {
    next(error);
  }
};
