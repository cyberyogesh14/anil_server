const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    freeDeliveryThreshold: { type: Number, required: true, default: 999 },
    deliveryFee: { type: Number, required: true, default: 99 },
    gstPercentage: { type: Number, required: true, default: 18 },
    contactEmail: { type: String, required: true, default: 'support@anilkabadi.com' },
    contactPhone: { type: String, required: true, default: '+91 98765 43210' },
    storeName: { type: String, required: true, default: 'AnilKabadi' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);