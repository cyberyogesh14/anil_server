const User = require('../models/User');
const { USER_PUBLIC_FIELDS } = require('../models/User');
const { generateToken, verifyToken } = require('../utils/generateToken');
const sendEmail = require('../utils/sendEmail');
const emailService = require('../services/emailService');
const { getTransporter } = require('../config/mail');
const {
  generateOtp,
  hashOtp,
  verifyOtp,
  isOtpExpired,
  maskEmail,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
} = require('../utils/otp');
const crypto = require('crypto');
const { validatePassword } = require('../utils/passwordPolicy');

const afterOtpEmailSent = (user, otp, sent) => {
  if (!sent && !getTransporter() && process.env.NODE_ENV !== 'production') {
    console.log(`[DEV] OTP for ${user.email}: ${otp}`);
  }
};

exports.register = async (req, res, next) => {
  try {
    const { name, email, phone, password, termsAccepted, marketingConsent } =
      req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and password are required',
      });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    if (termsAccepted !== true) {
      return res.status(400).json({
        success: false,
        message: 'You must accept the Terms & Conditions to continue',
      });
    }

    // Existence check only. Projecting just `_id` means the password hash, tokens
    // and OTP fields never leave the database, and no Mongoose document is built
    // to answer a yes/no question.
    const existingUser = await User.findOne({ email: email.toLowerCase() })
      .select('_id')
      .lean();
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
      });
    }

    const otp = generateOtp();

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      phone: phone || '',
      password,
      emailVerified: false,
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      marketingConsent: marketingConsent === true,
      marketingConsentAt: marketingConsent === true ? new Date() : null,
      otpHash: hashOtp(otp),
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      otpAttempts: 0,
      lastOtpSentAt: new Date(),
    });

    if (user.email) {
      try {
        const sent = await emailService.sendVerificationOtpEmail({
          to: user.email,
          name: user.name,
          otp,
        });
        afterOtpEmailSent(user, otp, sent);
      } catch (error) {
        console.error('OTP email failed:', error.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'OTP sent to your email',
      requiresVerification: true,
      email: maskEmail(user.email),
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyEmailOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required',
      });
    }

    if (!/^\d{6}$/.test(String(otp))) {
      return res.status(400).json({
        success: false,
        message: 'OTP must be exactly 6 digits',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      '+otpHash +otpExpiresAt +otpAttempts +lastOtpSentAt'
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
      });
    }

    if (user.emailVerified === true) {
      return res.status(400).json({
        success: false,
        message: 'Email already verified. Please login.',
      });
    }

    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      user.otpHash = undefined;
      user.otpExpiresAt = undefined;
      user.otpAttempts = 0;
      user.lastOtpSentAt = undefined;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new OTP.',
      });
    }

    if (isOtpExpired(user)) {
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.',
      });
    }

    const isValid = verifyOtp(String(otp), user.otpHash);
    if (!isValid) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
        user.otpHash = undefined;
        user.otpExpiresAt = undefined;
        user.otpAttempts = 0;
        user.lastOtpSentAt = undefined;
        await user.save({ validateBeforeSave: false });
        return res.status(400).json({
          success: false,
          message: 'Too many incorrect attempts. Please request a new OTP.',
        });
      }
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${OTP_MAX_ATTEMPTS - user.otpAttempts} attempt(s) remaining.`,
      });
    }

    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.otpHash = undefined;
    user.otpExpiresAt = undefined;
    user.otpAttempts = 0;
    user.lastOtpSentAt = undefined;
    await user.save({ validateBeforeSave: false });

    if (user.email) {
      try {
        await emailService.sendWelcomeEmail({
          to: user.email,
          name: user.name,
          marketingConsent: user.marketingConsent,
        });
      } catch (error) {
        console.error('Welcome email failed:', error.message);
      }
    }

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Email verified successfully',
      token,
      user,
    });
  } catch (error) {
    next(error);
  }
};

exports.resendEmailOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const genericResponse = {
      success: true,
      message:
        'If an account exists and verification is pending, a new OTP has been sent.',
    };

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      '+otpHash +otpExpiresAt +otpAttempts +lastOtpSentAt'
    );

    const invalidOtp = (value) => {
      if (!value) return;
      value.otpHash = undefined;
      value.otpExpiresAt = undefined;
      value.otpAttempts = 0;
      value.lastOtpSentAt = undefined;
    };

    if (!user || user.emailVerified === true) {
      return res.json(genericResponse);
    }

    if (
      user.lastOtpSentAt &&
      Date.now() - user.lastOtpSentAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      return res.json(genericResponse);
    }

    const otp = generateOtp();

    user.otpHash = hashOtp(otp);
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    user.otpAttempts = 0;
    user.lastOtpSentAt = new Date();
    await user.save({ validateBeforeSave: false });

    if (user.email) {
      try {
        const sent = await emailService.sendVerificationOtpEmail({
          to: user.email,
          name: user.name,
          otp,
        });
        afterOtpEmailSent(user, otp, sent);
      } catch (error) {
        console.error('OTP email failed:', error.message);
      }
    }

    return res.json(genericResponse);
  } catch (error) {
    next(error);
  }
};

exports.updateMarketingPreference = async (req, res, next) => {
  try {
    const enabled = req.body && req.body.marketingConsent === true;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        marketingConsent: enabled,
        marketingConsentAt: enabled ? new Date() : null,
      },
      { new: true, runValidators: true }
    );

    res.json({
      success: true,
      message: enabled
        ? 'You are now subscribed to promotional emails'
        : 'You have unsubscribed from promotional emails',
      marketingConsent: user.marketingConsent,
      marketingConsentAt: user.marketingConsentAt,
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      '+password'
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (user.emailVerified === false) {
      return res.status(401).json({
        success: false,
        requiresVerification: true,
        message: 'Please verify your email before logging in.',
      });
    }

    const token = generateToken(user);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        addresses: user.addresses,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * The authenticated user's own record.
 *
 * `protect` has already read this row to evaluate the session (audit finding
 * F-03), but it reads only the handful of fields authentication needs, so it
 * cannot serve this response. Re-reading with the full public allow-list is still
 * one fewer round trip than before, where an unrestricted `User.findById()` ran
 * on top of the authentication read, and it now returns a lean projection instead
 * of a hydrated document.
 */
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select(USER_PUBLIC_FIELDS)
      .lean();

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const { name, email, phone } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (email) {
      const existing = await User.findOne({
        email: email.toLowerCase(),
        _id: { $ne: req.user._id },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Email already in use',
        });
      }
      updateData.email = email.toLowerCase();
    }
    if (phone !== undefined) updateData.phone = phone;

    const user = await User.findByIdAndUpdate(req.user._id, updateData, {
      new: true,
      runValidators: true,
    });

    res.json({
      success: true,
      message: 'Profile updated',
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Logout (audit finding F-03).
 *
 * This used to be a no-op that returned 200, which meant a leaked or borrowed token
 * stayed valid for its full 7 days even after the user "logged out". It is now a real
 * revocation: the presented token's user has its `tokenVersion` bumped, so every
 * token issued for that account stops authenticating.
 *
 * Verification is best-effort on purpose - logout stays idempotent and never fails,
 * because the caller's goal is to end up logged out, not to be told they were not.
 */
exports.logout = async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (token) {
      const decoded = verifyToken(token);
      await User.findByIdAndUpdate(decoded.id, {
        $inc: { tokenVersion: 1 },
      });
    }
  } catch (error) {
    // An already-expired or tampered token means there is nothing left to revoke.
    console.warn('Logout token could not be verified:', error.message);
  }

  res.json({
    success: true,
    message: 'Logged out successfully',
  });
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.json({
        success: true,
        message: 'If an account exists, a reset email has been sent',
      });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.resetPasswordExpire = Date.now() + 30 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.CLIENT_URL}/reset-password/${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: 'AnilKabadi - Password Reset',
      html: `
        <h2>Password Reset Request</h2>
        <p>Hi ${user.name},</p>
        <p>Click the link below to reset your password. This link expires in 30 minutes.</p>
        <a href="${resetUrl}">Reset Password</a>
        <p>If you did not request this, please ignore this email.</p>
        <br>
        <p>Thanks,<br>AnilKabadi Team</p>
      `,
    });

    res.json({
      success: true,
      message: 'If an account exists, a reset email has been sent',
    });
  } catch (error) {
    next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: 'Token and password are required',
      });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    }).select('+resetPasswordToken +resetPasswordExpire');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token',
      });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    // Audit finding F-03: a password reset must invalidate sessions that were
    // opened with the old credentials, before the new token below is minted.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    const newToken = generateToken(user);

    res.json({
      success: true,
      message: 'Password reset successful',
      token: newToken,
    });
  } catch (error) {
    next(error);
  }
};

exports.addAddress = async (req, res, next) => {
  try {
    const { fullName, phone, addressLine1, addressLine2, city, state, pincode, country, isDefault: wantDefault } =
      req.body;

    if (!fullName || !phone || !addressLine1 || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: 'All address fields are required',
      });
    }

    const user = await User.findById(req.user._id);

    if (wantDefault) {
      user.addresses.forEach((addr) => {
        addr.isDefault = false;
      });
    }

    const isFirst = user.addresses.length === 0;

    user.addresses.push({
      fullName,
      phone,
      addressLine1,
      addressLine2: addressLine2 || '',
      city,
      state,
      pincode: String(pincode),
      country: country || 'India',
      isDefault: wantDefault || isFirst,
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'Address added',
      addresses: user.addresses,
    });
  } catch (error) {
    next(error);
  }
};

exports.getAddresses = async (req, res, next) => {
  try {
    // Narrow read of just this subdocument instead of a whole `User.findById()`,
    // which dragged along the password hash, OTP and reset-token fields'
    // siblings and every unrelated user attribute to read one array.
    const user = await User.findById(req.user._id).select('addresses').lean();
    res.json({
      success: true,
      addresses: user ? user.addresses : [],
    });
  } catch (error) {
    next(error);
  }
};

exports.updateAddress = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.id);

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found',
      });
    }

    if (req.body.isDefault) {
      user.addresses.forEach((addr) => {
        addr.isDefault = false;
      });
    }

    Object.assign(address, req.body);
    await user.save();

    res.json({
      success: true,
      message: 'Address updated',
      addresses: user.addresses,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteAddress = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.id);

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found',
      });
    }

    user.addresses.pull(req.params.id);
    await user.save();

    res.json({
      success: true,
      message: 'Address deleted',
      addresses: user.addresses,
    });
  } catch (error) {
    next(error);
  }
};
