const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  updateProfile,
  updateMarketingPreference,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmailOtp,
  resendEmailOtp,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
} = require('../controllers/authController');
const protect = require('../middleware/authMiddleware');
const {
  authLimiter,
  otpLimiter,
} = require('../middleware/rateLimitMiddleware');

router.post('/register', authLimiter, register);
router.post('/verify-email-otp', otpLimiter, verifyEmailOtp);
router.post('/resend-email-otp', otpLimiter, resendEmailOtp);
router.post('/login', authLimiter, login);
router.get('/me', protect, getMe);
router.get('/profile', protect, getMe);
router.put('/profile', protect, updateProfile);
router.put('/marketing-preference', protect, updateMarketingPreference);
router.post('/logout', protect, logout);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);
router.get('/addresses', protect, getAddresses);
router.post('/addresses', protect, addAddress);
router.put('/addresses/:id', protect, updateAddress);
router.delete('/addresses/:id', protect, deleteAddress);

module.exports = router;
