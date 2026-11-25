/**
 * AnilKabadi Shiprocket shipping integration harness.
 *
 * Boots the REAL server (routes, controllers, models, services) against an
 * in-memory MongoDB. Only two things are faked:
 *
 *   1. the Shiprocket HTTP transport (services/shiprocket.service.js exposes a
 *      test-only transport hook, so no real credentials are used)
 *   2. outbound email
 *
 * Everything else is production code: checkout rating and fallback, order
 * creation, shipment claiming/idempotency, AWB/label/manifest/pickup/cancel,
 * tracking persistence, webhook authentication and status mapping, and the
 * admin/customer access rules.
 *
 * Run: node scripts/shippingIntegrationTest.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '5103';
process.env.JWT_SECRET = 'shipping_test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

// Fully configured Shiprocket so the live path is exercised.
process.env.SHIPROCKET_EMAIL = 'shipping-harness@anilkabadi.test';
process.env.SHIPROCKET_PASSWORD = 'harness_password';
process.env.SHIPROCKET_BASE_URL = 'https://shiprocket.test/v1/external';
process.env.SHIPROCKET_WEBHOOK_SECRET = 'harness_shiprocket_webhook_secret';
process.env.SHIPROCKET_PICKUP_LOCATION = 'Harness Warehouse';
process.env.SHIPROCKET_PICKUP_PINCODE = '411001';
process.env.SHIPROCKET_SHIPPING_MODE = 'shiprocket';
process.env.SHIPROCKET_AUTO_ASSIGN_AWB = 'false';
process.env.SHIPROCKET_AUTO_GENERATE_LABEL = 'false';
process.env.SHIPROCKET_AUTO_REQUEST_PICKUP = 'false';

process.env.API_RATE_LIMIT_MAX = '100000';
process.env.SHIPPING_RATE_LIMIT_MAX = '100000';
process.env.SHIPROCKET_WEBHOOK_RATE_LIMIT_MAX = '100000';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const crypto = require('crypto');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

/* -------------------------------------------------------------------------- *
 * Fake Shiprocket transport
 * -------------------------------------------------------------------------- */

const fake = {
  serviceable: true,
  created: [],
  calls: [],
  tokenSeq: 0,
  nextOrderId: 9000,
  nextShipmentId: 7000,
  nextAwb: 4000,
  trackingStatus: 'SHIPPED',
  trackingActivities: null,
};

const pathOf = (url) => {
  try {
    return new URL(url, 'https://shiprocket.test').pathname;
  } catch {
    return String(url);
  }
};

const json = (data) => ({ data });

