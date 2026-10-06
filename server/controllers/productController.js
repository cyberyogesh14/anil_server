const Product = require('../models/Product');
const APIFeatures = require('../utils/apiFeatures');
const cache = require('../utils/simpleCache');
const { escapeRegex } = require('../utils/safeRegex');
const { buildProductSearchFilter } = require('../utils/productSearch');

/**
 * Fields a public catalogue request is allowed to filter on. Anything else in the
 * query string is ignored, and operator-shaped parameters are rejected by
 * `assertSafeQuery` before MongoDB ever sees them (audit finding F-01).
 * `isActive` is deliberately absent: the routes below decide visibility themselves.
 */
const PUBLIC_FILTER_KEYS = [
  'category',
  'brand',
  'carBrand',
  'carModel',
  'condition',
  'emissionStandard',
  'featured',
  'sku',
];

/** `?category[]=a&category[]=b`, `?brand[]=…`, `?emissionStandard[]=…` */
const PUBLIC_MULTI_FILTER_KEYS = ['category', 'brand', 'emissionStandard'];

/** Projection is allow-listed too, so `?fields=` cannot reach arbitrary paths. */
const PUBLIC_FIELD_KEYS = [
  '_id',
  'name',
  'slug',
  'sku',
  'description',
  'brand',
  'category',
  'carBrand',
  'carModel',
  'compatibleYears',
  'partNumber',
  'condition',
  'emissionStandard',
  'price',
  'mrp',
  'discount',
  'stock',
  'images',
  'featured',
  'isActive',
  'rating',
  'numReviews',
  'specifications',
  'createdAt',
  'updatedAt',
];

/**
 * Drops every cached catalogue snapshot.
 *
 * Four endpoints cache their result for 120-180s because the same handful of
 * rows are re-read by essentially every visitor, on every page load, forever:
 *
 *   featured:<limit>        GET /api/products/featured
 *   bestdeals:<limit>       GET /api/products/best-deals
 *   tata_bs6:<limit>        GET /api/products/tata-bs6
 *   condition:<condition>:<limit>   GET /api/products/condition/:condition
 *
 * Three rules keep this safe:
 *
 *   1. Only whole-catalogue public reads are cached. Nothing personalised, no user
 *      id in any key, and no authenticated response. `/products` itself, which
 *      reflects live stock and paging, is NOT cached.
 *   2. Every product mutation calls this, so an admin publish, edit, price change
 *      or deactivation shows up on the next request rather than after the TTL. The
 *      TTL is a safety net, not the invalidation mechanism.
 *   3. The cached documents DO include `stock`, so a checkout that moves stock must
 *      drop these keys too. That lives in `stockService`, and the key list itself
 *      is shared via `utils/catalogueCache` so the two call sites cannot drift.
 */
const { CATALOGUE_TOTAL_KEY, invalidateCatalogueCache } = require('../utils/catalogueCache');

/**
 * How long the unfiltered catalogue total is reused before it is recounted.
 *
 * Deliberately the shortest TTL in the codebase. The number it serves is the
 * "N products found" count and the page count in the pagination block, both of
 * which the storefront renders, so it must never look stale for long. Product
 * create / update / deactivate also drop it immediately via
 * `invalidateCatalogueCache()`.
 */
const CATALOGUE_TOTAL_TTL_MS = 30 * 1000;

/** Cache key for `countDocuments({ isActive: true })`. */

