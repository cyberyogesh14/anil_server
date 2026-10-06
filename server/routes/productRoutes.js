const express = require('express');
const router = express.Router();
const {
  getProducts,
  getProductById,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
  getFeaturedProducts,
  getTataBS6Products,
  getProductsByCondition,
  getBestDeals,
  searchProducts,
  getProductsByCategory,
} = require('../controllers/productController');
const protect = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const upload = require('../middleware/uploadMiddleware');

router.get('/featured', getFeaturedProducts);
router.get('/tata-bs6', getTataBS6Products);
router.get('/best-deals', getBestDeals);
router.get('/search', searchProducts);
router.get('/condition/:condition', getProductsByCondition);
router.get('/category/:categoryId', getProductsByCategory);
router.get('/slug/:slug', getProductBySlug);

router.get('/', getProducts);
// optionalAuth, not protect: shoppers may read a product by id, but only staff or
// an admin may see an unpublished one (audit finding F-05). An absent or invalid
// token simply means "treat this as a public request".
router.get('/:id', optionalAuth, getProductById);

router.post('/', protect, requireRole('admin', 'staff'), upload.array('images', 5), createProduct);
router.put('/:id', protect, requireRole('admin', 'staff'), upload.array('images', 5), updateProduct);
router.delete('/:id', protect, requireRole('admin', 'staff'), deleteProduct);

module.exports = router;
