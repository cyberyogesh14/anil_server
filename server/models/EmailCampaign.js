const mongoose = require('mongoose');

const emailCampaignSchema = new mongoose.Schema(
  {
    campaignId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    bodyHtml: {
      type: String,
      required: true,
    },
    audience: {
      type: String,
      required: true,
      enum: [
        'all',
        'marketing',
        'new',
        'with_orders',
        'no_orders',
        'delivered_orders',
        'pending_orders',
      ],
    },
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    recipientCount: {
      type: Number,
      default: 0,
    },
    sentCount: {
      type: Number,
      default: 0,
    },
    failedCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['queued', 'sending', 'completed', 'failed'],
      default: 'queued',
    },
    sentAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('EmailCampaign', emailCampaignSchema);