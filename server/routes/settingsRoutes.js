const express = require('express');
const router = express.Router();
const { getPublicSettings } = require('../controllers/settingsController');

router.get('/', getPublicSettings);

module.exports = router;