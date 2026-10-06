const Cart = require('../models/Cart');
const Product = require('../models/Product');

/**
 * The product shape a cart line exposes. Every cart read populates exactly this,
 * so it lives in one place rather than being repeated per call site.
 */
const CART_PRODUCT_FIELDS =
  'name slug price mrp discount stock images isActive condition';

const readCart = (userId) =>
  Cart.findOne({ user: userId }).populate('items.product', CART_PRODUCT_FIELDS);

exports.getCart = async (req, res, next) => {
  try {
    let cart = await readCart(req.user._id).lean();

    if (!cart) {
      cart = await Cart.create({ user: req.user._id, items: [] });
    }

    const validItems = cart.items.filter(
      (item) => item.product && item.product.isActive
    );

    if (validItems.length !== cart.items.length) {
      /**
       * The prune is the rare path, and it has to go through a real document:
       * `Cart` recomputes `totalPrice` in a `pre('save')` hook, which
       * `findByIdAndUpdate` / `updateOne` would bypass and leave the stored total
       * disagreeing with the items. So the full document is loaded, saved, and the
       * lean projection is simply re-read.
       */
      const doc = await Cart.findById(cart._id);
      doc.items = validItems;
      await doc.save();

      cart = await readCart(req.user._id).lean();
    }

    res.json({
      success: true,
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};

exports.addToCart = async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;
    const qty = parseInt(quantity, 10) || 1;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required',
      });
    }

    // Only the three fields the stock check and the stored cart price need.
    // The previous full read also pulled the description, the specifications Map
    // and every image URL for a product the request never looks at.
    const product = await Product.findById(productId)
      .select('isActive stock price')
      .lean();

    if (!product || !product.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    if (product.stock < qty) {
      return res.status(400).json({
        success: false,
        message: `Only ${product.stock} items available in stock`,
      });
    }

    let cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      cart = new Cart({ user: req.user._id, items: [] });
    }

    const existingIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId
    );

    if (existingIndex >= 0) {
      const newQty = cart.items[existingIndex].quantity + qty;
      if (newQty > product.stock) {
        return res.status(400).json({
          success: false,
          message: `Only ${product.stock} items available in stock`,
        });
      }
      cart.items[existingIndex].quantity = newQty;
      cart.items[existingIndex].price = product.price;
    } else {
      cart.items.push({
        product: productId,
        quantity: qty,
        price: product.price,
      });
    }

    await cart.save();

    // The document just written is already in hand, so populating it in place
    // replaces a second full read of the cart that produced the same thing.
    await cart.populate('items.product', CART_PRODUCT_FIELDS);

    res.json({
      success: true,
      message: 'Item added to cart',
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateCartItem = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { quantity } = req.body;
    const qty = parseInt(quantity, 10);

    if (!qty || qty < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid quantity is required',
      });
    }

    const product = await Product.findById(productId)
      .select('isActive stock price')
      .lean();

    if (!product || !product.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    if (qty > product.stock) {
      return res.status(400).json({
        success: false,
        message: `Only ${product.stock} items available in stock`,
      });
    }

    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found',
      });
    }

    const itemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId
    );

    if (itemIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Item not in cart',
      });
    }

    cart.items[itemIndex].quantity = qty;
    cart.items[itemIndex].price = product.price;
    await cart.save();

    await cart.populate('items.product', CART_PRODUCT_FIELDS);

    res.json({
      success: true,
      message: 'Cart updated',
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};

exports.removeCartItem = async (req, res, next) => {
  try {
    const { productId } = req.params;

    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found',
      });
    }

    const itemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId
    );

    if (itemIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Item not in cart',
      });
    }

    cart.items.splice(itemIndex, 1);
    await cart.save();

    await cart.populate('items.product', CART_PRODUCT_FIELDS);

    res.json({
      success: true,
      message: 'Item removed from cart',
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};

exports.clearCart = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found',
      });
    }

    cart.items = [];
    await cart.save();

    res.json({
      success: true,
      message: 'Cart cleared',
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};
