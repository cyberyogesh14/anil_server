const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const addressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  addressLine1: { type: String, required: true },
  addressLine2: { type: String, default: '' },
  city: { type: String, required: true },
  state: { type: String, required: true },
  pincode: { type: String, required: true },
  country: { type: String, default: 'India' },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, default: '' },
    password: { type: String, required: true, minlength: 6, select: false },
    role: {
      type: String,
      enum: ['customer', 'staff', 'admin'],
      default: 'customer',
    },
    /**
     * Bumped whenever something about the account's security posture changes
     * (password change, password reset, logout, role change, admin suspension).
     * The value is stamped into every JWT at issue time and re-checked on every
     * request, which is what finally makes a stateless token revocable: once this
     * moves, every token issued before it stops authenticating.
     */
    tokenVersion: { type: Number, default: 0 },
    avatar: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    addresses: [addressSchema],
    isActive: { type: Boolean, default: true },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    otpHash: { type: String, select: false },
    otpExpiresAt: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    lastOtpSentAt: { type: Date, select: false },
    marketingConsent: { type: Boolean, default: false },
    marketingConsentAt: { type: Date, default: null },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date, default: null },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpire: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpire;
  delete obj.otpHash;
  delete obj.otpExpiresAt;
  delete obj.otpAttempts;
  delete obj.lastOtpSentAt;
  return obj;
};

/**
 * Serves the admin user list in `controllers/adminController.js`, which does
 * `find({}).sort({ createdAt: -1 }).skip().limit()`. The only other index on this
 * collection is the unique `email`, so that listing was doing a full collection
 * scan plus a blocking in-memory sort of every user - the cost grows linearly with
 * the account base, which is exactly what this index removes.
 */
userSchema.index({ createdAt: -1 });

/**
 * Every field of a user that is safe to return over the API.
 *
 * This mirrors exactly what a plain `User.findById()` returned before reads were
 * switched to projections: all of it except the fields the schema marks
 * `select: false` (`password`, `otpHash`, `otpExpiresAt`, `otpAttempts`,
 * `lastOtpSentAt`, `resetPasswordToken`, `resetPasswordExpire`). Naming them
 * keeps the guarantee independent of the schema and makes it reviewable in one
 * place - a secret added to the schema without a `select: false` fails to appear
 * in an allow-list, so it is not returned by mistake.
 */
const USER_PUBLIC_FIELDS = [
  '_id',
  'name',
  'email',
  'phone',
  'role',
  'avatar',
  'addresses',
  'isActive',
  'emailVerified',
  'emailVerifiedAt',
  'marketingConsent',
  'marketingConsentAt',
  'termsAccepted',
  'termsAcceptedAt',
  'tokenVersion',
  'createdAt',
  'updatedAt',
].join(' ');

module.exports = mongoose.model('User', userSchema);
module.exports.USER_PUBLIC_FIELDS = USER_PUBLIC_FIELDS;
