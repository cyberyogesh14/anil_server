/**
 * AnilKabadi review / product-rating test harness.
 *
 * Boots the REAL server (routes, controllers, models) against an in-memory
 * MongoDB and drives real HTTP requests. Only outbound email is faked; the
 * review pipeline itself - the delivered-order gate, the duplicate guard and
 * the rating aggregation in `updateProductRating` - is production code.
 *
 * This suite exists because the payments-only suite stayed 49/49 green while
 * every product rating in the catalogue was silently zeroed (audit finding C2).
 *
 * Run: node scripts/reviewIntegrationTest.js
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '5101';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

// Online payments are irrelevant here; leave the keys unset on purpose so the
// server proves it still boots cleanly when Razorpay is not configured.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;

// No real SMTP.
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const path = require('path');
const fs = require('fs');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(SERVER_ROOT, '..', 'client');

const readClientSource = (relative) =>
  fs.readFileSync(path.join(CLIENT_ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as the payment harness)
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
  process.env.MONGO_URI = mongod.getUri('anilkabadi_review_test');
  console.log(`In-memory MongoDB: ${process.env.MONGO_URI}`);

  require(path.join(SERVER_ROOT, 'server.js'));
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const mongoose = require(path.join(SERVER_ROOT, 'node_modules/mongoose'));
  const Order = require(path.join(SERVER_ROOT, 'models/Order'));
  const Product = require(path.join(SERVER_ROOT, 'models/Product'));
  const Review = require(path.join(SERVER_ROOT, 'models/Review'));
  const User = require(path.join(SERVER_ROOT, 'models/User'));
  const Category = require(path.join(SERVER_ROOT, 'models/Category'));
  const emailService = require(path.join(SERVER_ROOT, 'services/emailService'));
  const { generateToken } = require(path.join(SERVER_ROOT, 'utils/generateToken'));

  const sentEmails = [];
  emailService.sendOrderConfirmationEmail = async () => {
    sentEmails.push(true);
    return true;
  };

  await mongoose.connection.asPromise();

  // --- Fixtures -----------------------------------------------------------
  const stamp = Date.now();

  const buyer = await User.create({
    name: 'Review Buyer',
    email: `buyer-${stamp}@anilkabadi.test`,
    phone: '9876543210',
    password: 'test1234',
    isActive: true,
  });
  const buyerToken = generateToken(buyer._id);

  const buyerTwo = await User.create({
    name: 'Review Buyer Two',
    email: `buyer2-${stamp}@anilkabadi.test`,
    phone: '9876543211',
    password: 'test1234',
    isActive: true,
  });
  const buyerTwoToken = generateToken(buyerTwo._id);

  const admin = await User.create({
    name: 'Review Admin',
    email: `admin-${stamp}@anilkabadi.test`,
    password: 'test1234',
    isActive: true,
    role: 'admin',
  });
  const adminToken = generateToken(admin._id);

  const category = await Category.create({ name: `Review Category ${stamp}` });

  const makeProduct = async (spec = {}) =>
    Product.create({
      name: spec.name || `Review Part ${Math.random().toString(36).slice(2, 8)}`,
      description: 'Test part',
      category: category._id,
      price: spec.price ?? 500,
      mrp: spec.mrp ?? 500,
      stock: spec.stock ?? 25,
      isActive: true,
      images: [],
    });

  /**
   * The review gate requires a *delivered* order containing the product, so the
   * fixture is a real order document flipped to delivered.
   */
  const deliverOrder = async (user, products) => {
    const lines = products.map((p) => ({
      product: p._id,
      name: p.name,
      quantity: 1,
      price: p.price,
    }));
    const net = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

    return Order.create({
      user: user._id,
      items: lines,
      shippingAddress: {
        fullName: user.name,
        phone: '9876543210',
        addressLine1: '12 MG Road',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
        country: 'India',
      },
      subtotal: net,
      discount: 0,
      shippingFee: 0,
      gstAmount: 0,
      totalAmount: net,
      paymentMethod: 'cod',
      paymentStatus: 'cod',
      orderStatus: 'delivered',
    });
  };

  const ratingOf = async (productId) => {
    const p = await Product.findById(productId);
    return { rating: p.rating, numReviews: p.numReviews };
  };

  // =======================================================================
  suite('1. Creating a review updates the product rating (audit C2 regression)');

  const productA = await makeProduct({ name: `Rated Part A ${stamp}` });
  await deliverOrder(buyer, [productA]);

  await check('a new product starts at rating 0 / numReviews 0', async () => {
    const before = await ratingOf(productA._id);
    assertEqual(before.rating, 0, 'initial rating');
    assertEqual(before.numReviews, 0, 'initial numReviews');
  });

  let reviewA;
  await check('a 5-star review is accepted (201) and stored', async () => {
    const res = await api('POST', `/api/products/${productA._id}/reviews`, {
      token: buyerToken,
      body: { rating: 5, title: 'Excellent', comment: 'Fits perfectly' },
    });
    assertEqual(res.status, 201, `expected 201, got ${res.status}: ${res.text}`);
    reviewA = res.body.data;
    assertEqual(reviewA.rating, 5, 'stored rating');

    const stored = await Review.findById(reviewA._id);
    assert(stored, 'review persisted');
    assertEqual(String(stored.product), String(productA._id), 'review.product');
  });

  await check('product rating becomes 5 and numReviews becomes 1', async () => {
    const after = await ratingOf(productA._id);
    assertEqual(after.rating, 5, 'product rating (was zeroed by the old bug)');
    assertEqual(after.numReviews, 1, 'numReviews');
  });

  await check('the public product list reports the recomputed rating', async () => {
    const res = await api('GET', '/api/products');
    assertEqual(res.status, 200, 'products status');
    const listed = res.body.data.find((p) => p._id === String(productA._id));
    assert(listed, 'product present in list');
    assertEqual(listed.rating, 5, 'listed rating');
    assertEqual(listed.numReviews, 1, 'listed numReviews');
  });

  await check('the product detail endpoint reports the recomputed rating', async () => {
    const res = await api('GET', `/api/products/${productA._id}`);
    assertEqual(res.status, 200, 'product detail status');
    assertEqual(res.body.data.rating, 5, 'detail rating');
    assertEqual(res.body.data.numReviews, 1, 'detail numReviews');
  });

  // =======================================================================
  suite('2. Multiple reviews produce the correct average');

  const productB = await makeProduct({ name: `Rated Part B ${stamp}` });
  await deliverOrder(buyer, [productB]);
  await deliverOrder(buyerTwo, [productB]);

  const postReview = async (token, productId, body) =>
    api('POST', `/api/products/${productId}/reviews`, { token, body });

  await check('three reviews (5, 4, 3) average to 4.0', async () => {
    const r1 = await postReview(buyerToken, productB._id, { rating: 5 });
    const r2 = await postReview(buyerTwoToken, productB._id, { rating: 4 });
    assertEqual(r1.status, 201, 'first review');
    assertEqual(r2.status, 201, 'second review');

    // The third reviewer needs their own delivered order.
    const buyerThree = await User.create({
      name: 'Review Buyer Three',
      email: `buyer3-${stamp}@anilkabadi.test`,
      password: 'test1234',
      isActive: true,
    });
    await deliverOrder(buyerThree, [productB]);
    const r3 = await postReview(generateToken(buyerThree._id), productB._id, {
      rating: 3,
    });
    assertEqual(r3.status, 201, 'third review');

    const after = await ratingOf(productB._id);
    assertEqual(after.numReviews, 3, 'numReviews');
    assertEqual(after.rating, 4, 'average rating');
  });

  await check('an average that rounds to one decimal is stored rounded', async () => {
    // productB already holds 5, 4, 3 (sum 12). Adding 5, 5, 4, 1 (sum 15)
    // gives 27 / 7 = 3.857..., which must be stored as 3.9.
    const buyers = [];
    for (let i = 0; i < 4; i += 1) {
      const u = await User.create({
        name: `Round Buyer ${i}`,
        email: `round-${i}-${stamp}@anilkabadi.test`,
        password: 'test1234',
        isActive: true,
      });
      await deliverOrder(u, [productB]);
      buyers.push(generateToken(u._id));
    }

    const ratings = [5, 5, 4, 1];
    for (let i = 0; i < ratings.length; i += 1) {
      const res = await postReview(buyers[i], productB._id, {
        rating: ratings[i],
      });
      assertEqual(res.status, 201, `extra review ${i}`);
    }

    const after = await ratingOf(productB._id);
    assertEqual(after.numReviews, 7, 'numReviews');
    assertEqual(after.rating, 3.9, 'average rating rounded to 1dp');
  });

  // =======================================================================
  suite('3. Updating a review recalculates the average');

  let reviewToUpdate;
  await check('a second buyer can review the same product', async () => {
    await deliverOrder(buyerTwo, [productA]);
    const res = await api('POST', `/api/products/${productA._id}/reviews`, {
      token: buyerTwoToken,
      body: { rating: 5 },
    });
    assertEqual(res.status, 201, `expected 201, got ${res.status}: ${res.text}`);
    reviewToUpdate = res.body.data;

    const after = await ratingOf(productA._id);
    assertEqual(after.numReviews, 2, 'numReviews');
    assertEqual(after.rating, 5, 'average still 5');
  });

  await check('a non-owner cannot update the review (403)', async () => {
    const res = await api('PUT', `/api/reviews/${reviewToUpdate._id}`, {
      token: buyerToken,
      body: { rating: 1 },
    });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);

    const after = await ratingOf(productA._id);
    assertEqual(after.rating, 5, 'rating untouched by the rejected update');
  });

  await check('the owner can update the review', async () => {
    const res = await api('PUT', `/api/reviews/${reviewToUpdate._id}`, {
      token: buyerTwoToken,
      body: { rating: 1, comment: 'Changed my mind' },
    });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
    assertEqual(res.body.data.rating, 1, 'updated rating returned');
  });

  await check('the average is recalculated after the update', async () => {
    // productA now holds 5 (buyer) + 1 (buyerTwo) = 3.0
    const after = await ratingOf(productA._id);
    assertEqual(after.numReviews, 2, 'numReviews unchanged by an update');
    assertEqual(after.rating, 3, 'average rating after update');
  });

  await check('an unauthenticated update is rejected (401)', async () => {
    const res = await api('PUT', `/api/reviews/${reviewToUpdate._id}`, {
      body: { rating: 5 },
    });
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  // =======================================================================
  suite('4. Deleting a review recalculates the average');

  await check('the owner can delete their own review', async () => {
    const res = await api('DELETE', `/api/reviews/${reviewToUpdate._id}`, {
      token: buyerTwoToken,
    });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
    assertEqual(await Review.countDocuments({ _id: reviewToUpdate._id }), 0, 'row removed');
  });

  await check('the average is recalculated after the delete', async () => {
    // Back to buyerA's single 5-star review.
    const after = await ratingOf(productA._id);
    assertEqual(after.numReviews, 1, 'numReviews');
    assertEqual(after.rating, 5, 'average rating after delete');
  });

  await check('another user cannot delete the review (403)', async () => {
    const res = await api('DELETE', `/api/reviews/${reviewA._id}`, {
      token: buyerTwoToken,
    });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
    assertEqual(await Review.countDocuments({ _id: reviewA._id }), 1, 'review survives');
  });

  await check('an admin can delete any review and the rating recomputes', async () => {
    const res = await api('DELETE', `/api/reviews/${reviewA._id}`, {
      token: adminToken,
    });
    assertEqual(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);

    const after = await ratingOf(productA._id);
    assertEqual(after.numReviews, 0, 'numReviews');
    assertEqual(after.rating, 0, 'rating back to 0 - genuinely no reviews left');
  });

  await check('deleting a non-existent review returns 404', async () => {
    const res = await api('DELETE', '/api/reviews/64b7f0f0f0f0f0f0f0f0f0f0', {
      token: adminToken,
    });
    assertEqual(res.status, 404, `expected 404, got ${res.status}`);
  });

  // =======================================================================
  suite('5. Zero reviews leaves rating 0 / numReviews 0');

  await check('a never-reviewed product stays at 0 and is not corrupted', async () => {
    const fresh = await makeProduct({ name: `Never Reviewed ${stamp}` });
    const before = await ratingOf(fresh._id);
    assertEqual(before.rating, 0, 'rating');
    assertEqual(before.numReviews, 0, 'numReviews');
  });

  await check('deleting the last review zeroes the rating exactly once', async () => {
    const lonely = await makeProduct({ name: `Lonely Part ${stamp}` });
    await deliverOrder(buyer, [lonely]);

    const created = await api('POST', `/api/products/${lonely._id}/reviews`, {
      token: buyerToken,
      body: { rating: 4 },
    });
    assertEqual(created.status, 201, 'review created');
    assertEqual((await ratingOf(lonely._id)).rating, 4, 'rating while reviewed');

    const del = await api('DELETE', `/api/reviews/${created.body.data._id}`, {
      token: buyerToken,
    });
    assertEqual(del.status, 200, 'review deleted');

    const after = await ratingOf(lonely._id);
    assertEqual(after.rating, 0, 'rating after last delete');
    assertEqual(after.numReviews, 0, 'numReviews after last delete');
  });

  await check('rating never drifts below 0 or above 5', async () => {
    const all = await Product.find({ rating: { $exists: true } });
    all.forEach((p) => {
      assert(p.rating >= 0 && p.rating <= 5, `rating out of range: ${p.rating}`);
      assert(p.numReviews >= 0, `numReviews out of range: ${p.numReviews}`);
    });
  });

  // =======================================================================
  suite('6. Review guard rails');

  await check('a duplicate review from the same user returns 409', async () => {
    const product = await makeProduct({ name: `Duplicate Guard ${stamp}` });
    await deliverOrder(buyer, [product]);

    const first = await api('POST', `/api/products/${product._id}/reviews`, {
      token: buyerToken,
      body: { rating: 5 },
    });
    assertEqual(first.status, 201, 'first review created');

    const second = await api('POST', `/api/products/${product._id}/reviews`, {
      token: buyerToken,
      body: { rating: 1 },
    });
    assertEqual(second.status, 409, `expected 409, got ${second.status}`);
    assertEqual(await Review.countDocuments({ user: buyer._id, product: product._id }), 1, 'still one review');

    const after = await ratingOf(product._id);
    assertEqual(after.numReviews, 1, 'numReviews not inflated by the rejected duplicate');
    assertEqual(after.rating, 5, 'rating not corrupted by the rejected duplicate');
  });

  await check('an unauthenticated review is rejected (401)', async () => {
    const product = await makeProduct({ name: `Unauth Guard ${stamp}` });
    const res = await api('POST', `/api/products/${product._id}/reviews`, {
      body: { rating: 5 },
    });
    assertEqual(res.status, 401, `expected 401, got ${res.status}`);
    assertEqual((await ratingOf(product._id)).numReviews, 0, 'no rating written');
  });

  await check("a user cannot review a product in another user's order", async () => {
    const product = await makeProduct({ name: `Ownership Guard ${stamp}` });
    // Only buyerTwo has a delivered order for this product.
    await deliverOrder(buyerTwo, [product]);

    const res = await api('POST', `/api/products/${product._id}/reviews`, {
      token: buyerToken,
      body: { rating: 5 },
    });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
    assert(
      /purchased and received/i.test(res.body.message),
      `message: ${res.body.message}`
    );
    assertEqual(await Review.countDocuments({ product: product._id }), 0, 'no review stored');
    assertEqual((await ratingOf(product._id)).numReviews, 0, 'numReviews untouched');
  });

  await check('an order that is not yet delivered does not unlock review', async () => {
    const product = await makeProduct({ name: `Not Delivered ${stamp}` });
    await Order.create({
      user: buyer._id,
      items: [{ product: product._id, name: product.name, quantity: 1, price: product.price }],
      shippingAddress: {
        fullName: buyer.name,
        phone: '9876543210',
        addressLine1: '12 MG Road',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
        country: 'India',
      },
      subtotal: product.price,
      totalAmount: product.price,
      paymentMethod: 'cod',
      paymentStatus: 'cod',
      orderStatus: 'shipped',
    });

    const res = await api('POST', `/api/products/${product._id}/reviews`, {
      token: buyerToken,
      body: { rating: 5 },
    });
    assertEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  await check('a review for a non-existent product returns 404', async () => {
    const res = await api('POST', '/api/products/64b7f0f0f0f0f0f0f0f0f0f0/reviews', {
      token: buyerToken,
      body: { rating: 5 },
    });
    assertEqual(res.status, 404, `expected 404, got ${res.status}`);
    assert(/not found/i.test(res.body.message), `message: ${res.body.message}`);
  });

  await check('a review on an unknown (but well-formed) id returns 404', async () => {
    const missingId = new mongoose.Types.ObjectId('64b7f0f0f0f0f0f0f0f0f0f1');
    const res = await api('POST', `/api/products/${missingId}/reviews`, {
      token: buyerToken,
      body: { rating: 5 },
    });
    assertEqual(res.status, 404, `expected 404, got ${res.status}`);
  });

  await check('an out-of-range rating is rejected (400)', async () => {
    const product = await makeProduct({ name: `Range Guard ${stamp}` });
    await deliverOrder(buyer, [product]);
    for (const rating of [0, 6, -1]) {
      const res = await api('POST', `/api/products/${product._id}/reviews`, {
        token: buyerToken,
        body: { rating },
      });
      assertEqual(res.status, 400, `rating ${rating} should be rejected`);
    }
    assertEqual((await ratingOf(product._id)).numReviews, 0, 'no review stored');
  });

  // =======================================================================
  suite('7. Listing reviews');

  await check('reviews are listed for a product with pagination metadata', async () => {
    const res = await api('GET', `/api/products/${productB._id}/reviews`);
    assertEqual(res.status, 200, 'status');
    assert(res.body.data.length > 0, 'reviews returned');
    assertEqual(res.body.pagination.total, (await ratingOf(productB._id)).numReviews, 'pagination total matches numReviews');
  });

  await check('no order confirmation emails were sent by this suite', async () => {
    assertEqual(sentEmails.length, 0, 'unexpected emails');
  });

  // =======================================================================
  suite('8. Tata BS6 hero filter reaches the API (audit H4 regression guard)');

  await check('the hero CTA links with emissionStandard, not compatibility', async () => {
    const src = readClientSource('src/components/HeroSection.jsx');
    assert(
      src.includes('emissionStandard=BS6'),
      'HeroSection must link to ?emissionStandard=BS6'
    );
    assert(
      !/compatibility=BS6/.test(src),
      'HeroSection must not link to the unsupported ?compatibility=BS6'
    );
  });

  await check('the Products page reads and forwards emissionStandard', async () => {
    const src = readClientSource('src/pages/Products.jsx');
    assert(
      src.includes("params.getAll('emissionStandard')"),
      'Products must read the emissionStandard query param'
    );
    assert(
      src.includes('params.emissionStandard = filters.compatibility'),
      'Products must send emissionStandard to the API'
    );
  });

  const bs6Tata = await Product.create({
    name: `BS6 Tata Filter ${stamp}`,
    description: 'BS6 part',
    category: category._id,
    brand: 'Tata',
    carBrand: 'Tata',
    emissionStandard: 'BS6',
    price: 1200,
    mrp: 1200,
    stock: 10,
    isActive: true,
    images: [],
  });
  const bs4Tata = await Product.create({
    name: `BS4 Tata Filter ${stamp}`,
    description: 'BS4 part',
    category: category._id,
    brand: 'Tata',
    carBrand: 'Tata',
    emissionStandard: 'BS4',
    price: 1100,
    mrp: 1100,
    stock: 10,
    isActive: true,
    images: [],
  });
  const bs6Other = await Product.create({
    name: `BS6 Mahindra Filter ${stamp}`,
    description: 'BS6 part, other brand',
    category: category._id,
    brand: 'Mahindra',
    carBrand: 'Mahindra',
    emissionStandard: 'BS6',
    price: 1300,
    mrp: 1300,
    stock: 10,
    isActive: true,
    images: [],
  });

  await check('GET /api/products?brand=Tata&emissionStandard=BS6 returns only BS6 Tata parts', async () => {
    const res = await api('GET', '/api/products?brand=Tata&emissionStandard=BS6');
    assertEqual(res.status, 200, `status: ${res.text}`);

    const ids = res.body.data.map((p) => p._id);
    assert(ids.includes(String(bs6Tata._id)), 'BS6 Tata part is returned');
    assert(!ids.includes(String(bs4Tata._id)), 'BS4 Tata part must not be returned');
    assert(!ids.includes(String(bs6Other._id)), 'BS6 Mahindra part must not be returned');
    res.body.data.forEach((p) => {
      assertEqual(p.emissionStandard, 'BS6', `unexpected emissionStandard: ${p.name}`);
    });
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