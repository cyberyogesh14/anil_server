const crypto = require('crypto');
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const User = require('../models/User');
const shiprocket = require('./shiprocket.service');
const ApiError = require('./ApiError');
const { ORDER_PUBLIC_FIELDS } = require('../models/Order');

const {
  SHIPROCKET_PICKUP_LOCATION,
  SHIPROCKET_PICKUP_PINCODE,
  SHIPROCKET_DEFAULT_WEIGHT_KG,
  SHIPROCKET_DEFAULT_LENGTH_CM,
  SHIPROCKET_DEFAULT_BREADTH_CM,
  SHIPROCKET_DEFAULT_HEIGHT_CM,
  SHIPROCKET_AUTO_ASSIGN_AWB,
  SHIPROCKET_AUTO_GENERATE_LABEL,
  SHIPROCKET_AUTO_REQUEST_PICKUP,
  SHIPROCKET_CREATE_LOCK_MS,
  isShiprocketConfigured,
  isShiprocketPricingEnabled,
  isShiprocketShipmentReady,
} = require('../config/shiprocket');

const round2 = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampText = (value, max = 255) =>
  String(value === undefined || value === null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

const normalisePincode = (value) => String(value || '').trim();

const isValidPincode = (value) => /^\d{6}$/.test(normalisePincode(value));

const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatShiprocketDate = (date) => {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

const normaliseStatus = (value) =>
  clampText(value, 120).replace(/_/g, ' ').replace(/\s+/g, ' ').toUpperCase();

const statusIncludes = (status, fragments) =>
  fragments.some((fragment) => status.includes(fragment));

const safeErrorMessage = (error) => {
  const message =
    error?.message ||
    error?.response?.data?.message ||
    'Shiprocket request failed';
  return clampText(message, 300);
};

/* ========================================================================== *
 * Package / rate helpers
 * ========================================================================== */

const summarisePackage = (items = []) => {
  let weight = 0;
  let length = 0;
  let breadth = 0;
  let height = 0;
  let usesFallback = false;

  for (const item of items) {
    const quantity = Math.max(1, toNumber(item.quantity, 1));
    const units = quantity;

    const itemWeight = toNumber(item.weight, 0);
    const itemLength = toNumber(item.length, 0);
    const itemBreadth = toNumber(item.breadth, 0);
    const itemHeight = toNumber(item.height, 0);

    if (!itemWeight) usesFallback = true;
    if (!itemLength || !itemBreadth || !itemHeight) usesFallback = true;

    weight += (itemWeight > 0 ? itemWeight : SHIPROCKET_DEFAULT_WEIGHT_KG) * units;
    length = Math.max(length, itemLength > 0 ? itemLength : SHIPROCKET_DEFAULT_LENGTH_CM);
    breadth = Math.max(breadth, itemBreadth > 0 ? itemBreadth : SHIPROCKET_DEFAULT_BREADTH_CM);
    height += (itemHeight > 0 ? itemHeight : SHIPROCKET_DEFAULT_HEIGHT_CM) * units;
  }

  return {
    weight: round2(Math.max(0.01, weight)),
    length: Math.max(1, Math.round(length || SHIPROCKET_DEFAULT_LENGTH_CM)),
    breadth: Math.max(1, Math.round(breadth || SHIPROCKET_DEFAULT_BREADTH_CM)),
    height: Math.max(1, Math.min(200, Math.round(height || SHIPROCKET_DEFAULT_HEIGHT_CM))),
    usesFallback,
  };
};

const extractCouriers = (response) => {
  const data = response?.data || response || {};
  const companies =
    data.available_courier_companies ||
    data.courier_companies ||
    data.available_couriers ||
    [];

  if (!Array.isArray(companies)) return [];

  return companies.map((courier) => ({
    courierCompanyId:
      courier.courier_company_id ?? courier.courier_id ?? null,
    courierName: clampText(courier.courier_name || courier.name || 'Courier', 120),
    rate: round2(toNumber(courier.rate ?? courier.freight_charge, 0)),
    codCharge: round2(toNumber(courier.cod_charges ?? courier.cod_charge, 0)),
    estimatedDeliveryDays: clampText(
      courier.estimated_delivery_days || courier.etd || '',
      40
    ),
    expectedDeliveryDate: parseDate(
      courier.expected_delivery_date || courier.estimated_delivery_date
    ),
    recommended:
      String(courier.courier_company_id) ===
      String(data.recommended_courier_company_id),
  }));
};

const chooseCourier = (couriers, cod) =>
  [...couriers].sort(
    (a, b) =>
      a.rate +
      (cod ? a.codCharge : 0) -
      (b.rate + (cod ? b.codCharge : 0))
  )[0] || null;

const estimateDeliveryDate = (courier) => {
  if (courier?.expectedDeliveryDate) return courier.expectedDeliveryDate;
  const days = String(courier?.estimatedDeliveryDays || '');
  const match = days.match(/(\d+)\s*-\s*(\d+)/) || days.match(/(\d+)/);
  const upper = match ? Number(match[match.length - 1]) : 0;
  if (!upper || upper > 60) return null;
  return new Date(Date.now() + upper * 24 * 60 * 60 * 1000);
};

const resolvePickupPincode = () => {
  if (!SHIPROCKET_PICKUP_PINCODE) {
    throw new ApiError(
      503,
      'Shiprocket pickup pincode is not configured. Set SHIPROCKET_PICKUP_PINCODE.'
    );
  }
  return SHIPROCKET_PICKUP_PINCODE;
};

/**
 * Quotes a live Shiprocket rate. This function NEVER throws: checkout must not
 * be blocked by a carrier outage. Callers get `used: false` and keep the
 * existing Settings-based delivery fee instead.
 */
const quoteShipping = async ({
  deliveryPincode,
  items,
  declaredValue,
  cod = false,
  subtotal = 0,
  freeDeliveryThreshold = 0,
}) => {
  const pincode = normalisePincode(deliveryPincode);

  if (!isShiprocketPricingEnabled()) {
    return { available: false, used: false, reason: 'not_configured' };
  }

  if (!isValidPincode(pincode)) {
    return { available: false, used: false, reason: 'invalid_pincode' };
  }

  if (Number(subtotal) >= Number(freeDeliveryThreshold)) {
    return {
      available: true,
      used: true,
      charge: 0,
      free: true,
      courierName: '',
      courierCompanyId: null,
      estimatedDeliveryDays: '',
      estimatedDeliveryDate: null,
      codCharge: 0,
    };
  }

  const pkg = summarisePackage(items);

  try {
    const response = await shiprocket.checkServiceability({
      pickupPostcode: resolvePickupPincode(),
      deliveryPostcode: pincode,
      weight: pkg.weight,
      cod: Boolean(cod),
      declaredValue: round2(toNumber(declaredValue, 0)),
    });

    const couriers = extractCouriers(response);
    if (!couriers.length) {
      return {
        available: false,
        used: false,
        reason: 'no_serviceable_courier',
        package: pkg,
      };
    }

    const selected = chooseCourier(couriers, Boolean(cod));
    const charge = round2(selected.rate + (cod ? selected.codCharge : 0));

    return {
      available: true,
      used: true,
      free: false,
      charge,
      codCharge: cod ? selected.codCharge : 0,
      courierName: selected.courierName,
      courierCompanyId: selected.courierCompanyId,
      estimatedDeliveryDays: selected.estimatedDeliveryDays,
      estimatedDeliveryDate: estimateDeliveryDate(selected),
      package: pkg,
      couriers,
    };
  } catch (error) {
    return {
      available: false,
      used: false,
      reason: safeErrorMessage(error),
      package: pkg,
    };
  }
};

/**
 * Reads the user's cart straight from MongoDB and builds the package used for a
 * rate quote. Client-supplied weights or prices are never trusted.
 */
const getCartPackage = async (userId) => {
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    throw new ApiError(400, 'Cart is empty');
  }

  const productIds = cart.items.map((item) => item.product?._id || item.product);
  const products = await Product.find({ _id: { $in: productIds } })
    .select('_id name sku price mrp stock isActive weight length breadth height hsnCode')
    .lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  let declaredValue = 0;
  const items = [];

  for (const line of cart.items) {
    const product = productMap.get(String(line.product?._id || line.product));
    if (!product || !product.isActive) {
      throw new ApiError(400, 'An item in your cart is no longer available');
    }
    const quantity = Math.max(1, toNumber(line.quantity, 1));
    declaredValue += toNumber(product.price, 0) * quantity;
    items.push({
      product: product._id,
      name: product.name,
      sku: product.sku,
      quantity,
      price: product.price,
      weight: product.weight,
      length: product.length,
      breadth: product.breadth,
      height: product.height,
      hsnCode: product.hsnCode,
    });
  }

  return {
    items,
    declaredValue: round2(declaredValue),
    package: summarisePackage(items),
  };
};

/* ========================================================================== *
 * Shipment creation
 * ========================================================================== */

const buildShiprocketOrderPayload = (order, user) => {
  const address = order.shippingAddress;
  const pkg = summarisePackage(order.items);

  return {
    order_id: order.orderNumber,
    order_date: formatShiprocketDate(order.createdAt),
    pickup_location: SHIPROCKET_PICKUP_LOCATION,
    channel_id: '',
    comment: clampText(order.notes, 500),
    billing_customer_name: clampText(address.fullName, 100),
    billing_last_name: '',
    billing_address: clampText(
      [address.addressLine1, address.addressLine2].filter(Boolean).join(', '),
      255
    ),
    billing_address_2: '',
    billing_city: clampText(address.city, 100),
    billing_pincode: normalisePincode(address.pincode),
    billing_state: clampText(address.state, 100),
    billing_country: clampText(address.country || 'India', 60),
    billing_email: clampText(user?.email || '', 150),
    billing_phone: clampText(address.phone, 20),
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: clampText(item.name, 200),
      sku: clampText(item.sku || item._id, 100),
      units: Math.max(1, toNumber(item.quantity, 1)),
      selling_price: round2(toNumber(item.price, 0)),
      discount: '',
      tax: '',
      hsn: clampText(item.hsnCode || '', 30),
    })),
    payment_method: order.paymentMethod === 'cod' ? 'COD' : 'Prepaid',
    sub_total: round2(
      order.items.reduce(
        (sum, item) => sum + toNumber(item.price, 0) * Math.max(1, toNumber(item.quantity, 1)),
        0
      )
    ),
    total_discount: round2(toNumber(order.discount, 0)),
    shipping_charges: round2(toNumber(order.shippingFee, 0)),
    giftwrap_charges: 0,
    transaction_charges: 0,
    length: pkg.length,
    breadth: pkg.breadth,
    height: pkg.height,
    weight: pkg.weight,
    invoice_number: order.orderNumber,
    ewaybill_no: '',
    customer_gstin: '',
    order_type: 'Essential',
  };
};

