const express = require('express');
const router = express.Router();

const { getMyRoiHistory } = require('../controllers/roiController');
const { authenticate } = require('../middleware/authMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   GET /api/roi/history
router.get('/history', authenticate, getMyRoiHistory);

module.exports = router;