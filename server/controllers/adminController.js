const User = require('../models/User');
const { USER_PUBLIC_FIELDS } = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { ORDER_PUBLIC_FIELDS } = require('../models/Order');
const Category = require('../models/Category');
const Settings = require('../models/Settings');
const emailService = require('../services/emailService');
const stockService = require('../services/stockService');
const { getSettings } = require('./settingsController');
const { assertSafeQuery } = require('../utils/safeQuery');
const { escapeRegex } = require('../utils/safeRegex');
const cache = require('../utils/simpleCache');

/**
 * Order states the admin list may be filtered by. Hard-coded rather than derived
 * from the request so a crafted value can never become a Mongo filter
 * (audit finding F-01).
 */
const ADMIN_ORDER_STATUSES = new Set([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);

/**
 * How long the dashboard's *aggregate* rows are reused.
 *
 * 20 seconds - the shortest-lived cache in the application, and deliberately so.
 * The dashboard is the most expensive read in the codebase: it aggregates over
 * the whole `orders` collection and, for admins, `$unwind`s every line item of
 * every order to build the top-products list. Admin traffic is low-volume, so a
 * brief reuse of those aggregates is worth a lot and costs almost nothing in
 * staleness.
 *
 * What is cached, and what deliberately is not:
 *
 *   CACHED   the count/sum/revenue aggregates and `topProducts`. These are global,
 *            identical for every admin, contain no customer data, and are the
 *            expensive part. Keyed by role because staff do not get the revenue
 *            fields at all.
 *
 *   NOT cached
 *            `recentOrders` - it carries customer name and email. Customer PII has
 *            no business sitting in a process-wide cache where it outlives the
 *            request that fetched it, even for 20 seconds. It is one indexed
 *            `find` limited to 5 rows, so it is cheap enough to always run fresh.
 *            `lowStockProducts` - it is a live stock reading, and a stale "low
 *            stock" warning is the kind of wrong that gets acted on.
 *
 * The role flag is applied to the response, not stored in the cache, so one entry
 * can never leak the revenue fields to staff.
 */
const DASHBOARD_CACHE_TTL_MS = 20 * 1000;

exports.getDashboard = async (req, res, next) => {
  try {
    const isStaff = req.user.role === 'staff';
    const cacheKey = `admin:dashboard:aggregates:${isStaff ? 'staff' : 'admin'}`;

    const cachedAggregates = await cache.get(cacheKey);

    /**
     * The dashboard used to issue nine separate `countDocuments()` calls - four
     * against `products` and three against `orders` - each a full round trip and,
     * for the unconditional ones, a full collection scan. Each collection's counts
     * are now derived from ONE aggregation pass that visits each document once and
     * evaluates every predicate as a conditional sum, so the same numbers come out
     * of 2 queries instead of 7. The arithmetic is identical: `$sum` of a constant
     * 1 counts matching documents exactly as `countDocuments` does.
     */
    const [cachedOrProductStats, orderStats, lowStockProducts, recentOrders] =
      await Promise.all([
        cachedAggregates ? Promise.resolve(cachedAggregates.productStats) : Product.aggregate([
          {
            $group: {
              _id: null,
              totalProducts: { $sum: 1 },
              activeProducts: {
                $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] },
              },
              outOfStockCount: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$isActive', true] }, { $eq: ['$stock', 0] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
        cachedAggregates ? Promise.resolve(cachedAggregates.orderStats) : Order.aggregate([
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              pendingOrders: {
                $sum: { $cond: [{ $eq: ['$orderStatus', 'pending'] }, 1, 0] },
              },
              processingOrders: {
                $sum: {
                  $cond: [{ $eq: ['$orderStatus', 'processing'] }, 1, 0],
                },
              },
              deliveredOrders: {
                $sum: {
                  $cond: [{ $eq: ['$orderStatus', 'delivered'] }, 1, 0],
                },
              },
            },
          },
        ]),
        Product.find({ isActive: true, stock: { $gt: 0, $lte: 5 } })
          .select('name stock price')
          .sort({ stock: 1 })
          .limit(10)
          .lean(),
        // Dashboard summary row only. The panel renders order number, customer,
        // date, amount and status, so the line items, shipping address and status
        // timeline each of these orders carries are fetched and discarded.
        Order.find()
          .select('orderNumber orderStatus totalAmount paymentStatus createdAt')
          .populate('user', 'name email')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean(),
      ]);

    const productRow = cachedOrProductStats[0] || {};
    const orderRow = orderStats[0] || {};

    const data = {
      isStaff,
      totalProducts: productRow.totalProducts || 0,
      activeProducts: productRow.activeProducts || 0,
      totalOrders: orderRow.totalOrders || 0,
      pendingOrders: orderRow.pendingOrders || 0,
      processingOrders: orderRow.processingOrders || 0,
      deliveredOrders: orderRow.deliveredOrders || 0,
      lowStockProducts,
      outOfStockCount: productRow.outOfStockCount || 0,
      recentOrders,
    };

    // Declared out here rather than inside the `if` so the cache write below can
    // see them; staff never populate them and never cache them.
    let adminAggregates = null;

    if (!isStaff) {
      /**
       * The two revenue aggregates both match on the same non-cancelled orders,
       * so they are started together, and the product-name lookup that follows
       * depends only on `topProducts` - not on the counts.
       */
      const [totalUsers, salesData, topProducts] = await Promise.all([
        cachedAggregates
          ? Promise.resolve(cachedAggregates.totalUsers)
          : User.countDocuments({ role: { $ne: 'admin' } }),
        cachedAggregates
          ? Promise.resolve(cachedAggregates.salesData)
          : Order.aggregate([
              { $match: { orderStatus: { $ne: 'cancelled' } } },
              { $group: { _id: null, total: { $sum: '$totalAmount' } } },
            ]),
        cachedAggregates
          ? Promise.resolve(cachedAggregates.topProducts)
          : Order.aggregate([
              { $match: { orderStatus: { $ne: 'cancelled' } } },
              { $unwind: '$items' },
              {
                $group: {
                  _id: '$items.product',
                  unitsSold: { $sum: '$items.quantity' },
                  revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } },
                },
              },
              { $sort: { unitsSold: -1 } },
              { $limit: 5 },
            ]),
      ]);

      data.totalUsers = totalUsers;
      data.totalSales = salesData.length > 0 ? salesData[0].total : 0;
      adminAggregates = { totalUsers, salesData, topProducts };

      const topProductIds = topProducts.map((p) => p._id);
      const productDocs = await Product.find({
        _id: { $in: topProductIds },
      })
        .select('name price images')
        .lean();
      const productMap = new Map(productDocs.map((p) => [p._id.toString(), p]));

      data.topProducts = topProducts
        .map((p) => {
          const doc = productMap.get(p._id.toString());
          if (!doc) return null;
          return {
            _id: doc._id,
            name: doc.name,
            price: doc.price,
            image: doc.images && doc.images.length > 0 ? doc.images[0].url : '',
            unitsSold: p.unitsSold,
            revenue: Math.round(p.revenue * 100) / 100,
          };
        })
        .filter(Boolean);
    }

    // Cache the aggregates only. `lowStockProducts` and `recentOrders` are
    // deliberately left out of both the write and the key.
    if (!cachedAggregates) {
      await cache.set(
        cacheKey,
        {
          productStats: cachedOrProductStats,
          orderStats,
          // `topProducts` is cached in its aggregate shape (`_id` + unitsSold +
          // revenue). The product-name join still runs on every request, so the
          // cache never holds a stale product name or price.
          ...(adminAggregates || {}),
        },
        DASHBOARD_CACHE_TTL_MS
      );
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

exports.getUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.search) {
      assertSafeQuery(req.query);
      // Audit finding F-08: escaped literal match. `?search=[` used to throw a
      // SyntaxError inside the handler and return 500 with the internal regex
      // error text; it now matches a literal "[".
      const regex = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    /**
     * `USER_PUBLIC_FIELDS` replaces an unrestricted `User.find()` here. It lists
     * exactly what that query already returned - every field except the ones the
     * schema hides with `select: false` (password hash, OTP material, reset
     * token) - so the response is unchanged, but the row is smaller, nothing is
     * hydrated, and no secret can reach a response by accident.
     */
    const [users, total] = await Promise.all([
      User.find(query)
        .select(USER_PUBLIC_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: users,
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

exports.getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select(USER_PUBLIC_FIELDS)
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // The panel shows only the order number, status, amount and date, so the
    // line items, address and timeline are not fetched.
    const orders = await Order.find({ user: req.params.id })
      .select('orderNumber orderStatus totalAmount paymentStatus createdAt')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    res.json({
      success: true,
      data: { user, orders },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateUserStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean',
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user.role === 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Cannot change admin status',
      });
    }

    user.isActive = isActive;
    // Audit finding F-03: suspending or reinstating an account is a security
    // decision, so any session that is already open for it must stop working.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'}`,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user.role === 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete admin',
      });
    }

    user.isActive = false;
    await user.save();

    res.json({
      success: true,
      message: 'User deactivated',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Best-effort removal of a product's uploaded images.
 *
 * Runs before the database row is deleted so only ids that actually belonged to
 * this product are destroyed, and never blocks or fails the deletion itself -
 * an orphaned image is recoverable, a half-deleted product is not. Failures are
 * logged by product id only, so no credential or payload ever reaches the logs.
 */
async function deleteProductImages(product) {
  try {
    const { cloudinary } = require('../config/cloudinary');
    const fs = require('fs');
    const path = require('path');

    // These are independent HTTP calls to Cloudinary, and they used to be
    // awaited one at a time inside the loop - so a product with 8 images took 8
    // sequential round trips before the row could be deleted. `allSettled` issues
    // them together and still reports every individual outcome, which preserves
    // the two properties this function depends on: one image failing never stops
    // the others, and the delete is never blocked by a cleanup error.
    const cloudinaryIds = (product.images || [])
      .filter((image) => image?.publicId)
      .map((image) => image.publicId);

    const results = await Promise.allSettled(
      cloudinaryIds.map((publicId) => cloudinary.uploader.destroy(publicId))
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(
          `[product-images] cloudinary cleanup failed for product ${product._id}: ${result.reason?.message}`
        );
      }
    });

    // Legacy local-disk uploads. Untouched by the memory-storage change above:
    // these predate it, so the files really are on disk and still need removing.
    for (const image of product.images || []) {
      if (image?.url && image.url.includes('/uploads/')) {
        const filename = path.basename(image.url);
        const filePath = path.join(__dirname, '..', 'uploads', filename);
        try {
          fs.unlink(filePath, () => {});
        } catch {
          // Already gone, or nothing was ever written there.
        }
      }
    }
  } catch (error) {
    console.warn(
      `[product-images] image cleanup failed for product ${product._id}: ${error.message}`
    );
  }
}

exports.permanentDeleteProduct = async (req, res, next) => {
  try {
    // Only `images` is read, and only so the orphaned Cloudinary assets can be
    // cleaned up before the row goes. The existence check still runs first, so a
    // missing product is still a 404 and nothing is deleted.
    const product = await Product.findById(req.params.id)
      .select('images')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    await deleteProductImages(product);

    await Product.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Product permanently deleted',
    });
  } catch (error) {
    next(error);
  }
};