const assertShipmentEligible = (order) => {
  if (!order) throw new ApiError(404, 'Order not found');

  if (order.orderStatus === 'cancelled') {
    throw new ApiError(409, 'Cancelled orders cannot be shipped');
  }

  if (['shipped', 'out_for_delivery', 'delivered'].includes(order.orderStatus)) {
    throw new ApiError(409, 'This order has already been dispatched');
  }

  if (!['confirmed', 'processing'].includes(order.orderStatus)) {
    throw new ApiError(
      409,
      'Only confirmed or processing orders can be shipped'
    );
  }

  // Never dispatch an unpaid prepaid order, no matter what the frontend claimed.
  if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid') {
    throw new ApiError(409, 'This prepaid order has not been paid');
  }
};

/**
 * Atomically claims the right to create a Shiprocket shipment for an order.
 * Returns the claimed order, null when another worker already owns the claim, or
 * the existing order when a shipment id is already present.
 */
const claimShipmentCreation = async (orderId) => {
  const current = await Order.findById(orderId);
  if (!current) throw new ApiError(404, 'Order not found');

  if (current.shipping?.shiprocketOrderId) {
    return { alreadyExists: true, order: current };
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - SHIPROCKET_CREATE_LOCK_MS);

  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      $and: [
        {
          $or: [
            { 'shipping.shiprocketOrderId': { $exists: false } },
            { 'shipping.shiprocketOrderId': null },
            { 'shipping.shiprocketOrderId': '' },
          ],
        },
        {
          $or: [
            { 'shipping.creationState': { $ne: 'creating' } },
            { 'shipping.creationStartedAt': null },
            { 'shipping.creationStartedAt': { $lt: staleBefore } },
          ],
        },
      ],
    },
    {
      $set: {
        'shipping.creationState': 'creating',
        'shipping.creationStartedAt': now,
        'shipping.failureReason': '',
      },
    },
    { new: true }
  );

  if (!claimed) {
    const latest = await Order.findById(orderId);
    if (latest?.shipping?.shiprocketOrderId) {
      return { alreadyExists: true, order: latest };
    }
    return { inProgress: true, order: latest };
  }

  return { claimed: true, order: claimed };
};

