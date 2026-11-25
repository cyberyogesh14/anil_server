const mongoose = require('mongoose');
const ApiError = require('../services/ApiError');
const { stripToPlainText } = require('./seoText');
const { GROUP_TEMPLATE_DEFAULTS } = require('../models/ProductGroup');

const MAX_VARIANTS = 200;
const MAX_IMAGES = 5;
const NUMERIC_FIELDS = ['price', 'mrp', 'quantity'];
const AVAILABILITY = ['in_stock', 'out_of_stock', 'preorder', 'discontinued'];
const TEMPLATE_KEYS = Object.keys(GROUP_TEMPLATE_DEFAULTS);

function parseJson(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiError(400, `${label} must be valid JSON`);
  }
}

function plain(value, max, label, required = false) {
  const cleaned = stripToPlainText(value ?? '').slice(0, max);
  if (required && !cleaned) {
    throw new ApiError(400, `${label} is required`);
  }
  return cleaned;
}

function normalizeKey(value) {
  return stripToPlainText(value ?? '').toLowerCase().replace(/\s+/g, '');
}

function parseSpecifications(value) {
  const raw = parseJson(value, 'Specifications');
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'Specifications must be an object');
  }
  const specs = {};
  for (const [key, item] of Object.entries(raw).slice(0, 50)) {
    const cleanKey = plain(key, 60, 'Specification name', true);
    specs[cleanKey] = plain(item, 500, `Specification ${cleanKey}`);
  }
  return specs;
}

function parseTags(value) {
  const raw = parseJson(value, 'Tags');
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'Tags must be an array');
  return raw
    .slice(0, 20)
    .map((tag) => plain(tag, 40, 'Tag'))
    .filter(Boolean);
}

function parseTemplates(value) {
  const raw = parseJson(value, 'SEO templates') || {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'SEO templates must be an object');
  }
  const templates = {};
  for (const key of TEMPLATE_KEYS) {
    const limit = key === 'seoTitle' ? 200 : key === 'seoDescription' ? 500 : key === 'title' ? 300 : 20000;
    templates[key] = plain(raw[key] || GROUP_TEMPLATE_DEFAULTS[key], limit, `Template ${key}`, true);
  }
  return templates;
}

function parseCommon(body = {}) {
  const raw = parseJson(body.common, 'Common product details');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'Common product details are required');
  }
  if (!mongoose.Types.ObjectId.isValid(String(raw.category || ''))) {
    throw new ApiError(400, 'A valid category is required');
  }
  const condition = raw.condition || 'new';
  if (!['new', 'used_like_new', 'used_good', 'used_fair', 'refurbished'].includes(condition)) {
    throw new ApiError(400, 'Invalid condition');
  }
  const emissionStandard = raw.emissionStandard || '';
  if (!['', 'BS4', 'BS6'].includes(emissionStandard)) {
    throw new ApiError(400, 'Invalid emission standard');
  }
  return {
    baseTitle: plain(raw.baseTitle || raw.name, 200, 'Base product title', true),
    description: plain(raw.description, 20000, 'Description'),
    brand: plain(raw.brand, 120, 'Brand'),
    category: String(raw.category),
    subcategory: plain(raw.subcategory, 120, 'Subcategory'),
    carBrand: 'Tata',
    carModel: plain(raw.carModel, 120, 'Car model'),
    compatibleYears: plain(raw.compatibleYears, 120, 'Compatible years'),
    compatibility: plain(raw.compatibility, 5000, 'Compatibility information'),
    additionalInfo: plain(raw.additionalInfo, 5000, 'Additional information'),
    condition,
    emissionStandard,
    specifications: parseSpecifications(raw.specifications),
    tags: parseTags(raw.tags),
    templates: parseTemplates(raw.templates),
    isActive: raw.isActive !== false,
  };
}

function parseExistingImages(value, allowedImages) {
  const raw = parseJson(value, 'Existing images');
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'Existing images must be an array');
  const allowed = new Map(
    allowedImages.map((image) => [String(image.url), String(image.publicId || '')])
  );
  return raw.slice(0, MAX_IMAGES).map((image) => {
    const url = typeof image === 'string' ? image : image?.url;
    if (!url || !allowed.has(String(url))) {
      throw new ApiError(400, 'Invalid existing image');
    }
    return { url: String(url), publicId: allowed.get(String(url)) || '' };
  });
}

