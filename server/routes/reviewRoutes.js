const express = require('express');
const router = express.Router();
const {
  getProductReviews,
  createReview,
  updateReview,
  deleteReview,
} = require('../controllers/reviewController');
const protect = require('../middleware/authMiddleware');

router.get('/products/:productId/reviews', getProductReviews);
router.post('/products/:productId/reviews', protect, createReview);
router.put('/reviews/:id', protect, updateReview);
router.delete('/reviews/:id', protect, deleteReview);

module.exports = router;
