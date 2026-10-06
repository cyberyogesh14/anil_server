const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');

/** The product shape a wishlist entry exposes. */
const WISHLIST_PRODUCT_FIELDS =
  'name slug price mrp discount stock images isActive condition';

exports.getWishlist = async (req, res, next) => {
  try {
    const wishlist = await Wishlist.find({ user: req.user._id })
      .populate('product', WISHLIST_PRODUCT_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    const validItems = wishlist.filter(
      (item) => item.product && item.product.isActive
    );

    res.json({
      success: true,
      data: validItems,
    });
  } catch (error) {
    next(error);
  }
};

exports.addToWishlist = async (req, res, next) => {
  try {
    const { productId } = req.params;

    // Only the publish flag is consulted, so only that is fetched.
    const product = await Product.findById(productId)
      .select('isActive')
      .lean();
    if (!product || !product.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Existence check only - a projection keeps a whole wishlist row off the wire
    // to answer a yes/no question.
    const existing = await Wishlist.findOne({
      user: req.user._id,
      product: productId,
    })
      .select('_id')
      .lean();

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Product already in wishlist',
      });
    }

    const item = await Wishlist.create({
      user: req.user._id,
      product: productId,
    });

    res.status(201).json({
      success: true,
      message: 'Added to wishlist',
      data: item,
    });
  } catch (error) {
    next(error);
  }
};

exports.removeFromWishlist = async (req, res, next) => {
  try {
    const { productId } = req.params;

    const item = await Wishlist.findOneAndDelete({
      user: req.user._id,
      product: productId,
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not in wishlist',
      });
    }

    res.json({
      success: true,
      message: 'Removed from wishlist',
    });
  } catch (error) {
    next(error);
  }
};