const recordShippingError = async (orderId, error) => {
  try {
    await Order.updateOne(
      {
        _id: orderId,
        'shipping.shiprocketOrderId': { $exists: false },
      },
      {
        $set: {
          'shipping.creationState': 'failed',
          'shipping.failureReason': safeErrorMessage(error),
          'shipping.lastErrorAt': new Date(),
        },
      }
    );
  } catch {
    // A bookkeeping failure must never mask the original carrier error.
  }
};

const deriveShiprocketOrderId = (response) =>
  String(
    response?.order_id ??
      response?.orderId ??
      response?.data?.order_id ??
      ''
  );

const deriveShipmentId = (response) =>
  String(
    response?.shipment_id ??
      response?.shipmentId ??
      response?.data?.shipment_id ??
      ''
  );

/**
 * Creates (or returns) the Shiprocket shipment for an order.
 *
 * Idempotent at three levels:
 *   1. an existing `shipping.shiprocketOrderId` short-circuits immediately;
 *   2. an atomic Mongo claim prevents two workers creating at once;
 *   3. a unique sparse index on `shipping.shiprocketOrderId` is the final
 *      database guarantee.
 */
const createShipmentForOrder = async (orderId, options = {}) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }

  if (!isShiprocketShipmentReady()) {
    throw new ApiError(
      503,
      'Shiprocket shipping is not configured. Set SHIPROCKET_PICKUP_LOCATION and API credentials.'
    );
  }

  const initial = await Order.findById(orderId);
  assertShipmentEligible(initial);

  const claim = await claimShipmentCreation(orderId);

  if (claim.alreadyExists) {
    return {
      alreadyExists: true,
      order: claim.order,
      shipping: claim.order.shipping,
    };
  }

  if (claim.inProgress) {
    throw new ApiError(
      409,
      'Shipment creation is already in progress for this order'
    );
  }

  const order = claim.order;
  let createdResponse;

  try {
    const user = await User.findById(order.user).select('name email').lean();
    const payload = buildShiprocketOrderPayload(order, user);
    createdResponse = await shiprocket.createAdhocOrder(payload);

    const shiprocketOrderId = deriveShiprocketOrderId(createdResponse);
    const shipmentId = deriveShipmentId(createdResponse);

    if (!shiprocketOrderId || !shipmentId) {
      throw new ApiError(
        502,
        'Shiprocket did not return an order id and shipment id'
      );
    }

    const courierName = clampText(createdResponse.courier_name || '', 120);
    const courierCompanyId = String(
      createdResponse.courier_company_id || ''
    );

    const $set = {
      'shipping.provider': 'shiprocket',
      'shipping.shiprocketOrderId': shiprocketOrderId,
      'shipping.shipmentId': shipmentId,
      'shipping.shipmentStatus': clampText(
        createdResponse.status || 'NEW',
        60
      ),
      'shipping.shippingMethod':
        order.paymentMethod === 'cod' ? 'cod' : 'prepaid',
      'shipping.shippingCharges': round2(toNumber(order.shippingFee, 0)),
      'shipping.creationState': 'created',
      'shipping.failureReason': '',
      'shipping.lastErrorAt': null,
      'shipping.lastSyncedAt': new Date(),
    };

    if (courierName) $set['shipping.courierName'] = courierName;
    if (courierCompanyId) {
      $set['shipping.courierCompanyId'] = courierCompanyId;
    }
    if (createdResponse.awb_code) {
      $set['shipping.awbCode'] = String(createdResponse.awb_code);
      $set['shipping.trackingUrl'] = buildTrackingUrl(
        createdResponse.awb_code
      );
    }

    await Order.updateOne({ _id: orderId }, { $set });
    await Order.updateOne(
      { _id: orderId },
      {
        $push: {
          timeline: {
            status: order.orderStatus,
            date: new Date(),
            note: `Shiprocket shipment created (${shipmentId})`,
          },
        },
      }
    );
  } catch (error) {
    await recordShippingError(orderId, error);
    if (error instanceof ApiError) throw error;
    const wrapped = new ApiError(
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 502,
      safeErrorMessage(error)
    );
    throw wrapped;
  }

  // The shipment exists now. Courier/label/pickup are best-effort follow-ups:
  // a failure there must not make the caller think creation failed (that would
  // invite a retry and a duplicate shipment).
  const warnings = [];

  if (SHIPROCKET_AUTO_ASSIGN_AWB && !createdResponse.awb_code) {
    try {
      await assignAWBForOrder(orderId);
    } catch (error) {
      warnings.push(`AWB assignment: ${safeErrorMessage(error)}`);
      await recordFollowUpError(orderId, error);
    }
  }

  if (SHIPROCKET_AUTO_GENERATE_LABEL) {
    try {
      const latest = await Order.findById(orderId).select('shipping').lean();
      if (latest?.shipping?.shipmentId && !latest.shipping.labelUrl) {
        await generateLabelForOrder(orderId);
      }
    } catch (error) {
      warnings.push(`Label generation: ${safeErrorMessage(error)}`);
      await recordFollowUpError(orderId, error);
    }
  }

  if (SHIPROCKET_AUTO_REQUEST_PICKUP) {
    try {
      const latest = await Order.findById(orderId).select('shipping').lean();
      if (latest?.shipping?.awbCode && !latest.shipping.pickupScheduledDate) {
        await requestPickupForOrder(orderId);
      }
    } catch (error) {
      warnings.push(`Pickup request: ${safeErrorMessage(error)}`);
      await recordFollowUpError(orderId, error);
    }
  }

  const finalOrder = await Order.findById(orderId);

  return {
    created: true,
    order: finalOrder,
    shipping: finalOrder.shipping,
    warnings,
  };
};

