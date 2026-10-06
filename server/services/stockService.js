const Order = require('../models/Order');
const Product = require('../models/Product');
const { invalidateCatalogueCache } = require('../utils/catalogueCache');

/**
 * Stock handling for orders.
 *
 * COD keeps the original behaviour: stock is decremented once the order is
 * created. Online orders use the same decrement as a *reservation* so the
 * stock cannot be sold twice while the customer is on the Razorpay page; if the
 * payment never completes the reservation is released again.
 *
 * `stockReserved` / `stockRestored` make both directions exactly-once, so a
 * cancelled payment or a replayed webhook can never restore the same units
 * twice.
 */

const claimReservation = (orderId) =>
  Order.findOneAndUpdate(
    { _id: orderId, stockReserved: { $ne: true } },
    { $set: { stockReserved: true } },
    { new: true }
  );

const claimRestore = (orderId) =>
  Order.findOneAndUpdate(
    { _id: orderId, stockReserved: true, stockRestored: { $ne: true } },
    { $set: { stockRestored: true } },
    { new: true }
  );

const claimRelease = (orderId) =>
  Order.findOneAndUpdate(
    { _id: orderId, stockReserved: true, stockRestored: true },
    { $set: { stockReserved: false } },
    { new: true }
  );

/** Decrement using a guarded update so stock can never go negative. */
const decrementStock = async (items) => {
  const bulkOps = items.map((item) => ({
    updateOne: {
      filter: { _id: item.product, stock: { $gte: item.quantity } },
      update: {
        $inc: { stock: -item.quantity },
        $set: { isActive: true },
      },
    },
  }));

  const result = await Product.bulkWrite(bulkOps, { ordered: false });
  await invalidateCatalogueCache();
  return result.modifiedCount === items.length;
};

/**
 * Guarded decrement for the COD path (audit finding F-02).
 *
 * The guard (`stock: { $gte: quantity }`) and the `$subtract` are evaluated as ONE
 * atomic document update, so two concurrent orders can never both win the same
 * units: the first takes the stock, the second's filter no longer matches and
 * `modifiedCount` falls short. The old unguarded `$inc` read the stock earlier in
 * the request and then decremented unconditionally, which drove stock negative.
 *
 * `isActive` is derived from the value the product ends up with, computed inside the
 * same pipeline, so a sold-out product deactivates and a product that was already
 * inactive by an admin decision is not silently reactivated.
 *
 * @param {Array<{product: ObjectId, quantity: number, isActive: boolean}>} cartLines
 * @param {{session?: import('mongoose').ClientSession}} [options]
 * @returns {Promise<boolean>} false when any line could not be decremented
 */
const decrementStockForOrder = async (cartLines, options = {}) => {
  const { session } = options;

  const bulkOps = cartLines.map((line) => {
    const remaining = { $subtract: ['$stock', line.quantity] };

    return {
      updateOne: {
        filter: { _id: line.product, stock: { $gte: line.quantity } },
        // An aggregation-pipeline update is atomic and can reference the new value.
        update: [
          {
            $set: {
              stock: remaining,
              isActive: {
                $cond: [
                  line.isActive !== false,
                  { $gt: [remaining, 0] },
                  false,
                ],
              },
            },
          },
        ],
      },
    };
  });

  const result = await Product.bulkWrite(bulkOps, { ordered: true, session });

  // Only once the transaction has committed. Invalidating inside a transaction
  // that later aborts would drop the cache for nothing, and a committed
  // transaction must not leave the rails serving pre-checkout stock.
  if (!session) await invalidateCatalogueCache();
  return result.modifiedCount === cartLines.length;
};

/**
 * Puts back stock that `decrementStockForOrder` took.
 *
 * Two callers, and the difference between them is why visibility is a per-line flag
 * rather than a value this function guesses at:
 *
 *   - order creation compensation, on deployments without transaction support, where
 *     a later step fails after the stock was already claimed. Nothing else has
 *     touched the product, so the pre-order activation state is the correct one to
 *     restore (`restoreVisibility: true`).
 *
 *   - order cancellation (audit finding F-07), where the product may have been
 *     unpublished by an admin at any point since. Only lines whose own stock-out
 *     caused the deactivation (`restoreVisibility: true`) are brought back online;
 *     every other line keeps whatever state it is in, so a cancellation can never
 *     publish a product a human took down.
 *
 * @param {Array<{product: ObjectId, quantity: number, restoreVisibility?: boolean}>} lines
 * @param {{session?: import('mongoose').ClientSession}} [options]
 */
const restoreStockForOrder = async (lines, options = {}) => {
  const { session } = options;

  const bulkOps = lines.map((line) => {
    const restored = { $add: ['$stock', line.quantity] };

    return {
      updateOne: {
        filter: { _id: line.product },
        update: [
          {
            $set: {
              stock: restored,
              // Derived from the value the product ends up with, inside the same
              // atomic update, so this cannot race a concurrent stock change.
              isActive: line.restoreVisibility
                ? { $gt: [restored, 0] }
                : '$isActive',
            },
          },
        ],
      },
    };
  });

  await Product.bulkWrite(bulkOps, { ordered: true, session });
  if (!session) await invalidateCatalogueCache();
};

const incrementStock = async (items) => {
  const bulkOps = items.map((item) => ({
    updateOne: {
      filter: { _id: item.product },
      update: {
        $inc: { stock: item.quantity },
        $set: { isActive: true },
      },
    },
  }));

  await Product.bulkWrite(bulkOps, { ordered: false });
  await invalidateCatalogueCache();
};

/**
 * Reserves stock for a newly created order.
 * Returns false when the reservation could not be taken (e.g. stock changed
 * between validation and creation).
 */
const reserveStock = async (order) => {
  const claimed = await claimReservation(order._id);
  if (!claimed) {
    return true;
  }

  const ok = await decrementStock(order.items);

  if (!ok) {
    // Roll the claim back so the order can be retried or released cleanly.
    await claimRelease(order._id);
    return false;
  }

  return true;
};

/**
 * Releases a reservation. Safe to call repeatedly - only the first call
 * actually puts stock back.
 */
const releaseStock = async (order) => {
  const claimed = await claimRestore(order._id);
  if (!claimed) {
    return false;
  }

  await incrementStock(order.items);
  return true;
};

/**
 * Makes sure a paid order has its stock actually decremented. Used by the
 * webhook path, where the reservation may never have been taken.
 */
const ensureStockDeducted = async (order) => {
  const claimed = await claimReservation(order._id);
  if (!claimed) {
    return true;
  }

  const ok = await decrementStock(order.items);
  if (!ok) {
    await claimRelease(order._id);
    return false;
  }

  return true;
};

module.exports = {
  decrementStockForOrder,
  restoreStockForOrder,
  reserveStock,
  releaseStock,
  ensureStockDeducted,
};
