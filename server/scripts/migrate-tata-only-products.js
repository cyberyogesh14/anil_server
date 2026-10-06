/**
 * TATA-only catalogue migration.
 *
 * Brings a legacy database into the TATA-only policy. Everything in here is safe
 * to run repeatedly: each action re-classifies the row with the SAME policy the
 * API enforces, so a second run changes nothing.
 *
 *   --apply                perform the migrations (default is a dry run)
 *   --normalize-empty      set `carBrand: 'Tata'` on rows classified `unbranded`
 *   --deactivate-nontata   soft-delete rows whose `carBrand` names another make
 *   --delete-nontata       permanently delete those rows (irreversible)
 *
 * Actions can be combined. `--deactivate-nontata` and `--delete-nontata` are
 * mutually exclusive; `--delete-nontata` wins if both are passed.
 *
 * What NEVER happens automatically, and why:
 *
 *   - Rows classified `conflicting` (empty `carBrand` but another field names
 *     another make) are never touched. They need a human to decide whether the
 *     part belongs in a Tata catalogue; neither "assume Tata" nor "delete" is a
 *     safe default.
 *   - `carBrand` spellings that ARE Tata aliases (`TATA`, `Tata Motors`) are
 *     normalised to the canonical `Tata` in every run. This is not an opinion:
 *     the read-side policy pins `carBrand: 'Tata'` exactly, so an alias would be
 *     invisible in the store.
 *   - No non-Tata content (a `name` saying "fits Hyundai") is rewritten. The
 *     read rules hide those rows; editing product copy is a manual merchandising
 *     task tracked by the audit's `review` bucket.
 *
 * Usage:  node scripts/migrate-tata-only-products.js [--apply] [--normalize-empty]
 *               [--deactivate-nontata | --delete-nontata]
 *         Target another database with MONGO_URI (default: .env value).
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { TATA_CAR_BRAND, isTataCarBrand, classifyProduct } = require('../utils/tataPolicy');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/anilkabadi';

const flags = new Set(process.argv.slice(2));
const apply = flags.has('--apply');
const normalizeEmpty = flags.has('--normalize-empty');
const deactivateNontata = flags.has('--deactivate-nontata');
const deleteNontata = flags.has('--delete-nontata') || deactivateNontata; // delete wins

(async () => {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected to ${MONGO_URI}\n`);
  console.log(apply ? 'APPLY MODE: migrations will run\n' : 'DRY RUN: nothing will be written\n');

  const stats = {
    aliasNormalised: 0,
    unbrandedNormalised: 0,
    nonTataDeactivated: 0,
    nonTataDeleted: 0,
    skippedConflicting: 0,
  };

  const products = await Product.find().lean();

  for (const raw of products) {
    const product = new Product(raw); // run the model's setters/defaults in memory
    const { status, signals } = classifyProduct(raw);

    // 1. Everyone: canonicalise Tata aliases. Legacy rows may carry `TATA` /
    //    `Tata Motors`, which the read filter would treat as "not Tata".
    if (isTataCarBrand(product.carBrand) && product.carBrand !== TATA_CAR_BRAND) {
      console.log(`  normalise alias: ${raw.name} carBrand ${product.carBrand} -> ${TATA_CAR_BRAND}`);
      if (apply) {
        await Product.updateOne(
          { _id: raw._id },
          { $set: { carBrand: TATA_CAR_BRAND } }
        );
      }
      stats.aliasNormalised += 1;
      continue;
    }

    if (status === 'unbranded' && normalizeEmpty) {
      console.log(`  unbranded -> Tata: ${raw.name}`);
      if (apply) {
        await Product.updateOne({ _id: raw._id }, { $set: { carBrand: TATA_CAR_BRAND } });
      }
      stats.unbrandedNormalised += 1;
      continue;
    }

    if (status === 'non-tata') {
      if (deleteNontata) {
        console.log(`  delete non-tata: ${raw.name} (carBrand=${raw.carBrand})`);
        if (apply) await Product.deleteOne({ _id: raw._id });
        stats.nonTataDeleted += 1;
      } else if (deactivateNontata) {
        console.log(`  deactivate non-tata: ${raw.name} (carBrand=${raw.carBrand})`);
        if (apply) await Product.updateOne({ _id: raw._id }, { $set: { isActive: false } });
        stats.nonTataDeactivated += 1;
      } else {
        console.log(`  (no action) non-tata: ${raw.name} - pass --deactivate-nontata or --delete-nontata`);
      }
      continue;
    }

    if (status === 'conflicting') {
      stats.skippedConflicting += 1;
      console.log(`  (human review) conflicting: ${raw.name} - signals: ${signals.join(', ')}`);
    }
  }

  await mongoose.disconnect();

  console.log('\n' + '='.repeat(70));
  console.log(`Alias spellings normalised : ${stats.aliasNormalised}`);
  console.log(`Unbranded -> Tata          : ${stats.unbrandedNormalised}`);
  console.log(`Non-Tata deactivated       : ${stats.nonTataDeactivated}`);
  console.log(`Non-Tata deleted           : ${stats.nonTataDeleted}`);
  console.log(`Conflicting (not touched)  : ${stats.skippedConflicting}`);
  console.log(apply ? '\nMigration complete.' : '\nDry run complete. Re-run with --apply to write these changes.');
  process.exit(0);
})().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
});