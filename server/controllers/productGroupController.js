const mongoose = require('mongoose');
const ApiError = require('../services/ApiError');
const Product = require('../models/Product');
const ProductGroup = require('../models/ProductGroup');
const Category = require('../models/Category');
const Cart = require('../models/Cart');
const slugify = require('../utils/slugify');
const { escapeRegex } = require('../utils/safeRegex');
const { validateProductBrandFields } = require('../utils/tataPolicy');
const { invalidateCatalogueCache } = require('../utils/catalogueCache');
const { runInTransaction } = require('../services/transactionRunner');
const { uploadGroupImages, destroyGroupImages } = require('../utils/bulkImages');
const {
  parseCommon,
  parseVariants,
  parseExistingImages,
  buildContent,
  buildVariantDoc,
  buildVariantUpdate,
} = require('../utils/bulkProduct');

const GROUP_FIELDS = [
  'baseTitle',
  'description',
  'brand',
  'category',
  'subcategory',
  'carBrand',
  'carModel',
  'compatibleYears',
  'compatibility',
  'additionalInfo',
  'condition',
  'emissionStandard',
  'specifications',
  'tags',
  'templates',
  'images',
  'isActive',
];

function pickGroupFields(common, images) {
  const picked = {};
  for (const key of GROUP_FIELDS) {
    if (key in common) picked[key] = common[key];
  }
  picked.images = images;
  return picked;
}

async function assertCategory(categoryId) {
  const exists = await Category.exists({ _id: categoryId });
  if (!exists) throw new ApiError(400, 'Category does not exist');
}

async function assertVariantKeysAvailable(rows, excludedIds = []) {
  const clauses = [];
  for (const row of rows) {
    clauses.push({ partNumberKey: row.partNumberKey });
    if (row.skuKey) clauses.push({ skuKey: row.skuKey });
  }
  if (!clauses.length) return;
  const conflicts = await Product.find({
    $or: clauses,
    _id: { $nin: excludedIds },
  })
    .select('partNumber sku')
    .lean();
  if (conflicts.length) {
    const first = conflicts[0];
    throw new ApiError(
      409,
      `Part number or SKU already exists: ${first.partNumber || first.sku}`
    );
  }
}