const recordFollowUpError = async (orderId, error) => {
  try {
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          'shipping.failureReason': safeErrorMessage(error),
          'shipping.lastErrorAt': new Date(),
        },
      }
    );
  } catch {
    // ignore
  }
};

const buildTrackingUrl = (awbCode) =>
  awbCode ? `https://shiprocket.co/tracking/${encodeURIComponent(awbCode)}` : '';

/* ========================================================================== *
 * AWB / label / manifest / pickup
 * ========================================================================== */

const loadShipmentOrder = async (orderId) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }
  const order = await Order.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  if (!order.shipping?.shipmentId) {
    throw new ApiError(409, 'Create the Shiprocket shipment first');
  }
  return order;
};

const assignAWBForOrder = async (orderId, { courierId } = {}) => {
  const order = await loadShipmentOrder(orderId);

  if (order.shipping.awbCode) {
    return { alreadyExists: true, shipping: order.shipping };
  }

  const response = await shiprocket.assignAWB({
    shipmentId: order.shipping.shipmentId,
    courierId: courierId || order.shipping.courierCompanyId || undefined,
  });

  const data = response?.response?.data || response?.data || response || {};
  const awbCode = String(data.awb_code || response?.awb_code || '');
  const courierName = clampText(
    data.courier_name || response?.courier_name || order.shipping.courierName,
    120
  );
  const courierCompanyId = String(
    data.courier_company_id || response?.courier_company_id || ''
  );

  if (!awbCode) {
    throw new ApiError(502, 'Shiprocket did not return an AWB code');
  }

  const $set = {
    'shipping.awbCode': awbCode,
    'shipping.trackingUrl': buildTrackingUrl(awbCode),
    'shipping.shipmentStatus': 'AWB ASSIGNED',
    'shipping.lastSyncedAt': new Date(),
  };
  if (courierName) $set['shipping.courierName'] = courierName;
  if (courierCompanyId) {
    $set['shipping.courierCompanyId'] = courierCompanyId;
  }

  const pickupDate = parseDate(data.pickup_scheduled_date);
  if (pickupDate) $set['shipping.pickupScheduledDate'] = pickupDate;

  await Order.updateOne({ _id: orderId }, { $set });
  await Order.updateOne(
    { _id: orderId },
    {
      $push: {
        timeline: {
          status: order.orderStatus,
          date: new Date(),
          note: `AWB ${awbCode} assigned${courierName ? ` (${courierName})` : ''}`,
        },
      },
    }
  );

  const updated = await Order.findById(orderId);
  return { shipping: updated.shipping };
};

