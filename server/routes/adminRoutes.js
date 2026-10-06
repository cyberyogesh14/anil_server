const express = require('express');
const router = express.Router();
const {
  getDashboard,
  getUsers,
  getUserById,
  updateUserStatus,
  deleteUser,
  getAdminOrders,
  getAdminOrderById,
  updateOrderStatus,
  updateSettings,
  permanentDeleteProduct,
} = require('../controllers/adminController');
const {
  getAudience,
  sendTest,
  sendCampaign,
  getCampaignHistory,
} = require('../controllers/emailCampaignController');
const protect = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const { emailLimiter } = require('../middleware/rateLimitMiddleware');

router.use(protect);

// Staff + admin: operational dashboard & order management
router.get('/dashboard', requireRole('admin', 'staff'), getDashboard);
router.get('/orders', requireRole('admin', 'staff'), getAdminOrders);
router.get('/orders/:id', requireRole('admin', 'staff'), getAdminOrderById);
router.put('/orders/:id/status', requireRole('admin', 'staff'), updateOrderStatus);

// Admin only: customer management, settings
router.get('/users', requireRole('admin'), getUsers);
router.get('/users/:id', requireRole('admin'), getUserById);
router.put('/users/:id/status', requireRole('admin'), updateUserStatus);
router.delete('/users/:id', requireRole('admin'), deleteUser);
router.put('/settings', requireRole('admin'), updateSettings);

// Admin only: permanent product deletion (staff can only soft-deactivate)
router.delete('/products/:id/permanent', requireRole('admin'), permanentDeleteProduct);

// Admin only: marketing emails
router.use('/emails', requireRole('admin'), emailLimiter);
router.get('/emails/audience', getAudience);
router.post('/emails/test', sendTest);
router.post('/emails/send', sendCampaign);
router.get('/emails/history', getCampaignHistory);

module.exports = router;