async function resolveContent(common, rows, excludedIds = []) {
  const entries = rows.map((row) => ({
    row,
    content: buildContent(common, row),
  }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const used = new Map();
    for (const entry of entries) {
      const slug = slugify(entry.content.name);
      if (used.has(slug)) {
        entry.content.name = `${entry.content.name} - ${entry.row.partNumber}`;
      }
      used.set(slugify(entry.content.name), entry.row);
    }
    const slugs = [...used.keys()];
    const existing = await Product.find({
      slug: { $in: slugs },
      _id: { $nin: excludedIds },
    })
      .select('slug')
      .lean();
    if (!existing.length) return entries.map((entry) => entry.content);
    const taken = new Set(existing.map((doc) => doc.slug));
    for (const entry of entries) {
      if (taken.has(slugify(entry.content.name))) {
        entry.content.name = `${entry.content.name} - ${entry.row.partNumber}`;
      }
    }
  }
  return entries.map((entry) => entry.content);
}

function assertTataPolicy(common, contents) {
  const first = contents[0] || {};
  const check = validateProductBrandFields({
    carBrand: common.carBrand,
    brand: common.brand,
    carModel: common.carModel,
    name: common.baseTitle,
    description: common.description,
    seoTitle: first.seoTitle,
    seoDescription: first.seoDescription,
  });
  if (!check.ok) throw new ApiError(400, check.message);
}

function readPayload(req, allowedImages = []) {
  const common = parseCommon(req.body);
  const rows = parseVariants(req.body);
  const existingImages = allowedImages.length
    ? parseExistingImages(req.body.existingImages, allowedImages)
    : [];
  return { common, rows, existingImages };
}

exports.listGroups = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const groupFilter = {};
    if (req.query.isActive === 'false') groupFilter.isActive = false;
    if (mongoose.Types.ObjectId.isValid(String(req.query.category || ''))) {
      groupFilter.category = String(req.query.category);
    }

    const variantClauses = [];
    const andClauses = [];
    let searchRegex = null;
    if (req.query.search) {
      const term = String(req.query.search).trim().slice(0, 120);
      searchRegex = new RegExp(escapeRegex(term), 'i');
      variantClauses.push({ partNumber: searchRegex }, { sku: searchRegex });
    }
    if (req.query.availability === 'in_stock') {
      variantClauses.push({ stock: { $gt: 0 } });
    } else if (req.query.availability === 'out_of_stock') {
      variantClauses.push({ stock: { $lte: 0 } });
    }

    let matchingGroupIds = [];
    if (variantClauses.length) {
      const matching = await Product.find({ $or: variantClauses })
        .select('productGroup')
        .lean();
      matchingGroupIds = matching.map((item) => item.productGroup).filter(Boolean);
    }
    if (searchRegex) {
      andClauses.push({
        $or: [
          { baseTitle: searchRegex },
          { description: searchRegex },
          { _id: { $in: matchingGroupIds } },
        ],
      });
    } else if (variantClauses.length) {
      andClauses.push({ _id: { $in: matchingGroupIds } });
    }
    if (andClauses.length) groupFilter.$and = andClauses;

    const [groups, total] = await Promise.all([
      ProductGroup.find(groupFilter)
        .populate('category', 'name slug')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProductGroup.countDocuments(groupFilter),
    ]);

    const data = await Promise.all(
      groups.map(async (group) => {
        const variants = await Product.find({ productGroup: group._id })
          .select('name sku partNumber price mrp stock isActive availability slug')
          .sort({ partNumber: 1 })
          .lean();
        return {
          ...group,
          stats: {
            totalListings: variants.length,
            totalPartNumbers: variants.length,
            activeProducts: variants.filter((item) => item.isActive).length,
            outOfStock: variants.filter((item) => item.stock <= 0).length,
          },
          variants,
        };
      })
    );

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

exports.getGroup = async (req, res, next) => {
  try {
    const group = await ProductGroup.findById(req.params.id)
      .populate('category', 'name slug')
      .lean();
    if (!group) throw new ApiError(404, 'Product group not found');
    const variants = await Product.find({ productGroup: group._id })
      .sort({ partNumber: 1 })
      .lean();
    res.json({ success: true, data: { ...group, variants } });
  } catch (error) {
    next(error);
  }
};

exports.createGroup = async (req, res, next) => {
  let uploadedImages = [];
  try {
    const { common, rows } = readPayload(req);
    await assertCategory(common.category);
    await assertVariantKeysAvailable(rows);
    const contents = await resolveContent(common, rows);
    assertTataPolicy(common, contents);

    uploadedImages = await uploadGroupImages(req.files);
    const images = uploadedImages;
    let group;
    let variants;

    await runInTransaction(async (session) => {
      const [createdGroup] = await ProductGroup.create(
        [{ ...pickGroupFields(common, images), createdBy: req.user._id }],
        { session, ordered: true }
      );
      group = createdGroup;
      variants = await Product.create(
        rows.map((row, index) =>
          buildVariantDoc(common, row, images, group._id, contents[index])
        ),
        { session, ordered: true }
      );
    });

    await invalidateCatalogueCache();
    res.status(201).json({
      success: true,
      message: `${variants.length} product listings created`,
      data: { group, variants },
    });
  } catch (error) {
    if (uploadedImages.length) await destroyGroupImages(uploadedImages);
    if (error.code === 11000) {
      return next(new ApiError(409, 'A part number or SKU already exists'));
    }
    next(error);
  }
};

exports.updateGroup = async (req, res, next) => {
  let uploadedImages = [];
  try {
    const group = await ProductGroup.findById(req.params.id);
    if (!group) throw new ApiError(404, 'Product group not found');
    const { common, rows, existingImages } = readPayload(req, group.images || []);
    await assertCategory(common.category);

    const currentVariants = await Product.find({ productGroup: group._id })
      .select('_id partNumber sku')
      .lean();
    const currentIds = currentVariants.map((variant) => String(variant._id));
    const currentIdSet = new Set(currentIds);
    for (const row of rows) {
      if (row._id && !currentIdSet.has(row._id)) {
        throw new ApiError(400, `Part number ${row.partNumber} does not belong to this group`);
      }
    }
    const keptIds = rows.map((row) => row._id).filter(Boolean);
    const removedIds = currentIds.filter((id) => !keptIds.includes(id));

    await assertVariantKeysAvailable(rows, currentIds);
    const contents = await resolveContent(common, rows, currentIds);
    assertTataPolicy(common, contents);

    uploadedImages = await uploadGroupImages(req.files);
    const images = [...existingImages, ...uploadedImages];
    let updatedGroup;
    let updatedVariants = [];

    await runInTransaction(async (session) => {
      updatedGroup = await ProductGroup.findByIdAndUpdate(
        group._id,
        pickGroupFields(common, images),
        { new: true, runValidators: true, session }
      );

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const update = buildVariantUpdate(common, row, images, contents[index]);
        if (!row.sku) {
          delete update.sku;
          delete update.skuKey;
          update.$unset = { sku: '', skuKey: '' };
        }
        const variant = await Product.findByIdAndUpdate(row._id, update, {
          new: true,
          runValidators: true,
          session,
        });
        if (variant) updatedVariants.push(variant);
      }

      const newRows = rows
        .map((row, index) => ({ row, content: contents[index] }))
        .filter((entry) => !entry.row._id);
      if (newRows.length) {
        const created = await Product.create(
          newRows.map((entry) =>
            buildVariantDoc(common, entry.row, images, group._id, entry.content)
          ),
          { session, ordered: true }
        );
        updatedVariants.push(...created);
      }

      if (removedIds.length) {
        await Product.deleteMany(
          { _id: { $in: removedIds }, productGroup: group._id },
          { session }
        );
        const carts = await Cart.find({ 'items.product': { $in: removedIds } })
          .select('items')
          .session(session);
        for (const cart of carts) {
          cart.items = cart.items.filter(
            (item) => !removedIds.includes(String(item.product))
          );
          cart.totalPrice = cart.items.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
          );
          await cart.save({ session });
        }
      }
    });

    await invalidateCatalogueCache();
    res.json({
      success: true,
      message: 'Product group updated',
      data: { group: updatedGroup, variants: updatedVariants },
    });
  } catch (error) {
    if (uploadedImages.length) await destroyGroupImages(uploadedImages);
    if (error.code === 11000) {
      return next(new ApiError(409, 'A part number or SKU already exists'));
    }
    next(error);
  }
};

exports.deleteGroup = async (req, res, next) => {
  try {
    const group = await ProductGroup.findById(req.params.id);
    if (!group) throw new ApiError(404, 'Product group not found');
    const variantIds = (await Product.find({ productGroup: group._id }).select('_id').lean()).map(
      (item) => item._id
    );
    await runInTransaction(async (session) => {
      await Product.updateMany(
        { _id: { $in: variantIds } },
        { $set: { isActive: false, availability: 'discontinued' } },
        { session }
      );
      group.isActive = false;
      await group.save({ session });
    });
    await invalidateCatalogueCache();
    res.json({ success: true, message: 'Product group deactivated' });
  } catch (error) {
    next(error);
  }
};
