const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

const OTP_SECRET = process.env.OTP_SECRET || process.env.JWT_SECRET;

const generateOtp = () =>
  String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

const hashOtp = (otp) =>
  crypto
    .createHmac('sha256', OTP_SECRET)
    .update(String(otp))
    .digest('hex');

const verifyOtp = (otp, storedHash) => {
  if (!storedHash || !otp) return false;
  const candidate = Buffer.from(hashOtp(otp));
  const stored = Buffer.from(storedHash);
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
};

const isOtpExpired = (user) =>
  !user.otpExpiresAt || user.otpExpiresAt.getTime() < Date.now();

const maskEmail = (email) => {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length <= 2 ? local[0] || '' : local.slice(0, 2);
  return `${visible}***@${domain}`;
};

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  generateOtp,
  hashOtp,
  verifyOtp,
  isOtpExpired,
  maskEmail,
};