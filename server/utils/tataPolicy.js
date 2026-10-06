/**
 * AnilKabadi business rule: the catalogue is TATA-ONLY.
 *
 * This module is the single source of truth for that rule on the server. It is
 * deliberately free of any Express/Mongoose dependency so the same policy can be
 * used by request validation, by read queries, by the seed and by the
 * audit/migration scripts without any of them being able to drift apart.
 *
 * Two different fields are policed differently, because they mean different
 * things:
 *
 *   carBrand   the VEHICLE the part fits. Always exactly `Tata`. This is the
 *              field every read query pins, so a non-Tata row can never reach a
 *              shopper even if one exists in the database.
 *
 *   brand      the PART manufacturer / supplier (`Tata-Compatible`, `Exide`,
 *              `Bosch`, `Uno Minda`, ...). Part manufacturers are NOT vehicle
 *              brands, so they stay free - but the value may never NAME a
 *              non-Tata vehicle, because the admin form historically stored
 *              vehicle makes here (`Maruti Genuine`, `Hyundai OEM`).
 *
 * The denylists below are whole-token matches against a normalised string, so
 * `Oxford` never trips `ford` and `AMG` never trips `mg`.
 */

/** The only vehicle brand this store stocks. */
const TATA_CAR_BRAND = 'Tata';

/** Accepted spellings of the vehicle brand; anything else is rejected. */
const TATA_CAR_BRAND_ALIASES = new Set(['tata', 'tata motors']);

/**
 * Vehicle makes that must never appear in `brand`, `carBrand`, `carModel`,
 * `name` or `description`.
 *
 * Deliberately a token set rather than a substring test: matching whole
 * normalised words keeps legitimate part-manufacturer names (`Bosch`, `Exide`,
 * `Endurance`, `Uno Minda`, `Motherson`, `NGK`, `Denso`, `Valeo`, `Amaron`,
 * `Lucas`, `Febi`, `Lemförder`-style suppliers, ...) working while still
 * catching `Maruti Genuine`, `Hyundai OEM` and `Mahindra Thar`.
 */
const NON_TATA_VEHICLE_BRAND_TOKENS = new Set([
  'maruti',
  'suzuki',
  'hyundai',
  'mahindra',
  'toyota',
  'honda',
  'kia',
  'ford',
  'volkswagen',
  'vw',
  'skoda',
  'renault',
  'nissan',
  'mg',
  'jeep',
  'chevrolet',
  'chevy',
  'fiat',
  'bmw',
  'mercedes',
  'benz',
  'audi',
  'isuzu',
  'opel',
  'datsun',
  'daewoo',
  'citroen',
  'peugeot',
  'jaguar',
  'rover',
  'porsche',
  'volvo',
  'tesla',
  'byd',
  'changan',
  'chery',
  'greatwall',
  'haval',
  'ambassador',
  'hindustan',
]);

/**
 * Short tokens that are only safe to match on the structured fields
 * (`brand`, `carBrand`, `carModel`) and would false-positive in prose - `mg` in
 * a dosage-style spec line, `vw` in an abbreviation, `byd` in a part code.
 * Free-text checks therefore skip tokens shorter than this.
 */
const FREE_TEXT_MIN_TOKEN_LENGTH = 3;

/**
 * Model names belonging to other makes. Used ONLY on the `carModel` field -
 * never on free text, where an ordinary word such as "city" would false-match.
 *
 * Tata's own catalogue (`nexon`, `punch`, `harrier`, `safari`, `tiago`,
 * `tigor`, `altroz`, `curvv`, `ace`, `intra`, `sumo`, `hexa`, `indica`,
 * `indigo`, `manza`, `vista`, `bolt`, `zest`, `nano`, ...) is intentionally
 * absent, and ambiguous words that are also Tata names are left out too.
 */
const NON_TATA_VEHICLE_MODEL_TOKENS = new Set([
  'swift',
  'dzire',
  'baleno',
  'brezza',
  'ertiga',
  'alto',
  'celerio',
  'wagonr',
  'ignis',
  'esperio',
  'creta',
  'venue',
  'verna',
  'elantra',
  'tucson',
  'aura',
  'santro',
  'thar',
  'scorpio',
  'bolero',
  'nuvosport',
  'tuv300',
  'kuv100',
  'marazzo',
  'alturas',
  'xuv300',
  'xuv700',
  'innova',
  'fortuner',
  'etios',
  'camry',
  'glanza',
  'hyryder',
  'amaze',
  'civic',
  'accord',
  'jazz',
  'seltos',
  'sonet',
  'carens',
  'picanto',
  'vento',
  'tiguan',
  'passat',
  'octavia',
  'superb',
  'kushaq',
  'slavia',
  'kwid',
  'duster',
  'sandero',
  'magnite',
  'micra',
  'terrano',
  'kicks',
  'hector',
  'astor',
  'compass',
  'renegade',
  'wrangler',
  'spark',
  'cruze',
  'punto',
  'linea',
]);

/** Lower-cases and collapses everything that is not a letter or digit. */
const normalise = (value) =>
  String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The normalised word tokens of a value. */
const tokenise = (value) => normalise(value).split(' ').filter(Boolean);

/** `true` when `carBrand` names a Tata vehicle (any accepted spelling). */
const isTataCarBrand = (value) => TATA_CAR_BRAND_ALIASES.has(normalise(value));

/**
 * First token of `value` that names a vehicle make we do not stock.
 * Returns `null` when the value is clean.
 *
 * `minTokenLength` lets free-text fields (`name`, `description`) skip the two
 * character abbreviations that are legitimate words in prose.
 */