exports.getProducts = async (req, res, next) => {
  try {
    // The populate is applied to the base query, exactly as before, so the
    // `category: { name, slug }` subdocument in each response is unchanged.
    // `.lean()` is then safe: nothing here is saved or passed to a Mongoose
    // method, and a lean populated document serialises identically.
    const baseQuery = Product.find({ isActive: true }).populate(
      'category',
      'name slug'
    );
    const features = new APIFeatures(baseQuery, req.query, {
      filter: PUBLIC_FILTER_KEYS,
      array: PUBLIC_MULTI_FILTER_KEYS,
      fields: PUBLIC_FIELD_KEYS,
    })
      .search()
      .filter()
      .sort()
      .limitFields()
      .paginate()
      .lean();

    /**
     * The page of rows and the total count do not depend on each other, so they
     * are issued together instead of one after the other. This halves the
     * round trips the storefront's busiest endpoint makes - it was two
     * sequential waits, now it is one.
     *
     * The unfiltered total is also the one count that repeats identically on
     * every page view, and it measured ~1 ms against a ~2.9 ms page query, so
     * that single case is reused for 30 s. Only the exact filter
     * `{ isActive: true }` qualifies; anything the shopper actually filtered on
     * is still counted exactly, because a filtered count is neither repetitive
     * nor cheap to key safely.
     */
    const totalFilter = {
      isActive: true,
      ...(features.dbFilter || {}),
    };
    const isUnfilteredTotal = Object.keys(totalFilter).length === 1;

    const totalPromise = isUnfilteredTotal
      ? Promise.resolve().then(async () => {
          const cached = await cache.get(CATALOGUE_TOTAL_KEY);
          if (cached !== undefined) return cached;
          const counted = await Product.countDocuments(totalFilter);
          await cache.set(CATALOGUE_TOTAL_KEY, counted, CATALOGUE_TOTAL_TTL_MS);
          return counted;
        })
      : Product.countDocuments(totalFilter);

    const [products, total] = await Promise.all([features.query, totalPromise]);

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

    res.json({
      success: true,
      data: products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reads one product by id.
 *
 * Audit finding F-05: this used to return any product, including `isActive: false`,
 * so an unpublished product could be read by a shopper who guessed or collected its
 * id even though every list route filtered it out.
 *
 * Public callers now get the same 404 they would get for a product that does not
 * exist - a hidden product must not be distinguishable from a missing one. Staff and
 * admins may still read one, because the admin product detail and edit screens fetch
 * through this same endpoint and need to see the unpublished item.
 */
exports.getProductById = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('category', 'name slug')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const isPrivileged =
      req.user && (req.user.role === 'admin' || req.user.role === 'staff');

    if (!product.isActive && !isPrivileged) {
      // Deliberately identical to "not found" rather than a 403, so an anonymous
      // caller cannot use the status code to probe for hidden products.
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    res.json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductBySlug = async (req, res, next) => {
  try {
    const product = await Product.findOne({
      slug: req.params.slug,
      isActive: true,
    })
      .populate('category', 'name slug')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    res.json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.createProduct = async (req, res, next) => {
  try {
    const {
      name,
      description,
      brand,
      category,
      carBrand,
      carModel,
      compatibleYears,
      partNumber,
      condition,
      emissionStandard,
      price,
      mrp,
      stock,
      sku,
      featured,
      specifications,
    } = req.body;

    if (!name || !price || !mrp || !category) {
      return res.status(400).json({
        success: false,
        message: 'Name, price, mrp and category are required',
      });
    }

    const images = [];
    if (req.files && req.files.length > 0) {
      const { cloudinary } = require('../config/cloudinary');
      // Uploads run concurrently instead of one at a time. These are independent
      // HTTP calls, so a 6-image product used to pay six sequential round trips;
      // `Promise.all` keeps the *result* order identical to `req.files` (which is
      // what determines the order of `images`), and still rejects with the first
      // failure so the controller's error handling behaves as before.
      //
      // `file.buffer`, not `file.path`: uploads use memory storage, so the image
      // bytes are in the buffer and no temp file was ever written.
      const uploaded = await Promise.all(
        req.files.map((file) => {
          return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                folder: 'anilkabadi/products',
                transformation: [{ width: 800, height: 800, crop: 'limit' }],
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              }
            );
            stream.end(file.buffer);
          });
        })
      );

      for (const result of uploaded) {
        images.push({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    }

    let parsedSpecs = {};
    if (specifications) {
      try {
        parsedSpecs =
          typeof specifications === 'string'
            ? JSON.parse(specifications)
            : specifications;
      } catch {
        parsedSpecs = {};
      }
    }

    let finalSku = sku;
    if (!finalSku) {
      finalSku = `AK-${Date.now().toString(36).toUpperCase()}`;
    }

    const product = await Product.create({
      name,
      sku: finalSku,
      description: description || '',
      brand: brand || '',
      category,
      carBrand: carBrand || '',
      carModel: carModel || '',
      compatibleYears: compatibleYears || '',
      partNumber: partNumber || '',
      condition: condition || 'new',
      emissionStandard: emissionStandard || '',
      price: Number(price),
      mrp: Number(mrp),
      stock: Number(stock) || 0,
      images,
      featured: featured === 'true' || featured === true,
      specifications: parsedSpecs,
    });

    // Invalidate the cached rails before responding. A newly created product can
    // appear in featured / best-deals / condition / Tata BS6 the moment it is
    // published, so the cached snapshots are dropped here rather than waiting
    // out their TTL.
    await invalidateCatalogueCache();

    res.status(201).json({
      success: true,
      message: 'Product created',
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Review aggregates and lifecycle state a product update may never touch
 * (audit finding F-04). `rating` and `numReviews` are owned exclusively by the review
 * service; `isActive` is a publish decision, not something an editor's form sets.
 */
const STAFF_PRODUCT_FIELDS = [
  'name',
  'description',
  'brand',
  'category',
  'carBrand',
  'carModel',
  'compatibleYears',
  'partNumber',
  'condition',
  'emissionStandard',
  'price',
  'mrp',
  'discount',
  'stock',
  'featured',
  'specifications',
];

/** Admins additionally control SKU, images and the publish flag. */
const ADMIN_PRODUCT_FIELDS = [...STAFF_PRODUCT_FIELDS, 'sku', 'images', 'isActive'];

/** Carries over exactly the keys an editor is allowed to change. */
const pickAllowed = (body, allowed) => {
  const picked = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) picked[key] = body[key];
  }
  return picked;
};

exports.updateProduct = async (req, res, next) => {
  try {
    let product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Audit finding F-04: this used to be `{ ...req.body }`, which let any
    // authenticated editor (including staff) rewrite review aggregates and other
    // server-owned fields. Only allow-listed keys are copied now, and
    // `existingImages` / `images` are recomputed below rather than taken verbatim.
    const allowedFields =
      req.user.role === 'admin' ? ADMIN_PRODUCT_FIELDS : STAFF_PRODUCT_FIELDS;
    const updateData = pickAllowed(req.body, allowedFields);

    let baseImages = product.images || [];
    if (updateData.existingImages) {
      try {
        baseImages = typeof updateData.existingImages === 'string'
          ? JSON.parse(updateData.existingImages)
          : updateData.existingImages;
      } catch {
        // keep baseImages
      }
      delete updateData.existingImages;
    }

    if (req.files && req.files.length > 0) {
      const { cloudinary } = require('../config/cloudinary');
      // Concurrent uploads, `Promise.all` preserving `req.files` order so the new
      // images stay in the order the admin picked them. See `createProduct` for
      // the same reasoning.
      const uploaded = await Promise.all(
        req.files.map((file) => {
          return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                folder: 'anilkabadi/products',
                transformation: [{ width: 800, height: 800, crop: 'limit' }],
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              }
            );
            stream.end(file.buffer);
          });
        })
      );

      const newImages = uploaded.map((result) => ({
        url: result.secure_url,
        publicId: result.public_id,
      }));

      updateData.images = [...baseImages, ...newImages];
    } else if (updateData.existingImages !== undefined) {
      updateData.images = baseImages;
    }

    if (updateData.specifications && typeof updateData.specifications === 'string') {
      try {
        updateData.specifications = JSON.parse(updateData.specifications);
      } catch {
        delete updateData.specifications;
      }
    }

    if (updateData.price !== undefined) updateData.price = Number(updateData.price);
    if (updateData.mrp !== undefined) updateData.mrp = Number(updateData.mrp);
    if (updateData.stock !== undefined) updateData.stock = Number(updateData.stock);
    if (updateData.featured !== undefined) {
      updateData.featured = updateData.featured === 'true' || updateData.featured === true;
    }

    product = await Product.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });

    // Price/stock/featured edits change what every cached rail should show.
    await invalidateCatalogueCache();

    res.json({
      success: true,
      message: 'Product updated',
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    product.isActive = false;
    await product.save();

    // Deactivating removes the product from every cached rail immediately.
    await invalidateCatalogueCache();

    res.json({
      success: true,
      message: 'Product deactivated',
    });
  } catch (error) {
    next(error);
  }
};

exports.getFeaturedProducts = async (req, res, next) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit, 10) || 8);
    const cacheKey = `featured:${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
      });
    }
    const products = await Product.find({
      isActive: true,
      featured: true,
    })
      .populate('category', 'name slug')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    await cache.set(cacheKey, products, 120000);
    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

exports.getTataBS6Products = async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const cacheKey = `tata_bs6:${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
      });
    }
    const products = await Product.find({
      isActive: true,
      carBrand: 'Tata',
      emissionStandard: 'BS6',
    })
      .populate('category', 'name slug')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    await cache.set(cacheKey, products, 180000);
    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The `condition` values the schema actually defines. Anything else is a client
 * error rather than something to hand to the driver (audit finding F-08: the raw
 * `req.params` value was previously used as a filter as-is).
 */
