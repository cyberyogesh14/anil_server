process.env.NODE_ENV = 'test';
process.env.PORT = '5117';
process.env.JWT_SECRET = 'bulk_test_jwt_secret';
process.env.JWT_EXPIRES_IN = '1d';
process.env.CLIENT_URL = 'http://localhost:5173';
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.EMAIL_HOST;

const assert = require('node:assert/strict');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

(async () => {
  const mongod = process.env.BULK_TEST_STANDALONE === '1'
    ? await MongoMemoryServer.create()
    : await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = mongod.getUri();
  const mongoose = require('mongoose');
  require('../server');
  for (let i = 0; i < 120 && mongoose.connection.readyState !== 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(mongoose.connection.readyState, 1, 'server did not connect');

  const { getSupport } = require('../services/transactionRunner');
  const { generateToken } = require('../utils/generateToken');
  const Category = require('../models/Category');
  const User = require('../models/User');
  const Product = require('../models/Product');
  const ProductGroup = require('../models/ProductGroup');
  const Cart = require('../models/Cart');

  const transactions = await getSupport();
  const base = 'http://localhost:5117/api';
  const category = await Category.create({ name: 'Engine', slug: 'engine', description: 'Engine parts' });
  const admin = await User.create({
    name: 'Bulk Admin',
    email: 'bulkadmin@test.local',
    phone: '9000000001',
    password: 'VerifyPass!2345',
    role: 'admin',
    isVerified: true,
    emailVerified: true,
  });
  const token = generateToken(admin._id, admin.role, admin.tokenVersion);
  const headers = { Authorization: `Bearer ${token}` };

  async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  }

  function form(common, variants, extra = {}) {
    const data = new FormData();
    data.append('common', JSON.stringify(common));
    data.append('variants', JSON.stringify(variants));
    for (const [key, value] of Object.entries(extra)) data.append(key, value);
    return data;
  }

  const common = {
    baseTitle: 'Tata ECU Engine Control Module',
    description: 'Genuine Tata ECU Engine Control Module. Contact us for compatibility and availability.',
    brand: 'Tata OEM',
    category: String(category._id),
    carModel: 'Nexon',
    compatibleYears: '2018-2024',
    condition: 'new',
    emissionStandard: 'BS6',
    specifications: { Voltage: '12V', Warranty: '6 months' },
    tags: ['ecu', 'engine'],
    templates: {},
  };
  const parts = ['546416252001', '546416252002', '546416252003', '546416252004'];
  const variants = parts.map((part, index) => ({
    partNumber: part,
    sku: `ECU-${index + 1}`,
    price: 1000 + index * 100,
    mrp: 1500 + index * 100,
    quantity: 10 - index,
    isActive: true,
  }));

  const created = await request('/product-groups', {
    method: 'POST',
    body: form(common, variants),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.variants.length, 4);
  assert.deepEqual(
    created.body.data.variants.map((v) => v.name),
    parts.map((p) => `Tata ECU Engine Control Module - ${p}`)
  );
  assert.equal(created.body.data.variants[0].seoTitle, 'Tata ECU Engine Control Module 546416252001 | Buy Online');
  assert.equal(
    created.body.data.variants[0].seoDescription,
    `${common.description} Part Number: 546416252001.`
  );
  assert.equal(new Set(created.body.data.variants.map((v) => v.slug)).size, 4);
  assert.deepEqual(created.body.data.variants.map((v) => v.price), [1000, 1100, 1200, 1300]);

  const groupId = created.body.data.group._id;
  const dupInPayload = await request('/product-groups', {
    method: 'POST',
    body: form(common, [variants[0], variants[0]]),
  });
  assert.equal(dupInPayload.status, 400);
  assert.match(dupInPayload.body.message, /Duplicate part number/);

  const dupInDb = await request('/product-groups', {
    method: 'POST',
    body: form(common, [{ ...variants[0], sku: 'NEW-SKU-1' }]),
  });
  assert.equal(dupInDb.status, 409, JSON.stringify(dupInDb.body));

  const searchPart = await request('/products/search?q=546416252003');
  assert.equal(searchPart.status, 200);
  assert.equal(searchPart.body.data.length, 1);
  assert.equal(searchPart.body.data[0].price, 1200);
  const searchSku = await request('/products/search?q=ECU-4');
  assert.equal(searchSku.status, 200);
  assert.equal(searchSku.body.data.length, 1);
  assert.equal(searchSku.body.data[0].partNumber, '546416252004');

  const variantId = created.body.data.variants[2]._id;
  const removedVariantId = created.body.data.variants[1]._id;
  const bySlug = await request(`/products/slug/${created.body.data.variants[2].slug}`);
  assert.equal(bySlug.status, 200);
  assert.equal(bySlug.body.data._id, variantId);
  assert.equal(bySlug.body.data.stock, 8);

  const shopper = await User.create({
    name: 'Buyer', email: 'buyer@test.local', phone: '9000000002',
    password: 'VerifyPass!2345', role: 'customer', isVerified: true, emailVerified: true,
  });
  const shopperToken = generateToken(shopper._id, shopper.role, shopper.tokenVersion);
  const cartAdd = await fetch(`${base}/cart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shopperToken}` },
    body: JSON.stringify({ productId: variantId, quantity: 2 }),
  });
  assert.equal(cartAdd.status, 200);
  const cartBody = await cartAdd.json();
  assert.equal(cartBody.data.items[0].product._id, variantId);
  assert.equal(cartBody.data.items[0].product.price, 1200);
  assert.equal(cartBody.data.items[0].quantity, 2);
  const removedCartAdd = await fetch(`${base}/cart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shopperToken}` },
    body: JSON.stringify({ productId: removedVariantId, quantity: 1 }),
  });
  assert.equal(removedCartAdd.status, 200);

  const updateRows = created.body.data.variants.map((v, index) => ({
    _id: v._id,
    partNumber: v.partNumber,
    sku: v.sku,
    price: v.price + 50,
    mrp: v.mrp,
    quantity: v.stock,
    isActive: v.isActive,
    titleOverride: index === 0 ? 'Custom Tata ECU Title' : '',
    descriptionOverride: index === 0 ? 'Custom description' : '',
  }));
  updateRows.splice(1, 1);
  updateRows.push({
    partNumber: '546416252099',
    sku: 'ECU-99',
    price: 2222,
    mrp: 2500,
    quantity: 3,
    isActive: true,
  });
  const updated = await request(`/product-groups/${groupId}`, {
    method: 'PUT',
    body: form(
      { ...common, baseTitle: 'Tata ECU Control Unit', description: 'Updated common description.' },
      updateRows,
      { existingImages: '[]' }
    ),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const after = await Product.find({ productGroup: groupId }).sort({ partNumber: 1 }).lean();
  assert.equal(after.length, 4);
  assert.equal(after[0].name, 'Custom Tata ECU Title');
  assert.equal(after[0].description, 'Custom description');
  assert.equal(after[1].name, 'Tata ECU Control Unit - 546416252003');
  assert.equal(after[1].description, 'Updated common description.');
  assert.equal(after[1].price, 1250);
  assert.equal(after[2].name, 'Tata ECU Control Unit - 546416252004');
  assert.equal(after[3].name, 'Tata ECU Control Unit - 546416252099');
  assert.equal(await Product.exists({ partNumber: '546416252002' }), null);

  const cleanedCart = await Cart.findOne({ user: shopper._id }).lean();
  assert.equal(cleanedCart.items.length, 1);
  assert.equal(String(cleanedCart.items[0].product), variantId);
  const groupList = await request('/product-groups?search=546416252099');
  assert.equal(groupList.status, 200);
  assert.equal(groupList.body.data.length, 1);
  assert.equal(groupList.body.data[0].stats.totalListings, 4);
  assert.equal(groupList.body.data[0].stats.activeProducts, 4);

  const detail = await request(`/product-groups/${groupId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.variants.length, 4);

  const deactivated = await request(`/product-groups/${groupId}`, { method: 'DELETE' });
  assert.equal(deactivated.status, 200);
  assert.equal(await Product.countDocuments({ productGroup: groupId, isActive: true }), 0);
  assert.equal(await ProductGroup.findById(groupId).then((g) => g.isActive), false);

  console.log(`bulk product suite passed (transactions=${transactions})`);
  await mongoose.connection.close();
  await mongod.stop();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