const fakeTransport = {
  async post(url) {
    fake.calls.push({ method: 'POST_AUTH', url: pathOf(url) });
    if (!pathOf(url).endsWith('/auth/login')) {
      throw new Error(`Unexpected auth POST ${url}`);
    }
    fake.tokenSeq += 1;
    return json({ token: `fake_shiprocket_token_${fake.tokenSeq}` });
  },

  async request(config) {
    const route = pathOf(config.url);
    fake.calls.push({
      method: config.method,
      url: route,
      data: config.data,
      params: config.params,
    });

    if (route === '/courier/serviceability/') {
      return json({
        data: {
          recommended_courier_company_id: fake.serviceable ? 7 : null,
          available_courier_companies: fake.serviceable
            ? [
                {
                  courier_company_id: 7,
                  courier_name: 'Harness Express',
                  rate: 120,
                  cod_charges: 20,
                  estimated_delivery_days: '2-4',
                  expected_delivery_date: '2026-11-12',
                },
                {
                  courier_company_id: 8,
                  courier_name: 'Harness Economy',
                  rate: 150,
                  cod_charges: 10,
                  estimated_delivery_days: '4-6',
                },
              ]
            : [],
        },
      });
    }

    if (route === '/orders/create/adhoc') {
      fake.created.push(config.data);
      fake.nextOrderId += 1;
      fake.nextShipmentId += 1;
      return json({
        order_id: fake.nextOrderId,
        shipment_id: fake.nextShipmentId,
        status: 'NEW',
        awb_code: '',
        courier_name: '',
      });
    }

    if (route === '/courier/assign/awb') {
      fake.nextAwb += 1;
      return json({
        response: {
          data: {
            awb_code: `AWB${fake.nextAwb}`,
            courier_name: 'Harness Express',
            courier_company_id: 7,
          },
        },
      });
    }

    if (route === '/courier/generate/label') {
      return json({ label_url: 'https://labels.anilkabadi.test/harness.pdf' });
    }

    if (route === '/manifests/generate') {
      return json({
        manifest_url: 'https://manifests.anilkabadi.test/harness.pdf',
      });
    }

    if (route === '/courier/generate/pickup') {
      return json({
        pickup_token_number: 'PICKUP-HARNESS-1',
        pickup_scheduled_date: '2026-11-10 10:00',
        status: 'scheduled',
      });
    }

    if (route === '/orders/cancel') {
      return json({ message: 'Order cancelled successfully' });
    }

    if (route === '/orders/cancel/shipment/awbs') {
      return json({ message: 'Shipments cancelled successfully' });
    }

    if (route.startsWith('/courier/track/awb/')) {
      return json({
        tracking_data: {
          shipment_status: 7,
          track_status: 7,
          awb_code: config.url.split('/').pop(),
          courier_name: 'Harness Express',
          current_status: fake.trackingStatus,
          etd: '2026-11-12',
          shipment_track: [
            {
              awb_code: config.url.split('/').pop(),
              courier_name: 'Harness Express',
              current_status: fake.trackingStatus,
              delivered_date: '',
              origin: 'Pune',
              destination: 'Mumbai',
            },
          ],
          shipment_track_activities:
            fake.trackingActivities ||
            [
              {
                date: '2026-11-08 09:00',
                status: 'PICKED UP',
                activity: 'Shipment picked up',
                location: 'Pune',
              },
              {
                date: '2026-11-09 12:00',
                status: fake.trackingStatus,
                activity: `Shipment ${fake.trackingStatus.toLowerCase()}`,
                location: 'Mumbai',
              },
            ],
        },
      });
    }

    if (route === '/settings/company/pickup') {
      return json({
        data: {
          shipping_address: [
            {
              pickup_location: 'Harness Warehouse',
              city: 'Pune',
              state: 'Maharashtra',
              pin_code: '411001',
              is_default: true,
            },
          ],
        },
      });
    }

    if (route.startsWith('/orders/show/')) {
      return json({ data: { status: 'NEW' } });
    }

    throw new Error(`Unhandled fake Shiprocket route: ${config.method} ${route}`);
  },
};

/* -------------------------------------------------------------------------- *
 * Tiny runner
 * -------------------------------------------------------------------------- */

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

const hmac = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

const round2 = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/* -------------------------------------------------------------------------- *
 * HTTP helper
 * -------------------------------------------------------------------------- */

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
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }

  return { status: res.status, body: parsed, text };
};

const waitFor = async (label, fn, { timeout = 8000, interval = 100 } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`${label} timed out after ${timeout}ms`);
};

/* -------------------------------------------------------------------------- *
 * Boot
 * -------------------------------------------------------------------------- */