const extractUrl = (response, keys = ['label_url', 'manifest_url']) => {
  const data = response?.response || response?.data || response || {};
  for (const key of keys) {
    if (data[key]) return String(data[key]);
    if (response?.[key]) return String(response[key]);
  }
  return '';
};

const generateLabelForOrder = async (orderId) => {
  const order = await loadShipmentOrder(orderId);

  if (order.shipping.labelUrl) {
    return { alreadyExists: true, labelUrl: order.shipping.labelUrl };
  }

  const response = await shiprocket.generateLabel({
    shipmentIds: [Number(order.shipping.shipmentId) || order.shipping.shipmentId],
  });
  const labelUrl = extractUrl(response, ['label_url']);

  if (!labelUrl) {
    throw new ApiError(502, 'Shiprocket did not return a label URL');
  }

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        'shipping.labelUrl': labelUrl,
        'shipping.labelGeneratedAt': new Date(),
        'shipping.lastSyncedAt': new Date(),
      },
    }
  );

  const updated = await Order.findById(orderId);
  return { labelUrl, shipping: updated.shipping };
};

const generateManifestForOrder = async (orderId) => {
  const order = await loadShipmentOrder(orderId);

  if (order.shipping.manifestUrl) {
    return { alreadyExists: true, manifestUrl: order.shipping.manifestUrl };
  }

  const response = await shiprocket.generateManifest({
    shipmentIds: [Number(order.shipping.shipmentId) || order.shipping.shipmentId],
  });
  const manifestUrl = extractUrl(response, [
    'manifest_url',
    'url',
    'print_url',
  ]);

  if (!manifestUrl) {
    throw new ApiError(502, 'Shiprocket did not return a manifest URL');
  }

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        'shipping.manifestUrl': manifestUrl,
        'shipping.manifestGeneratedAt': new Date(),
        'shipping.lastSyncedAt': new Date(),
      },
    }
  );

  const updated = await Order.findById(orderId);
  return { manifestUrl, shipping: updated.shipping };
};

const requestPickupForOrder = async (orderId) => {
  const order = await loadShipmentOrder(orderId);

  if (!order.shipping.awbCode) {
    throw new ApiError(409, 'Assign an AWB before requesting pickup');
  }

  if (order.shipping.pickupScheduledDate) {
    return {
      alreadyExists: true,
      pickupScheduledDate: order.shipping.pickupScheduledDate,
    };
  }

  const response = await shiprocket.requestPickup({
    shipmentIds: [Number(order.shipping.shipmentId) || order.shipping.shipmentId],
  });

  const data = response?.response || response?.data || response || {};
  const pickupDate =
    parseDate(data.pickup_scheduled_date) ||
    parseDate(response?.pickup_scheduled_date) ||
    new Date();

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        'shipping.pickupScheduledDate': pickupDate,
        'shipping.pickupToken': clampText(
          data.pickup_token_number || response?.pickup_token_number || '',
          150
        ),
        'shipping.pickupStatus': clampText(
          String(data.status || response?.pickup_status || 'scheduled'),
          40
        ),
        'shipping.lastSyncedAt': new Date(),
      },
    }
  );

  await Order.updateOne(
    { _id: orderId },
    {
      $push: {
        timeline: {
          status: order.orderStatus,
          date: new Date(),
          note: `Pickup requested with ${order.shipping.courierName || 'courier'}`,
        },
      },
    }
  );

  const updated = await Order.findById(orderId);
  return { pickupScheduledDate: pickupDate, shipping: updated.shipping };
};

