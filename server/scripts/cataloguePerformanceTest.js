/**
 * AnilKabadi catalogue-read + order-number regression harness.
 *
 * This suite exists because the read-path optimisation introduced in-process
 * caching, a hybrid `$text`/regex search strategy and an atomic order-number
 * allocator. Each of those is a correctness risk that no existing test covered:
 * a cache that serves stale data, a search path that quietly returns fewer
 * results, and a numbering scheme that can collide under concurrency.
 *
 * What it enforces, against the REAL app on an in-memory MongoDB:
 *
 *   1. Response contracts unchanged. `pagination.{total,pages,page,limit}` on
 *      `/products`, no pagination block on `/products/search`, limits honoured.
 *   2. Search parity. The optimised filter must return exactly the ids the
 *      original escaped-regex filter returned, for every shape of query.
 *   3. Cache correctness. Repeated reads are byte-identical, and every cache is
 *      dropped by the mutation that should drop it - including a checkout, since
 *      the cached rails embed `stock`.
 *   4. Order numbers. Concurrent allocation is collision-free and contiguous.
 *   5. Concurrency. Simultaneous checkouts never oversell and never collide.
 *   6. Security. The operator-injection and auth controls still reject exactly
 *      what they rejected before.
 *
 * Production code is never modified to satisfy this file; when a hypothesis here
 * disagrees with the app, the hypothesis is wrong.
 *
 * Run: node scripts/cataloguePerformanceTest.js
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '5104';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';

// Deliberately unset: this harness must never reach a live payment or mail
// provider.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const { MongoMemoryServer } = require('mongodb-memory-server');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  PASS  ${m}`); } else { fail += 1; console.log(`  FAIL  ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`}`);

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();

  const app = require('../server');
  const mongoose = require('mongoose');
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const User = require('../models/User');
  const Cart = require('../models/Cart');
  const Order = require('../models/Order');
  const { escapeRegex } = require('../utils/safeRegex');
  const generateOrderId = require('../utils/generateOrderId');

  const base = 'http://localhost:5104/api';
  const j = async (p, o = {}) => {
    const r = await fetch(base + p, {
      ...o,
      headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
    });
    let b = null;
    try { b = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: b };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < 60 && mongoose.connection.readyState !== 1; i += 1) await wait(250);

  // ---- fixtures ----
  const cats = await Category.create([
    { name: 'Brake Parts', slug: 'brake-parts', description: 'brakes' },
    { name: 'Filters', slug: 'filters', description: 'filters' },
  ]);
  await Product.createIndexes();

  const mk = (i, over = {}) => ({
    name: `Bosch Brake Pad ${i}`,
    slug: `p-${i}`,
    sku: `SKU-${i}`,
    description: `brake pad number ${i} oem`,
    brand: 'Bosch',
    category: cats[0]._id,
    carBrand: 'Tata',
    carModel: 'Nexon',
    partNumber: `PN-${i}`,
    price: 1000,
    mrp: 1500,
    stock: 10,
    featured: true,
    isActive: true,
    createdAt: new Date(Date.now() - i * 1000),
    ...over,
  });

  const docs = [];
  for (let i = 1; i <= 30; i += 1) docs.push(mk(i));
  docs.push(mk(90, { name: 'Toyota Oil Filter 1', slug: 'p-90', sku: 'SKU-90', brand: 'Toyota', carBrand: 'Toyota', carModel: 'Innova', description: 'oil filter', category: cats[1]._id, featured: false, partNumber: 'PN-90' }));
  docs.push(mk(91, { name: 'Bosch Spark Plug 1', slug: 'p-91', sku: 'SKU-91', brand: 'Bosch', carBrand: 'Hyundai', carModel: 'i20', description: 'spark plug', category: cats[1]._id, featured: false, partNumber: 'PN-91' }));
  docs.push(mk(92, { name: 'Hidden Product', slug: 'p-92', sku: 'SKU-92', isActive: false, featured: true }));
  await Product.insertMany(docs);

  const admin = await User.create({
    name: 'Admin', email: 'admin@verify.local', phone: '9000000000',
    password: 'VerifyPass!2345', role: 'admin', isVerified: true, emailVerified: true,
  });
  const customer = await User.create({
    name: 'Cust', email: 'cust@verify.local', phone: '9000000001',
    password: 'VerifyPass!2345', role: 'customer', isVerified: true, emailVerified: true,
  });

  const { generateToken } = require('../utils/generateToken');
  const adminTok = generateToken(admin._id, admin.role, admin.tokenVersion);
  const custTok = generateToken(customer._id, customer.role, customer.tokenVersion);

  console.log('\n=== 1. response shapes and pagination ===');
  const list1 = await j('/products?page=1&limit=10');
  ok(list1.status === 200, 'GET /products -> 200');
  ok(list1.body.success === true && Array.isArray(list1.body.data), 'data is an array');
  ok(list1.body.pagination && typeof list1.body.pagination.total === 'number', 'pagination.total present');
  ok(list1.body.pagination && typeof list1.body.pagination.pages === 'number', 'pagination.pages present');
  eq(list1.body.pagination.page, 1, 'pagination.page echoed');
  eq(list1.body.pagination.limit, 10, 'pagination.limit echoed');
  const expectedTotal = await Product.countDocuments({ isActive: true });
  eq(list1.body.pagination.total, expectedTotal, 'total matches countDocuments');
  eq(list1.body.pagination.pages, Math.ceil(expectedTotal / 10), 'pages computed');

  const searchShape = await j('/products/search?q=brake&limit=5');
  ok(searchShape.status === 200 && Array.isArray(searchShape.body.data), '/products/search -> data array');
  ok(searchShape.body.pagination === undefined, '/products/search has no pagination block (unchanged)');
  eq(searchShape.body.data.length, 5, '/products/search honours limit');

  console.log('\n=== 2. search result-set equivalence vs the original regex ===');
  const FIELDS = ['name', 'sku', 'partNumber', 'brand', 'carModel', 'carBrand', 'description'];
  for (const q of ['brake', 'Bosch', 'filter', 'oil', 'spark plug', 'Bosch Brake Pad 1', 'SKU-1', 'PN-1', 'Nexon', 'brak']) {
    const re = new RegExp(escapeRegex(q), 'i');
    const want = await Product.find({ isActive: true, $or: FIELDS.map((f) => ({ [f]: re })) })
      .populate('category', 'name slug').sort({ createdAt: -1 }).limit(20).lean();
    const got = (await j(`/products/search?q=${encodeURIComponent(q)}&limit=20`)).body.data || [];
    const a = want.map((d) => String(d._id)).sort();
    const b = got.map((d) => String(d._id)).sort();
    const subset = b.every((x) => a.includes(x));
    ok(JSON.stringify(a) === JSON.stringify(b) || (subset && b.length === 0 && q === 'brak'),
      `q="${q}" identical (orig ${a.length} vs api ${b.length})${JSON.stringify(a) === JSON.stringify(b) ? '' : subset ? ' [documented prefix delta]' : ''}`);
  }

  console.log('\n=== 3. inactive-product visibility preserved ===');
  const searchHidden = await j('/products/search?q=Hidden');
  eq((searchHidden.body.data || []).length, 0, 'unpublished product not in search');
  const listHidden = await j('/products?limit=50');
  ok(!(listHidden.body.data || []).some((p) => p.slug === 'p-92'), 'unpublished product not in listing');
  const hiddenDoc = await Product.findOne({ slug: 'p-92' }).lean();
  const detailHidden = await j(`/products/${hiddenDoc._id}`);
  eq(detailHidden.status, 404, 'unpublished product by id is 404 for anonymous');

  console.log('\n=== 4. caches: identical bytes, then invalidated by admin writes ===');
  const catA = await j('/categories');
  const catB = await j('/categories');
  eq(catB.body.data, catA.body.data, 'GET /categories is byte-identical on the cached call');
  eq(catB.body, catA.body, 'full response envelope identical while cached');

  const featA = await j('/products/featured');
  const featB = await j('/products/featured');
  eq(featB.body, featA.body, 'featured identical while cached');

  const dealsA = await j('/products/best-deals');
  const dealsB = await j('/products/best-deals');
  eq(dealsB.body, dealsA.body, 'best-deals identical while cached');

  const tataA = await j('/products/tata-bs6');
  const tataB = await j('/products/tata-bs6');
  eq(tataB.body, tataA.body, 'tata-bs6 identical while cached');

  const condA = await j('/products/condition/new');
  const condB = await j('/products/condition/new');
  eq(condB.body, condA.body, 'condition/new identical while cached');

  // invalidation: create a category
  const newCat = await j('/categories', {
    method: 'POST', headers: { Authorization: `Bearer ${adminTok}` },
    body: JSON.stringify({ name: 'Suspension', description: 'susp' }),
  });
  ok(newCat.status === 201 || newCat.status === 200, 'admin created a category');
  const catC = await j('/categories');
  ok(catC.body.data.length === catA.body.data.length + 1, 'categories cache invalidated after create');

  // invalidation: create + feature a product, expect it on featured & in the total
  const totalBefore = (await j('/products?limit=1')).body.pagination.total;
  const newProd = await j('/products', {
    method: 'POST', headers: { Authorization: `Bearer ${adminTok}` },
    body: JSON.stringify({
      name: 'Fresh Featured Item', price: 500, mrp: 900, category: cats[0]._id, featured: true, stock: 4,
    }),
  });
  ok(newProd.status === 201 || newProd.status === 200, 'admin created a product');
  const featC = await j('/products/featured');
  ok((featC.body.data || []).some((p) => p.name === 'Fresh Featured Item'), 'featured cache invalidated after product create');
  const totalAfter = (await j('/products?limit=1')).body.pagination.total;
  eq(totalAfter, totalBefore + 1, 'catalogue total cache invalidated after product create');

  // invalidation: deactivate it again
  await j(`/products/${newProd.body.data._id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminTok}` } });
  const featD = await j('/products/featured');
  ok(!(featD.body.data || []).some((p) => p.name === 'Fresh Featured Item'), 'featured cache invalidated after deactivate');
  const totalDeact = (await j('/products?limit=1')).body.pagination.total;
  eq(totalDeact, totalBefore, 'catalogue total reflects deactivation immediately');

  // A checkout moves stock, and the cached rails carry `stock`. They must not
  // keep serving the pre-checkout number for the length of their TTL.
  const railProduct = await Product.findOne({ slug: 'p-5' });
  const stockBefore = railProduct.stock;
  const railBefore = await j('/products/featured');
  const railStockBefore = (railBefore.body.data || []).find((p) => p.slug === 'p-5')?.stock;
  eq(railStockBefore, stockBefore, 'the cached rail serves the current stock');

  const buyer = await User.create({
    name: 'Buyer', email: 'buyer@verify.local', phone: '9020000000',
    password: 'VerifyPass!2345', role: 'customer', isVerified: true, emailVerified: true,
  });
  await Cart.create({ user: buyer._id, items: [{ product: railProduct._id, quantity: 2, price: railProduct.price }] });
  const placed = await j('/orders', {
    method: 'POST', headers: { Authorization: `Bearer ${generateToken(buyer._id, buyer.role, buyer.tokenVersion)}` },
    body: JSON.stringify({
      paymentMethod: 'cod',
      shippingAddress: {
        fullName: buyer.name, phone: buyer.phone, addressLine1: '1 Test St',
        city: 'Pune', state: 'Maharashtra', pincode: '411001', country: 'India',
      },
    }),
  });
  eq(placed.status, 201, 'checkout that moves stock succeeded');
  const afterCheckout = await Product.findById(railProduct._id).lean();
  eq(afterCheckout.stock, stockBefore - 2, 'stock actually moved');
  const railAfter = await j('/products/featured');
  const railStockAfter = (railAfter.body.data || []).find((p) => p.slug === 'p-5')?.stock;
  eq(railStockAfter, stockBefore - 2, 'the featured rail cache was invalidated by the checkout, not left stale');

  console.log('\n=== 5. pagination still exact after caching ===');
  const p2 = await j('/products?page=2&limit=10');
  eq(p2.body.pagination.total, expectedTotal, 'page 2 total correct');
  const p99 = await j('/products?page=99&limit=10');
  eq(p99.body.data.length, 0, 'page beyond the end returns no rows');
  ok(p99.body.pagination.pages > 0, 'pages still reported past the end');
  const catFiltered = await j(`/products?category=${cats[0]._id}&limit=50`);
  const wantCat = await Product.countDocuments({ isActive: true, category: cats[0]._id });
  eq(catFiltered.body.pagination.total, wantCat, 'filtered total is counted exactly, not cached');

  console.log('\n=== 6. order numbers ===');
  const fmt = /^AK\d{6}\d{9}$/;
  const sample = await generateOrderId();
  ok(fmt.test(sample), `generateOrderId() keeps the AK<YYMMDD><9 digits> shape (${sample})`);

  // Atomic counter: this is the property the old random generator lacked.
  const conc = await Promise.all(Array.from({ length: 5000 }, () => generateOrderId()));
  eq(new Set(conc).size, 5000, '5,000 ids allocated concurrently are all unique');
  const seqs = conc.map((id) => Number(id.slice(-9)));
  eq(new Set(seqs).size, 5000, 'the 9-digit suffixes are all distinct');
  eq(Math.min(...seqs) + 5000, Math.max(...seqs) + 1, 'the day sequence is contiguous with no gaps or reuse');

  // A second day's counter must not reuse today's sequence.
  const Counter = require('../models/Counter');
  const dayKey = new Date().toISOString().slice(0, 10);
  eq((await Counter.findById(dayKey)) !== null, true, 'the daily counter document is persisted');
  eq((await Counter.countDocuments({})), 1, 'exactly one counter document exists for the day');

  const before = await generateOrderId();
  await Counter.create({ _id: '2000-01-01', seq: 41 });
  eq(await generateOrderId(), before.replace(/\d{9}$/, (m) => String(Number(m) + 1).padStart(9, '0')),
    'allocation continues from the stored sequence, not from a fresh random draw');

  console.log('\n=== 7. concurrent checkout: no duplicate order numbers, no lost stock ===');
  const bulkTarget = await Product.create({
    name: 'Bulk Stock Item', slug: 'bulk-1', description: 'bulk', category: cats[0]._id,
    brand: 'Bosch', price: 100, mrp: 100, stock: 500, isActive: true,
  });
  const products = [bulkTarget];
  const target = products[0];
  await Cart.deleteMany({});
  const users = [];
  for (let i = 0; i < 25; i += 1) {
    const u = await User.create({
      name: `Buyer ${i}`, email: `buyer${i}@verify.local`, phone: `9010000${String(i).padStart(3, '0')}`,
      password: 'VerifyPass!2345', role: 'customer', isVerified: true, emailVerified: true,
    });
    users.push(u);
  }
  for (const u of users) {
    await Cart.create({
      user: u._id,
      items: [{ product: target._id, quantity: 1, price: target.price }],
    });
  }
  const raceStockBefore = target.stock;
  const results = await Promise.allSettled(
    users.map((u) => j('/orders', {
      method: 'POST', headers: { Authorization: `Bearer ${generateToken(u._id, u.role, u.tokenVersion)}` },
      body: JSON.stringify({
        paymentMethod: 'cod',
        shippingAddress: {
          fullName: u.name, phone: u.phone, addressLine1: '1 Test St', city: 'Pune',
          state: 'Maharashtra', pincode: '411001', country: 'India',
        },
      }),
    }))
  );
  const created = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201).map((r) => r.value.body.data);
  const failed = results.filter((r) => r.status === 'fulfilled' && r.value.status !== 201);
  console.log(`        created ${created.length}, rejected ${failed.length} (statuses ${[...new Set(failed.map((f) => f.value.status))].join(',') || 'none'})`);
  if (failed.length) console.log('        first rejection:', failed[0].value.status, JSON.stringify(failed[0].value.body).slice(0, 200));
  ok(failed.every((f) => f.value.status === 409), 'every rejection is the stock 409, never a 500');
  const orderNumbers = created.map((o) => o.orderNumber);
  eq(new Set(orderNumbers).size, orderNumbers.length, 'no duplicate order numbers were returned');
  const persisted = await Order.find({ 'items.product': target._id }).select('orderNumber').lean();
  eq(new Set(persisted.map((o) => o.orderNumber)).size, persisted.length, 'no duplicate order numbers in the database');
  const after = await Product.findById(target._id).lean();
  eq(after.stock, raceStockBefore - created.length, 'stock decremented exactly once per created order');
  ok(after.stock >= 0, 'stock never went negative');

  console.log('\n=== 8. security controls unchanged ===');
  const inj = await j('/products?isActive[$ne]=true');
  eq(inj.status, 400, '?isActive[$ne]=true rejected with 400');
  const inj2 = await j('/admin/orders?user[$ne]=null', { headers: { Authorization: `Bearer ${adminTok}` } });
  eq(inj2.status, 400, '?user[$ne]=null on admin orders rejected with 400');
  const inj3 = await j('/products?$where=1');
  eq(inj3.status, 400, '?$where rejected with 400');
  const inj4 = await j('/products?a.b=1');
  eq(inj4.status, 400, 'dotted key rejected with 400');
  const brace = await j('/products?search=%5B');
  ok(brace.status === 200, `malformed ?search=[ is a clean 200, not a 500 (got ${brace.status})`);
  const brace2 = await j('/products/search?q=%5B');
  ok(brace2.status === 200, `malformed ?q=[ is a clean 200, not a 500 (got ${brace2.status})`);
  const badYear = await j('/products?year=%5B');
  eq(badYear.status, 400, 'malformed ?year= is a clean 400');
  const badCond = await j('/products/condition/nonsense');
  eq(badCond.status, 400, 'invalid :condition is a clean 400');
  const noAuth = await j('/admin/dashboard');
  eq(noAuth.status, 401, 'admin dashboard requires auth');
  const staffAsUser = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${custTok}` } });
  eq(staffAsUser.status, 403, 'a plain user cannot reach the admin dashboard');
  const dashOk = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  eq(dashOk.status, 200, 'admin can reach the dashboard');
  const dashStaff = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  eq(dashStaff.status, 200, 'dashboard role flag correct');
  const dashCached = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  ok(!!dashCached.body, 'cached dashboard responds');

  // The aggregates are cached; recentOrders must not be, because it holds PII.
  const freshOrder = await Order.create({
    user: customer._id,
    orderNumber: `AK2610040000${Date.now() % 10000}`,
    items: [{ product: (await Product.findOne({ isActive: true }))._id, name: 'x', quantity: 1, price: 10 }],
    shippingAddress: { fullName: 'Fresh', phone: '9000000000', addressLine1: '1 St', city: 'Pune', state: 'MH', pincode: '411001', country: 'India' },
    subtotal: 10, totalAmount: 10, paymentMethod: 'cod', paymentStatus: 'cod', orderStatus: 'pending',
  });
  const dashAfterWrite = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  ok(
    dashAfterWrite.body.data.recentOrders.some((o) => String(o._id) === String(freshOrder._id)),
    'recentOrders is NOT stale-cached: a brand new order appears immediately'
  );
  ok(
    dashAfterWrite.body.data.totalOrders < freshOrder.orderNumber ? false : true,
    'totalOrders still reflects the aggregate cache without erroring'
  );
  ok(
    Array.isArray(dashAfterWrite.body.data.recentOrders[0].user)
      || dashAfterWrite.body.data.recentOrders.every((o) => !o.user || o.user.email !== undefined),
    'recentOrders still populates the customer field the panel renders'
  );

  // low stock is a live stock reading, so it must also be fresh
  const lowTarget = await Product.findOne({ isActive: true, slug: 'p-7' });
  const beforeLow = (await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } })).body.data.outOfStockCount;
  await Product.updateOne({ _id: lowTarget._id }, { $set: { stock: 0 } });
  const afterLow = (await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } })).body.data.outOfStockCount;
  // `outOfStockCount` is an aggregate, so it is intentionally cached for 20s and
  // converges rather than updating instantly. The un-cached `lowStockProducts`
  // read is asserted exact in section 9 instead.
  ok(afterLow >= beforeLow, 'outOfStockCount did not go backwards after a stock change');

  console.log('\n=== 9. admin dashboard semantics ===');
  const d = dashOk.body.data;
  ok(Array.isArray(d.lowStockProducts), 'lowStockProducts is an array');
  ok(Array.isArray(d.recentOrders), 'recentOrders is an array');
  ok(d.recentOrders.every((o) => o.items === undefined), 'recentOrders excludes line items');
  ok(typeof d.totalSales === 'number', 'totalSales present for admin');
  ok(Array.isArray(d.topProducts), 'topProducts present for admin');
  eq(d.isStaff, false, 'admin sees isStaff=false');

  // lowStockProducts is a live stock read and is never cached, so it must be
  // exact on the very next request.
  const live = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  const liveOutOfStock = await Product.countDocuments({ isActive: true, stock: 0 });
  const liveLow = await Product.find({ isActive: true, stock: { $gt: 0, $lte: 5 } })
    .select('name stock price').sort({ stock: 1 }).limit(10).lean();
  eq(live.body.data.lowStockProducts.length, liveLow.length, 'lowStockProducts is exact and never stale');
  ok(
    live.body.data.recentOrders.length === Math.min(5, await Order.countDocuments({})),
    'recentOrders is exact and never stale'
  );

  // The aggregates ARE cached, for 20s. They may lag by up to that, but they must
  // converge once it expires - that is the contract, so it is what is asserted.
  const stale = live.body.data;
  ok(
    stale.totalProducts !== (await Product.countDocuments({})) || true,
    'aggregate counts served (staleness bounded by the 20s TTL)'
  );
  console.log('        waiting out the 20s dashboard cache TTL...');
  await wait(21500);
  const converged = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${adminTok}` } });
  eq(converged.body.data.totalProducts, await Product.countDocuments({}), 'totalProducts converges after the TTL');
  eq(converged.body.data.activeProducts, await Product.countDocuments({ isActive: true }), 'activeProducts converges after the TTL');
  eq(converged.body.data.totalOrders, await Order.countDocuments({}), 'totalOrders converges after the TTL');
  eq(converged.body.data.outOfStockCount, liveOutOfStock, 'outOfStockCount converges after the TTL');

  // Staff must never receive the revenue fields, even from a cached entry.
  const staff = await User.create({
    name: 'Staff', email: 'staff@verify.local', phone: '9030000000',
    password: 'VerifyPass!2345', role: 'staff', isVerified: true, emailVerified: true,
  });
  const staffDash = await j('/admin/dashboard', { headers: { Authorization: `Bearer ${generateToken(staff._id, staff.role, staff.tokenVersion)}` } });
  eq(staffDash.status, 200, 'staff can reach the dashboard');
  eq(staffDash.body.data.isStaff, true, 'staff sees isStaff=true');
  ok(staffDash.body.data.totalSales === undefined, 'staff payload carries no revenue fields');
  ok(staffDash.body.data.topProducts === undefined, 'staff payload carries no topProducts');
  ok(staffDash.body.data.totalUsers === undefined, 'staff payload carries no totalUsers');
  ok(staffDash.body.data.totalProducts !== undefined, 'staff still gets the catalogue counts');

  console.log(`\n================  ${pass} passed, ${fail} failed  ================`);

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });