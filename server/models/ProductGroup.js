const mongoose = require('mongoose');

const GROUP_TEMPLATE_DEFAULTS = {
  title: '{baseTitle} - {partNumber}',
  seoTitle: '{baseTitle} {partNumber} | Buy Online',
  description: '{baseDescription}',
  seoDescription: '{baseDescription} Part Number: {partNumber}.',
};

const productGroupSchema = new mongoose.Schema(
  {
    baseTitle: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 20000 },
    brand: { type: String, default: '', trim: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    subcategory: { type: String, default: '', trim: true },
    carBrand: { type: String, default: 'Tata', trim: true },
    carModel: { type: String, default: '', trim: true },
    compatibleYears: { type: String, default: '', trim: true },
    compatibility: { type: String, default: '', maxlength: 5000 },
    additionalInfo: { type: String, default: '', maxlength: 5000 },
    condition: {
      type: String,
      enum: ['new', 'used_like_new', 'used_good', 'used_fair', 'refurbished'],
      default: 'new',
    },
    emissionStandard: { type: String, enum: ['BS4', 'BS6', ''], default: '' },
    specifications: { type: Map, of: String, default: {} },
    tags: { type: [String], default: [] },
    images: [
      {
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
      },
    ],
    templates: {
      title: { type: String, default: GROUP_TEMPLATE_DEFAULTS.title, maxlength: 300 },
      description: {
        type: String,
        default: GROUP_TEMPLATE_DEFAULTS.description,
        maxlength: 20000,
      },
      seoTitle: {
        type: String,
        default: GROUP_TEMPLATE_DEFAULTS.seoTitle,
        maxlength: 200,
      },
      seoDescription: {
        type: String,
        default: GROUP_TEMPLATE_DEFAULTS.seoDescription,
        maxlength: 500,
      },
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

productGroupSchema.index({ category: 1, isActive: 1 });
productGroupSchema.index({ isActive: 1, createdAt: -1 });
productGroupSchema.index({ baseTitle: 'text', description: 'text' });

module.exports = mongoose.model('ProductGroup', productGroupSchema);
module.exports.GROUP_TEMPLATE_DEFAULTS = GROUP_TEMPLATE_DEFAULTS;
