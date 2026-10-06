const Category = require('../models/Category');
const { escapeRegex } = require('../utils/safeRegex');
const cache = require('../utils/simpleCache');
const { CATEGORIES_KEY } = require('../utils/catalogueCache');

exports.getCategories = async (req, res, next) => {
  try {
    const cached = await cache.get(CATEGORIES_KEY);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
      });
    }
    const categories = await Category.find({ isActive: true })
      .sort({ name: 1 })
      .lean();
    await cache.set(CATEGORIES_KEY, categories, 120000); // 120s TTL
    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    next(error);
  }
};

exports.getCategoryById = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id).lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

exports.createCategory = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Category name is required',
      });
    }

    // Escaped, not a bare `new RegExp(name)`: a name containing a metacharacter such
// as `(` would otherwise throw and surface as a 500 (audit finding F-08). The
// anchors stay unescaped so this remains an exact, case-insensitive match.
const existing = await Category.findOne({
      name: new RegExp(`^${escapeRegex(String(name).trim())}$`, 'i'),
    })
      .select('_id')
      .lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Category already exists',
      });
    }

    let image = { url: '', publicId: '' };
    if (req.file) {
      const { cloudinary } = require('../config/cloudinary');
      // `file.buffer`, not `file.path`: uploads use memory storage.
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: 'anilkabadi/categories',
            transformation: [{ width: 400, height: 400, crop: 'limit' }],
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });
      image = { url: result.secure_url, publicId: result.public_id };
    }

    const category = await Category.create({
      name,
      description: description || '',
      image,
    });

    await cache.del(CATEGORIES_KEY);

    res.status(201).json({
      success: true,
      message: 'Category created',
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Fields a category update may touch (audit finding F-04).
 *
 * This used to be `{ ...req.body }`, so a staff session could send `isActive` and
 * quietly unpublish a category - the catalogue then kept serving it through routes
 * that only filter by other criteria. Publishing is an explicit admin action and the
 * audit block that manages it, so neither is settable here.
 */
const CATEGORY_EDITABLE_FIELDS = [
  'name',
  'description',
  'slug',
  'image',
];

exports.updateCategory = async (req, res, next) => {
  try {
    const updateData = {};
    for (const key of CATEGORY_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updateData[key] = req.body[key];
      }
    }

    if (req.user.role === 'admin' && typeof req.body.isActive === 'boolean') {
      updateData.isActive = req.body.isActive;
    }

    if (req.file) {
      const { cloudinary } = require('../config/cloudinary');
      // `file.buffer`, not `file.path`: uploads use memory storage. This also
      // closes a leak - with the previous disk storage these category uploads
      // were never unlinked, so every category image left a temp file behind.
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: 'anilkabadi/categories',
            transformation: [{ width: 400, height: 400, crop: 'limit' }],
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });
      updateData.image = { url: result.secure_url, publicId: result.public_id };
    }

    const category = await Category.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    // A rename, retag or unpublish must be visible to the nav rail on the next
    // request, not after the TTL.
    await cache.del(CATEGORIES_KEY);

    res.json({
      success: true,
      message: 'Category updated',
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    category.isActive = false;
    await category.save();

    await cache.del(CATEGORIES_KEY);

    res.json({
      success: true,
      message: 'Category deactivated',
    });
  } catch (error) {
    next(error);
  }
};