const cancelShipmentForOrder = async (orderId, { reason = '' } = {}) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }

  const order = await Order.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');

  if (!order.shipping?.shiprocketOrderId) {
    throw new ApiError(409, 'No Shiprocket shipment exists for this order');
  }

  if (normaliseStatus(order.shipping.shipmentStatus) === 'CANCELLED') {
    return { alreadyExists: true, shipping: order.shipping };
  }

  try {
    await shiprocket.cancelOrder({
      shiprocketOrderIds: [
        Number(order.shipping.shiprocketOrderId) ||
          order.shipping.shiprocketOrderId,
      ],
    });
  } catch (error) {
    // Newer API surface: cancel by AWB. Fall back only when an AWB exists.
    if (order.shipping.awbCode) {
      await shiprocket.cancelShipmentsByAWB({ awbs: [order.shipping.awbCode] });
    } else {
      throw error;
    }
  }

  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        'shipping.shipmentStatus': 'CANCELLED',
        'shipping.cancelledAt': new Date(),
        'shipping.lastSyncedAt': new Date(),
      },
      $push: {
        timeline: {
          status: 'shipping_cancelled',
          date: new Date(),
          note: clampText(
            reason
              ? `Shiprocket shipment cancelled: ${reason}`
              : 'Shiprocket shipment cancelled',
            200
          ),
        },
      },
    }
  );

  const updated = await Order.findById(orderId);
  return { cancelled: true, shipping: updated.shipping };
};

/* ========================================================================== *
 * Tracking
 * ========================================================================== */

const normaliseTrackingResponse = (response) => {
  const trackingData = response?.tracking_data || response?.data || response || {};
  const track = Array.isArray(trackingData.shipment_track)
    ? trackingData.shipment_track[0] || {}
    : trackingData.shipment_track || {};
  const activities =
    trackingData.shipment_track_activities ||
    trackingData.scans ||
    trackingData.activities ||
    [];

  const events = (Array.isArray(activities) ? activities : []).map((event) => ({
    status: clampText(
      event.status || event.activity || event.current_status || '',
      120
    ),
    activity: clampText(event.activity || event.status || '', 200),
    location: clampText(event.location || event.city || '', 150),
    date: parseDate(event.date || event.updated_at) || new Date(),
    awbCode: clampText(event.awb || track.awb_code || '', 60),
    source: 'shiprocket',
  }));

  const currentStatus = clampText(
    track.current_status ||
      trackingData.current_status ||
      events[events.length - 1]?.activity ||
      '',
    120
  );

  return {
    awbCode: clampText(track.awb_code || trackingData.awb_code || '', 60),
    courierName: clampText(
      track.courier_name || trackingData.courier_name || '',
      120
    ),
    currentStatus,
    shipmentStatus: clampText(
      String(trackingData.shipment_status || trackingData.track_status || ''),
      40
    ),
    origin: clampText(track.origin || '', 120),
    destination: clampText(track.destination || '', 120),
    deliveredDate: parseDate(track.delivered_date),
    estimatedDeliveryDate: parseDate(track.edd || trackingData.etd),
    activities: events,
  };
};

const ORDER_STATUS_RANK = {
  pending: 0,
  confirmed: 1,
  processing: 2,
  shipped: 3,
  out_for_delivery: 4,
  delivered: 5,
};

const mapToOrderStatus = (statusText) => {
  const status = normaliseStatus(statusText);
  if (!status) return null;

  if (statusIncludes(status, ['RTO', 'RETURN TO ORIGIN'])) return null;
  if (statusIncludes(status, ['CANCEL'])) return null;
  if (statusIncludes(status, ['DELIVERED'])) return 'delivered';
  if (statusIncludes(status, ['OUT FOR DELIVERY', 'OUT-FOR-DELIVERY'])) {
    return 'out_for_delivery';
  }
  if (
    statusIncludes(status, [
      'SHIPPED',
      'IN TRANSIT',
      'PICKED UP',
      'DISPATCHED',
      'REACHED',
    ])
  ) {
    return 'shipped';
  }
  if (statusIncludes(status, ['PICKUP', 'MANIFEST', 'AWB ASSIGNED'])) {
    return 'processing';
  }
  return null;
};

const advanceOrderStatus = async (order, statusText, note) => {
  const mapped = mapToOrderStatus(statusText);
  if (!mapped) return false;

  const currentRank = ORDER_STATUS_RANK[order.orderStatus] ?? -1;
  const nextRank = ORDER_STATUS_RANK[mapped];

  // Never move backwards, never revive a cancelled order, never downgrade a
  // delivered one. Courier scans can arrive out of order.
  if (nextRank <= currentRank) return false;
  if (order.orderStatus === 'cancelled') return false;

  const $set = { orderStatus: mapped };
  if (mapped === 'delivered' && order.paymentMethod === 'cod') {
    $set.paymentStatus = 'cod';
  }

  const result = await Order.updateOne(
    {
      _id: order._id,
      orderStatus: { $nin: ['cancelled', 'delivered'] },
    },
    {
      $set,
      $push: {
        timeline: {
          status: mapped,
          date: new Date(),
          note: clampText(note || 'Updated from Shiprocket', 200),
        },
      },
    }
  );

  return result.modifiedCount > 0;
};

