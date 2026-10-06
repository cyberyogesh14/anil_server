const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
} = require('../controllers/categoryController');
const protect = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.get('/', getCategories);
router.get('/:id', getCategoryById);

router.post('/', protect, requireRole('admin', 'staff'), upload.single('image'), createCategory);
router.put('/:id', protect, requireRole('admin', 'staff'), upload.single('image'), updateCategory);
router.delete('/:id', protect, requireRole('admin', 'staff'), deleteCategory);

module.exports = router;
