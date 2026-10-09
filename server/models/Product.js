const mongoose = require('mongoose');
const slugify = require('../utils/slugify');
const { TATA_CAR_BRAND, isTataCarBrand } = require('../utils/tataPolicy');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true },
    sku: { type: String, unique: true, sparse: true },
    description: { type: String, default: '' },
    /**
     * Optional search-engine metadata an admin can override per product.
     *
     * Empty by default: when these are blank the storefront derives the
     * `<title>` / meta description from the real product fields
     * (client/src/pages/ProductDetails.jsx), so they are only ever a manual
     * override — they can never introduce claims the listing does not back up.
     * Lengths are clamped by utils/seoText.js on write as well, so an
     * over-long value is trimmed instead of rejected.
     */
    seoTitle: { type: String, default: '', trim: true, maxlength: 200 },
    seoDescription: { type: String, default: '', trim: true, maxlength: 500 },
    /**
     * Part manufacturer / supplier (`Tata-Compatible`, `Bosch`, `Exide`, ...).
     * NOT the vehicle make - that is `carBrand` below. Kept free-form on purpose
     * so legitimate part suppliers are not mistaken for vehicle brands.
     */
    brand: { type: String, default: '' },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    /**
     * The vehicle the part fits. AnilKabadi is a TATA-only store, so this
     * defaults to `Tata` and every public read pins it (see
     * `utils/tataPolicy.js`).
     *
     * There is deliberately no schema-level `enum` rejecting another make: a
     * legacy row must still be soft-deletable through `product.save()`, and a
     * validator that threw on save would turn "remove this old Maruti row" into
     * a 500. Write-side enforcement lives in the product controller (which
     * rejects non-Tata writes with a 400) and read-side enforcement lives in
     * every query.
     */
    carBrand: {
      type: String,
      trim: true,
      default: TATA_CAR_BRAND,
      // Canonicalises `TATA` / `tata motors` to `Tata` so an alias can never
      // hide a row from the pinned `carBrand: 'Tata'` read queries. Anything
      // else - including an empty string, which means "not classified yet" - is
      // stored untouched: the controller rejects it before it gets this far, and
      // the audit script needs to see legacy values as they really are.
      set: (value) => {
        if (value === undefined || value === null) return value;
        const trimmed = String(value).trim();
        return isTataCarBrand(trimmed) ? TATA_CAR_BRAND : trimmed;
      },
    },
    carModel: { type: String, default: '' },
    compatibleYears: { type: String, default: '' },
    partNumber: { type: String, default: '' },
    condition: {
      type: String,
      enum: ['new', 'used_like_new', 'used_good', 'used_fair', 'refurbished'],
      default: 'new',
    },
    emissionStandard: {
      type: String,
      enum: ['BS4', 'BS6', ''],
      default: '',
    },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    stock: { type: Number, required: true, default: 0, min: 0 },
    images: [
      {
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
      },
    ],
    featured: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    numReviews: { type: Number, default: 0 },
    specifications: { type: Map, of: String, default: {} },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', description: 'text', brand: 'text', sku: 'text', partNumber: 'text', carModel: 'text', carBrand: 'text' });
/**
 * Indexes touched by the TATA-only rule.
 *
 * Every public product read now carries `carBrand: 'Tata'`. No new index is
 * added for that: in a Tata-only catalogue `carBrand` is a near-constant
 * equality, so it works as a residual predicate on top of the existing
 * `{ isActive: 1, createdAt: -1 }` / `{ isActive: 1, discount: -1 }` / `{ category: 1, isActive: 1, createdAt: -1 }`
 * indexes without changing which index the planner picks or adding write
 * amplification. The dedicated `{ carBrand: 1, emissionStandard: 1, createdAt: -1 }`
 * index below is what serves the Tata BS6 rail.
 */
productSchema.index({ carBrand: 1, carModel: 1 });
productSchema.index({ emissionStandard: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ price: 1 });
productSchema.index({ featured: 1 });

/**
 * Note on `category: 1` and `isActive: 1`
 *
 * Both used to be declared as standalone single-field indexes. The two compound
 * indexes added below make them strict prefixes - `{ category: 1 }` is a prefix of
 * `{ category, isActive, createdAt }`, and `{ isActive: 1 }` is a prefix of
 * `{ isActive, createdAt }` - and MongoDB answers a query from any index whose
 * leading fields match, so the compound index already serves those queries on its
 * own. Keeping both would mean paying the write amplification and cache cost of
 * maintaining an index that can never be chosen preferentially, so the redundant
 * declarations have been dropped.
 *
 * This only affects the schema declaration. `ensureIndexes()` in `config/db.js`
 * uses `createIndexes()`, which never drops anything, so an existing database
 * keeps its current `category_1` / `isActive_1` indexes harmlessly until an
 * operator chooses to remove them. Dropping an index on a large collection
 * should be a deliberate, separately-scheduled operation, not a side effect of a
 * deploy.
 */

/**
 * Performance indexes.
 *
 * Every index below was added because a real query in `controllers/` cannot be
 * served by any of the indexes above. MongoDB can only use an index for a
 * `sort()` when the index prefix is pinned by an equality match, so
 * `find({ isActive: true }).sort({ createdAt: -1 })` was doing an in-memory sort
 * of the entire active catalogue on every catalogue request. Each compound index
 * here ends in the sort key precisely so the sort is served by the index.
 *
 * `rating` and `numReviews` are the two allow-listed sort options deliberately
 * left without a matching index. Both are user-facing (`?sort=rating`,
 * `?sort=popular`), but indexing every sort option on an already wide catalogue
 * costs write amplification on every product insert and update to speed up two
 * rarely chosen sorts. That trade-off is worth revisiting if the catalogue
 * grows large or those sorts show up in real traffic.
 */

/** Default catalogue listing: `getProducts`, `searchProducts`, `getProductsByCategory`. */
productSchema.index({ isActive: 1, createdAt: -1 });

/** "deals" rail on the storefront, sorted by deepest discount first. */
productSchema.index({ isActive: 1, discount: -1 });

/** `?inStock=true` catalogue filter, which becomes `stock: { $gt: 0 }`. */
productSchema.index({ isActive: 1, stock: 1 });

/** `?featured=true` rail, newest first. */
productSchema.index({ isActive: 1, featured: 1, createdAt: -1 });

/** Tata BS6 hero rail: equality on both fields, then newest first. */
productSchema.index({ carBrand: 1, emissionStandard: 1, createdAt: -1 });

/** Used/new/refurbished condition rails, newest first. */
productSchema.index({ condition: 1, createdAt: -1 });

/** `GET /api/products/category/:categoryId`, which filters on both fields. */
productSchema.index({ category: 1, isActive: 1, createdAt: -1 });

productSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    let baseSlug = slugify(this.name);
    this.slug = baseSlug;
  }
  if (this.mrp > 0 && this.price < this.mrp) {
    this.discount = Math.round(((this.mrp - this.price) / this.mrp) * 100);
  } else {
    this.discount = 0;
  }
  next();
});

productSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update.name) {
    update.slug = slugify(update.name);
  }
  if (update.price !== undefined && update.mrp !== undefined) {
    if (update.mrp > 0 && update.price < update.mrp) {
      update.discount = Math.round(((update.mrp - update.price) / update.mrp) * 100);
    } else {
      update.discount = 0;
    }
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
