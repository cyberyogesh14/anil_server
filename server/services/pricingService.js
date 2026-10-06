const Cart = require('../models/Cart');
const Product = require('../models/Product');
const { getSettings } = require('../controllers/settingsController');
const ApiError = require('./ApiError');

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * The product fields order building reads, and nothing else.
 *
 * A cart line only ever needs the id, the display name, the two prices, the
 * on-hand stock and the first image. Loading the full document also pulled the
 * description, the specifications Map and every image URL over the wire.
 */
const PRICING_PRODUCT_FIELDS =
  '_id name sku price mrp stock isActive images';

/**
 * Rebuilds the order lines and totals straight from MongoDB. The cart rows
 * stored on the client are never trusted - only product ids and quantities are
 * read from the cart, and price/mrp/stock always come from the Product
 * collection.
 */
const buildOrderFromCart = async ({ userId, cart: providedCart } = {}) => {
  /**
   * The cart is read WITHOUT `populate('items.product')`.
   *
   * It used to populate every line's product and then, a few lines later, fetch
   * the very same products again with `Product.find({ _id: { $in: productIds } })`
   * to read their prices from. That was two round trips and two full copies of
   * every product in the cart, and the populated copy was only ever consulted for
   * a product's name in one error message. One narrow query now serves both.
   */
  const cart = providedCart || (await Cart.findOne({ user: userId }));

  if (!cart || !cart.items || cart.items.length === 0) {
    throw new ApiError(400, 'Cart is empty');
  }

  const productIds = cart.items.map((item) => item.product?._id || item.product);
  const products = await Product.find({ _id: { $in: productIds } })
    .select(PRICING_PRODUCT_FIELDS)
    .lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const orderItems = [];
  const cartLines = [];
  let subtotal = 0;
  let totalDiscount = 0;

  for (const item of cart.items) {
    const productId = String(item.product?._id || item.product || '');
    const product = productMap.get(productId);
    const quantity = Number(item.quantity) || 0;

    if (!product || !product.isActive) {
      /**
       * `product` is present whenever the row exists, so a deactivated product
       * still reports its real name. Only a product whose row no longer exists
       * has nothing to name, and it falls back to the same placeholder as before.
       */
      const name = product?.name || item.product?.name || 'Unknown';
      throw new ApiError(400, `Product ${name} is no longer available`);
    }

    if (quantity < 1) {
      throw new ApiError(400, `Invalid quantity for ${product.name}`);
    }

    if (product.stock < quantity) {
      throw new ApiError(
        400,
        `Insufficient stock for ${product.name}. Available: ${product.stock}`
      );
    }

    const itemDiscount = (product.mrp - product.price) * quantity;

    subtotal += product.mrp * quantity;
    totalDiscount += itemDiscount;

    orderItems.push({
      product: product._id,
      name: product.name,
      sku: product.sku,
      quantity,
      price: product.price,
      image:
        product.images && product.images.length > 0 ? product.images[0].url : '',
      // Records the CAUSE of a hidden product, not a copy of its state: true only
      // when this very line is what takes the stock to zero and auto-deactivates the
      // product (finding F-07). A cancellation may then safely bring it back, whereas
      // a product an admin unpublished must stay unpublished.
      deactivatedByStockOut: product.stock - quantity <= 0,
    });

    // Keeps the pre-decrement stock so the caller can preserve the original
    // "deactivate when the last unit sells" behaviour.
    cartLines.push({
      product: product._id,
      quantity,
      availableStock: product.stock,
      isActive: product.isActive,
    });
  }

  const settings = await getSettings();
  const freeDeliveryThreshold = Number(settings.freeDeliveryThreshold) || 999;
  const deliveryFee = Number(settings.deliveryFee) || 0;
  const gstPercentage = Number(settings.gstPercentage) || 0;

  const shippingFee = subtotal >= freeDeliveryThreshold ? 0 : deliveryFee;
  // Matches the existing COD formula exactly so both paths always agree.
  const gstAmount = Math.round((subtotal - totalDiscount) * gstPercentage) / 100;
  const totalAmount = round2(subtotal - totalDiscount + shippingFee + gstAmount);

  return {
    cart,
    orderItems,
    cartLines,
    totals: {
      subtotal: round2(subtotal - totalDiscount),
      grossSubtotal: round2(subtotal),
      discount: round2(totalDiscount),
      shippingFee: round2(shippingFee),
      gstAmount: round2(gstAmount),
      totalAmount,
    },
  };
};

/** Stable fingerprint used to detect that a cart is unchanged on retry. */
const cartFingerprint = (orderItems, totalAmount) => {
  const signature = orderItems
    .map((item) => `${item.product}:${item.quantity}`)
    .sort()
    .join('|');

  return `${signature}::${round2(totalAmount)}`;
};

const normaliseAddress = (shippingAddress = {}) => ({
  fullName: String(shippingAddress.fullName || '').trim(),
  phone: String(shippingAddress.phone || '').trim(),
  addressLine1: String(shippingAddress.addressLine1 || '').trim(),
  addressLine2: String(shippingAddress.addressLine2 || '').trim(),
  city: String(shippingAddress.city || '').trim(),
  state: String(shippingAddress.state || '').trim(),
  pincode: String(shippingAddress.pincode || '').trim(),
  country: String(shippingAddress.country || 'India').trim() || 'India',
});

const validateAddress = (address) => {
  const required = [
    'fullName',
    'phone',
    'addressLine1',
    'city',
    'state',
    'pincode',
  ];
  const missing = required.filter((field) => !address[field]);

  if (missing.length) {
    throw new ApiError(400, 'Complete shipping address is required');
  }

  if (!/^\d{10}$/.test(address.phone)) {
    throw new ApiError(400, 'Enter a valid 10-digit phone number');
  }

  if (!/^\d{6}$/.test(address.pincode)) {
    throw new ApiError(400, 'Enter a valid 6-digit pincode');
  }
};

module.exports = {
  buildOrderFromCart,
  cartFingerprint,
  normaliseAddress,
  validateAddress,
  round2,
  ApiError,
};
