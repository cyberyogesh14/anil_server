const User = require('../models/User');
const { USER_PUBLIC_FIELDS } = require('../models/User');
const { validatePassword } = require('../utils/passwordPolicy');
const { generateToken } = require('../utils/generateToken');

exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select(USER_PUBLIC_FIELDS)
      .lean();
    res.json({
      success: true,
      data: user,
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
      // Existence check only, so just `_id` is fetched - see the equivalent check in
      // `registerUser`.
      const existing = await User.findOne({
        email: email.toLowerCase(),
        _id: { $ne: req.user._id },
      })
        .select('_id')
        .lean();
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
    })
      .select(USER_PUBLIC_FIELDS)
      .lean();

    res.json({
      success: true,
      message: 'Profile updated',
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current and new password are required',
      });
    }

    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError) {
      return res.status(400).json({
        success: false,
        message: `New ${newPasswordError.toLowerCase()}`,
      });
    }

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    user.password = newPassword;
    // Audit finding F-03: changing the password must kill the sessions that were
    // authenticated with the old one.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully',
      // Every session that used the old password is now revoked, including this
      // one. Hand the caller a fresh token so the device that made the change
      // stays signed in instead of being logged out by its own security action.
      token: generateToken(user),
    });
  } catch (error) {
    next(error);
  }
};

exports.getAddresses = async (req, res, next) => {
  try {
    // One subdocument array, not a whole user row.
    const user = await User.findById(req.user._id).select('addresses').lean();
    res.json({
      success: true,
      data: user ? user.addresses : [],
    });
  } catch (error) {
    next(error);
  }
};

exports.addAddress = async (req, res, next) => {
  try {
    const { fullName, phone, addressLine1, addressLine2, city, state, pincode, country, isDefault } =
      req.body;

    if (!fullName || !phone || !addressLine1 || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        message: 'All address fields are required',
      });
    }

    const user = await User.findById(req.user._id);

    if (isDefault) {
      user.addresses.forEach((addr) => {
        addr.isDefault = false;
      });
    }

    user.addresses.push({
      fullName,
      phone,
      addressLine1,
      addressLine2: addressLine2 || '',
      city,
      state,
      pincode: String(pincode),
      country: country || 'India',
      isDefault: isDefault || user.addresses.length === 0,
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'Address added',
      data: user.addresses,
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
      data: user.addresses,
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
      data: user.addresses,
    });
  } catch (error) {
    next(error);
  }
};
