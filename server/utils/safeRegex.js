/**
 * Regex safety helpers for user-supplied filter input.
 *
 * Audit finding F-08: `new RegExp(userInput)` throws a SyntaxError on malformed
 * input such as `?search=[`, and because the throw happened inside a request
 * handler the global error handler turned it into an HTTP 500. That is a denial of
 * service on a public endpoint: one crafted query string per request was enough, and
 * it also leaked the internal "Invalid regular expression" message.
 *
 * Two complementary defences live here:
 *
 *   1. STRUCTURED inputs (year, condition, enum-like values) are validated against
 *      a strict pattern. They are not meant to be patterns at all, so anything that
 *      is not exactly a year is a client error and gets a clean 400.
 *
 *   2. FREE-TEXT search input is escaped, not validated. A shopper searching for
 *      "brake[disc" means those literal characters, so the string is escaped and
 *      matched literally. This can never throw, and it also removes the
 *      catastrophic-backtracking risk of nested quantifiers like `(a+)+` that a
 *      "does it compile?" check would happily accept.
 */

/** Anything outside this is refused rather than escaped. */
const YEAR_PATTERN = /^(19|20)\d{2}$/;

/** Year windows are stored as e.g. '2018-2020'. */
const YEAR_RANGE_PATTERN = /^(19|20)\d{2}\s*-\s*(19|20)\d{2}$/;

/**
 * Escapes every character that carries meaning inside a regular expression, so the
 * result matches the input literally.
 */
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A case-insensitive literal-match regex for free-text search. Cannot throw.
 *
 * @param {unknown} value raw user input
 * @returns {RegExp|null} null when there is nothing to search for
 */
const literalSearchRegex = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return new RegExp(escapeRegex(text), 'i');
};

/**
 * Validates a single model year such as '2020'.
 *
 * @returns {boolean}
 */
const isValidYear = (value) => YEAR_PATTERN.test(String(value ?? '').trim());

/**
 * Validates a stored year window such as '2018-2020'. Used to check what is already
 * in the database rather than what a caller sent.
 *
 * @returns {boolean}
 */
const isValidYearRange = (value) =>
  YEAR_RANGE_PATTERN.test(String(value ?? '').trim());

/** Longest search term accepted, to keep query cost bounded. */
const MAX_SEARCH_LENGTH = 120;

const isValidSearchTerm = (value) => {
  const text = String(value ?? '');
  return text.length > 0 && text.length <= MAX_SEARCH_LENGTH;
};

module.exports = {
  YEAR_PATTERN,
  escapeRegex,
  literalSearchRegex,
  isValidYear,
  isValidYearRange,
  isValidSearchTerm,
  MAX_SEARCH_LENGTH,
};