const findNonTataVehicleBrandToken = (value, minTokenLength = 1) => {
  for (const token of tokenise(value)) {
    if (token.length < minTokenLength) continue;
    if (NON_TATA_VEHICLE_BRAND_TOKENS.has(token)) return token;
  }
  return null;
};

/**
 * First token of a `carModel` that names another make's vehicle - either the
 * make itself or one of its well-known models. Returns `null` when clean.
 */
const findNonTataVehicleModelToken = (value, minTokenLength = 1) => {
  for (const token of tokenise(value)) {
    if (token.length < minTokenLength) continue;
    if (NON_TATA_VEHICLE_BRAND_TOKENS.has(token)) return token;
    if (NON_TATA_VEHICLE_MODEL_TOKENS.has(token)) return token;
  }
  return null;
};

/** Error body shape every controller in this project already returns. */
const reject = (message) => ({ ok: false, message });

/**
 * Validates the vehicle-related fields of a product write.
 *
 * Called by `POST /api/products` and `PUT /api/products/:id`. Returns either
 * `{ ok: true, carBrand: 'Tata' }` (with the canonical spelling to persist) or
 * `{ ok: false, message }`, which the controller turns into the project's
 * standard 400 body.
 *
 * Rules:
 *   carBrand      must be a Tata spelling; empty means "default to Tata"
 *   brand         may name a part supplier, never a vehicle make
 *   carModel      may name a Tata model only
 *   name          may not name another make
 *   description   may not name another make
 */
const validateProductBrandFields = ({ carBrand, brand, carModel, name, description } = {}) => {
  if (carBrand !== undefined && carBrand !== null && String(carBrand).trim() !== '') {
    if (!isTataCarBrand(carBrand)) {
      return reject(
        'Car brand must be Tata. AnilKabadi stocks Tata parts only.'
      );
    }
  }

  if (findNonTataVehicleBrandToken(brand)) {
    return reject(
      'Part brand must not reference a non-Tata vehicle. AnilKabadi stocks Tata parts only.'
    );
  }

  if (carModel !== undefined && carModel !== null && String(carModel).trim() !== '') {
    if (findNonTataVehicleModelToken(carModel)) {
      return reject(
        'Car model must be a Tata model. AnilKabadi stocks Tata parts only.'
      );
    }
  }

  if (findNonTataVehicleBrandToken(name, FREE_TEXT_MIN_TOKEN_LENGTH)) {
    return reject(
      'Product name must not reference a non-Tata vehicle. AnilKabadi stocks Tata parts only.'
    );
  }

  if (findNonTataVehicleBrandToken(description, FREE_TEXT_MIN_TOKEN_LENGTH)) {
    return reject(
      'Product description must not reference a non-Tata vehicle. AnilKabadi stocks Tata parts only.'
    );
  }

  return { ok: true, carBrand: TATA_CAR_BRAND };
};

/**
 * Classifies one stored product for the audit / migration scripts.
 *
 *   'tata'         `carBrand` names a Tata vehicle - the row is in policy.
 *   'non-tata'     `carBrand` names another make - it must leave the catalogue.
 *   'unbranded'    `carBrand` empty and nothing else suggests another make -
 *                  almost always a row that predates the field. Safe to
 *                  normalise to Tata, but only because nothing contradicts it.
 *   'conflicting'  `carBrand` empty while `brand` / `carModel` / `name` /
 *                  `description` names another make. Never auto-fixed: a human
 *                  has to decide whether the row belongs in a Tata catalogue.
 *
 * `signals` carries the offending tokens so a report can explain WHY a row was
 * classified the way it was.
 */
const classifyProduct = (product = {}) => {
  const rawCarBrand =
    product.carBrand === undefined || product.carBrand === null
      ? ''
      : String(product.carBrand).trim();

  const signals = [];
  const brandSignal = findNonTataVehicleBrandToken(product.brand);
  if (brandSignal) signals.push(`brand:${brandSignal}`);
  const modelSignal = findNonTataVehicleModelToken(product.carModel);
  if (modelSignal) signals.push(`carModel:${modelSignal}`);
  const nameSignal = findNonTataVehicleBrandToken(product.name, FREE_TEXT_MIN_TOKEN_LENGTH);
  if (nameSignal) signals.push(`name:${nameSignal}`);
  const descriptionSignal = findNonTataVehicleBrandToken(
    product.description,
    FREE_TEXT_MIN_TOKEN_LENGTH
  );
  if (descriptionSignal) signals.push(`description:${descriptionSignal}`);

  if (rawCarBrand !== '') {
    return { status: isTataCarBrand(rawCarBrand) ? 'tata' : 'non-tata', signals };
  }

  return { status: signals.length ? 'conflicting' : 'unbranded', signals };
};

/**
 * Read-side guard.
 *
 * Every public product query is built through this, so the whole catalogue -
 * listing, search, featured, deals, condition rails, category pages, the Tata
 * BS6 rail and the two detail routes - is pinned to `carBrand: 'Tata'` at the
 * Mongo query level. A non-Tata row in the database is therefore invisible
 * everywhere rather than merely hidden by the UI, and it costs one equality
 * predicate on an already indexed field instead of a post-response filter.
 *
 * The object is copied per call so no caller can mutate a shared constant.
 */
const tataOnlyFilter = (filter = {}) => ({
  ...filter,
  carBrand: TATA_CAR_BRAND,
});

module.exports = {
  TATA_CAR_BRAND,
  FREE_TEXT_MIN_TOKEN_LENGTH,
  NON_TATA_VEHICLE_BRAND_TOKENS,
  NON_TATA_VEHICLE_MODEL_TOKENS,
  isTataCarBrand,
  normalise,
  tokenise,
  findNonTataVehicleBrandToken,
  findNonTataVehicleModelToken,
  validateProductBrandFields,
  classifyProduct,
  tataOnlyFilter,
};