const PRODUCT_CONDITIONS = new Set([
  'new',
  'used_like_new',
  'used_good',
  'used_fair',
  'refurbished',
]);

exports.getProductsByCondition = async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const { condition } = req.params;

    // 'used' is a storefront alias for the whole used_* family.
    const conditionFilter =
      condition === 'used'
        ? { $regex: '^used' }
        : PRODUCT_CONDITIONS.has(condition)
          ? condition
          : null;

    if (!conditionFilter) {
      return res.status(400).json({
        success: false,
        message: 'Invalid condition',
      });
    }

    // `condition` is validated against the fixed allow-list above before it is
    // used as a cache key, so a crafted path cannot address arbitrary entries.
    const cacheKey = `condition:${condition}:${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
      });
    }

    const products = await Product.find({
      isActive: true,
      condition: conditionFilter,
    })
      .populate('category', 'name slug')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    await cache.set(cacheKey, products, 120000);

    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

exports.getBestDeals = async (req, res, next) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit, 10) || 10);
    const cacheKey = `bestdeals:${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
      });
    }
    const products = await Product.find({
      isActive: true,
      discount: { $gt: 0 },
    })
      .populate('category', 'name slug')
      .sort({ discount: -1 })
      .limit(limit)
      .lean();
    await cache.set(cacheKey, products, 120000);
    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

