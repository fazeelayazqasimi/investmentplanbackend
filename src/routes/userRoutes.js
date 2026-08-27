const express = require('express');
const router = express.Router();

const { getProfile, updateProfile } = require('../controllers/userController');
const {
  getMyUpline,
  getMyDownlines,
  getMyReferralTree,
} = require('../controllers/referralController');
const { authenticate } = require('../middleware/authMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   GET /api/users/profile
router.get('/profile', authenticate, getProfile);

// @route   PUT /api/users/profile
router.put('/profile', authenticate, updateProfile);

// @route   GET /api/users/upline
router.get('/upline', authenticate, getMyUpline);

// @route   GET /api/users/downlines
router.get('/downlines', authenticate, getMyDownlines);

// @route   GET /api/users/tree
router.get('/tree', authenticate, getMyReferralTree);

module.exports = router;