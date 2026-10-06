process.env.NODE_ENV = 'test';
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');
const { hashOtp } = require('../utils/otp');

const [mode, email, value] = process.argv.slice(2);

(async () => {
  try {
    await connectDB();
    const user = await User.findOne({ email }).select(
      '+otpHash +otpExpiresAt +otpAttempts +lastOtpSentAt'
    );
    if (!user) {
      console.log('USER_NOT_FOUND');
      process.exit(1);
    }

    switch (mode) {
      case 'set':
        user.otpHash = hashOtp(value);
        user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        user.otpAttempts = 0;
        user.lastOtpSentAt = new Date(Date.now() - 2 * 60 * 1000);
        await user.save({ validateBeforeSave: false });
        console.log('OTP set to', value);
        break;
      case 'expire':
        user.otpHash = hashOtp(value);
        user.otpExpiresAt = new Date(Date.now() - 60 * 1000);
        user.otpAttempts = 0;
        await user.save({ validateBeforeSave: false });
        console.log('OTP expired for', value);
        break;
      case 'reset':
        user.otpHash = undefined;
        user.otpExpiresAt = undefined;
        user.otpAttempts = 0;
        user.lastOtpSentAt = new Date(Date.now() - 2 * 60 * 1000);
        await user.save({ validateBeforeSave: false });
        console.log('OTP cleared + resend cooldown reset');
        break;
      case 'show':
        console.log(
          JSON.stringify({
            emailVerified: user.emailVerified,
            hasHash: !!user.otpHash,
            expiresAt: user.otpExpiresAt,
            attempts: user.otpAttempts,
            lastSentAt: user.lastOtpSentAt,
          })
        );
        break;
      default:
        console.log('unknown mode');
    }
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();