const main = async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');

  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri('anilkabadi_shipping_test');
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
  const shiprocketService = require(path.join(
    SERVER_ROOT,
    'services/shiprocket.service'
  ));
  const { generateToken } = require(path.join(
    SERVER_ROOT,
    'utils/generateToken'
  ));

  emailService.sendOrderConfirmationEmail = async () => true;
  emailService.sendOrderStatusEmail = async () => true;

  shiprocketService.setTransportForTests(fakeTransport);
  shiprocketService.resetAuthForTests();

  await mongoose.connection.asPromise();

  /* Fixtures -------------------------------------------------------------- */

  await Settings.deleteMany({});
  await Settings.create({
    freeDeliveryThreshold: 999,
    deliveryFee: 99,
    gstPercentage: 18,
  });

  const stamp = Date.now();

  const customer = await User.create({
    name: 'Shipping Customer',
    email: `shipping-${stamp}@anilkabadi.test`,
    phone: '9876543210',
    password: 'test1234',
    isActive: true,
  });
  const token = generateToken(customer._id);

  const otherCustomer = await User.create({
    name: 'Other Customer',
    email: `shipping-other-${stamp}@anilkabadi.test`,
    phone: '9876543211',
    password: 'test1234',
    isActive: true,
  });
  const otherToken = generateToken(otherCustomer._id);

  const admin = await User.create({
    name: 'Shipping Admin',
    email: `shipping-admin-${stamp}@anilkabadi.test`,
    password: 'test1234',
    isActive: true,
    role: 'admin',
  });
  const adminToken = generateToken(admin._id);

  const category = await Category.create({ name: `Shipping Category ${stamp}` });

  const product = await Product.create({
    name: 'Shipping Test Part',
    description: 'Shipping integration test part',
    category: category._id,
    price: 500,
    mrp: 600,
    stock: 50,
    isActive: true,
    images: [],
    weight: 1.2,
    length: 25,
    breadth: 20,
    height: 15,
    hsnCode: '87089900',
  });

  const ADDRESS = {
    fullName: 'Shipping Customer',
    phone: '9876543210',
    addressLine1: '12 MG Road',
    addressLine2: 'Near Bus Stop',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    country: 'India',
  };

  const setCart = async (quantity = 1) => {
    await Cart.findOneAndDelete({ user: customer._id });
    return Cart.create({
      user: customer._id,
      items: [{ product: product._id, quantity, price: 0 }],
    });
  };

  const createCodOrder = async (label) => {
    await setCart(1);
    const res = await api('POST', '/api/orders', {
      token,
      body: { shippingAddress: ADDRESS, paymentMethod: 'cod' },
    });
    assertEqual(res.status, 201, `${label}: order creation (${res.text})`);
    return Order.findById(res.body.data._id);
  };

  const confirmViaAdmin = async (orderId) => {
    const res = await api('PUT', `/api/admin/orders/${orderId}/status`, {
      token: adminToken,
      body: { orderStatus: 'confirmed' },
    });
    assertEqual(res.status, 200, `admin confirm (${res.text})`);
  };

  const waitUntilShipped = (orderId) =>
    waitFor('shipment creation', async () => {
      const current = await Order.findById(orderId);
      return current?.shipping?.shiprocketOrderId ? current : null;
    });

  /* ======================================================================= *
   * 1. Configuration and rating
   * ======================================================================= */

  suite('1. Configuration and live rating');

  await check('public config reports a fully configured integration', async () => {
    const res = await api('GET', '/api/shipping/config');
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.configured, true, 'configured');
    assertEqual(res.body.data.pricingEnabled, true, 'pricingEnabled');
    assertEqual(res.body.data.shipmentReady, true, 'shipmentReady');
    assert(!res.text.includes('harness_password'), 'password leaked');
    assert(
      !res.text.includes(process.env.SHIPROCKET_WEBHOOK_SECRET),
      'webhook secret leaked'
    );
  });

  await check('quote requires authentication', async () => {
    const res = await api('POST', '/api/shipping/quote', {
      body: { pincode: '400001', paymentMethod: 'cod' },
    });
    assertEqual(res.status, 401, 'anonymous quote must be rejected');
  });

  await check('COD quote uses the cheapest courier plus COD charge', async () => {
    await setCart(1);
    const res = await api('POST', '/api/shipping/quote', {
      token,
      body: { pincode: '400001', paymentMethod: 'cod' },
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.used, true, 'used');
    assertEqual(res.body.data.available, true, 'available');
    // Harness Express: 120 rate + 20 COD charge = 140.
    assertEqual(res.body.data.shippingFee, 140, 'COD shipping fee');
    assertEqual(res.body.data.courier.name, 'Harness Express', 'courier');
    assertEqual(res.body.data.package.weight, 1.2, 'package weight');
  });

  await check('prepaid quote excludes the COD charge', async () => {
    const res = await api('POST', '/api/shipping/quote', {
      token,
      body: { pincode: '400001', paymentMethod: 'online' },
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.shippingFee, 120, 'prepaid shipping fee');
  });

  await check('invalid pincode is rejected', async () => {
    const res = await api('POST', '/api/shipping/quote', {
      token,
      body: { pincode: '12', paymentMethod: 'cod' },
    });
    assertEqual(res.status, 400, res.text);
  });

  await check('unserviceable pincode falls back to the Settings fee', async () => {
    fake.serviceable = false;
    try {
      const res = await api('POST', '/api/shipping/quote', {
        token,
        body: { pincode: '400001', paymentMethod: 'cod' },
      });
      assertEqual(res.status, 200, res.text);
      assertEqual(res.body.data.used, false, 'used must be false');
      assertEqual(res.body.data.shippingFee, 99, 'settings fallback fee');
    } finally {
      fake.serviceable = true;
    }
  });

  /* ======================================================================= *
   * 2. Order snapshot and shipment creation
   * ======================================================================= */

  suite('2. Order snapshot, shipment creation and idempotency');

  const order = await createCodOrder('order #1');

  await check('order stores the live shipping fee and package snapshot', async () => {
    assertEqual(order.shippingFee, 140, 'shippingFee');
    assertEqual(order.shipping.shippingCharges, 140, 'shippingCharges');
    assertEqual(order.shipping.courierName, 'Harness Express', 'courier');
    assertEqual(order.shipping.shippingMethod, 'cod', 'shippingMethod');
    assertEqual(order.items[0].weight, 1.2, 'item weight snapshot');
    assertEqual(order.items[0].hsnCode, '87089900', 'item HSN snapshot');
    assertEqual(
      order.totalAmount,
      round2(order.subtotal + order.shippingFee + order.gstAmount),
      'total invariant'
    );
  });

  await check('a pending order cannot be shipped', async () => {
    const res = await api('POST', `/api/shipping/admin/orders/${order._id}/create`, {
      token: adminToken,
    });
    assertEqual(res.status, 409, res.text);
  });

  await check('a non-owner cannot read another customer shipment', async () => {
    const res = await api('GET', `/api/shipping/orders/${order._id}`, {
      token: otherToken,
    });
    assertEqual(res.status, 403, res.text);
  });

  await check('a normal customer cannot use admin shipping routes', async () => {
    const res = await api('GET', '/api/shipping/admin/shipments', { token });
    assertEqual(res.status, 403, res.text);
  });

  await check('admin confirmation auto-creates the Shiprocket shipment', async () => {
    const before = fake.created.length;
    await confirmViaAdmin(order._id);
    const shipped = await waitUntilShipped(order._id);

    assertEqual(fake.created.length, before + 1, 'one adhoc order created');
    assert(shipped.shipping.shipmentId, 'shipment id stored');
    assertEqual(shipped.shipping.provider, 'shiprocket', 'provider');
    assertEqual(shipped.shipping.creationState, 'created', 'creationState');
  });

  await check('the adhoc payload carries authoritative order data', async () => {
    const payload = fake.created[fake.created.length - 1];
    assertEqual(payload.order_id, order.orderNumber, 'order_id');
    assertEqual(payload.pickup_location, 'Harness Warehouse', 'pickup_location');
    assertEqual(payload.payment_method, 'COD', 'payment_method');
    assertEqual(payload.weight, 1.2, 'weight');
    assertEqual(payload.shipping_charges, 140, 'shipping_charges');
    assertEqual(payload.billing_pincode, '411001', 'billing_pincode');
    assertEqual(payload.order_items[0].units, 1, 'units');
    assertEqual(payload.order_items[0].selling_price, 500, 'selling_price');
    assertEqual(payload.order_items[0].hsn, '87089900', 'hsn');
  });

  await check('a second create call is idempotent (no duplicate shipment)', async () => {
    const before = fake.created.length;
    const res = await api('POST', `/api/shipping/admin/orders/${order._id}/create`, {
      token: adminToken,
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.shipping.shiprocketOrderId !== undefined, true, 'shipment present');
    assertEqual(fake.created.length, before, 'no extra adhoc order');
  });

  /* ======================================================================= *
   * 3. AWB / label / manifest / pickup / tracking
   * ======================================================================= */

  suite('3. AWB, label, manifest, pickup and tracking');

  await check('AWB assignment stores the AWB and tracking URL', async () => {
    const res = await api('POST', `/api/shipping/admin/orders/${order._id}/awb`, {
      token: adminToken,
    });
    assertEqual(res.status, 200, res.text);
    assert(res.body.data.awbCode, 'AWB missing');
    assert(
      String(res.body.data.trackingUrl).includes(res.body.data.awbCode),
      'tracking URL missing AWB'
    );
  });

  await check('label generation stores a label URL', async () => {
    const res = await api(
      'POST',
      `/api/shipping/admin/orders/${order._id}/label`,
      { token: adminToken }
    );
    assertEqual(res.status, 200, res.text);
    assertEqual(
      res.body.data.labelUrl,
      'https://labels.anilkabadi.test/harness.pdf',
      'label URL'
    );
  });

  await check('manifest generation stores a manifest URL', async () => {
    const res = await api(
      'POST',
      `/api/shipping/admin/orders/${order._id}/manifest`,
      { token: adminToken }
    );
    assertEqual(res.status, 200, res.text);
    assertEqual(
      res.body.data.manifestUrl,
      'https://manifests.anilkabadi.test/harness.pdf',
      'manifest URL'
    );
  });

  await check('pickup request stores the pickup token', async () => {
    const res = await api(
      'POST',
      `/api/shipping/admin/orders/${order._id}/pickup`,
      { token: adminToken }
    );
    assertEqual(res.status, 200, res.text);
    assertEqual(
      res.body.data.shipping.pickupToken,
      'PICKUP-HARNESS-1',
      'pickup token'
    );
  });

  await check('customer tracking persists scans and advances the order', async () => {
    fake.trackingStatus = 'SHIPPED';
    const res = await api('GET', `/api/shipping/orders/${order._id}/track`, {
      token,
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.currentStatus, 'SHIPPED', 'current status');

    const updated = await Order.findById(order._id);
    assertEqual(updated.orderStatus, 'shipped', 'orderStatus advanced');
    assert(
      updated.shipping.trackingHistory.length >= 2,
      'tracking history persisted'
    );
    assert(
      updated.shipping.trackingHistory.every((event) => event.source === 'shiprocket'),
      'tracking history source'
    );
  });

  /* ======================================================================= *
   * 4. Webhooks
   * ======================================================================= */

  suite('4. Webhook authentication and idempotency');

  const webhookHeaders = () => ({
    'Content-Type': 'application/json',
    'x-shiprocket-webhook-secret': process.env.SHIPROCKET_WEBHOOK_SECRET,
  });

  await check('webhook rejects a wrong shared secret', async () => {
    const res = await api('POST', '/api/shipping/webhook', {
      rawBody: JSON.stringify({ data: { channel_order_id: order.orderNumber } }),
      headers: {
        'Content-Type': 'application/json',
        'x-shiprocket-webhook-secret': 'wrong-secret',
      },
    });
    assertEqual(res.status, 401, res.text);
  });

  await check('webhook accepts a valid HMAC signature without the secret header', async () => {
    const rawBody = JSON.stringify({
      event: 'shipment_status_changed',
      data: {
        channel_order_id: 'UNKNOWN-ORDER',
        awb: 'AWB-NONE',
        current_status: 'IN TRANSIT',
        event_id: 'hmac-only-event',
      },
    });
    const res = await api('POST', '/api/shipping/webhook', {
      rawBody,
      headers: {
        'Content-Type': 'application/json',
        'x-shiprocket-signature': `sha256=${hmac(
          process.env.SHIPROCKET_WEBHOOK_SECRET,
          rawBody
        )}`,
      },
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.ignored, true, 'unknown order ignored');
  });

  const deliveredPayload = {
    event: 'shipment_status_changed',
    data: {
      channel_order_id: order.orderNumber,
      awb: 'AWB-DELIVERED',
      current_status: 'DELIVERED',
      event_id: 'harness-delivered-1',
      courier_name: 'Harness Express',
    },
  };

  await check('delivered webhook advances the order and is idempotent', async () => {
    const first = await api('POST', '/api/shipping/webhook', {
      rawBody: JSON.stringify(deliveredPayload),
      headers: webhookHeaders(),
    });
    assertEqual(first.status, 200, first.text);
    assertEqual(first.body.data.processed, true, 'processed');

    const delivered = await Order.findById(order._id);
    assertEqual(delivered.orderStatus, 'delivered', 'orderStatus delivered');

    const second = await api('POST', '/api/shipping/webhook', {
      rawBody: JSON.stringify(deliveredPayload),
      headers: webhookHeaders(),
    });
    assertEqual(second.status, 200, second.text);
    assertEqual(second.body.data.duplicate, true, 'duplicate event');
  });

  await check('unknown order webhook is acknowledged and ignored', async () => {
    const res = await api('POST', '/api/shipping/webhook', {
      rawBody: JSON.stringify({
        data: {
          channel_order_id: 'DOES-NOT-EXIST',
          current_status: 'DELIVERED',
          event_id: 'unknown-order-event',
        },
      }),
      headers: webhookHeaders(),
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.ignored, true, 'ignored');
  });

  /* ======================================================================= *
   * 5. Cancellation and stock safety
   * ======================================================================= */

  suite('5. Cancellation and stock safety');

  const cancelOrder = await createCodOrder('order #2');
  const stockBeforeWebhook = (await Product.findById(product._id)).stock;

  await check('cancellation webhook does not cancel the order or touch stock', async () => {
    await confirmViaAdmin(cancelOrder._id);
    await waitUntilShipped(cancelOrder._id);

    const res = await api('POST', '/api/shipping/webhook', {
      rawBody: JSON.stringify({
        data: {
          channel_order_id: cancelOrder.orderNumber,
          awb: 'AWB-CANCELLED',
          current_status: 'CANCELLED',
          event_id: 'harness-cancelled-1',
        },
      }),
      headers: webhookHeaders(),
    });
    assertEqual(res.status, 200, res.text);

    const after = await Order.findById(cancelOrder._id);
    assertEqual(after.orderStatus, 'confirmed', 'order status unchanged');
    assertEqual(after.shipping.shipmentStatus, 'CANCELLED', 'shipping status');
    assert(after.shipping.cancelledAt, 'cancelledAt set');

    const stockAfter = (await Product.findById(product._id)).stock;
    assertEqual(stockAfter, stockBeforeWebhook, 'stock untouched by webhook');
  });

  await check('admin can cancel the courier shipment', async () => {
    const res = await api(
      'POST',
      `/api/shipping/admin/orders/${cancelOrder._id}/cancel`,
      { token: adminToken, body: { reason: 'Harness cancellation' } }
    );
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.shipmentStatus, 'CANCELLED', 'status');
  });

  /* ======================================================================= *
   * 6. Eligibility and admin diagnostics
   * ======================================================================= */

  suite('6. Eligibility and diagnostics');

  await check('an unpaid prepaid order cannot be shipped', async () => {
    const unpaid = await Order.create({
      user: customer._id,
      items: [
        {
          product: product._id,
          name: product.name,
          sku: product.sku,
          quantity: 1,
          price: product.price,
        },
      ],
      shippingAddress: ADDRESS,
      subtotal: 500,
      discount: 100,
      shippingFee: 120,
      gstAmount: 90,
      totalAmount: 710,
      paymentMethod: 'online',
      paymentStatus: 'pending',
      orderStatus: 'confirmed',
    });

    const res = await api(
      'POST',
      `/api/shipping/admin/orders/${unpaid._id}/create`,
      { token: adminToken }
    );
    assertEqual(res.status, 409, res.text);
  });

  await check('admin connection check reports the configured pickup', async () => {
    const res = await api('GET', '/api/shipping/admin/connection', {
      token: adminToken,
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data.success, true, 'auth success');
    assertEqual(res.body.data.shipmentReady, true, 'shipmentReady');
  });

  await check('admin pickup locations are listed without secrets', async () => {
    const res = await api('GET', '/api/shipping/admin/pickup-locations', {
      token: adminToken,
    });
    assertEqual(res.status, 200, res.text);
    assertEqual(res.body.data[0].pickupLocation, 'Harness Warehouse', 'pickup');
    assert(!res.text.includes('harness_password'), 'secret leaked');
  });

  await check('admin shipment list contains shipped orders', async () => {
    const res = await api('GET', '/api/shipping/admin/shipments?limit=50', {
      token: adminToken,
    });
    assertEqual(res.status, 200, res.text);
    assert(
      res.body.data.shipments.some((entry) => entry.orderNumber === order.orderNumber),
      'shipped order missing from list'
    );
  });

  /* ======================================================================= *
   * Summary
   * ======================================================================= */

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n\x1b[1m${results.length - failed.length}/${results.length} checks passed\x1b[0m`
  );

  if (failed.length) {
    failed.forEach((result) => {
      console.log(
        `  \x1b[31m${result.suite} :: ${result.label}\x1b[0m\n    ${result.error}`
      );
    });
  }

  await mongoose.connection.close(false);
  await mongod.stop();

  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error('\x1b[31mHarness crashed:\x1b[0m', error);
  process.exit(1);
});
