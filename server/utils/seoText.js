/**
 * Sanitisation for the optional SEO metadata fields (`seoTitle` /
 * `seoDescription`) shared by the product and category controllers.
 *
 * These values are plain text that ends up inside `<title>`, `<meta
 * name="description">` and JSON-LD. Two rules follow from that:
 *
 *   1. No markup ever survives: tags are stripped, `script` / `style` content
 *      is discarded wholesale by sanitize-html's `nonTextTags` default, and
 *      whitespace is collapsed so a pasted paragraph cannot blow up the tag.
 *   2. Lengths are clamped here rather than left to a schema `maxlength`
 *      error: an over-long title is trimmed silently (what a SERP would do
 *      anyway) instead of failing an admin's save with a 500.
 *
 * Both callers treat an absent key as "leave the stored value alone" —
 * `sanitizeSeoFields` only ever returns keys that were present on the input,
 * so a partial update cannot accidentally blank the other field.
 */

const sanitizeHtml = require('sanitize-html');

const SEO_TITLE_MAX = 200;
const SEO_DESCRIPTION_MAX = 500;

/** Tag-stripped, whitespace-collapsed plain text. */
const stripToPlainText = (value) =>
  sanitizeHtml(String(value ?? ''), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Returns `{ seoTitle?, seoDescription? }` containing only the keys that were
 * present on `source`, each sanitised and clamped.
 */
const sanitizeSeoFields = (source = {}) => {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(source, 'seoTitle')) {
    out.seoTitle = stripToPlainText(source.seoTitle).slice(0, SEO_TITLE_MAX);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'seoDescription')) {
    out.seoDescription = stripToPlainText(source.seoDescription).slice(
      0,
      SEO_DESCRIPTION_MAX
    );
  }
  return out;
};

module.exports = {
  stripToPlainText,
  sanitizeSeoFields,
  SEO_TITLE_MAX,
  SEO_DESCRIPTION_MAX,
};
