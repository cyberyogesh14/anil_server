/**
 * Seeds the ISOLATED load-test database with a realistic dataset.
 *
 * READ THIS BEFORE RUNNING
 *
 * This script refuses to run unless it is pointed at a database whose name ends
 * in `loadtest`. That guard is the whole safety story: it means a mistyped
 * `MONGO_URI` cannot cause this to wipe a real database. It also connects to the
 * URI the throwaway `db.js` wrote, never to the application's own `.env`.
 *
 * Repeatable: every run drops and rebuilds the load-test collections from
 * scratch, so two runs produce the same shape of data. A fixed PRNG seed makes the
 * dataset deterministic.
 *
 * Reversible: `npm run loadtest:teardown` deletes every collection it created.
 *
 * Usage:
 *   node scripts/loadtest/seed.js            # full dataset
 *   node scripts/loadtest/seed.js --users 5000 --products 1000
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const URI_FILE = path.join(__dirname, '.loadtest-db-uri');

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

function resolveUri() {
  // Prefer the URI the isolated mongod wrote. Fall back to an explicit env var so
  // the script can also be pointed at a manually started throwaway instance.
  const uri =
    (fs.existsSync(URI_FILE) && fs.readFileSync(URI_FILE, 'utf8').trim()) ||
    process.env.LOADTEST_MONGO_URI;

  if (!uri) {
    throw new Error(
      'No load-test database found. Start the isolated database first:\n' +
        '  node scripts/loadtest/db.js\n' +
        'or set LOADTEST_MONGO_URI to a throwaway instance.'
    );
  }

  const dbName = uri.split('/').pop().split('?')[0];
  if (!dbName.endsWith('loadtest')) {
    throw new Error(
      `REFUSING TO RUN: target database is "${dbName}", which does not end in ` +
        '"loadtest". This script drops collections, so it only ever runs against ' +
        'a disposable database.'
    );
  }

  return { uri, dbName };
}

// ---------------------------------------------------------------------------
// Deterministic PRNG so the dataset is reproducible
// ---------------------------------------------------------------------------

let seedState = 0x2f6e2b1;
function rnd() {
  // mulberry32
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

// ---------------------------------------------------------------------------
// Realistic reference data
// ---------------------------------------------------------------------------

const CATEGORIES = [
  ['Engine Parts', 'engine-parts', 'Pistons, valves, gaskets and seals'],
  ['Brake System', 'brake-system', 'Brake pads, discs, calipers and fluid'],
  ['Filter Set', 'filter-set', 'Oil, air, fuel and cabin filters'],
  ['Suspension', 'suspension', 'Shocks, bushings, springs and arms'],
  ['Electrical', 'electrical', 'Alternators, starters, sensors and wiring'],
  ['Body Parts', 'body-parts', 'Bumpers, panels, mirrors and lights'],
  ['Cooling System', 'cooling-system', 'Radiators, pumps, hoses and fans'],
  ['Transmission', 'transmission', 'Clutch, gearbox and drive components'],
  ['Lighting', 'lighting', 'Headlamps, tail lamps and indicators'],
  ['Tyres & Wheels', 'tyres-wheels', 'Alloy wheels, tyres and hub caps'],
  ['Consumables', 'consumables', 'Oils, additives, cleaners and adhesives'],
  ['Tools & Service', 'tools-service', 'Hand tools, jacks and service kits'],
];

// TATA-only catalogue: every seeded vehicle is a Tata, matching the read-side
// policy (`tataOnlyFilter`), so the load test exercises the same data shape the
// store serves in production.
const CAR_BRANDS = ['Tata'];
const CAR_MODELS = {
  Tata: ['Nexon', 'Punch', 'Altroz', 'Tiago', 'Harrier', 'Safari', 'Curvv', 'Tigor', 'Ace', 'Intra'],
};
const BRANDS = ['Bosch', 'Tata OEM', 'Valeo', 'Denso', 'NGK', 'Exide', 'Amaron', 'Minda'];
const PARTS = [
  'Brake Pad Set', 'Oil Filter', 'Air Filter', 'Spark Plug', 'Shock Absorber', 'Clutch Kit',
  'Radiator', 'Water Pump', 'Battery', 'Wiper Blade', 'Side Mirror', 'Headlight Bulb',
  'CV Joint', 'Wheel Bearing', 'Timing Belt', 'Ignition Coil', 'Fuel Pump', 'Alternator',
  'Bumper Cover', 'Tail Lamp', 'Bushing Kit', 'Drive Belt', 'Fuel Filter', 'Cabin Filter',
];
const CONDITIONS = ['new', 'used', 'refurbished'];
const STANDARDS = ['BS6', 'BS4'];
const CITIES = [
  ['Mumbai', 'Maharashtra'], ['Delhi', 'Delhi'], ['Bengaluru', 'Karnataka'],
  ['Hyderabad', 'Telangana'], ['Chennai', 'Tamil Nadu'], ['Pune', 'Maharashtra'],
  ['Kolkata', 'West Bengal'], ['Ahmedabad', 'Gujarat'], ['Jaipur', 'Rajasthan'],
  ['Lucknow', 'Uttar Pradesh'],
];
const STATES_UT = [
  ['Maharashtra', '400001'], ['Delhi', '110001'], ['Karnataka', '560001'],
  ['Telangana', '500001'], ['Tamil Nadu', '600001'], ['West Bengal', '700001'],
  ['Gujarat', '380001'], ['Rajasthan', '302001'], ['Uttar Pradesh', '226001'],
];
const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const REVIEW_TITLES = [
  'Excellent fit', 'Good quality', 'Value for money', 'Perfect match', 'Fast delivery',
  'Recommended', 'Works as expected', 'Decent product', 'Great price', 'Easy to fit',
];
const REVIEW_BODIES = [
  'Fitted perfectly on my car, no issues at all.',
  'Good build quality and arrived quickly.',
  'Correct part, exactly as described. Will order again.',
  'Reasonable price for the quality. Happy with it.',
  'Installation was straightforward using standard tools.',
  'Packaging was solid and the part was undamaged.',
];
const FIRST = ['Amit', 'Rohit', 'Sneha', 'Priya', 'Rahul', 'Anita', 'Vikram', 'Neha',
  'Suresh', 'Kavita', 'Arjun', 'Meera', 'Rajesh', 'Pooja', 'Sanjay', 'Divya',
  'Manish', 'Kiran', 'Anil', 'Sunita'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Singh', 'Gupta',
  'Mehta', 'Joshi', 'Kulkarni', 'Desai', 'Chauhan', 'Rao', 'Das'];

// Password used for every seeded account. It is a throwaway credential that only
// exists inside the disposable database; login is never load tested, tokens are
// minted directly during seeding instead (see README).
const SEED_PASSWORD = 'LoadTest!Passw0rd';

// ---------------------------------------------------------------------------
// Insertion helpers
// ---------------------------------------------------------------------------

async function insertBatches(collection, docs, batchSize) {
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    // `ordered: false` keeps a single bad document from aborting a whole batch.
    await collection.insertMany(batch, { ordered: false });
  }
}

/**
 * `insertMany` returns an InsertManyResult whose shape differs across driver
 * versions (an `insertedIds` map in some, a bare array of ids in others). This
 * normalises both so the seeder does not depend on the installed driver version.
 */
function idsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && result.insertedIds) {
    if (Array.isArray(result.insertedIds)) return result.insertedIds;
    // InsertManyResult.insertedIds is an object keyed by array index. Object keys
    // are numeric strings, so they must be ordered numerically, not lexically,
    // otherwise index 10 would sort before index 2 and ids would be mismatched.
    return Object.keys(result.insertedIds)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => result.insertedIds[k]);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? Number(args[idx + 1]) : dflt;
  };

  const USER_COUNT = getArg('users', 50000);
  const PRODUCT_COUNT = getArg('products', 12000);
  const REVIEW_RATIO = getArg('reviews', 20); // reviews per product (capped at 30)
  const ORDER_COUNT = getArg('orders', 40000);
  const WISHLIST_COUNT = getArg('wishlists', 20000);

  const { uri, dbName } = resolveUri();

  // bcrypt is deliberately NOT used here. Hashing 50,000 passwords at, say, 10
  // hashes/sec of CPU would dominate the entire seeding run for a credential
  // that is only ever used by a throwaway database. The stored value is a plain
  // marker string, which is fine because no login ever happens against this data.
  await mongoose.connect(uri, { maxPoolSize: 10 });
  const db = mongoose.connection.db;

  process.stdout.write(`[seed] target database: ${dbName}\n`);

  const started = Date.now();

  // ---- DROP (reversible: only ever the loadtest database) -----------------
  const existing = await db.listCollections().toArray();
  if (existing.length) {
    process.stdout.write(`[seed] dropping ${existing.length} existing collections\n`);
    for (const c of existing) await db.collection(c.name).drop();
  }

  // Build data before enabling indexes: inserting 50k documents with indexes
  // present is several times slower than building the indexes afterwards.
  await mongoose.connection.db.admin().command({ create: 'benchmarks' }).catch(() => {});
  await mongoose.connection.db.createCollection('benchmarks').catch(() => {});

  process.stdout.write(`[seed] ${USER_COUNT} users, ${PRODUCT_COUNT} products...\n`);

  // ---- Categories ---------------------------------------------------------
  const categoryIds = [];
  {
    const cats = CATEGORIES.map(([name, slug, description]) => ({
      name, slug, description,
      image: { url: `https://example.invalid/img/categories/${slug}.webp`, publicId: `lt/${slug}` },
      isActive: true,
    }));
    const res = await db.collection('categories').insertMany(cats, { ordered: false });
    idsOf(res).forEach((id, i) => categoryIds.push({ id, slug: CATEGORIES[i][1] }));
  }

  // ---- Users --------------------------------------------------------------
  const userIds = [];
  {
    const users = [];
    for (let i = 0; i < USER_COUNT; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const [city, state] = pick(CITIES);
      users.push({
        name,
        email: `loadtest.user${i}@example.invalid`,
        phone: `${int(70, 99)}${int(10000000, 99999999)}`,
        password: SEED_PASSWORD,
        role: 'customer',
        tokenVersion: 0,
        isActive: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        marketingConsent: rnd() < 0.4,
        termsAccepted: true,
        termsAcceptedAt: new Date(),
        addresses: [
          {
            fullName: name,
            phone: `${int(70, 99)}${int(10000000, 99999999)}`,
            addressLine1: `${int(1, 400)} ${pick(['MG Road', 'Station Road', 'Park Street', 'Civil Lines', 'Nehru Nagar'])}`,
            addressLine2: '',
            city,
            state,
            pincode: pick(STATES_UT)[1],
            country: 'India',
            isDefault: true,
          },
        ],
        createdAt: new Date(Date.now() - int(0, 900) * 24 * 3600 * 1000),
      });
    }
    const res = await db.collection('users').insertMany(users, { ordered: false });
    userIds.push(...idsOf(res));
    users.length = 0;
  }

  // ---- Products -----------------------------------------------------------
  const productIds = [];
  const productMeta = [];
  // Indices into `productIds` for products that are active and in stock. See the
  // note where this is populated.
  const purchasableIdx = [];
  {
    const products = [];
    for (let i = 0; i < PRODUCT_COUNT; i++) {
      const carBrand = pick(CAR_BRANDS);
      const carModel = pick(CAR_MODELS[carBrand]);
      const part = pick(PARTS);
      const mrp = int(3, 90) * 100;
      const price = Math.round(mrp * (rnd() < 0.45 ? 0.7 + rnd() * 0.25 : 1));
      const name = `${pick(BRANDS)} ${part} for ${carBrand} ${carModel}`;
      const slug = `ak-lt-${i}-${part.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const discount = mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;
      const cond = pick(CONDITIONS);
      const cat = categoryIds[i % categoryIds.length];

      // Only ~2% out of stock, and in-stock items carry a deeper range. The
      // earlier 6% at 1-120 units meant order creation kept hitting "Insufficient
      // stock ... Available: 0" during checkout runs. That validation is correct
      // application behaviour, but a dataset where a fifth of orders cannot
      // possibly succeed measures stock exhaustion rather than checkout
      // throughput. Stockout is still represented, just not dominantly.
      const stock = rnd() < 0.02 ? 0 : int(50, 500);
      const isActive = rnd() > 0.03;

      // Indices of products that a customer could actually buy. Carts and seeded
      // orders are built only from these. Order creation validates every line of the
      // cart, so a cart that happens to contain an inactive or sold-out line makes
      // the whole order fail regardless of what the test adds to it. Hoisting the
      // stockouts into a separate list keeps the catalogue honest while letting the
      // checkout scenarios measure checkout rather than seed luck.
      if (isActive && stock > 0) purchasableIdx.push(i);

      products.push({
        name,
        slug,
        sku: `LT-SKU-${String(i).padStart(7, '0')}`,
        description: `${part} compatible with ${carBrand} ${carModel}. OEM quality replacement part with ${int(6, 60)} month warranty. Includes all mounting hardware.`,
        brand: pick(BRANDS),
        category: cat.id,
        carBrand,
        carModel,
        compatibleYears: `${int(2012, 2021)}-${int(2012, 2021)}`,
        partNumber: `PN-${int(100000, 999999)}`,
        condition: cond,
        emissionStandard: pick(STANDARDS),
        price,
        mrp,
        discount,
        stock,
        images: [
          { url: `https://example.invalid/img/products/${slug}-1.webp`, publicId: `lt/${slug}/1` },
        ],
        featured: rnd() < 0.05,
        isActive,
        rating: rnd() < 0.85 ? int(3, 5) : 0,
        numReviews: 0,
        specifications: { warranty: `${int(6, 60)} months`, origin: 'India', material: 'Alloy' },
        createdAt: new Date(Date.now() - int(0, 365) * 24 * 3600 * 1000),
      });

      productIds.push(null); // placeholder, filled after insert
      productMeta.push({ slug, cond, discount, price, name });
    }

    const res = await db.collection('products').insertMany(products, { ordered: false });
    idsOf(res).forEach((id, i) => {
      productIds[i] = id;
    });
    products.length = 0;
  }

  // ---- Reviews ------------------------------------------------------------
  {
    const activeProductIdx = [];
    for (let i = 0; i < productIds.length; i++) activeProductIdx.push(i);
    const reviews = [];
    // Capped at 30 per product. The earlier cap of 4 produced only ~1.5 reviews per
    // product across 12,000 products, which made per-product review loading look
    // artificially cheap. Real auto parts accumulate far more, and a product detail
    // page is one of the endpoints under test, so the dataset should exercise it.
    const perProduct = Math.min(REVIEW_RATIO, 30);

    for (let pi = 0; pi < activeProductIdx.length && reviews.length < 250000; pi++) {
      const pIdx = activeProductIdx[pi];
      const count = int(0, perProduct);
      const usedUsers = new Set();
      for (let r = 0; r < count; r++) {
        // One review per (product, user) - there is a unique compound index.
        let u = int(0, userIds.length - 1);
        let guard = 0;
        while (usedUsers.has(u) && guard++ < 5) u = int(0, userIds.length - 1);
        usedUsers.add(u);
        reviews.push({
          user: userIds[u],
          product: productIds[pIdx],
          rating: int(3, 5),
          title: pick(REVIEW_TITLES),
          comment: pick(REVIEW_BODIES),
          createdAt: new Date(Date.now() - int(0, 300) * 24 * 3600 * 1000),
        });
      }
    }

    process.stdout.write(`[seed] ${reviews.length} reviews...\n`);
    await insertBatches(db.collection('reviews'), reviews, 2000);
    reviews.length = 0;
  }

  // ---- Orders -------------------------------------------------------------
  {
    process.stdout.write(`[seed] ${ORDER_COUNT} orders...\n`);
    const orders = [];
    for (let i = 0; i < ORDER_COUNT; i++) {
      const u = int(0, userIds.length - 1);
      const lineCount = int(1, 4);
      const items = [];
      let subtotal = 0;
      const seen = new Set();
      for (let l = 0; l < lineCount; l++) {
        let pIdx = purchasableIdx[int(0, purchasableIdx.length - 1)];
        if (seen.has(pIdx)) continue;
        seen.add(pIdx);
        const qty = int(1, 3);
        const price = productMeta[pIdx].price;
        items.push({
          product: productIds[pIdx],
          name: productMeta[pIdx].name,
          sku: `LT-SKU-${String(pIdx).padStart(7, '0')}`,
          quantity: qty,
          price,
          image: `https://example.invalid/img/products/${productMeta[pIdx].slug}-1.webp`,
          autoDeactivated: false,
        });
        subtotal += qty * price;
      }
      if (!items.length) continue;

      const [city, state] = pick(CITIES);
      const shippingFee = subtotal >= 999 ? 0 : 99;
      const gstAmount = Math.round((subtotal * 18) / 100);
      const orderStatus = pick(ORDER_STATUSES);
      const created = new Date(Date.now() - int(0, 300) * 24 * 3600 * 1000);

      orders.push({
        orderNumber: `AKLT${String(1000000 + i)}`,
        user: userIds[u],
        items,
        shippingAddress: {
          fullName: `${pick(FIRST)} ${pick(LAST)}`,
          phone: `${int(70, 99)}${int(10000000, 99999999)}`,
          addressLine1: `${int(1, 400)} ${pick(['MG Road', 'Station Road', 'Park Street'])}`,
          addressLine2: '',
          city,
          state,
          pincode: pick(STATES_UT)[1],
          country: 'India',
        },
        subtotal,
        discount: 0,
        shippingFee,
        gstAmount,
        totalAmount: subtotal + shippingFee + gstAmount,
        // COD only. No Razorpay identifiers are seeded, so no payment provider is
        // involved at any point.
        paymentMethod: 'cod',
        paymentStatus: orderStatus === 'delivered' ? 'paid' : 'pending',
        orderStatus,
        stockReserved: true,
        stockRestored: orderStatus === 'cancelled',
        notes: '',
        timeline: [{ status: orderStatus, date: created, note: 'Seeded for load test' }],
        createdAt: created,
        updatedAt: created,
      });

      if (orders.length >= 2000) {
        await db.collection('orders').insertMany(orders, { ordered: false });
        orders.length = 0;
      }
    }
    if (orders.length) await db.collection('orders').insertMany(orders, { ordered: false });
  }

  // ---- Carts (a fraction of users are mid-checkout) -----------------------
  let cartUserIds = [];
  {
    const carts = [];
    const cartCount = Math.floor(userIds.length * 0.35);
    // One cart per user (the schema enforces a unique `user` index). Users are
    // visited in a shuffled order rather than picked at random so duplicates cannot
    // occur, and the cart users are still a random subset of the user base.
    const candidates = userIds.slice();
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }
    for (let i = 0; i < cartCount; i++) {
      const user = candidates[i];
      const lineCount = int(1, 3);
      const items = [];
      let total = 0;
      for (let l = 0; l < lineCount; l++) {
        // Purchasable only. Order creation validates every cart line, so seeding a
        // cart with a sold-out or inactive product would make every order for that
        // user fail with 400 before the test's own line is even considered.
        const pIdx = purchasableIdx[int(0, purchasableIdx.length - 1)];
        const qty = int(1, 3);
        const price = productMeta[pIdx].price;
        items.push({ product: productIds[pIdx], quantity: qty, price });
        total += qty * price;
      }
      carts.push({ user, items, totalPrice: total });
      if (carts.length >= 2000) {
        await db.collection('carts').insertMany(carts, { ordered: false });
        carts.length = 0;
      }
    }
    if (carts.length) await db.collection('carts').insertMany(carts, { ordered: false });
    cartUserIds = candidates.slice(0, cartCount);
  }

  // ---- Wishlists ----------------------------------------------------------
  {
    const wish = [];
    // Uniqueness is enforced here rather than by relying on the index. Building the
    // documents under a `user|product` key means the unique index can be created
    // straight afterwards without a de-duplication pass, and without the risk that
    // a duplicate slips in and makes index creation fail. The application enforces
    // the same invariant with addToSet, so this mirrors real data.
    const seen = new Set();
    let guard = 0;
    while (wish.length < WISHLIST_COUNT && guard < WISHLIST_COUNT * 50) {
      guard += 1;
      const user = userIds[int(0, userIds.length - 1)];
      const product = productIds[int(0, productIds.length - 1)];
      const key = `${user}|${product}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wish.push({ user, product, createdAt: new Date() });
    }
    if (wish.length < WISHLIST_COUNT) {
      process.stdout.write(
        `[seed] note: only ${wish.length}/${WISHLIST_COUNT} unique wishlist rows possible for this user x product space\n`
      );
    }
    const coll = db.collection('wishlists');
    await insertBatches(coll, wish, 500);
    wish.length = 0;
    seen.clear();
  }

  // ---- Settings (the app reads these on boot) -----------------------------
  await db.collection('settings').insertOne({
    freeDeliveryThreshold: 999,
    deliveryFee: 99,
    gstPercentage: 18,
    contactEmail: 'support@example.invalid',
    contactPhone: '+91 98765 43210',
    storeName: 'AnilKabadi LoadTest',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // ---- Indexes (built after insert for speed) -----------------------------
  process.stdout.write('[seed] building indexes...\n');

  await db.collection('products').createIndexes([
    { key: { slug: 1 }, name: 'slug_1', unique: true },
    { key: { sku: 1 }, name: 'sku_1', unique: true, sparse: true },
    { key: { name: 'text', description: 'text', brand: 'text' }, name: 'name_text_description_text_brand_text' },
    { key: { carBrand: 1, carModel: 1 }, name: 'carBrand_1_carModel_1' },
    { key: { emissionStandard: 1 }, name: 'emissionStandard_1' },
    { key: { brand: 1 }, name: 'brand_1' },
    { key: { price: 1 }, name: 'price_1' },
    { key: { featured: 1 }, name: 'featured_1' },
    { key: { isActive: 1, createdAt: -1 }, name: 'isActive_1_createdAt_-1' },
    { key: { isActive: 1, discount: -1 }, name: 'isActive_1_discount_-1' },
    { key: { isActive: 1, stock: 1 }, name: 'isActive_1_stock_1' },
    { key: { isActive: 1, featured: 1, createdAt: -1 }, name: 'isActive_1_featured_1_createdAt_-1' },
    { key: { carBrand: 1, emissionStandard: 1, createdAt: -1 }, name: 'carBrand_1_emissionStandard_1_createdAt_-1' },
    { key: { condition: 1, createdAt: -1 }, name: 'condition_1_createdAt_-1' },
    { key: { category: 1, isActive: 1, createdAt: -1 }, name: 'category_1_isActive_1_createdAt_-1' },
  ]);

  await db.collection('users').createIndexes([
    { key: { email: 1 }, name: 'email_1', unique: true },
    { key: { createdAt: -1 }, name: 'createdAt_-1' },
  ]);

  await db.collection('orders').createIndexes([
    { key: { orderNumber: 1 }, name: 'orderNumber_1', unique: true },
    { key: { user: 1, createdAt: -1 }, name: 'user_1_createdAt_-1' },
    { key: { orderStatus: 1 }, name: 'orderStatus_1' },
    { key: { razorpayOrderId: 1 }, name: 'razorpayOrderId_1', sparse: true },
    { key: { user: 1, paymentMethod: 1, paymentStatus: 1 }, name: 'user_1_paymentMethod_1_paymentStatus_1' },
    {
      key: { user: 1, paymentMethod: 1, paymentStatus: 1, orderStatus: 1, createdAt: -1 },
      name: 'user_1_paymentMethod_1_paymentStatus_1_orderStatus_1_createdAt_-1',
    },
    { key: { user: 1, orderStatus: 1, 'items.product': 1 }, name: 'user_1_orderStatus_1_items.product_1' },
  ]);

  await db.collection('reviews').createIndexes([
    { key: { product: 1, user: 1 }, name: 'product_1_user_1', unique: true },
    { key: { product: 1, createdAt: -1 }, name: 'product_1_createdAt_-1' },
  ]);

  await db.collection('categories').createIndexes([
    { key: { name: 1 }, name: 'name_1', unique: true },
    { key: { slug: 1 }, name: 'slug_1', unique: true },
  ]);

  await db.collection('carts').createIndexes([{ key: { user: 1 }, name: 'user_1', unique: true }]);

  await db.collection('wishlists').createIndexes([
    { key: { user: 1, product: 1 }, name: 'user_1_product_1', unique: true },
  ]);

  // ---- Report + hand off tokens ------------------------------------------
  const stats = {};
  for (const c of ['users', 'products', 'categories', 'orders', 'reviews', 'carts', 'wishlists', 'settings']) {
    stats[c] = await db.collection(c).countDocuments();
  }

  // Mint tokens with the application's own signing code so authenticated
  // scenarios do not have to hammer POST /api/auth/login (which is deliberately
  // rate limited to 20 per 15 minutes and would otherwise invalidate the test).
  // eslint-disable-next-line global-require
  const { generateToken } = require('../../utils/generateToken');

  const adminEmail = 'loadtest.admin@example.invalid';
  await db.collection('users').updateOne(
    { email: adminEmail },
    {
      $setOnInsert: {
        name: 'Load Test Admin',
        email: adminEmail,
        phone: '9000000001',
        password: SEED_PASSWORD,
        role: 'admin',
        tokenVersion: 0,
        isActive: true,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        marketingConsent: false,
        termsAccepted: true,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
  const adminId = await db
    .collection('users')
    .findOne({ email: adminEmail }, { projection: { _id: 1 } });
  stats.users += 1;

  const customerSamples = [];
  for (let i = 0; i < 400; i++) customerSamples.push(userIds[int(0, userIds.length - 1)]);

  // Verify the product ids actually resolve before handing them to the scenarios.
  // Passing unverified ids produced a steady ~3.2% of 404s on the product detail
  // endpoint, which is a seed artefact rather than an application behaviour and
  // would otherwise be reported as a real error rate.
  const wantedProductIds = productIds.slice(0, 400).filter(Boolean).map((id) => new mongoose.Types.ObjectId(String(id)));
  const foundProducts = await db
    .collection('products')
    .find({ _id: { $in: wantedProductIds }, isActive: true }, { projection: { _id: 1 } })
    .toArray();
  if (foundProducts.length !== wantedProductIds.length) {
    process.stdout.write(
      `[seed] note: ${wantedProductIds.length - foundProducts.length} of ${wantedProductIds.length} sampled product ids did not resolve and were dropped\n`
    );
  }

  // A pool of products that are unambiguously purchasable, for the checkout
  // scenarios. Order creation validates stock and rejects anything unavailable with
  // 400 "Insufficient stock", so checkout is driven from this verified list rather
  // than from whatever the catalogue happens to contain. The depth requirement leaves
  // room for the stock decrement that each successful order performs.
  const checkoutProducts = await db
    .collection('products')
    .find({ isActive: true, stock: { $gt: 400 } }, { projection: { _id: 1 } })
    .limit(600)
    .toArray();

  // Tokens for users who already hold a cart. Order creation rejects an empty cart,
  // so the checkout scenario needs users whose cart is primed rather than users it
  // has to prime itself.
  const checkoutSamples = cartUserIds.slice(0, 4000);

  const tokens = {
    admin: generateToken(adminId._id),
    customers: customerSamples.map((id) => generateToken(id, 'customer')),
    cartCustomers: checkoutSamples.map((id) => generateToken(id, 'customer')),
    productIds: foundProducts.map((p) => String(p._id)),
    checkoutProductIds: checkoutProducts.map((p) => String(p._id)),
    categoryIds: categoryIds.map((c) => String(c.id)),
    orderNumbers: (await db.collection('orders').find({}, { projection: { orderNumber: 1 } }).limit(200).toArray()).map(
      (o) => o.orderNumber
    ),
  };

  fs.writeFileSync(path.join(__dirname, '.loadtest-tokens.json'), JSON.stringify(tokens), 'utf8');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n[seed] done in ${elapsed}s\n`);
  process.stdout.write(`[seed] ${JSON.stringify(stats, null, 2)}\n`);
  process.stdout.write('[seed] tokens written to .loadtest-tokens.json\n');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  process.stderr.write(`[seed] FAILED: ${error.stack}\n`);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});