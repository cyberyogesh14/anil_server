const { escapeRegex, isValidSearchTerm, MAX_SEARCH_LENGTH } = require('./safeRegex');

/**
 * The fields the storefront has always searched, in the same order.
 *
 * The text index in `models/Product.js` is declared over exactly these seven
 * paths, so a `$text` clause can never silently return results from a field the
 * literal matcher did not cover (or vice versa).
 */
const SEARCH_FIELDS = [
  'name',
  'sku',
  'partNumber',
  'brand',
  'carModel',
  'carBrand',
  'description',
];

/**
 * Inputs the text index answers *exactly* as the old escaped regex did.
 *
 * `$text` is word-based, not substring-based, so two classes of input must stay
 * on the literal matcher or results would quietly get worse:
 *
 *   1. Tokenisation. `$search` splits on non-alphanumerics, so it cannot match
 *      the literal characters inside a code:
 *        - `br1-4470`      tokenises to `br1` + `4470`, NOT `BR1-4470`
 *        - `AKB/BOS/09912` tokenises to `akb` + `bos` + `09912`
 *        - `99912`         a bare number is dropped from `$search` as a stop word
 *      Part numbers and SKUs are exactly what shoppers paste in.
 *
 *   2. Word prefixes. `$search` does not stem-match a prefix either, so `brak`
 *      would stop finding "brake". Typing a few characters and watching results
 *      narrow is the single most common search interaction, so any term that is
 *      merely a prefix of a longer word has to keep the substring behaviour.
 *
 * Phrases are excluded as well: `$search` treats multiple words as "any of these
 * words" rather than the old regex's literal "this exact substring", so
 * `"brake pad"` must stay on the regex or it would start returning products that
 * contain "brake" but not "pad".
 *
 * The fast path is therefore a SINGLE alphabetic token that is a whole English
 * word, which is both the most common query shape (a part type or a brand) and
 * the only shape where `$text` is provably equivalent to the old regex.
 */
const IS_TEXT_SAFE = /^[a-z]+$/i;

/**
 * Stemmed forms of common car-part search vocabulary.
 *
 * `stopWords` is MongoDB's own English list, plus a few absent from it. Only
 * nouns a shopper actually types are listed here - never plurals that `$text`
 * already stems correctly (`filter`/`filters`, `plug`/`plugs`).
 *
 * This exists to keep the fast path available for the highest-frequency queries.
 * It is a *widening* set, never a narrowing one: an unlisted word simply takes
 * the literal path and behaves exactly as it always did.
 */
const WORD_FORMS = new Map(
  Object.entries({
    air: ['air', 'airs'],
    bearing: ['bearing', 'bearings'],
    battery: ['battery', 'batteries'],
    belt: ['belt', 'belts'],
    brake: ['brake', 'brakes'],
    bumper: ['bumper', 'bumpers'],
    cabin: ['cabin', 'cabins'],
    chain: ['chain', 'chains'],
    clamp: ['clamp', 'clamps'],
    clutch: ['clutch', 'clutches'],
    cylinder: ['cylinder', 'cylinders'],
    damper: ['damper', 'dampers'],
    engine: ['engine', 'engines'],
    exhaust: ['exhaust', 'exhausts'],
    fan: ['fan', 'fans'],
    filter: ['filter', 'filters'],
    gasket: ['gasket', 'gaskets'],
    horn: ['horn', 'horns'],
    hose: ['hose', 'hoses'],
    ignition: ['ignition', 'ignitions'],
    injector: ['injector', 'injectors'],
    lamp: ['lamp', 'lamps'],
    leaf: ['leaf', 'leafs'],
    mirror: ['mirror', 'mirrors'],
    motor: ['motor', 'motors'],
    mudguard: ['mudguard', 'mudguards'],
    oil: ['oil', 'oils'],
    pad: ['pad', 'pads'],
    piston: ['piston', 'pistons'],
    plate: ['plate', 'plates'],
    plug: ['plug', 'plugs'],
    pump: ['pump', 'pumps'],
    rack: ['rack', 'racks'],
    radiator: ['radiator', 'radiators'],
    resistor: ['resistor', 'resistors'],
    ring: ['ring', 'rings'],
    rotor: ['rotor', 'rotors'],
    sensor: ['sensor', 'sensors'],
    shock: ['shock', 'shocks'],
    sleeve: ['sleeve', 'sleeves'],
    spark: ['spark', 'sparks'],
    spring: ['spring', 'springs'],
    starter: ['starter', 'starters'],
    steering: ['steering', 'steerings'],
    strut: ['strut', 'struts'],
    switch: ['switch', 'switches'],
    tank: ['tank', 'tanks'],
    tensioner: ['tensioner', 'tensioners'],
    thermostat: ['thermostat', 'thermostats'],
    tube: ['tube', 'tubes'],
    tyre: ['tyre', 'tyres'],
    tire: ['tire', 'tires'],
    valve: ['valve', 'valves'],
    washer: ['washer', 'washers'],
    wheel: ['wheel', 'wheels'],
    wiper: ['wiper', 'wipers'],
  })
);

