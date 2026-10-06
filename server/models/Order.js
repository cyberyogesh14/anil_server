const mongoose = require('mongoose');
const generateOrderId = require('../utils/generateOrderId');

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  name: { type: String, required: true },
  sku: { type: String, default: '' },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true },
  image: { type: String, default: '' },
  /**
   * Whether this order line was the one that took the product's stock to zero and
   * therefore auto-deactivated it.
   *
   * Cancelling restores the units, and when the units are the reason the product is
   * hidden then restoring them should bring it back (audit finding F-07). When the
   * product is hidden for any other reason - an admin unpublished it, before or
   * after the order - the cancellation must leave it alone, which is why the flag
   * records the *cause* of the hidden state rather than a copy of it.
   *
   * Defaults to false, so orders placed before this field existed never republish a
   * product: the safer direction to fail in.
   */
  deactivatedByStockOut: { type: Boolean, default: false },
});

const timelineSchema = new mongoose.Schema({
  status: { type: String, required: true },
  date: { type: Date, default: Date.now },
  note: { type: String, default: '' },
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    items: [orderItemSchema],
    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      addressLine1: { type: String, required: true },
      addressLine2: { type: String, default: '' },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      country: { type: String, default: 'India' },
    },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ['cod', 'online'],
      default: 'cod',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded', 'cod'],
      default: 'pending',
    },
    orderStatus: {
      type: String,
      enum: [
        'pending',
        'confirmed',
        'processing',
        'shipped',
        'out_for_delivery',
        'delivered',
        'cancelled',
      ],
      default: 'pending',
    },
    razorpayOrderId: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },
    razorpaySignature: { type: String, default: '' },
    paymentVerifiedAt: { type: Date, default: null },
    paymentFailedAt: { type: Date, default: null },
    paymentExpiresAt: { type: Date, default: null },
    razorpayWebhookEvents: { type: [String], default: [] },
    cartFingerprint: { type: String, default: '' },
    stockReserved: { type: Boolean, default: false },
    stockRestored: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    timeline: [timelineSchema],
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
orderSchema.index({ user: 1, paymentMethod: 1, paymentStatus: 1 });

/**
 * Serves `findReusableOrder` in `controllers/paymentController.js`, which looks up a
 * user's still-pending online orders sorted newest-first. The existing
 * `{ user, paymentMethod, paymentStatus }` index stops one field short, so that
 * lookup had no usable index for either its `orderStatus` equality or its sort.
 */
orderSchema.index(
  { user: 1, paymentMethod: 1, paymentStatus: 1, orderStatus: 1, createdAt: -1 }
);

/** Review listing for a product, newest first. */
orderSchema.index({ user: 1, orderStatus: 1, 'items.product': 1 });

/**
 * The exact field list every order read endpoint is allowed to return.
 *
 * This exists because of a trap in the `toJSON` transform below: `.lean()`
 * bypasses `toJSON` entirely, so simply adding `.lean()` to an order query would
 * start leaking `razorpaySignature` and `razorpayWebhookEvents` to clients - the
 * HMAC signature used to authorise the payment, and the internal webhook
 * idempotency keys. `razorpayIntegrationTest.js` asserts the signature is absent
 * from `GET /api/orders/:id`, so this constant is the allow-list that keeps
 * `.lean()` safe: it mirrors what `toJSON` keeps, field for field.
 *
 * `razorpayPaymentId` is deliberately present - the owning customer is entitled to
 * their own payment reference.
 */
const ORDER_PUBLIC_FIELDS = [
  '_id',
  'user',
  'items',
  'shippingAddress',
  'subtotal',
  'discount',
  'shippingFee',
  'gstAmount',
  'totalAmount',
  'paymentMethod',
  'paymentStatus',
  'orderStatus',
  'razorpayOrderId',
  'razorpayPaymentId',
  'paymentVerifiedAt',
  'paymentFailedAt',
  'paymentExpiresAt',
  'cartFingerprint',
  'stockReserved',
  'stockRestored',
  'notes',
  'timeline',
  'createdAt',
  'updatedAt',
].join(' ');

/**
 * Razorpay ids and the payment signature are secrets-adjacent. They are only
 * ever returned to the owning customer for their own order, never to the
 * public order-tracking endpoint.
 */
orderSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.razorpaySignature;
    delete ret.razorpayWebhookEvents;
    delete ret.__v;
    return ret;
  },
});

orderSchema.pre('save', async function (next) {
  try {
    if (!this.orderNumber) {
      this.orderNumber = await generateOrderId();
    }
    if (this.isNew) {
      this.timeline.push({ status: 'pending', date: new Date() });
    }
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Order', orderSchema);
module.exports.ORDER_PUBLIC_FIELDS = ORDER_PUBLIC_FIELDS;
