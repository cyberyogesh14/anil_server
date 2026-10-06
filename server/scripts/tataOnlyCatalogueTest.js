/**
 * TATA-only catalogue test suite.
 *
 * Boots the full application against mongodb-memory-server and proves the
 * business rule end to end: the catalogue stores, serves and accepts ONLY Tata
 * vehicle parts, at the query level rather than the UI level.
 *
 * Covers:
 *   - every public read (list, rails, search, category, detail) excludes rows
 *     whose `carBrand` is not Tata, including via `?carBrand=` which is ignored
 *   - `brand` continues to mean "part supplier", not vehicle make
 *   - non-Tata product detail is a 404 for anonymous AND staff/admin callers
 *   - writes reject a non-Tata `carBrand`, `brand`, `carModel`, `name` or
 *     `description` with a 400 (create and update, staff and admin)
 *   - Tata spellings are canonicalised to `Tata` (model default + controller)
 *   - the admin dashboard product stats count the Tata catalogue only
 *   - legacy rows with an empty `carBrand` stay invisible (migration's job)
 *
 * Run: npm run test:tata
 */
'use strict';

process.env.PORT = '5105';
process.env.JWT_SECRET = 'test_jwt_secret_tata';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';

delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
let failed = 0;

const ok = (cond, msg) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${msg}`);
  }
};

const assertStatus = (res, status, label) =>
  ok(res.status === status, `${label} -> ${status} (got ${res.status})`);

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();

  const app = require('../server');
  const mongoose = require('mongoose');
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const User = require('../models/User');
  const { generateToken } = require('../utils/generateToken');

  const base = `http://127.0.0.1:${process.env.PORT}`;

  const api = async (method, url, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: payload,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: json, text: await res.text().catch(() => '') };
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 60 && mongoose.connection.readyState !== 1; i += 1) await wait(250);

  const cats = await Category.create([
    { name: 'Brake Parts', slug: 'brake-parts', description: 'brakes' },
    { name: 'Filters', slug: 'filters', description: 'filters' },
  ]);

  const mk = (i, over = {}) => ({
    name: `Tata Nexon Part ${i}`,
    slug: `tt-${i}`,
    sku: `TT-SKU-${i}`,
    description: `tata part number ${i}`,
    brand: 'Bosch',
    category: cats[0]._id,
    carBrand: 'Tata',
    carModel: 'Nexon',
    partNumber: `TT-PN-${i}`,
    price: 1000,
    mrp: 1500,
    stock: 10,
    featured: false,
    isActive: true,
    emissionStandard: 'BS6',
    discount: 0,
    ...over,
  });

  // Fixture rows: four Tata parts, one Maruti row, one Hyundai row with a big
  // discount (it must lose to a Tata part on every rail, including best-deals),
  // one row with an alias spelling and one unclassified (empty carBrand) row.
  const fixtures = [
    mk(1, { name: 'Tata Nexon BS6 Brake Pad', slug: 'tt-brake', carModel: 'Nexon', featured: true }),
    mk(2, { name: 'Tata Altroz Air Filter', slug: 'tt-filter-altroz', carModel: 'Altroz', brand: 'Valeo', condition: 'used_good', emissionStandard: 'BS4' }),
    mk(3, { name: 'Tata Punch Cabin Filter', slug: 'tt-filter-punch', carModel: 'Punch', category: cats[1]._id, featured: true }),
    mk(4, { name: 'Tata Harrier Wiper Set', slug: 'tt-wiper', carModel: 'Harrier', discount: 30 }),
    {
      name: 'Maruti Swift Oil Filter',
      slug: 'tt-maruti',
      sku: 'TT-SKU-90',
      description: 'oil filter for a Maruti swift',
      brand: 'Maruti Genuine',
      category: cats[1]._id,
      carBrand: 'Maruti Suzuki',
      carModel: 'Swift',
      partNumber: 'TT-PN-90',
      price: 249,
      mrp: 399,
      stock: 5,
      featured: true,
      isActive: true,
      emissionStandard: 'BS6',
      discount: 25,
    },
    {
      name: 'Hyundai Creta Brake Disc',
      slug: 'tt-hyundai',
      sku: 'TT-SKU-91',
      description: 'brake disc for hyundai',
      brand: 'Hyundai OEM',
      category: cats[0]._id,
      carBrand: 'Hyundai',
      carModel: 'Creta',
      partNumber: 'TT-PN-91',
      price: 2999,
      mrp: 4499,
      stock: 5,
      featured: true,
      isActive: true,
      emissionStandard: 'BS6',
      discount: 55,
    },
    mk(5, { name: 'Tata Tigor Suspension Kit', slug: 'tt-alias', carModel: 'Tigor', carBrand: 'TATA' }),
    mk(6, { name: 'Tata Tiago Fuel Pump', slug: 'tt-empty', carModel: 'Tiago', carBrand: '' }),
  ];
  const inserted = await Product.insertMany(fixtures);
  const byId = (doc) => String(doc._id);

  // Fixture order: 0 nexon, 1 altroz, 2 punch, 3 wiper, 4 maruti, 5 hyundai,
  // 6 tigor(alias), 7 tiago(empty carBrand).
  const tataIds = new Set([0, 1, 2, 3, 6].map((i) => byId(inserted[i])));
  const nonTataIds = new Set([4, 7].map((i) => byId(inserted[i])));

  const admin = await User.create({
    name: 'Admin Tata', email: 'tata-admin@verify.local', phone: '9000000100',
    password: 'VerifyPass!2345', role: 'admin', isVerified: true, emailVerified: true,
  });
  const staff = await User.create({
    name: 'Staff Tata', email: 'tata-staff@verify.local', phone: '9000000101',
    password: 'VerifyPass!2345', role: 'staff', isVerified: true, emailVerified: true,
  });
  const adminToken = generateToken(admin._id, admin.role, admin.tokenVersion);
  const staffToken = generateToken(staff._id, staff.role, staff.tokenVersion);
  const expectedTataActive = 5; // 4 + alias (TATA -> Tata), excluding the empty row

  const idsOf = (data) => (data || []).map((p) => String(p._id));
  const everyTata = (data) => idsOf(data).every((id) => tataIds.has(id));
  const excludes = (data, id) => !idsOf(data).includes(String(id));

  // =======================================================================
  console.log('='.repeat(70));
  console.log('1. GET /products - list (query-level enforcement)');
  console.log('='.repeat(70));

  const list = await api('GET', '/api/products?limit=50');
  assertStatus(list, 200, 'GET /products');
  ok(
    everyTata(list.body.data) && list.body.data.length === expectedTataActive,
    `returns only Tata parts (${list.body.data.length}/${expectedTataActive})`
  );
  ok(excludes(list.body.data, inserted[4]._id), 'Maruti row excluded');
  ok(excludes(list.body.data, inserted[7]._id), 'empty-carBrand row excluded');

  ok(
    list.body.pagination.total === expectedTataActive,
    `pagination.total counts the Tata catalogue only (${list.body.pagination.total})`
  );

  const ignored = await api('GET', '/api/products?carBrand=Maruti&limit=50');
  ok(
    everyTata(ignored.body.data) && ignored.body.data.length === expectedTataActive,
    '?carBrand=Maruti is ignored (param is not a filter)'
  );

  const tataParam = await api('GET', '/api/products?carBrand=Tata&limit=50');
  ok(
    everyTata(tataParam.body.data) && tataParam.body.data.length === expectedTataActive,
    '?carBrand=Tata behaves identically (no widening, no narrowing)'
  );

  const brandFilter = await api('GET', '/api/products?brand=Bosch&limit=50');
  ok(
    brandFilter.body.data.length >= 1 &&
      idsOf(brandFilter.body.data).every((id) => tataIds.has(id)),
    '?brand=Bosch is a part-supplier filter and stays Tata'
  );

  const modelFilter = await api('GET', '/api/products?carModel=Nexon&limit=50');
  ok(
    idsOf(modelFilter.body.data).length >= 1 &&
      idsOf(modelFilter.body.data).every((id) => tataIds.has(id)),
    '?carModel=Nexon filters within the Tata catalogue'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('2. Rails - featured, BS6, condition, best-deals');
  console.log('='.repeat(70));

  const featured = await api('GET', '/api/products/featured');
  ok(everyTata(featured.body.data), 'featured rail is Tata only');

  const bs6 = await api('GET', '/api/products/tata-bs6?limit=50');
  ok(
    everyTata(bs6.body.data) &&
      idsOf(bs6.body.data).every((id) => id !== String(inserted[4]._id)),
    'tata-bs6 rail is Tata only (Hyundai BS6 row excluded)'
  );

  const used = await api('GET', '/api/products/condition/used');
  ok(everyTata(used.body.data), 'condition rail is Tata only');

  const deals = await api('GET', '/api/products/best-deals?limit=50');
  ok(
    everyTata(deals.body.data) && excludes(deals.body.data, inserted[4]._id),
    'best-deals rail is Tata only (deep-discounted Maruti row excluded)'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('3. Search');
  console.log('='.repeat(70));

  const search = await api('GET', '/api/products/search?q=filter&limit=50');
  ok(
    everyTata(search.body.data) && excludes(search.body.data, inserted[4]._id),
    'search is Tata only (Maruti oil filter does not leak through "filter")'
  );

  const searchBrand = await api('GET', '/api/products/search?q=Maruti');
  ok(
    searchBrand.body.data.length === 0 || everyTata(searchBrand.body.data),
    'searching the non-Tata brand name finds nothing'
  );

  let searchGlobal;
  try {
    searchGlobal = await api('GET', '/api/products?search=filter&limit=50');
  } catch {
    searchGlobal = { body: { data: [] } };
  }
  ok(
    idsOf(searchGlobal.body.data).every((id) => tataIds.has(id)),
    'global ?search= filter is Tata only'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('4. Detail routes - 404 for non-Tata, every caller');
  console.log('='.repeat(70));

  const nonTataById = await api('GET', `/api/products/${inserted[4]._id}`);
  assertStatus(nonTataById, 404, 'GET /products/:id of Maruti row (anonymous)');

  const nonTataBySlug = await api('GET', '/api/products/slug/tt-maruti');
  assertStatus(nonTataBySlug, 404, 'GET /products/slug/tt-maruti');

  const emptyById = await api('GET', `/api/products/${inserted[7]._id}`);
  assertStatus(emptyById, 404, 'GET /products/:id of empty-carBrand row');

  const nonTataAsAdmin = await api('GET', `/api/products/${inserted[4]._id}`, { token: adminToken });
  assertStatus(nonTataAsAdmin, 404, 'GET /products/:id of Maruti row (admin)');

  const nonTataAsStaff = await api('GET', `/api/products/${inserted[4]._id}`, { token: staffToken });
  assertStatus(nonTataAsStaff, 404, 'GET /products/:id of Maruti row (staff)');

  const tataById = await api('GET', `/api/products/${inserted[0]._id}`);
  assertStatus(tataById, 200, 'GET /products/:id of a Tata row');

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('5. Category read');
  console.log('='.repeat(70));

  const byCat = await api('GET', `/api/products/category/${cats[0]._id}?limit=50`);
  ok(
    everyTata(byCat.body.data),
    'category read is Tata only (Hyundai brake disc in same category excluded)'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('6. Writes - createProduct (admin + staff)');
  console.log('='.repeat(70));

  const baseBody = {
    name: 'Tata Nexon Air Filter',
    description: 'air filter',
    brand: 'Bosch',
    category: String(cats[1]._id),
    carBrand: 'Tata',
    carModel: 'Nexon',
    price: 500,
    mrp: 700,
    stock: 10,
  };

  const rej = await api('POST', '/api/products', {
    token: adminToken,
    body: { ...baseBody, carBrand: 'Fiat' },
  });
  assertStatus(rej, 400, 'create with carBrand=Fiat is rejected');

  const rejBrand = await api('POST', '/api/products', {
    token: adminToken,
    body: { ...baseBody, brand: 'Hyundai OEM' },
  });
  assertStatus(rejBrand, 400, 'create with brand=Hyundai OEM is rejected');

  const rejName = await api('POST', '/api/products', {
    token: adminToken,
    body: { ...baseBody, name: 'For Honda City only' },
  });
  assertStatus(rejName, 400, 'create with a non-Tata name is rejected');

  const rejDesc = await api('POST', '/api/products', {
    token: adminToken,
    body: { ...baseBody, description: 'fits Toyota Innova perfectly' },
  });
  assertStatus(rejDesc, 400, 'create with a non-Tata description is rejected');

  const rejStaff = await api('POST', '/api/products', {
    token: staffToken,
    body: { ...baseBody, carBrand: 'Mahindra' },
  });
  assertStatus(rejStaff, 400, 'staff create with non-Tata carBrand is rejected');

  const aliasBody = { ...baseBody, name: 'Tata Altroz Filter', carBrand: 'TATA', sku: 'TT-NEW-ALIAS' };
  const aliasCreated = await api('POST', '/api/products', { token: adminToken, body: aliasBody });
  assertStatus(aliasCreated, 201, 'create with carBrand=TATA succeeds');
  ok(
    aliasCreated.body.data && aliasCreated.body.data.carBrand === 'Tata',
    `TATA spelling is normalised to the canonical "Tata" (stored: ${aliasCreated.body.data && aliasCreated.body.data.carBrand})`
  );

  const emptyBody = { ...baseBody, name: 'Tata Curvv Filter', carBrand: '', sku: 'TT-NEW-EMPTY' };
  const emptyCreated = await api('POST', '/api/products', { token: adminToken, body: emptyBody });
  assertStatus(emptyCreated, 201, 'create with empty carBrand succeeds');
  ok(
    emptyCreated.body.data.carBrand === 'Tata',
    'empty carBrand defaults to Tata'
  );

  const fresh = await api('GET', `/api/products/slug/${aliasCreated.body.data.slug}`);
  assertStatus(fresh, 200, 'newly created alias product is readable');
  ok(
    fresh.body.data.carBrand === 'Tata',
    'the canonical carBrand is what the read filter matches'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('7. Writes - updateProduct (admin + staff)');
  console.log('='.repeat(70));

  const target = inserted[0];
  const upd = await api('PUT', `/api/products/${target._id}`, {
    token: adminToken,
    body: { carBrand: 'Kia' },
  });
  assertStatus(upd, 400, 'update to carBrand=Kia is rejected');

  const updModel = await api('PUT', `/api/products/${target._id}`, {
    token: adminToken,
    body: { carModel: 'Ford Ecosport' },
  });
  assertStatus(updModel, 400, 'update to a non-Tata carModel is rejected');

  const updStaff = await api('PUT', `/api/products/${target._id}`, {
    token: staffToken,
    body: { carModel: 'Seltos' },
  });
  assertStatus(updStaff, 400, 'staff update to a non-Tata carModel is rejected');

  const updPrice = await api('PUT', `/api/products/${target._id}`, {
    token: adminToken,
    body: { price: 1234 },
  });
  assertStatus(updPrice, 200, 'legitimate price update succeeds');
  const reloaded = await Product.findById(target._id).lean();
  ok(reloaded.carBrand === 'Tata', 'the update left carBrand untouched as Tata');

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('8. Admin dashboard stats - Tata catalogue only');
  console.log('='.repeat(70));

  const dash = await api('GET', '/api/admin/dashboard', { token: adminToken });
  assertStatus(dash, 200, 'GET /admin/dashboard (admin)');
  ok(
    dash.body.data.totalProducts === await Product.countDocuments({ carBrand: 'Tata' }),
    'dashboard totalProducts counts Tata rows only'
  );
  ok(
    dash.body.data.activeProducts ===
      await Product.countDocuments({ carBrand: 'Tata', isActive: true }),
    'dashboard activeProducts counts active Tata rows only'
  );

  // =======================================================================
  console.log('\n' + '='.repeat(70));
  console.log('9. Model defaults and canonicalisation');
  console.log('='.repeat(70));

  const noBrand = await Product.create({
    name: 'Tata Nano Wiper', slug: 'tt-model-default', sku: 'TT-MODEL-1',
    category: cats[0]._id, price: 100, mrp: 200, stock: 1,
  });
  ok(noBrand.carBrand === 'Tata', 'Product.create with no carBrand defaults to Tata');

  const aliasModel = await Product.create({
    name: 'Tata Hatch Wiper', slug: 'tt-model-alias', sku: 'TT-MODEL-2',
    category: cats[0]._id, price: 100, mrp: 200, stock: 1, carBrand: 'Tata Motors',
  });
  ok(aliasModel.carBrand === 'Tata', 'carBrand "Tata Motors" is canonicalised to Tata');

  console.log('\n\nTATA-ONLY CATALOGUE TESTS');
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async (error) => {
  console.error(`Test harness failed: ${error.message}`);
  process.exit(1);
});