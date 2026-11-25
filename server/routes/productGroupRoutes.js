const express = require('express');
const router = express.Router();
const protect = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const upload = require('../middleware/uploadMiddleware');
const {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
} = require('../controllers/productGroupController');

router.use(protect);
router.use(requireRole('admin', 'staff'));

router.get('/', listGroups);
router.get('/:id', getGroup);
router.post('/', upload.array('images', 5), createGroup);
router.put('/:id', upload.array('images', 5), updateGroup);
router.delete('/:id', deleteGroup);

module.exports = router;
