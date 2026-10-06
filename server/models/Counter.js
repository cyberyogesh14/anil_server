const mongoose = require('mongoose');

/**
 * Atomic per-day counters, used to allocate order numbers.
 *
 * `_id` is the local calendar day (`YYYY-MM-DD`) and `seq` is a monotonically
 * increasing count of the orders allocated for that day. Both the insert and the
 * increment happen in a single `findOneAndUpdate`, so two requests allocating at
 * the same moment are serialised by the server and receive different `seq`
 * values. That is what makes collision-free allocation possible without holding a
 * lock and without a retry loop.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, collection: 'counters' }
);

module.exports = mongoose.models.Counter || mongoose.model('Counter', counterSchema);