const trackShipmentForOrder = async (orderId, { persist = true } = {}) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }

  const order = await Order.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');

  if (!order.shipping?.awbCode && !order.shipping?.shipmentId) {
    throw new ApiError(409, 'No Shiprocket shipment exists for this order');
  }

  const response = order.shipping.awbCode
    ? await shiprocket.trackByAWB(order.shipping.awbCode)
    : await shiprocket.trackByShipmentId(order.shipping.shipmentId);

  const tracking = normaliseTrackingResponse(response);

  if (persist) {
    const $set = {
      'shipping.lastTrackingUpdate': new Date(),
      'shipping.lastSyncedAt': new Date(),
    };

    if (tracking.currentStatus) {
      $set['shipping.shipmentStatus'] = tracking.currentStatus;
    }
    if (tracking.courierName) {
      $set['shipping.courierName'] = tracking.courierName;
    }
    if (tracking.estimatedDeliveryDate) {
      $set['shipping.estimatedDeliveryDate'] = tracking.estimatedDeliveryDate;
    }
    if (normaliseStatus(tracking.currentStatus).startsWith('RTO')) {
      $set['shipping.rtoStatus'] = tracking.currentStatus;
    }

    const update = { $set };
    if (tracking.activities.length) {
      update.$push = {
        'shipping.trackingHistory': {
          $each: tracking.activities,
          $slice: -100,
        },
      };
    }

    await Order.updateOne({ _id: orderId }, update);

    await advanceOrderStatus(
      order,
      tracking.currentStatus,
      `Tracking update: ${tracking.currentStatus}`
    );
  }

  return { order, tracking };
};

/* ========================================================================== *
 * Inbound webhooks
 * ========================================================================== */

const findOrderForWebhook = async (payload) => {
  const data = payload?.data || payload || {};

  const queries = [];

  const channelOrderId =
    data.channel_order_id || data.order_id || data.orderId || null;

  if (channelOrderId !== null && channelOrderId !== undefined) {
    const text = String(channelOrderId);
    queries.push({ orderNumber: text.toUpperCase() });
    queries.push({ 'shipping.shiprocketOrderId': text });
  }

  const srOrderId = data.sr_order_id || data.shiprocket_order_id || null;
  if (srOrderId !== null && srOrderId !== undefined) {
    queries.push({ 'shipping.shiprocketOrderId': String(srOrderId) });
  }

  const awb = data.awb || data.awb_code || data.awbCode || null;
  if (awb) queries.push({ 'shipping.awbCode': String(awb) });

  const shipmentId = data.shipment_id || data.shipmentId || null;
  if (shipmentId) queries.push({ 'shipping.shipmentId': String(shipmentId) });

  for (const query of queries) {
    const order = await Order.findOne(query);
    if (order) return order;
  }

  return null;
};

const deriveWebhookEventId = (payload, rawBody) => {
  const data = payload?.data || payload || {};

  return (
    data.event_id ||
    payload?.event_id ||
    [
      data.awb || data.awb_code || '',
      data.current_status || data.shipment_status || '',
      data.current_status_id || '',
      data.updated_at || data.scan_date || data.date || '',
    ].join(':') ||
    crypto.createHash('sha256').update(String(rawBody || '')).digest('hex')
  );
};

/**
 * Applies an authenticated Shiprocket webhook.
 *
 * The controller has already proved the shared secret. This function handles the
 * business side: locate the order, claim the event id exactly once, then update
 * shipping state and tracking history. Unknown orders and duplicate events are
 * acknowledged without error so Shiprocket does not retry forever.
 */
