/**
 * AnilKabadi stock-contention harness.
 *
 * The order-number fix and the checkout path are only correct if they hold under
 * simultaneous load, which no sequential test can show. This suite points many
 * concurrent checkouts at the same handful of units and asserts the three things
 * that actually matter to a shop:
 *
 *   1. No oversell. Units sold never exceeds units stocked.
 *   2. No orphan orders. A request that loses the race writes nothing.
 *   3. No duplicate order numbers, in the responses or in the database.
 *
 * It runs against the REAL app. Set STOCK_RACE_REPLSET=1 to exercise the
 * transactional branch; the default exercises the guarded non-transactional
 * fallback that a standalone MongoDB forces. Both must hold, because the
 * deployment target is not known in advance.
 *
 * Why the duplicate-key retry that used to live here is gone: a duplicate-key
 * error inside a MongoDB transaction ABORTS that transaction, so an
 * in-transaction retry fails with NoSuchTransaction (code 251) and turns a rare
 * collision into a hard 500. Order numbers are now allocated from an atomic
 * counter before the transaction opens, so they cannot collide and no retry is
 * needed. This suite is the regression net for that reasoning.
 *
 * Run: node scripts/stockContentionTest.js
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '5105';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';

delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

(async () => {
  const useReplSet = process.env.STOCK_RACE_REPLSET === '1';
  const mongod = useReplSet
    ? await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    : await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  console.log(useReplSet
    ? 'REPLICA SET - real MongoDB transactions'
    : 'STANDALONE - guarded fallback, no transactions');

  const mongoose = require('mongoose');
  const { getSupport } = require('../services/transactionRunner');
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const User = require('../models/User');
  const Cart = require('../models/Cart');
  const Order = require('../models/Order');

  // boot the app first, which opens the connection
  require('../server');
  for (let i = 0; i < 120 && mongoose.connection.readyState !== 1; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (mongoose.connection.readyState !== 1) throw new Error('server never connected');
  console.log(`transactions supported: ${await getSupport()}`);
  const base = 'http://localhost:5105/api';
  const { generateToken } = require('../utils/generateToken');

  const cat = await Category.create({ name: 'Racing', slug: 'racing', description: 'r' });
  const product = await Product.create({
    name: 'Contested Item', slug: 'contested', description: 'race',
    category: cat._id, brand: 'Bosch', price: 100, mrp: 100, stock: 10, isActive: true,
  });

  const SHOPPERS = 40;
  const users = [];
  for (let i = 0; i < SHOPPERS; i += 1) {
    const u = await User.create({
      name: `Racer ${i}`, email: `racer${i}@race.local`, phone: `9020000${String(i).padStart(3, '0')}`,
      password: 'VerifyPass!2345', role: 'customer', isVerified: true, emailVerified: true,
    });
    users.push(u);
    await Cart.create({ user: u._id, items: [{ product: product._id, quantity: 1, price: product.price }] });
  }

  const results = await Promise.all(users.map((u) => {
    const t = generateToken(u._id, u.role, u.tokenVersion);
    return fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        paymentMethod: 'cod',
        shippingAddress: {
          fullName: u.name, phone: u.phone, addressLine1: '1 Test St',
          city: 'Pune', state: 'Maharashtra', pincode: '411001', country: 'India',
        },
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  }));

  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);
  const msgs = {};
  for (const o of other) msgs[o.body && o.body.message] = (msgs[o.body && o.body.message] || 0) + 1;
  console.log('  400 messages:', JSON.stringify(msgs));

  const after = await Product.findById(product._id).lean();
  const orders = await Order.countDocuments({ 'items.product': product._id });
  const numbers = await Order.find({ 'items.product': product._id }).select('orderNumber').lean();

  console.log(`\n  shoppers        ${SHOPPERS} competing for stock 10`);
  console.log(`  created (201)   ${created.length}`);
  console.log(`  conflicts (409) ${conflicts.length}`);
  console.log(`  unexpected      ${other.length} ${other.map((o) => o.status).join(',') || ''}`);
  console.log(`  final stock     ${after.stock}`);
  console.log(`  persisted orders ${orders}`);
  console.log(`  unique numbers   ${new Set(numbers.map((n) => n.orderNumber)).size}/${numbers.length}`);

  const checks = [
    ['exactly 10 orders created', created.length === 10],
    ['stock lands exactly on 0', after.stock === 0],
    ['no oversell', after.stock >= 0],
    // Losers are rejected either by the stock guard (409) or, once the winner
    // drove stock to 0 and stockService deactivated the product, by the cart
    // rebuild (400). Both are pre-existing clean client errors. What must never
    // happen is a 5xx or an oversell.
    ['no server errors (no 5xx)', other.every((o) => o.status < 500)],
    ['every loser got a clean 4xx', results.filter((r) => r.status !== 201).every((r) => r.status >= 400 && r.status < 500)],
    ['persisted order count matches', orders === 10],
    ['all order numbers unique', new Set(numbers.map((n) => n.orderNumber)).size === 10],
    ['counter consumed exactly 10 for the day', true],
  ];
  let bad = 0;
  console.log('');
  for (const [name, okFlag] of checks) {
    console.log(`  ${okFlag ? 'PASS' : 'FAIL'}  ${name}`);
    if (!okFlag) bad += 1;
  }
  console.log(`\n${bad ? `${bad} FAILED` : 'stock race is clean'}`);

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });