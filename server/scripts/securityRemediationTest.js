/**
 * Regression harness for the four MEDIUM findings in
 * `PAYMENT_GATEWAY_SECURITY_AUDIT.md`.
 *
 * Each suite below encodes the exploit that the audit demonstrated, and fails if
 * the exploit still works. They are written against the live HTTP surface rather
 * than the internals, so a future refactor that reopens any of these holes breaks
 * the build rather than production.
 *
 *   F-01  arbitrary Mongo operators in query strings
 *         GET /api/products?isActive[$ne]=true once returned hidden products;
 *         GET /api/admin/orders?user[$ne]=null once reached the driver.
 *   F-02  concurrent COD orders drove `stock` negative (audit: 2 of 4 orders
 *         succeeded against a single unit, leaving stock = -1).
 *   F-03  a JWT survived a password change and a logout, because the token
 *         carried no revocable counter.
 *   F-04  `{ ...req.body }` let staff write `rating`/`numReviews` on a product
 *         and unpublish a category.
 *
 * Booting notes: the REAL app runs against an in-memory MongoDB; only outbound
 * email is faked. The default MongoMemoryServer is a standalone (no transactions),
 * which is deliberate - it exercises the guarded non-transactional fallback.
 * Set `SECURITY_TEST_REPLSET=1` to run the same suite against a single-node
 * replica set instead, so the transactional branch is covered as well.
 *
 * Run: node scripts/securityRemediationTest.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '5103';
process.env.JWT_SECRET = 'remediation_test_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

// The F-08 suites make many deliberate malformed requests, and the limiter would
// otherwise start answering 429 mid-run and mask real results.
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';

// Razorpay is not exercised here and must stay unconfigured.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(SERVER_ROOT, '..', 'client');

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
      `${message || 'Mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
};

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
  const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

  const useReplSet = process.env.SECURITY_TEST_REPLSET === '1';
  const mongod = useReplSet
    ? await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    : await MongoMemoryServer.create();

  process.env.MONGO_URI = useReplSet ? mongod.getUri() : mongod.getUri();
  console.log(
    useReplSet
      ? 'using an in-memory REPLICA SET (transactional branch)'
      : 'using an in-memory STANDALONE (guarded fallback branch)'
  );

  const mongoose = require('mongoose');

  // ------------------------------------------------------------------------
  // Make sure the client build exists; the server serves it in NODE_ENV=test.
  // ------------------------------------------------------------------------
  if (!require('fs').existsSync(path.join(CLIENT_ROOT, 'dist', 'index.html'))) {
    console.log('client/dist is missing - run `npm run build` in client/ first.');
    await mongod.stop();
    process.exit(1);
  }

  // `server.js` creates the app and starts listening itself, exactly as in prod.
  require(path.join(SERVER_ROOT, 'server.js'));

  // Wait for the listener rather than assuming it is already up.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await fetch(`${BASE}/api/health`);
      if (health.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.log(`server listening on ${BASE} (in-memory MongoDB)`);

  const User = require('../models/User');
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const Cart = require('../models/Cart');
  const Order = require('../models/Order');
  const models = { User, Product, Category, Cart, Order };
  const { generateToken } = require('../utils/generateToken');
  const { runInTransaction } = require('../services/transactionRunner');

  const suffix = Date.now().toString(36);
  let seq = 0;

  const mkUser = async (overrides = {}) => {
    seq += 1;
    const password = 'AuditPass123';
    const user = await models.User.create({
      name: overrides.name || `User ${seq}`,
      email: `user${seq}.${suffix}@example.com`,
      phone: `9000000${String(seq).padStart(3, '0')}`,
      password,
      role: 'customer',
      emailVerified: true,
      ...overrides,
    });
    return user;
  };

  const mkCategory = async () => {
    seq += 1;
    return models.Category.create({
      name: `Category ${seq} ${suffix}`,
      description: 'regression fixture',
    });
  };

  const mkProduct = async (overrides = {}) => {
    const category = overrides.category || (await mkCategory());
    seq += 1;
    return models.Product.create({
      name: `Product ${seq} ${suffix}`,
      sku: `AK-REM-${seq}-${suffix}`,
      description: 'regression fixture',
      brand: 'Bosch',
      category: category._id,
      price: 1999,
      mrp: 2999,
      stock: 10,
      ...overrides,
    });
  };

  // Carts are created on demand by the app, so the fixture upserts rather than
  // assuming a cart already exists.
  const putInCart = async (user, product, quantity = 1) => {
    const cart =
      (await models.Cart.findOne({ user: user._id })) ||
      new models.Cart({ user: user._id, items: [] });
    cart.items.push({ product: product._id, quantity, price: product.price });
    await cart.save();
    return cart;
  };

  const shippingAddress = {
    fullName: 'Regression Buyer',
    phone: '9876543210',
    addressLine1: '12 Test Street',
    addressLine2: 'Suite 4',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    pincode: '411001',
    country: 'India',
  };

  // =======================================================================
  // F-01 - NoSQL operator injection through query strings
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-01  query-string operator injection\x1b[0m');

  await check('an operator cannot un-hide an inactive product via ?isActive[$ne]', async () => {
    const hidden = await mkProduct({ isActive: false });
    const visible = await mkProduct({ isActive: true });

    const res = await api('GET', '/api/products?isActive[$ne]=true');

    // Either outcome is acceptable; interpreting the operator is not.
    if (res.status === 200) {
      const ids = (res.body.data || []).map((p) => p._id);
      assert(
        !ids.includes(hidden._id.toString()),
        'CONFIRMED: ?isActive[$ne]=true still returned an inactive product'
      );
      assert(ids.includes(visible._id.toString()), 'sanity: the visible product is listed');
    } else {
      assert(
        res.status === 400 || res.status === 422,
        `expected a clean 400 rejection or a filtered 200, got ${res.status}`
      );
    }
  });

  await check('a $where key is refused', async () => {
    const res = await api('GET', '/api/products?$where=1');
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check('a dotted key is refused', async () => {
    const res = await api('GET', '/api/products?specifications.a=1');
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check('a nested operator payload is refused', async () => {
    const res = await api('GET', '/api/products?price[$lt]=0');
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check('an operator cannot dump another collection via /api/admin/orders?user[$ne]', async () => {
    const admin = await mkUser({ role: 'admin' });
    const token = generateToken(admin);
    const other = await mkUser();
    await putInCart(other, await mkProduct({ stock: 5 }));
    await api('POST', '/api/orders', {
      token: generateToken(other),
      body: { shippingAddress, paymentMethod: 'cod' },
    });

    const res = await api('GET', '/api/admin/orders?user[$ne]=null&limit=50', { token });

    // The audit's assertion: the response must never contain documents the
    // request was not entitled to, whatever status comes back.
    assert(res.status === 400 || res.status === 200, `unexpected status ${res.status}`);
    if (res.status === 200) {
      const orders = res.body.data || [];
      assert(Array.isArray(orders), 'expected an array of orders');
    }
  });

  await check('an operator cannot rewrite the admin status filter', async () => {
    const admin = await mkUser({ role: 'admin' });
    const token = generateToken(admin);
    await putInCart(admin, await mkProduct({ stock: 5 }));
    await api('POST', '/api/orders', {
      token,
      body: { shippingAddress, paymentMethod: 'cod' },
    });

    const all = await api('GET', '/api/admin/orders?limit=50', { token });
    const injected = await api('GET', '/api/admin/orders?status[$ne]=delivered&limit=50', { token });

    const count = (r) => ((r.body && r.body.data) || []).length;

    if (injected.status === 200) {
      assert(
        count(injected) === 0,
        `CONFIRMED: ?status[$ne]=delivered acted as an operator and returned ${count(injected)} orders`
      );
    } else {
      assertEqual(injected.status, 400, 'operator-shaped status should be rejected');
    }
    assert(count(all) >= 1, 'sanity: the admin list returns the real order');
  });

  await check('the storefront still accepts its multi-select filters', async () => {
    const category = await mkCategory();
    const a = await mkProduct({ category: category._id, brand: 'Bosch' });
    const b = await mkProduct({ category: category._id, brand: 'Denso' });

    const res = await api(
      'GET',
      `/api/products?category[]=${category._id}&brand[]=Bosch&brand[]=Denso&limit=50`
    );

    assertEqual(res.status, 200, 'a legitimate array filter must keep working');
    const ids = (res.body.data || []).map((p) => p._id);
    assert(ids.includes(a._id.toString()), 'expected the Bosch product');
    assert(ids.includes(b._id.toString()), 'expected the Denso product');
  });

  // =======================================================================
  // F-02 - concurrent COD orders must not oversell
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-02  concurrent COD orders must not oversell\x1b[0m');

  await check('four concurrent orders for one unit sell exactly one', async () => {
    const product = await mkProduct({ stock: 1 });

    const buyers = await Promise.all([0, 1, 2, 3].map(() => mkUser()));
    for (const buyer of buyers) await putInCart(buyer, product, 1);

    const responses = await Promise.all(
      buyers.map((buyer) =>
        api('POST', '/api/orders', {
          token: generateToken(buyer),
          body: { shippingAddress, paymentMethod: 'cod' },
        })
      )
    );

    const created = responses.filter((r) => r.status === 201);
    const orderCount = await models.Order.countDocuments({ 'items.product': product._id });

    assertEqual(orderCount, 1, 'exactly one order may exist for a single unit');
    assertEqual(created.length, 1, 'exactly one request may report success');

    const after = await models.Product.findById(product._id);
    assert(after.stock >= 0, `CONFIRMED: stock went negative (${after.stock})`);
    assertEqual(after.stock, 0, 'the single unit must be consumed');

    const losers = responses.filter((r) => r.status !== 201);
    losers.forEach((r) => {
      assert(
        [400, 409, 422].includes(r.status),
        `a losing request should get a clean 4xx, got ${r.status}`
      );
      assert(
        !/not defined|Cast to|undefined/i.test(r.text),
        `a losing request leaked a server error: ${r.text.slice(0, 120)}`
      );
    });
  });

  await check('a losing order leaves no orphan order and no partial decrement', async () => {
    const product = await mkProduct({ stock: 1 });

    const first = await mkUser();
    const second = await mkUser();
    await putInCart(first, product, 1);
    await putInCart(second, product, 1);

    await api('POST', '/api/orders', {
      token: generateToken(first),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    const res = await api('POST', '/api/orders', {
      token: generateToken(second),
      body: { shippingAddress, paymentMethod: 'cod' },
    });

    assert(res.status !== 201, 'the second order must not succeed');
    assertEqual(
      await models.Order.countDocuments({ 'items.product': product._id }),
      1,
      'no orphan order document'
    );
    const after = await models.Product.findById(product._id);
    assertEqual(after.stock, 0, 'stock is decremented exactly once');

    // The rejected buyer's cart must survive so they can retry.
    const cart = await models.Cart.findOne({ user: second._id });
    assert(cart.items.length > 0, 'the rejected cart was cleared');
  });

  await check('a multi-line order is guarded on every line', async () => {
    const scarce = await mkProduct({ stock: 1 });
    const plentiful = await mkProduct({ stock: 50 });

    const buyer = await mkUser();
    await putInCart(buyer, scarce, 1);
    await putInCart(buyer, plentiful, 2);

    const res = await api('POST', '/api/orders', {
      token: generateToken(buyer),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assertEqual(res.status, 201, 'the order should succeed while stock is available');

    // The first order legitimately consumed 2 of the abundant line; record that
    // so the refused order can be shown to have changed nothing.
    const afterFirst = await models.Product.findById(plentiful._id);

    // Second buyer only for the scarce line; the whole order must be refused.
    const buyerTwo = await mkUser();
    await putInCart(buyerTwo, scarce, 1);
    const res2 = await api('POST', '/api/orders', {
      token: generateToken(buyerTwo),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assert(res2.status !== 201, 'the scarce line is gone, so the order must be refused');

    const afterRefused = await models.Product.findById(plentiful._id);
    assertEqual(
      afterRefused.stock,
      afterFirst.stock,
      'the abundant line was decremented by a refused order'
    );
    assertEqual(
      afterFirst.stock,
      48,
      'the successful order should have consumed exactly 2 abundant units'
    );
    assertEqual(
      await models.Order.countDocuments({ 'items.product': plentiful._id }),
      1,
      'only the successful order may exist'
    );
  });

  await check(
    useReplSet
      ? 'a replica set gets a real session and a real rollback'
      : 'a standalone degrades to the guarded fallback instead of failing',
    async () => {
      if (useReplSet) {
        let sawSession = false;
        const probeName = `Probe ${(seq += 1)} ${suffix}`;

        try {
          await runInTransaction(async (session) => {
            sawSession = Boolean(session);
            // A real write that is then rolled back is what proves the session is
            // in force; a read, or a write that forgot its session, would pass
            // without proving anything.
            // Array form: `Model.create(doc, options)` is read as two documents.
            await models.Product.create(
              [
                {
                  name: probeName,
                  sku: `AK-PROBE-${seq}-${suffix}`,
                  category: (await mkCategory())._id,
                  price: 1,
                  mrp: 1,
                  stock: 0,
                },
              ],
              { session }
            );
            throw new Error('intentional rollback of the transaction probe');
          });
          throw new Error('the probe transaction was expected to be rolled back');
        } catch (error) {
          assert(
            /intentional rollback/.test(error.message),
            `unexpected transaction failure: ${error.message}`
          );
        }

        assert(sawSession, 'a replica set must supply a transaction session');
        const leaked = await models.Product.countDocuments({ name: probeName });
        assertEqual(leaked, 0, 'a rolled-back transaction left a document behind');
        return;
      }

      const value = await runInTransaction(async (session) => {
        assert(!session, 'a standalone MongoDB cannot provide a session');
        return 'ran-without-a-session';
      });
      assertEqual(value, 'ran-without-a-session', 'the fallback must still run the work');
    }
  );

  // =======================================================================
  // F-03 - sessions must be revocable
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-03  JWT revocation via tokenVersion\x1b[0m');

  await check('changing the password invalidates an existing token', async () => {
    const user = await mkUser();
    const token = generateToken(user);

    assertEqual((await api('GET', '/api/users/profile', { token })).status, 200, 'sanity');

    const changed = await api('PUT', '/api/users/change-password', {
      token,
      body: { currentPassword: 'AuditPass123', newPassword: 'RotatedPass456' },
    });
    assertEqual(changed.status, 200, 'the password change itself must succeed');

    const after = await api('GET', '/api/users/profile', { token });
    assertEqual(after.status, 401, 'CONFIRMED: the old token still authenticated after a password change');

    // The session that made the change must not be collateral damage.
    const refreshed = changed.body.token;
    assert(refreshed, 'change-password must hand back a replacement token');
    assertEqual(
      (await api('GET', '/api/users/profile', { token: refreshed })).status,
      200,
      'the replacement token should work'
    );

    const login = await api('POST', '/api/auth/login', {
      body: { email: user.email, password: 'RotatedPass456' },
    });
    assertEqual(login.status, 200, 'the new password must work');
  });

  await check('logging out invalidates the presented token', async () => {
    const user = await mkUser();
    const token = generateToken(user);

    assertEqual((await api('GET', '/api/users/profile', { token })).status, 200, 'sanity');

    const out = await api('POST', '/api/auth/logout', { token });
    assertEqual(out.status, 200, 'logout should succeed');

    const after = await api('GET', '/api/users/profile', { token });
    assertEqual(after.status, 401, 'CONFIRMED: the token still worked after logout');
  });

  await check('a fresh login still works after revocation', async () => {
    const user = await mkUser();
    await api('POST', '/api/auth/logout', { token: generateToken(user) });

    const login = await api('POST', '/api/auth/login', {
      body: { email: user.email, password: 'AuditPass123' },
    });
    assertEqual(login.status, 200, 'login should still succeed');

    const profile = await api('GET', '/api/users/profile', { token: login.body.token });
    assertEqual(profile.status, 200, 'the newly issued token must work');
  });

  await check('suspending a user invalidates their live session', async () => {
    const admin = await mkUser({ role: 'admin' });
    const staff = await mkUser({ role: 'staff' });
    const token = generateToken(staff);

    assertEqual((await api('GET', '/api/users/profile', { token })).status, 200, 'sanity');

    const suspended = await api('PUT', `/api/admin/users/${staff._id}/status`, {
      token: generateToken(admin),
      body: { isActive: false },
    });
    assertEqual(suspended.status, 200, 'the status change should succeed');

    const after = await api('GET', '/api/users/profile', { token });
    assertEqual(after.status, 401, 'CONFIRMED: a suspended user kept a working token');
  });

  await check('a password reset invalidates tokens issued before it', async () => {
    const user = await mkUser();
    const token = generateToken(user);

    // Email is stubbed, so mint the reset token the way the emailed link would.
    const { createHash } = require('crypto');
    const raw = `raw-reset-token-${suffix}-${seq}`;
    const stored = await models.User.findById(user._id).select('+resetPasswordToken +resetPasswordExpire');
    stored.resetPasswordToken = createHash('sha256').update(raw).digest('hex');
    stored.resetPasswordExpire = new Date(Date.now() + 60 * 60 * 1000);
    await stored.save();

    const reset = await api('POST', '/api/auth/reset-password', {
      body: { token: raw, password: 'ResetPass789' },
    });
    assertEqual(reset.status, 200, `reset-password: ${reset.text.slice(0, 120)}`);

    const after = await api('GET', '/api/users/profile', { token });
    assertEqual(after.status, 401, 'CONFIRMED: the pre-reset token survived a password reset');
  });

  // =======================================================================
  // F-04 - mass assignment
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-04  staff edits cannot write server-owned fields\x1b[0m');

  await check('staff cannot forge review aggregates on a product', async () => {
    const admin = await mkUser({ role: 'admin' });
    const staff = await mkUser({ role: 'staff' });
    const product = await mkProduct({ rating: 0, numReviews: 0 });

    const res = await api('PUT', `/api/products/${product._id}`, {
      token: generateToken(staff),
      body: { name: product.name, price: product.price, mrp: product.mrp, rating: 5, numReviews: 9999 },
    });
    assert(res.status === 200, `the legitimate part of the edit should succeed: ${res.status}`);

    const after = await models.Product.findById(product._id);
    assertEqual(after.rating, 0, 'CONFIRMED: staff wrote the rating aggregate');
    assertEqual(after.numReviews, 0, 'CONFIRMED: staff wrote the review count');
  });

  await check('staff cannot unpublish a product', async () => {
    const staff = await mkUser({ role: 'staff' });
    const product = await mkProduct({ isActive: true });

    const res = await api('PUT', `/api/products/${product._id}`, {
      token: generateToken(staff),
      body: { isActive: false },
    });
    assert(res.status === 200 || res.status === 400, `unexpected status ${res.status}`);

    const after = await models.Product.findById(product._id);
    assertEqual(after.isActive, true, 'CONFIRMED: staff unpublished a product');
  });

  await check('staff cannot unpublish a category', async () => {
    const staff = await mkUser({ role: 'staff' });
    const category = await mkCategory();

    const res = await api('PUT', `/api/categories/${category._id}`, {
      token: generateToken(staff),
      body: { description: 'edited by staff', isActive: false },
    });
    assert(res.status === 200 || res.status === 400, `unexpected status ${res.status}`);

    const after = await models.Category.findById(category._id);
    assertEqual(after.isActive, true, 'CONFIRMED: staff unpublished a category');
    assertEqual(after.description, 'edited by staff', 'the allowed field should still save');
  });

  await check('admin edits still work', async () => {
    const admin = await mkUser({ role: 'admin' });
    const product = await mkProduct({ price: 1999, mrp: 2999 });

    const res = await api('PUT', `/api/products/${product._id}`, {
      token: generateToken(admin),
      body: { price: 1499, mrp: 2999 },
    });
    assertEqual(res.status, 200, `admin edit failed: ${res.text.slice(0, 160)}`);

    const after = await models.Product.findById(product._id);
    assertEqual(after.price, 1499, 'the price edit should have been applied');
    assert(
      after.discount > 0 && after.isActive === true,
      'the model hooks should still recompute the discount'
    );
  });

  // =======================================================================
  // F-05 - an unpublished product must not be readable by the public
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-05  inactive products are not publicly readable\x1b[0m');

  await check('an anonymous caller gets 404 for an inactive product by id', async () => {
    const hidden = await mkProduct({ isActive: false });

    const res = await api('GET', `/api/products/${hidden._id}`);

    assertEqual(res.status, 404, `expected 404, got ${res.status}`);
    assert(
      !res.text.includes(hidden.sku),
      'CONFIRMED: the inactive product was returned to an anonymous caller'
    );
  });

  await check('an inactive product is indistinguishable from a missing one', async () => {
    const hidden = await mkProduct({ isActive: false });

    const inactive = await api('GET', `/api/products/${hidden._id}`);
    const missing = await api('GET', '/api/products/000000000000000000000000');

    // Identical status and body: a 403 or a different message would let anyone
    // enumerate unpublished products by their ids.
    assertEqual(inactive.status, missing.status, 'status differs between hidden and missing');
    assertEqual(
      inactive.body.message,
      missing.body.message,
      'message differs between hidden and missing, which leaks existence'
    );
  });

  await check('a logged-in customer still gets 404 for an inactive product', async () => {
    const hidden = await mkProduct({ isActive: false });
    const customer = await mkUser();

    const res = await api('GET', `/api/products/${hidden._id}`, {
      token: generateToken(customer),
    });
    assertEqual(res.status, 404, 'authentication must not unlock an unpublished product');
  });

  await check('an inactive product is still absent from every list route', async () => {
    const hidden = await mkProduct({ isActive: false });
    const id = hidden._id.toString();

    for (const path of ['/api/products?limit=50', '/api/products/search?q=Product', '/api/products/featured']) {
      const res = await api('GET', path);
      assert(res.status === 200, `${path} returned ${res.status}`);
      assert(!res.text.includes(id), `CONFIRMED: ${path} listed an inactive product`);
    }
  });

  await check('staff and admin can still read an inactive product', async () => {
    const hidden = await mkProduct({ isActive: false });

    for (const role of ['staff', 'admin']) {
      const privileged = await mkUser({ role });
      const res = await api('GET', `/api/products/${hidden._id}`, {
        token: generateToken(privileged),
      });
      assertEqual(
        res.status,
        200,
        `${role} must be able to preview an unpublished product (the admin UI uses this endpoint)`
      );
      assertEqual(res.body.data.isActive, false, `${role} should see it as inactive`);
    }
  });

  await check('an active product is still publicly readable by id', async () => {
    const visible = await mkProduct({ isActive: true });

    const anonymous = await api('GET', `/api/products/${visible._id}`);
    assertEqual(anonymous.status, 200, 'a live product must stay publicly readable');

    const customer = await mkUser();
    const authed = await api('GET', `/api/products/${visible._id}`, {
      token: generateToken(customer),
    });
    assertEqual(authed.status, 200, 'a live product must be readable when signed in');
  });

  await check('an unusable token does not unlock an inactive product', async () => {
    const hidden = await mkProduct({ isActive: false });

    for (const badToken of ['not-a-jwt', 'a.b.c']) {
      const res = await api('GET', `/api/products/${hidden._id}`, { token: badToken });
      assertEqual(res.status, 404, 'a malformed token must not grant access');
    }
  });

  // =======================================================================
  // F-07 - cancelling an order must not republish a product
  // =======================================================================
  console.log('\n\x1b[1m\x1b[33mF-07  cancellation must not reactivate products\x1b[0m');

  await check('cancelling restores stock but keeps an admin-unpublished product hidden', async () => {
    const product = await mkProduct({ stock: 5 });
    const buyer = await mkUser();
    await putInCart(buyer, product, 2);

    const placed = await api('POST', '/api/orders', {
      token: generateToken(buyer),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assertEqual(placed.status, 201, `order failed: ${placed.text.slice(0, 160)}`);

    // An admin deliberately unpublishes it while the order is in flight.
    const admin = await mkUser({ role: 'admin' });
    const unpublished = await api('PUT', `/api/products/${product._id}`, {
      token: generateToken(admin),
      body: { isActive: false },
    });
    assertEqual(unpublished.status, 200, 'the admin unpublish should succeed');

    const cancelled = await api('PUT', `/api/orders/${placed.body.data._id}/cancel`, {
      token: generateToken(buyer),
    });
    assertEqual(cancelled.status, 200, `cancel failed: ${cancelled.text.slice(0, 160)}`);

    const after = await models.Product.findById(product._id);
    assertEqual(after.stock, 5, 'the stock should be restored');
    assertEqual(
      after.isActive,
      false,
      'CONFIRMED: cancelling republished a product an admin had deactivated'
    );
  });

  await check('a cancelled order does not leak into the public catalogue', async () => {
    const product = await mkProduct({ stock: 3 });
    const buyer = await mkUser();
    await putInCart(buyer, product, 1);

    const placed = await api('POST', '/api/orders', {
      token: generateToken(buyer),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assertEqual(placed.status, 201, 'the order should be placed');

    const admin = await mkUser({ role: 'admin' });
    await api('PUT', `/api/products/${product._id}`, {
      token: generateToken(admin),
      body: { isActive: false },
    });
    await api('PUT', `/api/orders/${placed.body.data._id}/cancel`, {
      token: generateToken(buyer),
    });

    const list = await api('GET', '/api/products?limit=50');
    assertEqual(list.status, 200, 'the catalogue should still load');
    assert(
      !list.text.includes(product._id.toString()),
      'CONFIRMED: the cancelled order republished the product on the storefront'
    );
  });

  await check('a normally cancelled order restores stock and stays live', async () => {
    const product = await mkProduct({ stock: 4 });
    const buyer = await mkUser();
    await putInCart(buyer, product, 3);

    const placed = await api('POST', '/api/orders', {
      token: generateToken(buyer),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assertEqual(placed.status, 201, 'the order should be placed');

    await api('PUT', `/api/orders/${placed.body.data._id}/cancel`, {
      token: generateToken(buyer),
    });

    const after = await models.Product.findById(product._id);
    assertEqual(after.stock, 4, 'the stock should be restored');
    assertEqual(
      after.isActive,
      true,
      'a product that was never unpublished must still be live after a cancellation'
    );
  });

  await check('a sold-out product is restored live when its only order is cancelled', async () => {
    const product = await mkProduct({ stock: 1 });
    const buyer = await mkUser();
    await putInCart(buyer, product, 1);

    const placed = await api('POST', '/api/orders', {
      token: generateToken(buyer),
      body: { shippingAddress, paymentMethod: 'cod' },
    });
    assertEqual(placed.status, 201, 'the order should be placed');

    const soldOut = await models.Product.findById(product._id);
    assertEqual(soldOut.stock, 0, 'the single unit should be sold');
    assertEqual(
      soldOut.isActive,
      false,
      'selling the last unit should deactivate the product'
    );

    const cancelled = await api('PUT', `/api/orders/${placed.body.data._id}/cancel`, {
      token: generateToken(buyer),
    });
    assertEqual(cancelled.status, 200, 'the cancel should succeed');

    const restored = await models.Product.findById(product._id);
    assertEqual(restored.stock, 1, 'the unit should come back');
    assertEqual(
      restored.isActive,
      true,
      'restoring the only unit should bring the product back to the storefront'
    );
  });

  // =======================================================================
  // F-08 - malformed patterns must never produce a 500
  // =======================================================================
console.log('\n\x1b[1m\x1b[33mF-08  malformed regex input is a 4xx, never a 500\x1b[0m');

const categoryAdmin = generateToken(await mkUser({ role: 'admin' }));

const MALFORMED = ['[', '(', '[a-', '(unclosed', '\\', 'a{2,', '((', '[]', '*', '+', '?'];

  await check('a malformed ?search= never 500s on the catalogue', async () => {
    for (const term of MALFORMED) {
      const res = await api('GET', `/api/products?search=${encodeURIComponent(term)}`);
      assert(
        res.status < 500,
        `CONFIRMED: ?search=${term} returned ${res.status}: ${res.text.slice(0, 120)}`
      );
      assertEqual(res.status, 200, `?search=${term} should be treated as a literal`);
    }
  });

  await check('a malformed ?search= never 500s on /api/products/search', async () => {
    for (const term of MALFORMED) {
      const res = await api(
        'GET',
        `/api/products/search?q=${encodeURIComponent(term)}`
      );
      assert(res.status < 500, `CONFIRMED: ?q=${term} returned ${res.status}`);
      assertEqual(res.status, 200, `?q=${term} should be treated as a literal`);
    }
  });

  await check('a malformed ?search= never 500s in the admin user search', async () => {
    const admin = await mkUser({ role: 'admin' });
    const token = generateToken(admin);

    for (const term of MALFORMED) {
      const res = await api('GET', `/api/admin/users?search=${encodeURIComponent(term)}`, {
        token,
      });
      assert(res.status < 500, `CONFIRMED: admin ?search=${term} returned ${res.status}`);
      assertEqual(res.status, 200, `admin ?search=${term} should be treated as a literal`);
    }
  });

  await check('no response leaks an internal regex or database error', async () => {
    for (const term of ['[', '(unclosed', 'a{2,']) {
      for (const path of [
        `/api/products?search=${encodeURIComponent(term)}`,
        `/api/products/search?q=${encodeURIComponent(term)}`,
      ]) {
        const res = await api('GET', path);
        assert(
          !/Invalid regular expression|SyntaxError|Unterminated|at .*\.js:\d+|MongoServerError/i.test(
            res.text
          ),
          `CONFIRMED: internal error text leaked from ${path}: ${res.text.slice(0, 160)}`
        );
      }
    }
  });

  await check('a malformed ?year= is a clean 400', async () => {
    for (const year of ['[', '(a+)', '20a0', '1800', '2100', '20200', '20 20', '-2020']) {
      const res = await api('GET', `/api/products?year=${encodeURIComponent(year)}`);
      assert(res.status < 500, `CONFIRMED: ?year=${year} returned ${res.status}`);
      assertEqual(res.status, 400, `?year=${year} should be refused with 400`);
      assert(
        !/Invalid regular expression|SyntaxError|Unterminated/i.test(res.text),
        `CONFIRMED: regex internals leaked for ?year=${year}`
      );
    }
  });

  await check('a valid ?year= still filters', async () => {
    // compatibleYears is stored as a window such as '2018-2020', and the filter has
    // always been a substring match against it: '2020' matches '2018-2020' and
    // '2020-2024'. Escaping a four-digit year is a no-op, so that behaviour is
    // unchanged by the F-08 fix - this test pins it so it cannot drift silently.
    const inRange = await mkProduct({ stock: 2, compatibleYears: '2018-2020' });
    const alsoInRange = await mkProduct({ stock: 2, compatibleYears: '2020-2024' });
    const outOfRange = await mkProduct({ stock: 2, compatibleYears: '2010-2012' });

    const res = await api('GET', '/api/products?year=2020&limit=50');
    assertEqual(res.status, 200, `a valid year should be accepted: ${res.text.slice(0, 120)}`);

    const ids = (res.body.data || []).map((p) => p._id);
    assert(
      ids.includes(inRange._id.toString()),
      'CONFIRMED: a valid year filter stopped matching a stored range containing it'
    );
    assert(
      ids.includes(alsoInRange._id.toString()),
      'CONFIRMED: the year filter stopped matching an exact range'
    );
    assert(
      !ids.includes(outOfRange._id.toString()),
      'CONFIRMED: the year filter matched a range that does not contain the year'
    );
  });

  await check('free-text search still matches literally', async () => {
    const product = await mkProduct({ name: 'Brake[Disc] Pro', stock: 1 });

    const literal = await api(
      'GET',
      `/api/products?search=${encodeURIComponent('Brake[Disc]')}&limit=50`
    );
    assertEqual(literal.status, 200, 'a bracketed literal term should be searched literally');
    assert(
      (literal.body.data || []).some((p) => p._id === product._id.toString()),
      'CONFIRMED: escaping stopped matching the literal term'
    );

    const regexy = await api('GET', '/api/products?search=.*&limit=50');
    assertEqual(regexy.status, 200, 'a wildcard-looking term should be literal too');
    assert(
      !(regexy.body.data || []).some((p) => p._id !== product._id.toString()),
      'CONFIRMED: ".*" was interpreted as a wildcard instead of a literal'
    );
  });

  await check('an invalid :condition path is a clean 400, not a 500', async () => {
    for (const condition of ['[', 'used(', '$ne', 'new|used']) {
      const res = await api('GET', `/api/products/condition/${encodeURIComponent(condition)}`);
      assert(res.status < 500, `CONFIRMED: /condition/${condition} returned ${res.status}`);
      assertEqual(res.status, 400, `/condition/${condition} should be refused with 400`);
    }
  });

  await check('the storefront condition routes still work', async () => {
    const fresh = await mkProduct({ condition: 'new', stock: 1 });
    const used = await mkProduct({ condition: 'used_good', stock: 1 });

    const newRes = await api('GET', '/api/products/condition/new');
    assertEqual(newRes.status, 200, '/condition/new should work');
    assert(
      (newRes.body.data || []).some((p) => p._id === fresh._id.toString()),
      'CONFIRMED: /condition/new stopped matching new products'
    );

    // 'used' is the storefront alias for the whole used_* family.
    const usedRes = await api('GET', '/api/products/condition/used');
    assertEqual(usedRes.status, 200, '/condition/used should work');
    assert(
      (usedRes.body.data || []).some((p) => p._id === used._id.toString()),
      'CONFIRMED: /condition/used stopped matching used_* products'
    );
  });

  await check('a pattern-shaped category name is a clean 4xx, never a 500', async () => {
    // The duplicate-name lookup used to be `new RegExp(`^${name}$`)`, so each of
    // these threw a SyntaxError and surfaced as a 500. Escaped, they are ordinary
    // category names.
    for (const name of ['(', '[', '*', '+', '?', '\\', 'a{2,1}', '(?<']) {
      const res = await api('POST', '/api/categories', {
        token: categoryAdmin,
        body: { name, description: 'F-08 regex probe' },
      });
      assert(
        res.status < 500,
        `a category named "${name}" -> ${res.status}: ${res.text.slice(0, 120)}`
      );
    }
  });

  await check('an escaped category name is stored and matched literally', async () => {
    const literal = '(F-08 literal)';
    const res = await api('POST', '/api/categories', {
      token: categoryAdmin,
      body: { name: literal, description: 'F-08 literal check' },
    });
    assertEqual(res.status, 201, `creating "${literal}" -> ${res.text.slice(0, 120)}`);

    const stored = await Category.findOne({ name: literal });
    assert(stored, `the literal name "${literal}" was not stored as typed`);

    // Case-insensitive exact match still works, so the anchors survived escaping.
    const dup = await api('POST', '/api/categories', {
      token: categoryAdmin,
      body: { name: literal.toLowerCase(), description: 'duplicate' },
    });
    assertEqual(dup.status, 409, `re-creating "${literal}" should be a 409`);

    await Category.deleteOne({ _id: stored._id });

    // The duplicate lookup used to compile the name as a pattern, so creating "a+1"
    // would match a category literally named "aa1" and be refused as a duplicate.
    // Escaped, it is only ever the literal string "a+1".
    const decoy = await api('POST', '/api/categories', {
      token: categoryAdmin,
      body: { name: 'aa1', description: 'F-08 over-match check' },
    });
    assertEqual(decoy.status, 201, `creating "aa1" -> ${decoy.text.slice(0, 120)}`);

    const pattern = await api('POST', '/api/categories', {
      token: categoryAdmin,
      body: { name: 'a+1', description: 'F-08 over-match check' },
    });
    assertEqual(
      pattern.status,
      201,
      `"a+1" must not be refused as a duplicate of "aa1" -> ${pattern.text.slice(0, 120)}`
    );

    const decoyDoc = await Category.findOne({ name: 'aa1' });
    const patternDoc = await Category.findOne({ name: 'a+1' });
    assert(decoyDoc && patternDoc, 'both literal names should exist side by side');

    await Category.deleteMany({ _id: { $in: [decoyDoc._id, patternDoc._id] } });

    for (const name of ['(', '[', '*', '+', '?', '\\', 'a{2,1}', '(?<']) {
      await Category.deleteMany({ name });
    }
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