const processWebhook = async (payload, { rawBody, eventId } = {}) => {
  const data = payload?.data || payload || {};
  const order = await findOrderForWebhook(payload);

  if (!order) {
    return { ignored: true, reason: 'unknown_order' };
  }

  const eventKey = clampText(
    eventId || deriveWebhookEventId(payload, rawBody),
    180
  );

  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, 'shipping.webhookEvents': { $ne: eventKey } },
    {
      $push: {
        'shipping.webhookEvents': { $each: [eventKey], $slice: -200 },
      },
    },
    { new: false }
  );

  if (!claimed) {
    return { duplicate: true, orderId: order._id };
  }

  const statusText = clampText(
    data.current_status ||
      data.shipment_status ||
      data.status ||
      data.activity ||
      '',
    120
  );
  const normalised = normaliseStatus(statusText);

  const activities =
    data.scans || data.shipment_track_activities || data.activities || [];
  const events = (Array.isArray(activities) ? activities : []).map((event) => ({
    status: clampText(event.status || event.activity || statusText, 120),
    activity: clampText(event.activity || event.status || statusText, 200),
    location: clampText(event.location || '', 150),
    date: parseDate(event.date || event.updated_at) || new Date(),
    awbCode: clampText(data.awb || data.awb_code || '', 60),
    source: 'shiprocket',
  }));

  if (!events.length && statusText) {
    events.push({
      status: statusText,
      activity: statusText,
      location: clampText(data.current_location || data.location || '', 150),
      date: parseDate(data.updated_at || data.scan_date) || new Date(),
      awbCode: clampText(data.awb || data.awb_code || '', 60),
      source: 'shiprocket',
    });
  }

  const $set = {
    'shipping.lastTrackingUpdate': new Date(),
    'shipping.lastSyncedAt': new Date(),
  };

  if (statusText) $set['shipping.shipmentStatus'] = statusText;
  if (data.courier_name) {
    $set['shipping.courierName'] = clampText(data.courier_name, 120);
  }
  if (data.awb || data.awb_code) {
    $set['shipping.awbCode'] = clampText(data.awb || data.awb_code, 60);
    $set['shipping.trackingUrl'] = buildTrackingUrl(data.awb || data.awb_code);
  }
  const edd = parseDate(data.etd || data.expected_delivery_date);
  if (edd) $set['shipping.estimatedDeliveryDate'] = edd;

  if (normalised.includes('RTO')) {
    $set['shipping.rtoStatus'] = statusText;
  }
  if (normalised.includes('CANCEL')) {
    $set['shipping.cancelledAt'] = new Date();
  }

  const update = { $set };
  if (events.length) {
    update.$push = {
      'shipping.trackingHistory': { $each: events, $slice: -100 },
    };
  }

  await Order.updateOne({ _id: order._id }, update);

  // Delivered / shipped / out-for-delivery move the customer-visible order
  // forward. Cancellation and RTO only update shipping state and history: stock
  // restoration remains owned by the existing admin/customer cancellation flows
  // so this webhook can never double-credit inventory.
  await advanceOrderStatus(
    order,
    statusText,
    `Shiprocket webhook: ${statusText}`
  );

  return {
    processed: true,
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: statusText,
    mappedOrderStatus: mapToOrderStatus(statusText),
  };
};

/* ========================================================================== *
 * Admin listing / read helpers
 * ========================================================================== */

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listShipments = async ({ page = 1, limit = 20, status, search } = {}) => {
  const filter = {
    $or: [
      { 'shipping.provider': 'shiprocket' },
      { 'shipping.creationState': { $in: ['creating', 'created', 'failed'] } },
    ],
  };

  if (status) {
    filter['shipping.shipmentStatus'] = new RegExp(
      `^${escapeRegex(String(status).trim())}$`,
      'i'
    );
  }

  if (search && String(search).trim()) {
    const regex = new RegExp(escapeRegex(String(search).trim()), 'i');
    filter.$and = [
      {
        $or: [
          { orderNumber: regex },
          { 'shipping.awbCode': regex },
          { 'shipping.shiprocketOrderId': regex },
          { 'shipping.shipmentId': regex },
        ],
      },
    ];
  }

  const skip = (page - 1) * limit;

  const [shipments, total] = await Promise.all([
    Order.find(filter)
      .select(ORDER_PUBLIC_FIELDS)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(filter),
  ]);

  return {
    shipments,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

const getShippingForOrder = async (orderId) => {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new ApiError(400, 'Invalid order id');
  }
  const order = await Order.findById(orderId).select(
    'orderNumber orderStatus paymentStatus paymentMethod shippingAddress shipping user totalAmount'
  );
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
};

/**
 * Best-effort background creation used by payment verification, the Razorpay
 * webhook and admin confirmation. Never throws and never blocks the request.
 */
const scheduleShipmentCreation = (orderId) => {
  if (!isShiprocketShipmentReady()) return;

  setImmediate(() => {
    createShipmentForOrder(orderId).catch((error) => {
      // Order id only. Never log credentials, tokens or the request payload.
      console.error(
        `[shiprocket] automatic shipment creation failed for order ${orderId}: ${safeErrorMessage(error)}`
      );
    });
  });
};

module.exports = {
  round2,
  summarisePackage,
  quoteShipping,
  getCartPackage,
  buildShiprocketOrderPayload,
  assertShipmentEligible,
  createShipmentForOrder,
  assignAWBForOrder,
  generateLabelForOrder,
  generateManifestForOrder,
  requestPickupForOrder,
  cancelShipmentForOrder,
  trackShipmentForOrder,
  processWebhook,
  listShipments,
  getShippingForOrder,
  scheduleShipmentCreation,
  buildTrackingUrl,
  mapToOrderStatus,
  normaliseTrackingResponse,
  isShiprocketConfigured,
  isShiprocketPricingEnabled,
  isShiprocketShipmentReady,
};
