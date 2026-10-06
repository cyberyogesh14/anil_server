const { CONTROL_KEYS, assertSafeQuery, buildFilter } = require('./safeQuery');
const {
  isValidSearchTerm,
  isValidYear,
  MAX_SEARCH_LENGTH,
} = require('./safeRegex');
const { buildProductSearchFilter } = require('./productSearch');

const ApiError = require('../services/ApiError');

/**
 * Query builder for catalogue endpoints.
 *
 * Security note: this class never copies `req.query` into a Mongo filter. The
 * caller must supply an explicit allow-list of filterable fields, and every
 * parameter is first screened by `assertSafeQuery`, so `?isActive[$ne]=true`,
 * `?$where=…` and `?a.b=c` are rejected with a 400 instead of being handed to
 * the driver. Unknown keys are ignored rather than forwarded.
 */
class APIFeatures {
  /**
   * @param {import('mongoose').Query} query
   * @param {object} queryString `req.query`
   * @param {object} [options]
   * @param {Iterable<string>} [options.filter] fields this route allows filtering on
   * @param {Iterable<string>} [options.array] allowed filter fields that accept `?field[]=a&field[]=b`
   * @param {Iterable<string>} [options.fields] fields this route allows projecting
   */
  constructor(query, queryString, options = {}) {
    this.query = query;
    this.queryString = queryString || {};
    this.allowedFilterKeys = new Set(options.filter || []);
    this.allowedFieldKeys = new Set(options.fields || []);
    this.arrayKeys = new Set(options.array || []);

    // Fail fast and loudly on operator-style parameters. Multi-select keys are
    // passed through because the storefront legitimately sends `category[]=…`.
    assertSafeQuery(this.queryString, { arrayKeys: this.arrayKeys });
  }

  /**
   * Free-text search over the catalogue.
   *
   * The matching itself lives in `utils/productSearch.js` so this method and the
   * dedicated `/api/products/search` route cannot drift apart. The length bound
   * is still enforced here, and still surfaces as the same 400 it always did.
   */
  search() {
    const term = this.queryString.search;

    if (term !== undefined && term !== null && String(term).trim() !== '') {
      // Audit finding F-08: the search term is matched literally, never compiled
      // as a pattern. `?search=[` used to throw inside the handler and surface as
      // a 500; here it simply searches for a literal "[".
      if (!isValidSearchTerm(term)) {
        throw new ApiError(400, `Search term must be under ${MAX_SEARCH_LENGTH} characters`);
      }

      this.query = this.query.find(buildProductSearchFilter(String(term).trim()));
    }

    return this;
  }

  filter() {
    const dbFilter = buildFilter(this.queryString, this.allowedFilterKeys, {
      arrayKeys: this.arrayKeys,
    });

    if (dbFilter.condition === 'used') {
      dbFilter.condition = { $regex: '^used' };
    }

    const { minPrice, maxPrice } = this.queryString;
    if (minPrice !== undefined && minPrice !== '' && !Number.isNaN(Number(minPrice))) {
      dbFilter.price = { ...(dbFilter.price || {}), $gte: Number(minPrice) };
    }
    if (maxPrice !== undefined && maxPrice !== '' && !Number.isNaN(Number(maxPrice))) {
      dbFilter.price = { ...(dbFilter.price || {}), $lte: Number(maxPrice) };
    }

    if (this.queryString.inStock === 'true') {
      dbFilter.stock = { $gt: 0 };
    }

    if (this.queryString.year) {
      // Audit finding F-08: `year` is a structured value, not a pattern. Stored
      // values look like '2018-2020', so require exactly that shape and escape it
      // rather than compiling whatever arrived.
      const year = String(this.queryString.year).trim();

      if (!isValidYear(year)) {
        throw new ApiError(400, 'Year must be a four digit year, e.g. 2020');
      }

      dbFilter.compatibleYears = { $regex: year.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') };
    }

    this.dbFilter = dbFilter;
    this.query = this.query.find(dbFilter);
    return this;
  }

  sort() {
    // `sort` is an allow-list, so an arbitrary object can never reach the driver.
    const sortMap = {
      price_asc: { price: 1 },
      price_desc: { price: -1 },
      price_low: { price: 1 },
      price_high: { price: -1 },
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      rating: { rating: -1 },
      popular: { numReviews: -1 },
      name_asc: { name: 1 },
      name_desc: { name: -1 },
    };
    const sort = sortMap[this.queryString.sort] || { createdAt: -1 };
    this.query = this.query.sort(sort);
    return this;
  }

  /**
   * Projection is allow-listed too. `fields` is a client-controlled string, so only
   * the listed paths survive and every other token is dropped.
   */
  limitFields() {
    if (!this.queryString.fields) return this;

    const requested = String(this.queryString.fields)
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);

    const allowed = requested.filter((field) => this.allowedFieldKeys.has(field));
    const projection = allowed.length ? allowed.join(' ') : Array.from(this.allowedFieldKeys).join(' ');

    this.query = this.query.select(projection);
    return this;
  }

  paginate() {
    const page = Math.max(1, parseInt(this.queryString.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(this.queryString.limit, 10) || 20));
    const skip = (page - 1) * limit;

    this.query = this.query.skip(skip).limit(limit);
    this.page = page;
    this.limit = limit;
    return this;
  }

  /**
   * Opt-in switch to plain objects instead of hydrated Mongoose documents.
   *
   * Skipping hydration is the single largest saving available on a read path: it
   * avoids constructing a document, its subdocuments, its getters and its
   * `toJSON` transform for every row returned.
   *
   * It is deliberately opt-in rather than automatic. Only call it on a query
   * whose result is serialised straight into a response - a lean object has no
   * `.save()`, no `.populate()` and, importantly, no `toJSON()` override. A
   * schema-level `toJSON` that strips sensitive fields is a security control, so
   * on those models the projection must be made explicit instead (see
   * `ORDER_PUBLIC_FIELDS` in `models/Order.js` and `USER_PUBLIC_FIELDS` in
   * `models/User.js`).
   */
  lean() {
    this.query = this.query.lean();
    return this;
  }
}

module.exports = APIFeatures;
module.exports.CONTROL_KEYS = CONTROL_KEYS;