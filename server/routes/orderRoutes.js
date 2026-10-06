const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderById,
  trackOrder,
  cancelOrder,
} = require('../controllers/orderController');
const protect = require('../middleware/authMiddleware');

router.get('/track/:orderNumber', trackOrder);

router.use(protect);

router.get('/', getOrders);
router.get('/:id', getOrderById);
router.post('/', createOrder);
router.put('/:id/cancel', cancelOrder);

module.exports = router;