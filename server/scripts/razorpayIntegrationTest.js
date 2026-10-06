/**
 * AnilKabadi Razorpay integration test harness.
 *
 * Boots the REAL server (server.js, routes, controllers, models, services)
 * against an in-memory MongoDB, with only two things faked:
 *   1. the `razorpay` SDK's network calls (so no real API keys are needed)
 *   2. outbound email (so nothing is actually sent)
 *
 * Everything else - amount calculation, stock reservation, HMAC signature
 * verification, webhook raw-body verification, idempotency - is production
 * code under test.
 *
 * Run: node scripts/razorpayIntegrationTest.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '5099';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

// Test-mode-shaped credentials. The secret is a known value so the harness can
// compute valid HMAC signatures itself and prove the server rejects bad ones.
process.env.RAZORPAY_KEY_ID = 'rzp_test_HAK_HARNESS';
process.env.RAZORPAY_KEY_SECRET = 'harness_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'harness_webhook_secret';

// No real SMTP.
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

// The harness legitimately makes many payment calls from one IP.
process.env.PAYMENT_RATE_LIMIT_MAX = '10000';

const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const SERVER_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Fake Razorpay SDK
// ---------------------------------------------------------------------------

let rzOrderSeq = 0;
let rzPaymentSeq = 0;
const rzOrders = new Map();

const hmac = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

class FakeRazorpay {
  constructor(opts) {
    this.key_id = opts.key_id;
    this.key_secret = opts.key_secret;
    this.orders = {
      create: async (payload) => {
        rzOrderSeq += 1;
        const id = `order_test_${rzOrderSeq}`;
        const order = {
          id,
          entity: 'order',
          amount: payload.amount,
          currency: payload.currency,
          receipt: payload.receipt,
          status: 'created',
          created_at: Math.floor(Date.now() / 1000),
        };
        rzOrders.set(id, order);
        return { ...order };
      },
    };
  }
}

// Intercept require('razorpay') before the app loads.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'razorpay') return FakeRazorpay;
  return originalLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

const results = [];
let currentSuite = '';

const suite = (name) => {
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};

const check = async (label, fn) => {
  try {
    await fn();
    results.push({ suite: currentSuite, label, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } catch (error) {
    results.push({ suite: currentSuite, label, ok: false, error: error.message });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}\n        ${error.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'Assertion failed');
};

const assertEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message || 'Mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const BASE = `http://127.0.0.1:${process.env.PORT}`;

const api = async (method, url, { token, body, rawBody, headers = {} } = {}) => {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: requestHeaders,
    body: payload,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const main = async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');

  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri('anilkabadi_test');
  console.log(`In-memory MongoDB: ${process.env.MONGO_URI}`);

  require(path.join(SERVER_ROOT, 'server.js'));
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const mongoose = require(path.join(SERVER_ROOT, 'node_modules/mongoose'));
  const Order = require(path.join(SERVER_ROOT, 'models/Order'));
  const Product = require(path.join(SERVER_ROOT, 'models/Product'));
  const Cart = require(path.join(SERVER_ROOT, 'models/Cart'));
  const User = require(path.join(SERVER_ROOT, 'models/User'));
  const Settings = require(path.join(SERVER_ROOT, 'models/Settings'));
  const emailService = require(path.join(SERVER_ROOT, 'services/emailService'));
  const { generateToken } = require(path.join(SERVER_ROOT, 'utils/generateToken'));

  // Capture confirmation emails instead of sending them.
  const sentEmails = [];
  emailService.sendOrderConfirmationEmail = async (payload) => {
    sentEmails.push(payload);
    return true;
  };

  await mongoose.connection.asPromise();

  // --- Fixtures -----------------------------------------------------------
  await Settings.deleteMany({});
  await Settings.create({
    freeDeliveryThreshold: 999,
    deliveryFee: 99,
    gstPercentage: 18,
  });

  const user = await User.create({
    name: 'Test Customer',
    email: `test-${Date.now()}@anilkabadi.test`,
    phone: '9876543210',
    password: 'test1234',
    isActive: true,
  });
  const token = generateToken(user._id);

  const otherUser = await User.create({
    name: 'Other Customer',
    email: `other-${Date.now()}@anilkabadi.test`,
    password: 'test1234',
    isActive: true,
  });
  const otherToken = generateToken(otherUser._id);

  const ADDRESS = {
    fullName: 'Test Customer',
    phone: '9876543210',
    addressLine1: '12 MG Road',
    addressLine2: 'Near Bus Stop',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    country: 'India',
  };

  const Category = require(path.join(SERVER_ROOT, 'models/Category'));
  const category = await Category.create({ name: 'Test Category' });

  const makeProducts = async (specs) => {
    const created = [];
    for (const spec of specs) {
      created.push(
        await Product.create({
          name: spec.name,
          description: 'Test part',
          category: category._id,
          price: spec.price,
          mrp: spec.mrp,
          stock: spec.stock,
          isActive: true,
          images: [],
        })
      );
    }
    return created;
  };

  const setCart = async (lines) => {
    await Cart.findOneAndDelete({ user: user._id });
    return Cart.create({
      user: user._id,
      items: lines.map((l) => ({ product: l.product, quantity: l.quantity, price: 0 })),
    });
  };

  // Backend's expected total, computed independently of the app's own maths.
  const expectedTotal = (lines, { freeThreshold = 999, fee = 99, gst = 18 } = {}) => {
    let gross = 0;
    let discount = 0;
    for (const l of lines) {
      gross += l.product.mrp * l.quantity;
      discount += (l.product.mrp - l.product.price) * l.quantity;
    }
    const shipping = gross >= freeThreshold ? 0 : fee;
    const gstAmount = Math.round((gross - discount) * gst) / 100;
    const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
    return {
      subtotal: round2(gross - discount),
      shipping,
      gstAmount: round2(gstAmount),
      total: round2(gross - discount + shipping + gstAmount),
    };
  };

  const validSignature = (orderId, paymentId) =>
    hmac(process.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);

  // =======================================================================
  suite('1. Wiring / routing');

  await check('server is listening on the configured port', async () => {
    const res = await api('GET', '/api/health');
    assertEqual(res.status, 200, 'health status');
    assert(res.body.success, 'health body');
  });

  await check('create-order is mounted (not 404)', async () => {
    const res = await api('POST', '/api/payments/razorpay/create-order', { token });
    assert(res.status !== 404, 'endpoint should exist, got 404');
  });

  await check('create-order rejects unauthenticated requests', async () => {
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 401, 'expected 401');
  });

  await check('verify rejects unauthenticated requests', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', { body: {} });
    assertEqual(res.status, 401, 'expected 401');
  });

  // =======================================================================
  suite('2. Amount is always backend-calculated (multi-product + discount + shipping + GST)');

  const products2 = await makeProducts([
    { name: 'Brake Pad Set', price: 800, mrp: 1000, stock: 10 },
    { name: 'Oil Filter', price: 250, mrp: 300, stock: 20 },
  ]);
  await setCart([
    { product: products2[0]._id, quantity: 2 },
    { product: products2[1]._id, quantity: 3 },
  ]);

  let order2;
  const expected2 = expectedTotal([
    { product: products2[0], quantity: 2 },
    { product: products2[1], quantity: 3 },
  ]);

  await check('create-order returns backend-calculated paise amount', async () => {
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: {
        shippingAddress: ADDRESS,
        // Deliberately hostile: none of this may influence the amount.
        totalAmount: 1,
        subtotal: 1,
        discount: 99999,
        shipping: 0,
        tax: 0,
      },
    });
    assertEqual(res.status, 201, 'create-order status: ' + res.text);
    assert(res.body.success, 'success flag');

    const d = res.body.data;
    order2 = await Order.findById(d.internalOrderId);

    assertEqual(d.amount, Math.round(expected2.total * 100), 'paise amount');
    assertEqual(d.currency, 'INR', 'currency');
    assertEqual(d.keyId, process.env.RAZORPAY_KEY_ID, 'keyId');
    assert(d.razorpayOrderId, 'razorpayOrderId present');
    assert(d.internalOrderId, 'internalOrderId present');
  });

  await check('Razorpay order == internal order total == computed total', async () => {
    assertEqual(order2.totalAmount, expected2.total, 'order totalAmount');
    assertEqual(order2.subtotal, expected2.subtotal, 'order subtotal');
    assertEqual(order2.shippingFee, expected2.shipping, 'order shippingFee');
    assertEqual(order2.gstAmount, expected2.gstAmount, 'order gstAmount');
    const rz = rzOrders.get(order2.razorpayOrderId);
    assert(rz, 'razorpay order recorded');
    assertEqual(rz.amount, Math.round(order2.totalAmount * 100), 'razorpay amount');
    assertEqual(rz.currency, 'INR', 'razorpay currency');
    assertEqual(rz.receipt, order2.orderNumber, 'receipt is the internal order number');
  });

  await check('new order starts paymentStatus=pending, orderStatus=pending, method=online', async () => {
    assertEqual(order2.paymentMethod, 'online', 'paymentMethod');
    assertEqual(order2.paymentStatus, 'pending', 'paymentStatus');
    assertEqual(order2.orderStatus, 'pending', 'orderStatus');
  });

  await check('client-supplied amounts are ignored (no tampering)', async () => {
    assert(order2.totalAmount > 1, 'total must not be the client value 1');
    assert(order2.discount !== 99999, 'discount must not be the client value');
  });

  await check('response never contains the key secret', async () => {
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assert(!res.text.includes(process.env.RAZORPAY_KEY_SECRET), 'secret leaked in response');
    assert(!res.text.includes('RAZORPAY_KEY_SECRET'), 'secret key name leaked');
  });

  await check('cart is NOT cleared before payment is verified', async () => {
    const cart = await Cart.findOne({ user: user._id });
    assert(cart && cart.items.length > 0, 'cart should still hold items');
  });

  await check('stock is reserved at create-order time', async () => {
    const p0 = await Product.findById(products2[0]._id);
    const p1 = await Product.findById(products2[1]._id);
    assertEqual(p0.stock, 10 - 2, 'product 0 stock');
    assertEqual(p1.stock, 20 - 3, 'product 1 stock');
  });

  await check('repeating create-order reuses the pending order (no duplicates)', async () => {
    const before = await Order.countDocuments({ user: user._id });
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 201, 'second create-order');
    const after = await Order.countDocuments({ user: user._id });
    assertEqual(after, before, 'no extra internal order created');
    assertEqual(res.body.data.internalOrderId, String(order2._id), 'reused same order');
  });

  await check('out-of-stock product is rejected', async () => {
    const scarce = await makeProducts([{ name: 'Rare Part', price: 100, mrp: 100, stock: 1 }]);
    await setCart([{ product: scarce[0]._id, quantity: 5 }]);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 400, 'expected 400 for insufficient stock');
    assert(/Insufficient stock/i.test(res.body.message), `message: ${res.body.message}`);
  });

  await check('empty cart is rejected', async () => {
    await Cart.findOneAndDelete({ user: user._id });
    await Cart.create({ user: user._id, items: [] });
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 400, 'expected 400 for empty cart');
  });

  await check('incomplete address is rejected', async () => {
    await setCart([{ product: products2[0]._id, quantity: 1 }]);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: { ...ADDRESS, pincode: '' } },
    });
    assertEqual(res.status, 400, 'expected 400 for bad address');
  });

  // restore cart for payment tests
  await setCart([
    { product: products2[0]._id, quantity: 2 },
    { product: products2[1]._id, quantity: 3 },
  ]);
  const created = await api('POST', '/api/payments/razorpay/create-order', {
    token,
    body: { shippingAddress: ADDRESS },
  });
  const pending = await Order.findById(created.body.data.internalOrderId);

  // =======================================================================
  suite('3. Payment verification (signature)');

  const paymentId4 = 'pay_test_valid_1';
  const sig4 = validSignature(pending.razorpayOrderId, paymentId4);

  await check('wrong signature is rejected and order stays unpaid', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(pending._id),
        razorpay_order_id: pending.razorpayOrderId,
        razorpay_payment_id: paymentId4,
        razorpay_signature: 'deadbeef' + '0'.repeat(58),
      },
    });
    assertEqual(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    const after = await Order.findById(pending._id);
    assertEqual(after.paymentStatus, 'pending', 'must not be paid');
    assertEqual(after.razorpayPaymentId, '', 'must not store payment id');
  });

  await check('no confirmation email is sent for a rejected signature', async () => {
    assertEqual(sentEmails.length, 0, 'emails sent');
  });

  await check('signature from a different order id is rejected', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(pending._id),
        razorpay_order_id: 'order_test_someone_else',
        razorpay_payment_id: paymentId4,
        razorpay_signature: sig4,
      },
    });
    assertEqual(res.status, 400, 'expected 400 for mismatched razorpay order id');
  });

  await check('another user cannot verify this order', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token: otherToken,
      body: {
        internalOrderId: String(pending._id),
        razorpay_order_id: pending.razorpayOrderId,
        razorpay_payment_id: paymentId4,
        razorpay_signature: sig4,
      },
    });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
    const after = await Order.findById(pending._id);
    assertEqual(after.paymentStatus, 'pending', 'must not be paid');
  });

  await check('missing fields are rejected', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: { internalOrderId: String(pending._id) },
    });
    assertEqual(res.status, 400, 'expected 400');
  });

  await check('valid signature marks the order paid', async () => {
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(pending._id),
        razorpay_order_id: pending.razorpayOrderId,
        razorpay_payment_id: paymentId4,
        razorpay_signature: sig4,
      },
    });
    assertEqual(res.status, 200, `expected 200, got ${res.text}`);

    const after = await Order.findById(pending._id);
    assertEqual(after.paymentStatus, 'paid', 'paymentStatus');
    assertEqual(after.razorpayPaymentId, paymentId4, 'razorpayPaymentId');
    assert(after.razorpaySignature, 'signature stored');
    assert(after.paymentVerifiedAt, 'paymentVerifiedAt set');
    assertEqual(after.orderStatus, 'confirmed', 'orderStatus');
  });

  await check('signature is never returned to the client', async () => {
    const res = await api('GET', `/api/orders/${pending._id}`, { token });
    assertEqual(res.status, 200, 'get order');
    assert(!('razorpaySignature' in res.body.data), 'signature must be stripped');
  });

  await check('razorpay payment id IS returned to the owning customer', async () => {
    const res = await api('GET', `/api/orders/${pending._id}`, { token });
    assertEqual(res.body.data.razorpayPaymentId, paymentId4, 'payment id');
  });

  await check('confirmation email sent exactly once, after verification', async () => {
    assertEqual(sentEmails.length, 1, 'email count');
    const email = sentEmails[0];
    assertEqual(email.paymentMethod, 'online', 'email payment method');
    assertEqual(email.paymentStatus, 'paid', 'email payment status');
    assertEqual(email.razorpayPaymentId, paymentId4, 'email razorpay id');
  });

  await check('cart is cleared only after successful verification', async () => {
    const cart = await Cart.findOne({ user: user._id });
    assertEqual(cart.items.length, 0, 'cart should be empty');
  });

  await check('duplicate verification is idempotent (success, no re-charge)', async () => {
    const before = await Order.findById(pending._id);
    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(pending._id),
        razorpay_order_id: pending.razorpayOrderId,
        razorpay_payment_id: paymentId4,
        razorpay_signature: sig4,
      },
    });
    assertEqual(res.status, 200, 'expected idempotent 200');
    assert(res.body.alreadyVerified === true, 'alreadyVerified flag');
    const after = await Order.findById(pending._id);
    assertEqual(after.paymentStatus, 'paid', 'still paid');
    assertEqual(after.razorpayPaymentId, before.razorpayPaymentId, 'payment id unchanged');
    assertEqual(sentEmails.length, 1, 'no duplicate confirmation email');
  });

  await check('stock is not decremented twice by duplicate verification', async () => {
    const p0 = await Product.findById(products2[0]._id);
    assertEqual(p0.stock, 8, 'product 0 stock unchanged');
  });

  // =======================================================================
  suite('4. Order success page endpoint (GET /api/orders/:id)');

  await check('paid order is fetchable by id for the success page', async () => {
    const res = await api('GET', `/api/orders/${pending._id}`, { token });
    assertEqual(res.status, 200, 'status');
    assertEqual(res.body.data._id, String(pending._id), 'order id');
    assertEqual(res.body.data.paymentStatus, 'paid', 'payment status');
    assert(res.body.data.totalAmount > 0, 'total amount');
  });

  await check('success page data is not readable by another user', async () => {
    const res = await api('GET', `/api/orders/${pending._id}`, { token: otherToken });
    assertEqual(res.status, 403, 'expected 403');
  });

  await check('success page survives a refresh (repeat fetch works)', async () => {
    const a = await api('GET', `/api/orders/${pending._id}`, { token });
    const b = await api('GET', `/api/orders/${pending._id}`, { token });
    assertEqual(a.body.data._id, b.body.data._id, 'stable across fetches');
    assertEqual(b.status, 200, 'second fetch');
  });

  // =======================================================================
  suite('5. Free-shipping threshold / multiple quantity / single product');

  await check('order above free-delivery threshold gets zero shipping', async () => {
    const big = await makeProducts([{ name: 'Expensive Part', price: 2000, mrp: 2000, stock: 5 }]);
    await setCart([{ product: big[0]._id, quantity: 1 }]);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 201, 'status');
    const o = await Order.findById(res.body.data.internalOrderId);
    assertEqual(o.shippingFee, 0, 'shipping fee');
    assertEqual(res.body.data.amount, Math.round(o.totalAmount * 100), 'amount matches');
    // clean up reservation
    o.orderStatus = 'cancelled';
    o.paymentStatus = 'failed';
    await o.save();
    const stockService = require(path.join(SERVER_ROOT, 'services/stockService'));
    await stockService.releaseStock(o);
  });

  await check('order below threshold pays delivery fee', async () => {
    const small = await makeProducts([{ name: 'Cheap Part', price: 100, mrp: 120, stock: 30 }]);
    await setCart([{ product: small[0]._id, quantity: 2 }]);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const o = await Order.findById(res.body.data.internalOrderId);
    const exp = expectedTotal([{ product: small[0], quantity: 2 }]);
    assertEqual(o.shippingFee, exp.shipping, 'shipping fee');
    assertEqual(o.totalAmount, exp.total, 'total');
    o.orderStatus = 'cancelled';
    o.paymentStatus = 'failed';
    await o.save();
    const stockService = require(path.join(SERVER_ROOT, 'services/stockService'));
    await stockService.releaseStock(o);
  });

  // =======================================================================
  suite('6. Webhook (raw body signature + idempotency)');

  /**
   * Posts a webhook the way Razorpay really does. Callers pass the entity
   * directly (`payment_entity` / `order_entity`) and this helper wraps it in the
   * genuine envelope - `payload.payment.entity` or `payload.order.entity` - so
   * the test exercises the production payload shape rather than a convenient
   * invention that could agree with a bug in the controller.
   */
  const postWebhook = async (event, payload, { secret, eventId, raw: rawOverride } = {}) => {
    const entity = payload.payment_entity || payload.order_entity;
    const envelopeKey = event.startsWith('order.') ? 'order' : 'payment';
    const realPayload = entity ? { [envelopeKey]: { entity } } : payload;
    const raw = rawOverride || JSON.stringify({ event, payload: realPayload });
    const signature = hmac(secret || process.env.RAZORPAY_WEBHOOK_SECRET, raw);
    return api('POST', '/api/payments/razorpay/webhook', {
      rawBody: raw,
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
        ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
      },
    });
  };

  await check('a real Razorpay payload.payment.entity webhook is understood', async () => {
    const products = await makeProducts([{ name: 'Shape Part', price: 900, mrp: 900, stock: 5 }]);
    const created = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const order = await Order.findById(created.body.data.internalOrderId);

    // Byte-for-byte the envelope Razorpay documents.
    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_shape_1',
            order_id: order.razorpayOrderId,
            amount: order.totalAmount * 100,
            currency: 'INR',
            status: 'captured',
            method: 'card',
            captured: true,
          },
        },
      },
    });
    const res = await postWebhook('payment.captured', {}, {
      raw,
      eventId: 'evt_shape_1',
    });
    assertEqual(res.status, 200, 'real webhook shape accepted');
    const after = await Order.findById(order._id);
    assertEqual(after.paymentStatus, 'paid', 'real webhook shape marks the order paid');
    assertEqual(after.razorpayPaymentId, 'pay_shape_1', 'payment id captured from entity');
    void products;
  });

  await check('webhook with a bad signature is rejected', async () => {
    const res = await postWebhook('payment.captured', { payment_entity: { id: 'pay_x', order_id: 'order_x' } }, {
      secret: 'wrong_secret',
    });
    assertEqual(res.status, 400, `expected 400, got ${res.status}`);
  });

  await check('webhook for an unknown order is ignored gracefully', async () => {
    const res = await postWebhook('payment.captured', {
      payment_entity: { id: 'pay_unknown', order_id: 'order_does_not_exist' },
    });
    assertEqual(res.status, 200, 'expected 200');
    assert(/ignored/i.test(res.body.message), `message: ${res.body.message}`);
  });

  // A real pending order for the webhook to act on.
  const whProducts = await makeProducts([{ name: 'Webhook Part', price: 500, mrp: 500, stock: 4 }]);
  await setCart([{ product: whProducts[0]._id, quantity: 1 }]);
  const whCreate = await api('POST', '/api/payments/razorpay/create-order', {
    token,
    body: { shippingAddress: ADDRESS },
  });
  const whOrder = await Order.findById(whCreate.body.data.internalOrderId);
  const whPaymentId = 'pay_webhook_1';

  await check('payment.captured webhook confirms a paid order', async () => {
    const res = await postWebhook('payment.captured', {
      payment_entity: { id: whPaymentId, order_id: whOrder.razorpayOrderId, amount: 50000 },
    }, { eventId: 'evt_captured_1' });
    assertEqual(res.status, 200, `expected 200: ${res.text}`);

    const after = await Order.findById(whOrder._id);
    assertEqual(after.paymentStatus, 'paid', 'paymentStatus');
    assertEqual(after.razorpayPaymentId, whPaymentId, 'payment id from webhook');
    assertEqual(after.orderStatus, 'confirmed', 'orderStatus');
  });

  await check('replayed webhook event id is a no-op', async () => {
    const stockBefore = (await Product.findById(whProducts[0]._id)).stock;
    const emailBefore = sentEmails.length;

    const res = await postWebhook('payment.captured', {
      payment_entity: { id: whPaymentId, order_id: whOrder.razorpayOrderId },
    }, { eventId: 'evt_captured_1' });
    assertEqual(res.status, 200, 'expected 200');
    assert(/already processed/i.test(res.body.message), `message: ${res.body.message}`);

    const stockAfter = (await Product.findById(whProducts[0]._id)).stock;
    assertEqual(stockAfter, stockBefore, 'stock unchanged on replay');
    assertEqual(sentEmails.length, emailBefore, 'no duplicate email on replay');
  });

  await check('payment.failed webhook cancels and releases stock', async () => {
    const failProducts = await makeProducts([{ name: 'Fail Part', price: 400, mrp: 400, stock: 6 }]);
    await setCart([{ product: failProducts[0]._id, quantity: 2 }]);
    const create = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const order = await Order.findById(create.body.data.internalOrderId);
    const reserved = (await Product.findById(failProducts[0]._id)).stock;
    assertEqual(reserved, 4, 'stock reserved');

    const res = await postWebhook('payment.failed', {
      payment_entity: {
        id: 'pay_failed_1',
        order_id: order.razorpayOrderId,
        error_description: 'Insufficient funds',
      },
    }, { eventId: 'evt_failed_1' });
    assertEqual(res.status, 200, 'expected 200');

    const after = await Order.findById(order._id);
    assertEqual(after.paymentStatus, 'failed', 'paymentStatus');
    assertEqual(after.orderStatus, 'cancelled', 'orderStatus');

    const restored = await Product.findById(failProducts[0]._id);
    assertEqual(restored.stock, 6, 'stock restored');
  });

  await check('repeated payment.failed does not double-restore stock', async () => {
    const failProducts = await makeProducts([{ name: 'Fail2 Part', price: 400, mrp: 400, stock: 6 }]);
    await setCart([{ product: failProducts[0]._id, quantity: 2 }]);
    const create = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const order = await Order.findById(create.body.data.internalOrderId);

    await postWebhook('payment.failed', {
      payment_entity: { id: 'pay_f2', order_id: order.razorpayOrderId },
    }, { eventId: 'evt_f2_a' });

    // A *different* event id, same failure - must not restore twice.
    await postWebhook('payment.failed', {
      payment_entity: { id: 'pay_f2', order_id: order.razorpayOrderId },
    }, { eventId: 'evt_f2_b' });

    const restored = await Product.findById(failProducts[0]._id);
    assertEqual(restored.stock, 6, 'stock restored exactly once');
  });

  await check('a paid order is never downgraded by a failed webhook', async () => {
    const res = await postWebhook('payment.failed', {
      payment_entity: { id: whPaymentId, order_id: whOrder.razorpayOrderId },
    }, { eventId: 'evt_late_fail' });
    assertEqual(res.status, 200, 'expected 200');
    const after = await Order.findById(whOrder._id);
    assertEqual(after.paymentStatus, 'paid', 'still paid');
  });

  await check('order.paid event also confirms the order', async () => {
    const opProducts = await makeProducts([{ name: 'OrderPaid Part', price: 700, mrp: 700, stock: 3 }]);
    await setCart([{ product: opProducts[0]._id, quantity: 1 }]);
    const create = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const order = await Order.findById(create.body.data.internalOrderId);

    const res = await postWebhook('order.paid', {
      order_entity: { id: order.razorpayOrderId, amount: 70000 },
    }, { eventId: 'evt_order_paid_1' });
    assertEqual(res.status, 200, 'expected 200');

    const after = await Order.findById(order._id);
    assertEqual(after.paymentStatus, 'paid', 'paymentStatus');
  });

  // =======================================================================
  suite('7. COD unaffected');

  await check('COD order is created, decrements stock and emails', async () => {
    const codProducts = await makeProducts([{ name: 'COD Part', price: 300, mrp: 300, stock: 5 }]);
    await setCart([{ product: codProducts[0]._id, quantity: 2 }]);
    sentEmails.length = 0;

    const res = await api('POST', '/api/orders', {
      token,
      body: { shippingAddress: ADDRESS, paymentMethod: 'cod' },
    });
    assertEqual(res.status, 201, `expected 201: ${res.text}`);

    const order = await Order.findById(res.body.data._id);
    assertEqual(order.paymentMethod, 'cod', 'paymentMethod');
    assertEqual(order.paymentStatus, 'cod', 'paymentStatus stays cod');
    assertEqual(order.orderStatus, 'pending', 'orderStatus');

    const product = await Product.findById(codProducts[0]._id);
    assertEqual(product.stock, 3, 'stock decremented');

    assertEqual(sentEmails.length, 1, 'confirmation email sent');
    const cart = await Cart.findOne({ user: user._id });
    assertEqual(cart.items.length, 0, 'cart cleared');
  });

  await check('COD cannot be created with paymentMethod=online via /api/orders', async () => {
    const guardProducts = await makeProducts([{ name: 'Guard Part', price: 300, mrp: 300, stock: 5 }]);
    await setCart([{ product: guardProducts[0]._id, quantity: 1 }]);
    const res = await api('POST', '/api/orders', {
      token,
      body: { shippingAddress: ADDRESS, paymentMethod: 'online' },
    });
    assertEqual(res.status, 400, 'expected 400');
    assert(/Razorpay/i.test(res.body.message), `message: ${res.body.message}`);
    const product = await Product.findById(guardProducts[0]._id);
    assertEqual(product.stock, 5, 'stock untouched');
  });

  await check('COD order has no razorpay fields populated', async () => {
    const codOrders = await Order.find({ user: user._id, paymentMethod: 'cod' }).sort({ createdAt: -1 });
    assert(codOrders.length > 0, 'no cod order found');
    assertEqual(codOrders[0].razorpayOrderId, '', 'razorpayOrderId empty');
    assertEqual(codOrders[0].razorpayPaymentId, '', 'razorpayPaymentId empty');
  });

  // =======================================================================
  suite('8. Stock never goes negative');

  await check('stock cannot be decremented below zero', async () => {
    const tiny = await makeProducts([{ name: 'Tiny Part', price: 100, mrp: 100, stock: 1 }]);
    const cartLine = { product: tiny[0]._id, quantity: 1 };
    await setCart([cartLine]);

    // First reservation takes the only unit.
    await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual((await Product.findById(tiny[0]._id)).stock, 0, 'stock now 0');

    // Change the cart to 5 units behind the server's back and retry.
    await setCart([{ product: tiny[0]._id, quantity: 5 }]);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 400, `expected 400, got ${res.status}`);

    const product = await Product.findById(tiny[0]._id);
    assert(product.stock >= 0, `stock must not be negative, got ${product.stock}`);
  });

  // =======================================================================
  suite('9. Security');

  await check('no endpoint leaks the key secret', async () => {
    const probes = [
      ['GET', '/api/health'],
      ['GET', '/api/settings'],
    ];
    for (const [method, url] of probes) {
      const res = await api(method, url);
      assert(!res.text.includes(process.env.RAZORPAY_KEY_SECRET), `secret leaked at ${url}`);
    }
  });

  await check('client bundle never contains the key secret', async () => {
    // The secret only exists in server/.env; confirm it is not in any client file.
    const fs = require('fs');
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const roots = [path.join(SERVER_ROOT, '..', 'client', 'src')];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|html|json)$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf8');
          assert(!content.includes(secret), `secret found in ${full}`);
        }
      }
    };
    roots.forEach(walk);
  });

  await check('VITE_ vars are not used for secrets on the server', async () => {
    const fs = require('fs');
    const content = fs.readFileSync(path.join(SERVER_ROOT, 'server.js'), 'utf8')
      + fs.readFileSync(path.join(SERVER_ROOT, 'config/razorpay.js'), 'utf8');
    assert(!content.includes('VITE_RAZORPAY_KEY_SECRET'), 'server must not read a VITE_ secret');
  });

  await check('a signature made with the wrong secret is rejected', async () => {
    const p = await makeProducts([{ name: 'Sec Part', price: 900, mrp: 900, stock: 2 }]);
    await setCart([{ product: p[0]._id, quantity: 1 }]);
    const create = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    const order = await Order.findById(create.body.data.internalOrderId);
    const fake = 'pay_attacker_1';
    const forged = hmac('attacker_secret', `${order.razorpayOrderId}|${fake}`);

    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(order._id),
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: fake,
        razorpay_signature: forged,
      },
    });
    assertEqual(res.status, 400, 'forged signature must be rejected');
    const after = await Order.findById(order._id);
    assertEqual(after.paymentStatus, 'pending', 'not paid');
  });

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\x1b[1mTOTAL: ${passed}/${results.length} passed\x1b[0m`);
  if (failed.length) {
    console.log('\n\x1b[31mFAILURES:\x1b[0m');
    failed.forEach((f) => console.log(`  - [${f.suite}] ${f.label}\n      ${f.error}`));
  }
  console.log('='.repeat(70));

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error('\nHarness crashed:', error);
  process.exit(1);
});