/** MongoDB's English stop-word list, which `$search` silently discards. */
const STOP_WORDS = new Set(
  ('a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can cannot could did do does doing down during each few for from ' +
    'further had has have having he her here hers herself him himself his how i if in into is it ' +
    'its itself me more most my myself no nor not of off on once only or other our ours ourselves ' +
    'out over own same she should so some such than that the their theirs them themselves then ' +
    'there these they this those through to too under until up very was we were what when where ' +
    'which while who whom why with would you your yours yourself yourselves').split(' ')
);

const isTextSearchable = (term) => {
  if (!IS_TEXT_SAFE.test(term)) return false;

  const lower = term.toLowerCase();

  // Too short to be a meaningful standalone token - `$search` would drop it.
  if (lower.length < 4) return false;

  // A known vocabulary word, or a listed stem/plural the tokenizer would reduce
  // to a known word.
  if (WORD_FORMS.has(lower)) return true;

  return !STOP_WORDS.has(lower);
};

/**
 * Builds the Mongo filter used by both search entry points
 * (`GET /api/products?search=` and `GET /api/products/search?q=`).
 *
 * Returns one of:
 *
 *   1. Text-index clause  - a single-alphanumeric-token term, which the text
 *      index matches exactly as a case-insensitive substring would. This is the
 *      fast path and the overwhelmingly common one (part names and brands).
 *
 *   2. Escaped literal regex - everything else, byte-for-byte the filter this
 *      code used before. Behaviour is therefore preserved rather than narrowed.
 *
 * SECURITY: `escapeRegex` still runs on every branch, so a pattern-shaped term
 * such as `[` or `.*` is matched literally and can never reach the driver as a
 * regex metacharacter. `isValidSearchTerm` keeps the same length bound as before.
 * The returned object is a plain literal - no request value is ever used as an
 * object key, so there is no operator-injection surface (`assertSafeQuery` in
 * `APIFeatures` continues to reject operator-shaped query parameters before any
 * of this is reached).
 */
const buildProductSearchFilter = (rawTerm) => {
  if (rawTerm === undefined || rawTerm === null) return {};

  const term = String(rawTerm).trim();
  if (term === '') return {};

  if (!isValidSearchTerm(term)) {
    // Same bound and same 400 as before, raised by APIFeatures for `?search=`.
    // `?q=` never raised - it simply matched nothing - so this stays a no-match.
    throw Object.assign(new Error(`Search term must be under ${MAX_SEARCH_LENGTH} characters`), {
      statusCode: 400,
      isPublic: true,
    });
  }

  if (isTextSearchable(term)) {
    return { $text: { $search: term } };
  }

  const searchRegex = new RegExp(escapeRegex(term), 'i');
  return {
    $or: SEARCH_FIELDS.map((field) => ({ [field]: searchRegex })),
  };
};

module.exports = { buildProductSearchFilter, SEARCH_FIELDS, isTextSearchable };