const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');

exports.getProductReviews = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
    const skip = (page - 1) * limit;
    const filter = { product: req.params.productId };

    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .populate('user', 'name avatar')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Review.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: reviews,
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

exports.createReview = async (req, res, next) => {
  try {
    const { rating, title, comment } = req.body;
    const { productId } = req.params;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
      });
    }

    // Only the publish flag decides whether this product can be reviewed; loading
    // the whole document to read one boolean also pulled the specifications Map
    // and every image URL over the wire.
    const product = await Product.findById(productId)
      .select('isActive')
      .lean();
    if (!product || !product.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Existence check only, so a projection keeps it off the rest of the order.
    const hasDeliveredOrder = await Order.findOne({
      user: req.user._id,
      orderStatus: 'delivered',
      'items.product': productId,
    })
      .select('_id')
      .lean();

    if (!hasDeliveredOrder) {
      return res.status(403).json({
        success: false,
        message: 'You can only review products you have purchased and received',
      });
    }

    // Existence check only - `_id` is enough to answer it, and this keeps the
    // uniqueness guarantee enforced by the `{ product, user }` compound index
    // from needing a full document round trip first.
    const existingReview = await Review.findOne({
      user: req.user._id,
      product: productId,
    })
      .select('_id')
      .lean();

    if (existingReview) {
      return res.status(409).json({
        success: false,
        message: 'You have already reviewed this product',
      });
    }

    const review = await Review.create({
      user: req.user._id,
      product: productId,
      rating: Number(rating),
      title: title || '',
      comment: comment || '',
    });

    await updateProductRating(productId);

    res.status(201).json({
      success: true,
      message: 'Review submitted',
      data: review,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateReview = async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
      });
    }

    if (review.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this review',
      });
    }

    const { rating, title, comment } = req.body;
    if (rating) review.rating = Number(rating);
    if (title !== undefined) review.title = title;
    if (comment !== undefined) review.comment = comment;

    await review.save();
    await updateProductRating(review.product);

    res.json({
      success: true,
      message: 'Review updated',
      data: review,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteReview = async (req, res, next) => {
  try {
    // Read-only, and only `user` and `product` are consulted before the delete -
    // so the row never has to be hydrated. The authorization check still happens
    // BEFORE the delete, never after it.
    const review = await Review.findById(req.params.id)
      .select('user product')
      .lean();

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
      });
    }

    if (
      review.user.toString() !== req.user._id.toString() &&
      req.user.role !== 'admin'
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this review',
      });
    }

    const productId = review.product;
    await Review.findByIdAndDelete(req.params.id);
    await updateProductRating(productId);

    res.json({
      success: true,
      message: 'Review deleted',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Recomputes a product's `rating` / `numReviews` from its reviews.
 *
 * `Review.aggregate()` runs raw BSON, so unlike `find()` it does NOT cast the
 * incoming `productId`. Passing a string therefore matched zero documents and
 * the old `else` branch then wrote `rating: 0` over the product, permanently
 * zeroing every rating. The id is cast explicitly here, and a missing product
 * is a hard no-op rather than a reason to zero anything out.
 */
async function updateProductRating(productId) {
  let objectId;
  try {
    objectId = new mongoose.Types.ObjectId(String(productId));
  } catch {
    return { rating: null, numReviews: null };
  }

  const product = await Product.findById(objectId).select('_id').lean();
  if (!product) {
    return { rating: null, numReviews: null };
  }

  const stats = await Review.aggregate([
    { $match: { product: objectId } },
    {
      $group: {
        _id: '$product',
        averageRating: { $avg: '$rating' },
        numReviews: { $sum: 1 },
      },
    },
  ]);

  const numReviews = stats.length > 0 ? stats[0].numReviews : 0;
  const rating =
    numReviews > 0
      ? Math.round((stats[0].averageRating + Number.EPSILON) * 10) / 10
      : 0;

  await Product.findByIdAndUpdate(objectId, { rating, numReviews });

  return { rating, numReviews };
}
