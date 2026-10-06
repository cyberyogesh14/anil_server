const ApiError = require('../services/ApiError');

/**
 * Query-string hardening.
 *
 * MongoDB lets a client express operator syntax in a query string:
 *
 *   ?isActive[$ne]=true     ->  { isActive: { $ne: true } }
 *   ?$where=...             ->  a key that is itself an operator
 *   ?a.b=c                  ->  a dotted path into a sub-document
 *
 * Express parses that bracket syntax into a nested object, so passing `req.query`
 * straight into `find()` hands the client the driver's query language. Every route
 * that turns query parameters into a Mongo filter goes through this module instead:
 *
 *   - unknown keys are ignored (never forwarded to Mongo),
 *   - anything shaped like an operator is rejected outright with a 400,
 *   - only keys a route explicitly allow-lists can filter at all.
 */

/** Parameters that drive the query itself rather than filtering a field. */
const CONTROL_KEYS = new Set([
  'search',
  'q',
  'sort',
  'page',
  'limit',
  'fields',
  'minPrice',
  'maxPrice',
  'inStock',
  'year',
]);

/**
 * Recognises every shape a Mongo operator can arrive in.
 *
 * Express's default `qs` parser turns `?isActive[$ne]=true` into
 * `{ isActive: { $ne: 'true' } }`, so most attacks are caught as an operator
 * *value*. But `?a.b=c` is a dotted *key*, `?$where=…` is a key that is itself an
 * operator, and with the `simple` parser (or a hand-built params object) bracket
 * syntax can survive intact as `isActive[$ne]`. All three are rejected by key too,
 * so the guard holds regardless of how the query string was parsed.
 */
const isOperatorKey = (key) => {
  if (typeof key !== 'string') return true;
  return key.startsWith('$') || key.includes('.') || /\[\s*\$/.test(key) || /\[\.\$/.test(key);
};

const isPlainScalar = (value) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isScalarArray = (value) => Array.isArray(value) && value.every(isPlainScalar);

const operatorError = (key) =>
  new ApiError(400, `Unsupported query parameter: ${key}`);

/**
 * Decides whether a value can only have arrived as operator syntax.
 *
 * `?key[$ne]=1` and `?key[]=1` both arrive as objects. A plain object is never a
 * legitimate scalar filter. An array is legitimate only for the keys a route
 * declares as multi-select filters (the storefront sends `category[]=a&category[]=b`),
 * and only when every element is a plain scalar — `?key[][$ne]=1` still fails.
 */
const isOperatorValue = (value, allowArray = false) => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return !(allowArray && isScalarArray(value));
  return true;
};

/**
 * Rejects the whole request when *any* query parameter looks like Mongo operator
 * syntax. This is what stops `?isActive[$ne]=true` and `?status[$ne]=delivered`
 * from ever being interpreted, on public and admin routes alike.
 *
 * @param {object} query `req.query`
 * @param {object} [options]
 * @param {Iterable<string>} [options.arrayKeys] keys allowed to arrive as `?key[]=…`
 */
const assertSafeQuery = (query, options = {}) => {
  const arrayKeys = new Set(options.arrayKeys || []);

  for (const [rawKey, value] of Object.entries(query || {})) {
    const key = normaliseKey(rawKey);

    if (isOperatorKey(rawKey)) throw operatorError(rawKey);
    if (isOperatorValue(value, arrayKeys.has(key))) throw operatorError(rawKey);
  }

  return query;
};

/**
 * `?brand[]=Bosch` reaches us either already folded into an array (`{ brand: [...] }`,
 * Express's `qs` parser) or still carrying the empty brackets when the query was
 * parsed with `simple`. Both mean "multi-select", so the trailing `[]` is dropped.
 */
const normaliseKey = (key) => (typeof key === 'string' ? key.replace(/\[\]$/, '') : key);

const looksNumeric = (value) => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(Number(value));
};

/**
 * Query strings carry `"true"`, `"12"` and `"65f0…"` for what the schema declares as
 * boolean, number and ObjectId. Only a genuinely numeric string becomes a number —
 * turning an ObjectId into `NaN` would silently match nothing at all.
 */
const coerce = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (looksNumeric(value)) return Number(value);
  return value;
};

/**
 * Builds a Mongo filter from an explicit allow-list. Only listed keys survive, only
 * when the caller actually sent them, and each value is coerced the way the
 * catalogue queries have always expected.
 *
 * @param {object} query `req.query`
 * @param {Iterable<string>} allowedKeys fields this route allows filtering on
 * @param {object} [options]
 * @param {Iterable<string>} [options.arrayKeys] allowed keys mapped to `{ $in: [...] }`
 */
const buildFilter = (query, allowedKeys, options = {}) => {
  const arrayKeys = new Set(options.arrayKeys || []);
  assertSafeQuery(query, { arrayKeys });

  const filter = {};

  for (const rawKey of allowedKeys) {
    const key = normaliseKey(rawKey);
    if (!Object.prototype.hasOwnProperty.call(query || {}, rawKey)) continue;

    const value = query[rawKey];
    if (value === undefined || value === '') continue;

    if (Array.isArray(value)) {
      const values = value.filter((item) => item !== '' && item !== undefined);
      if (!values.length) continue;
      filter[key] = { $in: values.map((item) => coerce(item)) };
      continue;
    }

    if (!isPlainScalar(value)) continue;
    filter[key] = coerce(value);
  }

  return filter;
};

module.exports = {
  CONTROL_KEYS,
  assertSafeQuery,
  buildFilter,
  coerce,
  normaliseKey,
  isOperatorKey,
  isOperatorValue,
  isPlainScalar,
  isScalarArray,
};