exports.searchProducts = async (req, res, next) => {
  try {
    const { q } = req.query;
    const baseQuery = Product.find({ isActive: true }).populate(
      'category',
      'name slug'
    );

    let query = baseQuery;

    if (q) {
      /**
       * Audit finding F-08: escaped literal match, so a malformed pattern such as
       * `[` can no longer throw a SyntaxError and surface as a 500.
       *
       * This single unanchored, case-insensitive regex across seven fields was the
       * most expensive read in the application - the load test measured it at
       * roughly 100x the cost of a category read, because no index can serve an
       * unanchored substring match and MongoDB falls back to a collection scan
       * plus a full-text index lookup on every request.
       *
       * `buildProductSearchFilter()` resolves that with the existing text index
       * while keeping the result set a strict superset of the regex it replaces.
       * The literal-matching branch is still present for every input the text
       * index cannot answer equivalently (partial words, hyphenated part numbers,
       * codes, phrases), so search behaviour is preserved rather than narrowed.
       */
      query = query.find(buildProductSearchFilter(String(q).trim()));
    }

    const features = new APIFeatures(query, req.query, {
      filter: PUBLIC_FILTER_KEYS,
      array: PUBLIC_MULTI_FILTER_KEYS,
      fields: PUBLIC_FIELD_KEYS,
    })
      .filter()
      .sort()
      .paginate()
      .lean();

    const products = await features.query;

    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductsByCategory = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    const filter = {
      category: req.params.categoryId,
      isActive: true,
    };

    // Page and count are independent reads; issuing them together removes one
    // full round trip from the request.
    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('category', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};
