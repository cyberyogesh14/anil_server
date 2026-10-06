/**
 * TATA-only catalogue audit.
 *
 * Reads every product in the database and classifies it with the SAME policy the
 * API enforces (`server/utils/tataPolicy.js`), so "what does the app think about
 * this row?" can never disagree with what the audit reports.
 *
 *   tata          - `carBrand` names a Tata vehicle. In policy.
 *   review        - a Tata row whose `brand` / `carModel` / `name` /
 *                   `description` still names another make. The read-side rules
 *                   hide nothing here, but the copy should be cleaned up.
 *   non-tata      - `carBrand` names another make. Invisible to every read and
 *                   blocked from every write. Remove or deactivate.
 *   unbranded     - `carBrand` empty and nothing contradicts a Tata reading.
 *                   Safe to normalise to `Tata`.
 *   conflicting   - `carBrand` empty but another field names another make.
 *                   Requires a human decision: it can neither be trusted as Tata
 *                   nor blindly deleted.
 *
 * This is a dry report; it never writes. The one line it can recommend
 * confidently - `carBrand: 'Tata'` for `unbranded` rows - is applied by the
 * migration script, not here.
 *
 * Usage:            node scripts/audit-tata-only-products.js
 * Optionally target another database with MONGO_URI (default: .env value).
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { classifyProduct } = require('../utils/tataPolicy');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/anilkabadi';

(async () => {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected to ${MONGO_URI}\n`);

  const products = await Product.find().collation({ locale: 'en', strength: 2 }).lean().then(
    (rows) =>
      rows.sort((a, b) => String(a.carBrand || '').localeCompare(String(b.carBrand || '')))
  );

  const buckets = {
    tata: [],
    review: [],
    'non-tata': [],
    unbranded: [],
    conflicting: [],
  };

  for (const product of products) {
    const { status, signals } = classifyProduct(product);
    const row = {
      _id: product._id,
      name: product.name,
      brand: product.brand,
      carBrand: product.carBrand,
      carModel: product.carModel,
      isActive: product.isActive,
      signals,
    };
    if (status === 'tata' && signals.length === 0) buckets.tata.push(row);
    else if (status === 'tata') buckets.review.push(row);
    else buckets[status].push(row);
  }

  const count = (rows) => rows.length;
  const line = (row) =>
    `  - ${row.name}  [carBrand=${row.carBrand || '(empty)'} | brand=${row.brand || '-'} | ` +
    `model=${row.carModel || '-'} | active=${row.isActive}]` +
    (row.signals.length ? `  SIGNALS: ${row.signals.join(', ')}` : '');

  console.log('='.repeat(70));
  console.log('TATA-ONLY CATALOGUE AUDIT');
  console.log('='.repeat(70));
  console.log(`Total products:            ${count(products)}`);
  console.log(`  in policy (tata):        ${count(buckets.tata)}`);
  console.log(`  review needed (tata+):   ${count(buckets.review)}`);
  console.log(`  non-tata:                ${count(buckets['non-tata'])}`);
  console.log(`  unbranded (fixable):     ${count(buckets.unbranded)}`);
  console.log(`  conflicting:             ${count(buckets.conflicting)}`);

  for (const key of ['review', 'non-tata', 'unbranded', 'conflicting']) {
    if (buckets[key].length) {
      console.log(`\n--- ${key.toUpperCase()} (${count(buckets[key])}) ---`);
      buckets[key].forEach((row) => console.log(line(row)));
    }
  }

  const totals = {
    tata: count(buckets.tata),
    review: count(buckets.review),
    'non-tata': count(buckets['non-tata']),
    unbranded: count(buckets.unbranded),
    conflicting: count(buckets.conflicting),
  };

  await mongoose.disconnect();
  console.log('\nDone. No rows were modified by this audit.');
  process.exit(0);
})().catch((error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exit(1);
});