exports.getAdminOrders = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
    const skip = (page - 1) * limit;

    // Audit finding F-01: `?status[$ne]=delivered` used to reach MongoDB as
    // `{ orderStatus: { $ne: 'delivered' } }`. Operator-shaped parameters are now
    // rejected, and the status filter comes from a fixed allow-list.
    assertSafeQuery(req.query);

    const query = {};
    if (ADMIN_ORDER_STATUSES.has(req.query.status)) {
      query.orderStatus = req.query.status;
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .select(ORDER_PUBLIC_FIELDS)
        .populate('user', 'name email phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: orders,
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

exports.getAdminOrderById = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .select(ORDER_PUBLIC_FIELDS)
      .populate('user', 'name email phone')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { orderStatus, note } = req.body;

    const validStatuses = [
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'out_for_delivery',
      'delivered',
      'cancelled',
    ];

    if (!orderStatus || !validStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Valid order status is required',
      });
    }

    const order = await Order.findById(req.params.id).populate(
      'user',
      'name email'
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update cancelled order',
      });
    }

    if (order.orderStatus === 'delivered' && orderStatus !== 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update delivered order',
      });
    }

    if (orderStatus === 'cancelled') {
      if (order.paymentMethod === 'online') {
        // Online orders reserve stock through stockService, so releasing via the
        // same helper keeps the restore exactly-once. A webhook may already
        // have released it, and the guard prevents a double increment.
        await stockService.releaseStock(order);
      } else {
        /**
         * COD keeps its original restore behaviour untouched.
         *
         * These were `await`ed one at a time inside a loop, so an order with n
         * lines cost n sequential database round trips. `bulkWrite` issues the
         * same per-document `$inc`/`$set` in one call. Each document update is
         * still individually atomic - which is the only property this relies on,
         * since the lines are independent products - and `ordered: false` only
         * says a failure in one line must not stop the others, which the loop
         * never intended anyway.
         */
        await Product.bulkWrite(
          order.items.map((item) => ({
            updateOne: {
              filter: { _id: item.product },
              update: {
                $inc: { stock: item.quantity },
                $set: { isActive: true },
              },
            },
          })),
          { ordered: false }
        );
      }
    }

    const previousStatus = order.orderStatus;

    order.orderStatus = orderStatus;
    order.timeline.push({
      status: orderStatus,
      date: new Date(),
      note: note || '',
    });

    if (orderStatus === 'delivered' && order.paymentMethod === 'cod') {
      order.paymentStatus = 'cod';
    }

    await order.save();

    const statusMessages = {
      confirmed: 'Your order has been confirmed',
      processing: 'Your order is being processed',
      shipped: 'Your order has been shipped',
      out_for_delivery: 'Your order is out for delivery',
      delivered: 'Your order has been delivered',
      cancelled: 'Your order has been cancelled',
    };

    if (
      statusMessages[orderStatus] &&
      previousStatus !== orderStatus
    ) {
      try {
        await emailService.sendOrderStatusEmail({
          to: order.user.email,
          customerName: order.user.name,
          orderNumber: order.orderNumber,
          status: orderStatus,
          message: statusMessages[orderStatus],
        });
      } catch (error) {
        console.error('Order status email failed:', error.message);
      }
    }

    res.json({
      success: true,
      message: `Order status updated to ${orderStatus}`,
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

exports.getCategories = async (req, res, next) => {
  try {
    const categories = await Category.find().sort({ name: 1 }).lean();
    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const allowed = [
      'freeDeliveryThreshold',
      'deliveryFee',
      'gstPercentage',
      'contactEmail',
      'contactPhone',
      'storeName',
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (
      updates.freeDeliveryThreshold !== undefined &&
      (Number(updates.freeDeliveryThreshold) < 0 ||
        Number.isNaN(Number(updates.freeDeliveryThreshold)))
    ) {
      return res.status(400).json({
        success: false,
        message: 'freeDeliveryThreshold must be a valid number',
      });
    }
    if (
      updates.deliveryFee !== undefined &&
      (Number(updates.deliveryFee) < 0 ||
        Number.isNaN(Number(updates.deliveryFee)))
    ) {
      return res.status(400).json({
        success: false,
        message: 'deliveryFee must be a valid number',
      });
    }
    if (
      updates.gstPercentage !== undefined &&
      (Number(updates.gstPercentage) < 0 ||
        Number(updates.gstPercentage) > 100 ||
        Number.isNaN(Number(updates.gstPercentage)))
    ) {
      return res.status(400).json({
        success: false,
        message: 'gstPercentage must be between 0 and 100',
      });
    }

    const existing = await Settings.findOne();
    let settings;
    if (existing) {
      settings = await Settings.findOneAndUpdate(
        {},
        { ...updates, updatedBy: req.user._id },
        { new: true, runValidators: true }
      );
    } else {
      settings = await Settings.create({ ...updates, updatedBy: req.user._id });
    }

    res.json({
      success: true,
      message: 'Settings updated',
      data: settings,
    });
  } catch (error) {
    next(error);
  }
};