function parseVariants(body = {}) {
  const raw = parseJson(body.variants, 'Part numbers');
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'At least one part number is required');
  }
  if (raw.length > MAX_VARIANTS) {
    throw new ApiError(400, `A group can contain at most ${MAX_VARIANTS} part numbers`);
  }
  const seenParts = new Set();
  const seenSkus = new Set();
  const rows = raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ApiError(400, `Part number row ${index + 1} is invalid`);
    }
    const partNumber = plain(item.partNumber, 100, `Part number row ${index + 1}`, true);
    const sku = plain(item.sku, 100, `SKU row ${index + 1}`);
    const row = {
      _id: mongoose.Types.ObjectId.isValid(String(item._id || '')) ? String(item._id) : null,
      partNumber,
      partNumberKey: normalizeKey(partNumber),
      sku,
      skuKey: sku ? normalizeKey(sku) : null,
      price: Number(item.price),
      mrp: Number(item.mrp),
      quantity: Number(item.quantity ?? item.stock ?? 0),
      availability: AVAILABILITY.includes(item.availability)
        ? item.availability
        : Number(item.quantity ?? item.stock ?? 0) > 0
          ? 'in_stock'
          : 'out_of_stock',
      isActive: item.isActive !== false,
      titleOverride: plain(item.titleOverride, 300, `Title override row ${index + 1}`),
      descriptionOverride: plain(
        item.descriptionOverride,
        20000,
        `Description override row ${index + 1}`
      ),
      seoTitleOverride: plain(item.seoTitleOverride, 200, `SEO title override row ${index + 1}`),
      seoDescriptionOverride: plain(
        item.seoDescriptionOverride,
        500,
        `SEO description override row ${index + 1}`
      ),
      featured: item.featured === true,
    };
    if (!row.partNumberKey) {
      throw new ApiError(400, `Part number row ${index + 1} is required`);
    }
    for (const field of NUMERIC_FIELDS) {
      if (!Number.isFinite(row[field])) {
        throw new ApiError(400, `${field} must be a number in row ${index + 1}`);
      }
    }
    if (row.price < 0 || row.mrp < 0 || row.quantity < 0) {
      throw new ApiError(400, `Price, MRP and quantity cannot be negative in row ${index + 1}`);
    }
    if (!Number.isInteger(row.quantity)) {
      throw new ApiError(400, `Quantity must be a whole number in row ${index + 1}`);
    }
    if (row.mrp < row.price) {
      throw new ApiError(400, `MRP cannot be lower than price in row ${index + 1}`);
    }
    if (seenParts.has(row.partNumberKey)) {
      throw new ApiError(400, `Duplicate part number: ${row.partNumber}`);
    }
    seenParts.add(row.partNumberKey);
    if (row.skuKey) {
      if (seenSkus.has(row.skuKey)) {
        throw new ApiError(400, `Duplicate SKU: ${row.sku}`);
      }
      seenSkus.add(row.skuKey);
    }
    return row;
  });
  return rows;
}

function renderTemplate(template, context) {
  return stripToPlainText(
    String(template).replace(/\{(\w+)\}/g, (match, key) =>
      context[key] === undefined || context[key] === null ? '' : String(context[key])
    )
  );
}

function buildContent(common, row) {
  const context = {
    baseTitle: common.baseTitle,
    baseDescription: common.description,
    partNumber: row.partNumber,
    sku: row.sku,
    brand: common.brand,
    category: common.subcategory || common.carModel,
    carModel: common.carModel,
  };
  return {
    name: row.titleOverride || renderTemplate(common.templates.title, context),
    description:
      row.descriptionOverride || renderTemplate(common.templates.description, context),
    seoTitle:
      row.seoTitleOverride || renderTemplate(common.templates.seoTitle, context).slice(0, 200),
    seoDescription:
      row.seoDescriptionOverride ||
      renderTemplate(common.templates.seoDescription, context).slice(0, 500),
  };
}

function commonProductFields(common, images) {
  return {
    description: common.description,
    brand: common.brand,
    carBrand: common.carBrand,
    carModel: common.carModel,
    compatibleYears: common.compatibleYears,
    compatibility: common.compatibility,
    additionalInfo: common.additionalInfo,
    subcategory: common.subcategory,
    condition: common.condition,
    emissionStandard: common.emissionStandard,
    specifications: common.specifications,
    tags: common.tags,
    category: common.category,
    images,
  };
}

function buildVariantDoc(common, row, images, groupId, content) {
  return {
    ...commonProductFields(common, images),
    ...(content || buildContent(common, row)),
    productGroup: groupId,
    partNumber: row.partNumber,
    partNumberKey: row.partNumberKey,
    sku: row.sku || undefined,
    skuKey: row.skuKey || undefined,
    price: row.price,
    mrp: row.mrp,
    stock: row.quantity,
    availability: row.quantity > 0 ? row.availability : 'out_of_stock',
    isActive: row.isActive,
    featured: row.featured,
    titleOverride: row.titleOverride,
    descriptionOverride: row.descriptionOverride,
    seoTitleOverride: row.seoTitleOverride,
    seoDescriptionOverride: row.seoDescriptionOverride,
  };
}

function buildVariantUpdate(common, row, images, content) {
  return {
    ...commonProductFields(common, images),
    ...(content || buildContent(common, row)),
    partNumber: row.partNumber,
    partNumberKey: row.partNumberKey,
    sku: row.sku || undefined,
    skuKey: row.skuKey || undefined,
    price: row.price,
    mrp: row.mrp,
    stock: row.quantity,
    availability: row.quantity > 0 ? row.availability : 'out_of_stock',
    isActive: row.isActive,
    featured: row.featured,
    titleOverride: row.titleOverride,
    descriptionOverride: row.descriptionOverride,
    seoTitleOverride: row.seoTitleOverride,
    seoDescriptionOverride: row.seoDescriptionOverride,
  };
}

module.exports = {
  MAX_IMAGES,
  normalizeKey,
  parseCommon,
  parseExistingImages,
  parseVariants,
  renderTemplate,
  buildContent,
  buildVariantDoc,
  buildVariantUpdate,
};
