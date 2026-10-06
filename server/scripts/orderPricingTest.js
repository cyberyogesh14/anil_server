/**
 * AnilKabadi order pricing invariant harness.
 *
 * `services/pricingService.js` is the source of truth for money. Every order it
 * creates stores:
 *
 *   grossSubtotal = SUM(mrp x qty)          (gross product value)
 *   discount      = SUM((mrp - price) x qty) (informational / accounting)
 *   subtotal      = SUM(price x qty)          <-- ALREADY NET of the discount
 *   gstAmount     = round(subtotal x gst%)
 *   totalAmount   = round(subtotal + shippingFee + gstAmount)
 *
 * So the stored-order invariants this suite enforces, to the paisa, are:
 *
 *   1. net subtotal   : subtotal === grossSubtotal - discount
 *   2. final payable  : totalAmount === subtotal + shippingFee + gstAmount
 *
 * `discount` is stored separately as an informational/accounting field and must
 * never be subtracted from `subtotal` again - doing so would take the audit's
 * own reference order from the authoritative Rs. 21,236.46 to Rs. 13,236.46.
 *
 * `totalAmount` is also the single figure the customer pays and the exact one
 * the admin and customer order screens display. This suite exists because the
 * admin order page used to re-add GST on top of the already-final total (audit
 * finding C1) and nothing caught it.
 *
 * Production pricing logic is never modified to satisfy this file; when a
 * hypothesis here disagrees with `pricingService`, the hypothesis is wrong.
 *
 * Booting notes: the REAL app runs against an in-memory MongoDB; only the
 * Razorpay SDK network calls and outbound email are faked.
 *
 * Run: node scripts/orderPricingTest.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '5102';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

// Known test-mode credentials so the harness can compute valid HMACs.
process.env.RAZORPAY_KEY_ID = 'rzp_test_PRICING_HARNESS';
process.env.RAZORPAY_KEY_SECRET = 'harness_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'harness_webhook_secret';

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(SERVER_ROOT, '..', 'client');

// ---------------------------------------------------------------------------
// Fake Razorpay SDK (no network, no real credentials)
// ---------------------------------------------------------------------------

let rzOrderSeq = 0;
const rzOrders = new Map();

class FakeRazorpay {
  constructor(opts) {
    this.key_id = opts.key_id;
    this.key_secret = opts.key_secret;
    this.orders = {
      create: async (payload) => {
        rzOrderSeq += 1;
        const order = {
          id: `order_price_${rzOrderSeq}`,
          amount: payload.amount,
          currency: payload.currency,
          receipt: payload.receipt,
        };
        rzOrders.set(order.id, order);
        return { ...order };
      },
    };
  }
}

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
    throw new Error(
      `${message || 'Mismatch'}: expected ${JSON.stringify(
        expected
      )}, got ${JSON.stringify(actual)}`
    );
  }
};

// The production rounding helper is reused verbatim so this harness can never
// disagree with `pricingService` about currency precision.
const { round2 } = require('../services/pricingService');

const hmac = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const BASE = `http://127.0.0.1:${process.env.PORT}`;

const api = async (method, url, { token, body, headers = {} } = {}) => {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let payload;
  if (body !== undefined) {
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
  return { status: res.status, body: json, text };
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const main = async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');

  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri('anilkabadi_pricing_test');
  console.log(`In-memory MongoDB: ${process.env.MONGO_URI}`);

  require(path.join(SERVER_ROOT, 'server.js'));
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const mongoose = require(path.join(SERVER_ROOT, 'node_modules/mongoose'));
  const Order = require(path.join(SERVER_ROOT, 'models/Order'));
  const Product = require(path.join(SERVER_ROOT, 'models/Product'));
  const Cart = require(path.join(SERVER_ROOT, 'models/Cart'));
  const User = require(path.join(SERVER_ROOT, 'models/User'));
  const Category = require(path.join(SERVER_ROOT, 'models/Category'));
  const Settings = require(path.join(SERVER_ROOT, 'models/Settings'));
  const emailService = require(path.join(SERVER_ROOT, 'services/emailService'));
  const stockService = require(path.join(SERVER_ROOT, 'services/stockService'));
  const { generateToken } = require(path.join(SERVER_ROOT, 'utils/generateToken'));

  emailService.sendOrderConfirmationEmail = async () => true;

  await mongoose.connection.asPromise();

  // --- Fixtures -----------------------------------------------------------
  const BASE_SETTINGS = { freeDeliveryThreshold: 999, deliveryFee: 99, gstPercentage: 18 };
  const SETTINGS = { ...BASE_SETTINGS };
  await Settings.deleteMany({});
  await Settings.create(BASE_SETTINGS);

  // Kept in step with the Settings document by the suite 4 tests, so the
  // expected GST can be recomputed synchronously per order.
  let gstPercent = BASE_SETTINGS.gstPercentage;
  const applySettings = async (patch) => {
    await Settings.updateOne({}, { $set: patch });
    Object.assign(SETTINGS, patch);
    gstPercent = Number(patch.gstPercentage ?? SETTINGS.gstPercentage) || 0;
  };
  const resetSettings = () => applySettings(BASE_SETTINGS);

  const stamp = Date.now();

  const customer = await User.create({
    name: 'Pricing Customer',
    email: `pricing-${stamp}@anilkabadi.test`,
    phone: '9876543210',
    password: 'test1234',
    isActive: true,
  });
  const token = generateToken(customer._id);

  const admin = await User.create({
    name: 'Pricing Admin',
    email: `pricing-admin-${stamp}@anilkabadi.test`,
    password: 'test1234',
    isActive: true,
    role: 'admin',
  });
  const adminToken = generateToken(admin._id);

  const ADDRESS = {
    fullName: 'Pricing Customer',
    phone: '9876543210',
    addressLine1: '12 MG Road',
    addressLine2: 'Near Bus Stop',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    country: 'India',
  };

  const category = await Category.create({ name: `Pricing Category ${stamp}` });

  const makeProduct = async (spec) =>
    Product.create({
      name: spec.name,
      description: 'Pricing test part',
      category: category._id,
      price: spec.price,
      mrp: spec.mrp,
      stock: spec.stock ?? 50,
      isActive: true,
      images: [],
    });

  const setCart = async (lines) => {
    await Cart.findOneAndDelete({ user: customer._id });
    return Cart.create({
      user: customer._id,
      items: lines.map((l) => ({ product: l.product, quantity: l.quantity, price: 0 })),
    });
  };

  const everyOrderCreated = [];

  /** Resolves the cart lines to full product documents (mrp/price) once. */
  const normaliseLines = async (lines) => {
    const docs = await Product.find({ _id: { $in: lines.map((l) => l.product) } });
    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    return lines.map((line) => ({
      product: byId.get(String(line.product)),
      quantity: line.quantity,
    }));
  };

  /**
   * Creates a COD order through the real endpoint and returns the stored
   * document, then applies the invariant check that every other test reuses.
   */
  const createCodOrder = async (lines, label) => {
    await setCart(lines);
    const res = await api('POST', '/api/orders', {
      token,
      body: { shippingAddress: ADDRESS, paymentMethod: 'cod' },
    });
    assertEqual(res.status, 201, `${label}: COD order not created (${res.text})`);
    const order = await Order.findById(res.body.data._id);
    everyOrderCreated.push({ label, order, lines: await normaliseLines(lines) });
    return order;
  };

  const createOnlineOrder = async (lines, label) => {
    await setCart(lines);
    const res = await api('POST', '/api/payments/razorpay/create-order', {
      token,
      body: { shippingAddress: ADDRESS },
    });
    assertEqual(res.status, 201, `${label}: online order not created (${res.text})`);
    const order = await Order.findById(res.body.data.internalOrderId);
    everyOrderCreated.push({
      label,
      order,
      lines: await normaliseLines(lines),
      razorpay: res.body.data,
    });
    return order;
  };

  /**
   * The money the order SHOULD contain, derived independently from the product
   * catalogue (`lines`) rather than from the stored order, so the assertions
   * below are a genuine cross-check and not a tautology.
   */
  const expectedMoney = (lines) => {
    const grossSubtotal = round2(
      lines.reduce((sum, { product, quantity }) => sum + product.mrp * quantity, 0)
    );
    const discount = round2(
      lines.reduce(
        (sum, { product, quantity }) => sum + (product.mrp - product.price) * quantity,
        0
      )
    );
    const netSubtotal = round2(
      lines.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0)
    );
    return { grossSubtotal, discount, netSubtotal };
  };

  /**
   * Invariant 1 - NET SUBTOTAL RELATIONSHIP.
   *
   * `order.subtotal` is stored net of the discount, so:
   *
   *   subtotal === grossSubtotal - discount
   *
   * where `grossSubtotal` is the MRP total of the ordered lines. `discount`
   * remains a separately stored informational/accounting field.
   */
  const assertNetSubtotalRelationship = (order, lines, label) => {
    const { grossSubtotal, discount, netSubtotal } = expectedMoney(lines);

    assert(
      lines.every((line) => line.product),
      `${label}: unresolved product document`
    );
    assertEqual(
      order.discount,
      discount,
      `${label}: discount !== SUM((mrp - price) x qty)`
    );
    // Invariant 1: the stored subtotal is the gross value minus the discount.
    assertEqual(
      order.subtotal,
      round2(grossSubtotal - order.discount),
      `${label}: subtotal !== grossSubtotal - discount`
    );
    // ...and it is exactly the selling-price total of the stored order lines,
    // with catalogue prices (never a client-supplied price).
    assertEqual(order.subtotal, netSubtotal, `${label}: subtotal !== SUM(price x qty)`);
    assertEqual(
      order.subtotal,
      round2(order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)),
      `${label}: subtotal !== stored items' price total`
    );
    [...order.items]
      .sort((a, b) => String(a.product).localeCompare(String(b.product)))
      .forEach((item) => {
        const line = lines.find((l) => String(l.product._id) === String(item.product));
        assert(line, `${label}: stored item ${item.name} is not an ordered line`);
        assertEqual(item.quantity, line.quantity, `${label}: ${item.name} quantity`);
        assertEqual(item.price, line.product.price, `${label}: ${item.name} price`);
      });
    assertEqual(order.items.length, lines.length, `${label}: item count`);
  };

  /**
   * Invariant 2 - FINAL PAYABLE RELATIONSHIP.
   *
   *   totalAmount === subtotal + shippingFee + gstAmount
   *
   * with the production rounding: `gstAmount = round2(Math.round(subtotal *
   * gst%) / 100)` exactly as pricingService computes it, and the total rounded
   * to two decimals.
   */
  const assertFinalPayableRelationship = (order, label) => {
    const expectedGst = round2(Math.round(order.subtotal * gstPercent) / 100);
    assertEqual(
      order.gstAmount,
      expectedGst,
      `${label}: gstAmount !== round(subtotal x ${gstPercent}%)`
    );
    assertEqual(
      order.totalAmount,
      round2(order.subtotal + order.shippingFee + order.gstAmount),
      `${label}: totalAmount !== subtotal + shippingFee + gstAmount`
    );
    // Both the stored total and its inputs are exact paisa amounts.
    [order.subtotal, order.shippingFee, order.gstAmount, order.totalAmount].forEach((value) => {
      assertEqual(round2(value), value, `${label}: ${value} is not rounded to 2 decimals`);
    });
  };

  /** Both invariants together - the contract every created order must hold. */
  const assertPricingContract = (order, lines, label) => {
    assertNetSubtotalRelationship(order, lines, label);
    assertFinalPayableRelationship(order, label);
  };

  /**
   * Same two invariants, looked up from the cart lines the order was created
   * with, so the individual `check` blocks stay readable.
   */
  const assertInvariant = (order, label) => {
    const record = everyOrderCreated.find(
      (entry) => String(entry.order._id) === String(order._id)
    );
    assert(record, `${label}: no recorded cart lines for order ${order._id}`);
    assertPricingContract(order, record.lines, label);
  };

  // =======================================================================
  suite('1. The pricing invariant holds for every shape of order');

  const singleNoDiscount = await makeProduct({ name: `Plain Part ${stamp}`, price: 500, mrp: 500, stock: 40 });

  await check('COD, single product, quantity 1, below free-shipping threshold', async () => {
    const order = await createCodOrder(
      [{ product: singleNoDiscount._id, quantity: 1 }],
      'COD single'
    );
    assertInvariant(order, 'COD single');
    assertEqual(order.discount, 0, 'no discount');
    assertEqual(order.shippingFee, SETTINGS.deliveryFee, 'delivery charged below threshold');
    assertEqual(order.subtotal, 500, 'subtotal');
  });

  await check('COD, multiple quantities', async () => {
    const order = await createCodOrder(
      [{ product: singleNoDiscount._id, quantity: 4 }],
      'COD multi-qty'
    );
    assertInvariant(order, 'COD multi-qty');
    assertEqual(order.items[0].quantity, 4, 'quantity stored');
    assertEqual(order.subtotal, 2000, 'subtotal scales with quantity');
  });

  const discounted = await makeProduct({
    name: `Discounted Part ${stamp}`,
    price: 4999,
    mrp: 6999,
    stock: 25,
  });

  await check('COD, discounted product', async () => {
    const order = await createCodOrder(
      [{ product: discounted._id, quantity: 1 }],
      'COD discounted'
    );
    assertInvariant(order, 'COD discounted');
    assertEqual(order.discount, 2000, 'mrp - price');
    assertEqual(order.subtotal, 4999, 'subtotal is net of discount');
  });

  const second = await makeProduct({ name: `Second Part ${stamp}`, price: 1000, mrp: 1000, stock: 30 });

  await check('COD, multiple products', async () => {
    const order = await createCodOrder(
      [
        { product: discounted._id, quantity: 2 },
        { product: second._id, quantity: 3 },
      ],
      'COD multi-product'
    );
    assertInvariant(order, 'COD multi-product');
    assertEqual(order.items.length, 2, 'two lines');
    assertEqual(order.subtotal, 4999 * 2 + 1000 * 3, 'subtotal');
    assertEqual(order.discount, 2000 * 2, 'discount across both lines of the discounted part');
    assertEqual(order.shippingFee, 0, 'free shipping above threshold');
  });

  await check('COD, paid shipping on a discounted product below the threshold', async () => {
    // Gross (MRP) 900 < 999 threshold, so delivery is charged even though the
    // discount makes the net subtotal smaller.
    const smallDiscounted = await makeProduct({
      name: `Small Discounted Part ${stamp}`,
      price: 400,
      mrp: 900,
      stock: 20,
    });
    const order = await createCodOrder(
      [{ product: smallDiscounted._id, quantity: 1 }],
      'COD paid shipping'
    );
    assertInvariant(order, 'COD paid shipping');
    assertEqual(order.discount, 500, 'discount recorded');
    assertEqual(order.subtotal, 400, 'net subtotal');
    assertEqual(order.shippingFee, 99, 'delivery charged below threshold');
    assertEqual(order.totalAmount, round2(400 + 99 + 72), 'total with delivery and gst');
  });

  await check('COD, a discount large enough to cross the threshold still ships free', async () => {
    // Gross 6999 is above the threshold even though the net is 4999.
    const order = await createCodOrder(
      [{ product: discounted._id, quantity: 1 }],
      'COD discounted free shipping'
    );
    assertInvariant(order, 'COD discounted free shipping');
    assertEqual(order.shippingFee, 0, 'free shipping judged on the gross MRP total');
  });

  await check('COD, free shipping (above threshold)', async () => {
    const order = await createCodOrder(
      [{ product: second._id, quantity: 5 }],
      'COD free shipping'
    );
    assertInvariant(order, 'COD free shipping');
    assertEqual(order.shippingFee, 0, 'zero shipping above threshold');
  });

  await check('COD, multiple products and multiple quantities together', async () => {
    const order = await createCodOrder(
      [
        { product: singleNoDiscount._id, quantity: 3 },
        { product: discounted._id, quantity: 2 },
        { product: second._id, quantity: 1 },
      ],
      'COD mixed basket'
    );
    assertInvariant(order, 'COD mixed basket');
    assertEqual(order.items.length, 3, 'three lines');
  });

  await check('Online (Razorpay) order also satisfies the invariant', async () => {
    const order = await createOnlineOrder(
      [{ product: discounted._id, quantity: 2 }],
      'online'
    );
    assertInvariant(order, 'online');
    assertEqual(order.paymentMethod, 'online', 'paymentMethod');
    assertEqual(order.paymentStatus, 'pending', 'pending until verified');
  });

  await check('every order created in this run satisfies both invariants', async () => {
    assert(everyOrderCreated.length >= 8, `expected at least 8 orders, got ${everyOrderCreated.length}`);
    for (const { label, order, lines } of everyOrderCreated) {
      assertPricingContract(order, lines, label);
    }
  });

  // =======================================================================
  suite('2. Reproduces the audit reference order exactly');

  // Audit §3.3: 2 x (4999 from 6999 MRP) + 1 x (7999 from 11999 MRP)
  const third = await makeProduct({ name: `Expensive Part ${stamp}`, price: 7999, mrp: 11999, stock: 10 });

  let auditOrder;
  const AUDIT_LINES = [
    { product: discounted._id, quantity: 2 },
    { product: third._id, quantity: 1 },
  ];

  await check('the audit order stores exactly the recorded figures', async () => {
    auditOrder = await createCodOrder(AUDIT_LINES, 'audit reference');

    // Audit 3.3: 2 x (4999 from 6999 MRP) + 1 x (7999 from 11999 MRP)
    assertEqual(
      round2(discounted.mrp * 2 + third.mrp),
      25997,
      'gross product value'
    );
    assertEqual(auditOrder.discount, 8000, 'discount');
    assertEqual(auditOrder.subtotal, 17997, 'subtotal (net of the discount)');
    assertEqual(auditOrder.shippingFee, 0, 'shipping');
    assertEqual(auditOrder.gstAmount, 3239.46, 'gst');
    assertEqual(auditOrder.totalAmount, 21236.46, 'total the customer pays');
  });

  await check('invariant 1: subtotal === grossSubtotal - discount', async () => {
    assertNetSubtotalRelationship(auditOrder, await normaliseLines(AUDIT_LINES), 'audit reference');

    const grossSubtotal = round2(discounted.mrp * 2 + third.mrp);
    assertEqual(grossSubtotal, 25997, 'grossSubtotal');
    assertEqual(
      round2(grossSubtotal - auditOrder.discount),
      17997,
      'grossSubtotal - discount'
    );
    assertEqual(
      round2(auditOrder.subtotal + auditOrder.discount),
      grossSubtotal,
      'the discount is accounted for exactly once'
    );
  });

  await check('invariant 2: totalAmount === subtotal + shippingFee + gstAmount', async () => {
    assertFinalPayableRelationship(auditOrder, 'audit reference');

    assertEqual(
      round2(auditOrder.subtotal + auditOrder.shippingFee + auditOrder.gstAmount),
      21236.46,
      '17,997 + 0 + 3,239.46'
    );
  });

  await check('the discount is never subtracted from an already-net subtotal', async () => {
    // Reading the stored (net) subtotal as gross would give Rs. 13,236.46 -
    // Rs. 8,000 short of what the customer actually pays. This guards the
    // regression in both the stored order and the admin/customer screens.
    const doubleDiscounted = round2(
      auditOrder.subtotal - auditOrder.discount + auditOrder.shippingFee + auditOrder.gstAmount
    );
    assertEqual(doubleDiscounted, 13236.46, 'the wrong figure, for contrast only');
    assert(
      auditOrder.totalAmount !== doubleDiscounted,
      'order.subtotal is already net: the discount must not be subtracted again'
    );
    assertEqual(
      round2(
        round2(discounted.mrp * 2 + third.mrp) - auditOrder.discount + auditOrder.shippingFee + auditOrder.gstAmount
      ),
      auditOrder.totalAmount,
      'grossSubtotal - discount + shippingFee + gstAmount'
    );
  });

  await check('the customer payable amount equals order.totalAmount', async () => {
    const customerView = await api('GET', `/api/orders/${auditOrder._id}`, { token });
    assertEqual(customerView.status, 200, 'customer order fetch');
    assertEqual(customerView.body.data.totalAmount, 21236.46, 'customer sees the payable total');
  });

  await check('the admin view exposes the same stored totals', async () => {
    const adminView = await api('GET', `/api/admin/orders/${auditOrder._id}`, {
      token: adminToken,
    });
    assertEqual(adminView.status, 200, 'admin order fetch');

    const d = adminView.body.data;
    assertEqual(d.subtotal, 17997, 'admin subtotal');
    assertEqual(d.discount, 8000, 'admin discount');
    assertEqual(d.shippingFee, 0, 'admin shipping');
    assertEqual(d.gstAmount, 3239.46, 'admin gst');
    assertEqual(d.totalAmount, 21236.46, 'admin total');

    // The figure the admin screen shows must be order.totalAmount verbatim,
    // never totalAmount + shipping + gst recomputed in the browser.
    const legacyOverstatement = round2(
      d.totalAmount + (d.totalAmount >= 999 ? 0 : 99) + Math.round(d.totalAmount * 0.18)
    );
    assertEqual(d.totalAmount, 21236.46, 'stored total');
    assertEqual(legacyOverstatement, 25059.46, 'the old buggy admin figure is what must NOT be used');
  });

  // =======================================================================
  suite('3. Online amount matches the stored total exactly');

  let onlineOrder;
  await check('the Razorpay amount is the stored total in paise', async () => {
    onlineOrder = await createOnlineOrder(
      [{ product: second._id, quantity: 2 }],
      'online amount'
    );
    const rz = rzOrders.get(onlineOrder.razorpayOrderId);
    assert(rz, 'razorpay order recorded');
    assertEqual(rz.amount, Math.round(onlineOrder.totalAmount * 100), 'paise amount');
    assertInvariant(onlineOrder, 'online amount');
  });

  await check('after verification the total is unchanged (only the status moves)', async () => {
    const totalBefore = onlineOrder.totalAmount;
    const paymentId = 'pay_pricing_1';
    const signature = hmac(
      process.env.RAZORPAY_KEY_SECRET,
      `${onlineOrder.razorpayOrderId}|${paymentId}`
    );

    const res = await api('POST', '/api/payments/razorpay/verify', {
      token,
      body: {
        internalOrderId: String(onlineOrder._id),
        razorpay_order_id: onlineOrder.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
    });
    assertEqual(res.status, 200, `verification failed: ${res.text}`);

    const after = await Order.findById(onlineOrder._id);
    assertEqual(after.totalAmount, totalBefore, 'total must not move on verification');
    assertEqual(after.paymentStatus, 'paid', 'marked paid');
    assertInvariant(after, 'after verification');
  });

  await check('the paid amount the customer sees is still the stored total', async () => {
    const view = await api('GET', `/api/orders/${onlineOrder._id}`, { token });
    assertEqual(view.body.data.totalAmount, onlineOrder.totalAmount, 'customer total');
    assertInvariant(view.body.data, 'customer view');
  });

  // =======================================================================
  suite('4. Settings drive the pricing consistently');

  await check('a changed delivery fee is reflected and the invariant still holds', async () => {
    await applySettings({ deliveryFee: 149 });
    const cheap = await makeProduct({ name: `Cheap Part ${stamp}`, price: 100, mrp: 100, stock: 20 });
    const order = await createCodOrder([{ product: cheap._id, quantity: 1 }], 'fee 149');
    assertEqual(order.shippingFee, 149, 'new fee applied');
    assertInvariant(order, 'fee 149');
    await resetSettings();
  });

  await check('free delivery for everything when the fee is 0', async () => {
    await applySettings({ deliveryFee: 0 });
    const cheap = await makeProduct({ name: `Zero Fee Part ${stamp}`, price: 100, mrp: 100, stock: 20 });
    const order = await createCodOrder([{ product: cheap._id, quantity: 1 }], 'fee 0');
    assertEqual(order.shippingFee, 0, 'no delivery charge');
    assertEqual(order.totalAmount, round2(order.subtotal + order.gstAmount), 'total without shipping');
    assertInvariant(order, 'fee 0');
    await resetSettings();
  });

  await check('a zero-GST setting produces a zero GST amount', async () => {
    await applySettings({ gstPercentage: 0 });
    const order = await createCodOrder(
      [{ product: singleNoDiscount._id, quantity: 1 }],
      'gst 0'
    );
    assertEqual(order.gstAmount, 0, 'no gst');
    assertInvariant(order, 'gst 0');
    await resetSettings();
  });

  // =======================================================================
  suite('5. Order screens render the stored values (audit C1 regression guard)');

  const readSource = (relative) =>
    fs.readFileSync(path.join(CLIENT_ROOT, relative), 'utf8');

  await check('the admin order page reads totals from the order document', async () => {
    const src = readSource('src/pages/admin/OrderDetails.jsx');

    ['order.subtotal', 'order.discount', 'order.shippingFee', 'order.gstAmount', 'order.totalAmount'].forEach(
      (token) => {
        assert(src.includes(token), `admin page must read ${token}`);
      }
    );
  });

  await check('the admin order page no longer re-derives shipping or GST', async () => {
    const src = readSource('src/pages/admin/OrderDetails.jsx');
    const forbidden = [
      /totalAmount\s*>=\s*999/,          // hardcoded free-shipping threshold
      /Math\.round\(order\.totalAmount/, // GST recomputed on the final total
      /subtotal \+ deliveryCharge \+ tax/,
    ];
    forbidden.forEach((pattern) => {
      assert(!pattern.test(src), `admin page still contains ${pattern}`);
    });
  });

  await check('the customer order page is unchanged and still uses stored values', async () => {
    const src = readSource('src/pages/OrderDetails.jsx');
    ['order.subtotal', 'order.shippingFee', 'order.gstAmount', 'order.totalAmount'].forEach((token) => {
      assert(src.includes(token), `customer page must read ${token}`);
    });
    assert(!/Math\.round\(order\.totalAmount/.test(src), 'customer page must not recompute GST');
  });

  await check('the cart estimate mirrors the server pricing service fallbacks', async () => {
    const src = readSource('src/context/CartContext.jsx');
    assert(
      /Number\(settings\.deliveryFee\)\s*\|\|\s*0/.test(src),
      'CartContext must fall back to 0 for a missing deliveryFee, like pricingService does'
    );
    assert(!/settings\.deliveryFee\s*\|\|\s*99/.test(src), 'CartContext must not fall back to 99');
  });

  await check('no client file recalculates order totals on the server pricing path', async () => {
    // The client may estimate a cart, but must never send a total the server
    // would have to trust.
    const checkout = readSource('src/pages/Checkout.jsx');
    assert(
      !/totalAmount\s*[:,=]/.test(checkout),
      'Checkout must not pass a totalAmount to the order API'
    );
  });

  // =======================================================================
  suite('6. Stock and totals stay consistent');

  await check('COD stock is decremented exactly once and never restored by mistake', async () => {
    const tracked = await makeProduct({ name: `Stock Tracked ${stamp}`, price: 100, mrp: 100, stock: 5 });
    const order = await createCodOrder([{ product: tracked._id, quantity: 2 }], 'stock');
    const after = await Product.findById(tracked._id);
    assertEqual(after.stock, 3, 'stock decremented once');
    assertInvariant(order, 'stock');

    // COD never takes a reservation (it decrements on creation), so a release
    // must be a no-op rather than handing back units that were already sold.
    const released = await stockService.releaseStock(order);
    assertEqual(released, false, 'release must refuse an unreserved COD order');
    const unchanged = await Product.findById(tracked._id);
    assertEqual(unchanged.stock, 3, 'stock still decremented after a refused release');
    assertEqual(order.totalAmount, round2(200 + 99 + 36), 'total unchanged by stock movement');
  });

  await check('an online reservation is released exactly once', async () => {
    const tracked = await makeProduct({ name: `Reserved Part ${stamp}`, price: 100, mrp: 100, stock: 4 });
    const order = await createOnlineOrder(
      [{ product: tracked._id, quantity: 1 }],
      'reservation'
    );
    assertEqual((await Product.findById(tracked._id)).stock, 3, 'reserved');

    assertEqual(await stockService.releaseStock(order), true, 'first release works');
    assertEqual(await stockService.releaseStock(order), false, 'second release refused');
    assertEqual((await Product.findById(tracked._id)).stock, 4, 'restored exactly once');
    assertInvariant(order, 'reservation');
  });

  await check('cancelling does not alter the recorded totals', async () => {
    const order = everyOrderCreated[0].order;
    const before = { ...order.toObject() };
    order.orderStatus = 'cancelled';
    await order.save();
    const after = await Order.findById(order._id);
    assertEqual(after.totalAmount, before.totalAmount, 'total unchanged on cancel');
    assertEqual(after.subtotal, before.subtotal, 'subtotal unchanged on cancel');
    assertInvariant(after, 'cancelled order');
  });

  // =======================================================================
  suite('7. Cart, wishlist and role gates are untouched');

  await check('an unauthenticated cart request is rejected (401)', async () => {
    const res = await api('GET', '/api/cart');
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  await check('cart add / quantity / remove all work', async () => {
    const item = await makeProduct({ name: `Cart Part ${stamp}`, price: 250, mrp: 300, stock: 12 });
    await api('DELETE', '/api/cart', { token });

    const added = await api('POST', '/api/cart', {
      token,
      body: { productId: String(item._id), quantity: 2 },
    });
    assertEqual(added.status, 200, `add: ${added.text}`);
    assertEqual(added.body.data.items.length, 1, 'one line');

    const updated = await api('PUT', `/api/cart/${item._id}`, {
      token,
      body: { quantity: 5 },
    });
    assertEqual(updated.status, 200, `update: ${updated.text}`);
    const line = updated.body.data.items.find((i) => i.product?._id === String(item._id));
    assertEqual(line.quantity, 5, 'quantity updated');

    const removed = await api('DELETE', `/api/cart/${item._id}`, { token });
    assertEqual(removed.status, 200, `remove: ${removed.text}`);
    assertEqual(removed.body.data.items.length, 0, 'cart emptied');
  });

  await check('wishlist add and remove work', async () => {
    const item = await makeProduct({ name: `Wishlist Part ${stamp}`, price: 400, mrp: 400, stock: 5 });

    const added = await api('POST', `/api/wishlist/${item._id}`, { token });
    assertEqual(added.status, 201, `add: ${added.text}`);

    // The endpoint returns wishlist entries with the product populated.
    const listed = await api('GET', '/api/wishlist', { token });
    assertEqual(listed.status, 200, 'list');
    assert(
      listed.body.data.some((entry) => entry.product?._id === String(item._id)),
      'item present in wishlist'
    );

    const removed = await api('DELETE', `/api/wishlist/${item._id}`, { token });
    assertEqual(removed.status, 200, `remove: ${removed.text}`);

    const after = await api('GET', '/api/wishlist', { token });
    assert(
      !after.body.data.some((entry) => entry.product?._id === String(item._id)),
      'item removed from wishlist'
    );
  });

  await check('an admin can manage orders but only an admin sees users', async () => {
    const orders = await api('GET', '/api/admin/orders', { token: adminToken });
    assertEqual(orders.status, 200, `admin orders: ${orders.text}`);

    const users = await api('GET', '/api/admin/users', { token: adminToken });
    assertEqual(users.status, 200, `admin users: ${users.text}`);

    const settings = await api('GET', '/api/settings');
    assertEqual(settings.status, 200, `public settings: ${settings.text}`);
    assert(settings.body.data.deliveryFee !== undefined, 'deliveryFee exposed');
  });

  await check('staff keeps order access but is refused admin-only areas', async () => {
    const staff = await User.create({
      name: 'Pricing Staff',
      email: `pricing-staff-${stamp}@anilkabadi.test`,
      password: 'test1234',
      isActive: true,
      role: 'staff',
    });
    const staffToken = generateToken(staff._id);

    const orders = await api('GET', '/api/admin/orders', { token: staffToken });
    assertEqual(orders.status, 200, `staff orders: ${orders.text}`);

    const users = await api('GET', '/api/admin/users', { token: staffToken });
    assertEqual(users.status, 403, `staff users must be refused: ${users.text}`);

    const emails = await api('GET', '/api/admin/emails', { token: staffToken });
    assertEqual(emails.status, 403, `staff emails must be refused: ${emails.text}`);
  });

  await check('a customer cannot reach the admin area at all', async () => {
    const res = await api('GET', '/api/admin/orders', { token });
    assertEqual(res.status, 403, `expected 403, got ${res.status}: ${res.text}`);
  });

  // =======================================================================
  suite('8. Currency rounding is identical to production, to the paisa');

  await check('a GST amount landing on a half-paise rounds up like production', async () => {
    // net 3.50 at 5% => 17.5 paise-worth, which production rounds half-up:
    // Math.round(3.5 * 5) / 100 === 0.18.
    await applySettings({ gstPercentage: 5, deliveryFee: 99 });
    const cheap = await makeProduct({ name: `Paisa Part ${stamp}`, price: 3.5, mrp: 3.5, stock: 50 });
    const lines = [{ product: cheap._id, quantity: 1 }];
    const order = await createCodOrder(lines, 'half-paise');

    assertEqual(order.subtotal, 3.5, 'net subtotal');
    assertEqual(order.discount, 0, 'no discount');
    assertEqual(order.shippingFee, 99, 'below the threshold, so delivery is charged');
    assertEqual(order.gstAmount, 0.18, 'GST rounds half-up to 0.18');
    assertEqual(order.totalAmount, 102.68, '3.50 + 99 + 0.18');
    assertPricingContract(order, await normaliseLines(lines), 'half-paise');
    await resetSettings();
  });

  await check('fractional rupee prices stay exact through tax and shipping', async () => {
    // net 3 x 1234.56 = 3703.68; GST 18% => round(66666.24)/100 = 666.66;
    // gross 3 x 1500 = 4500 is above the threshold, so delivery is free.
    const lines = await (async () => {
      const part = await makeProduct({ name: `Fractional Part ${stamp}`, price: 1234.56, mrp: 1500, stock: 20 });
      return [{ product: part._id, quantity: 3 }];
    })();

    const order = await createOnlineOrder(lines, 'fractional rupees');
    const products = await normaliseLines(lines);
    assertPricingContract(order, products, 'fractional rupees');

    assertEqual(order.subtotal, 3703.68, 'net subtotal to the paisa');
    assertEqual(order.discount, 796.32, 'discount = (1500 - 1234.56) x 3');
    assertEqual(order.shippingFee, 0, 'free delivery on the gross total');
    assertEqual(order.gstAmount, 666.66, 'GST to the paisa');
    assertEqual(order.totalAmount, 4370.34, 'total to the paisa');

    // No floating-point drift: every stored figure is an exact 2dp value and
    // the paise amount handed to Razorpay is a whole number of paise.
    [order.subtotal, order.shippingFee, order.gstAmount, order.totalAmount].forEach((value) => {
      assertEqual(round2(value), value, `${value} has sub-paise drift`);
      assert(Number.isInteger(Math.round(value * 100)), `${value} is not a whole paisa amount`);
    });
    const rz = rzOrders.get(order.razorpayOrderId);
    assert(rz, 'razorpay order recorded');
    assertEqual(rz.amount, 437034, '4370.34 rupees is 437034 paise');
  });

  await check('paid shipping plus discount plus GST adds up to the paisa', async () => {
    await applySettings({ deliveryFee: 149.5 });

    // Above the free-delivery threshold on the gross MRP total: free delivery.
    const part = await makeProduct({ name: `Priced Part ${stamp}`, price: 333.33, mrp: 500, stock: 30 });
    const lines = [{ product: part._id, quantity: 3 }];
    const order = await createCodOrder(lines, 'odd delivery fee');
    // Under the threshold on the gross MRP total: the odd delivery fee applies.
    const small = await makeProduct({ name: `Odd Fee Part ${stamp}`, price: 199.99, mrp: 250, stock: 30 });
    const smallLines = [{ product: small._id, quantity: 2 }];
    const order2 = await createCodOrder(smallLines, 'odd delivery fee 2');

    assertEqual(order.discount, 500.01, '(500 - 333.33) x 3 = 500.01');
    assertEqual(order.subtotal, 999.99, 'net subtotal');
    assertEqual(order.shippingFee, 0, 'gross 1500 is above the threshold');
    assertEqual(order.gstAmount, 180, '999.99 * 18% = 180.00 (rounded)');
    assertEqual(order.totalAmount, 1179.99, '999.99 + 0 + 180');
    assertPricingContract(order, await normaliseLines(lines), 'odd delivery fee');

    assertEqual(order2.discount, 100.02, '(250 - 199.99) x 2 = 100.02');
    assertEqual(order2.subtotal, 399.98, 'net subtotal');
    assertEqual(order2.shippingFee, 149.5, 'the odd delivery fee is charged as stored');
    assertEqual(order2.gstAmount, 72, '399.98 * 18% = 72.00 (rounded)');
    assertEqual(order2.totalAmount, 621.48, '399.98 + 149.50 + 72.00');
    assertPricingContract(order2, await normaliseLines(smallLines), 'odd delivery fee 2');
    await resetSettings();
  });

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\x1b[1mTOTAL: ${passed}/${results.length} passed\x1b[0m`);
  if (failed.length) {
    console.log('\n\x1b[31mFAILURES:\x1b[0m');
    failed.forEach((f) =>
      console.log(`  - [${f.suite}] ${f.label}\n      ${f.error}`)
    );
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