const express = require('express');
const router = express.Router();

const { getProfile, updateProfile, updateProfilePhoto, activateAccount, activateDownline, depositDownline, getPublicConfig, getProgressData, searchMyDownlines } = require('../controllers/userController');
const {
  getMyUpline,
  getMyDownlines,
  getMyReferralTree,
  getEnrichedReferralData,
  getReferralStats,
} = require('../controllers/referralController');
const { authenticate } = require('../middleware/authMiddleware');
const { uploadProfilePhoto } = require('../middleware/uploadMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   GET /api/users/profile
router.get('/profile', authenticate, getProfile);

// @route   GET /api/users/config
router.get('/config', authenticate, getPublicConfig);

// @route   PUT /api/users/profile
router.put('/profile', authenticate, updateProfile);

// @route   PUT /api/users/profile/photo
router.put('/profile/photo', authenticate, uploadProfilePhoto, updateProfilePhoto);

// @route   POST /api/users/activate
router.post('/activate', authenticate, activateAccount);

// @route   POST /api/users/activate-downline
router.post('/activate-downline', authenticate, activateDownline);

// @route   POST /api/users/deposit-downline
router.post('/deposit-downline', authenticate, depositDownline);

// @route   GET /api/users/progress
router.get('/progress', authenticate, getProgressData);

// @route   GET /api/users/upline
router.get('/upline', authenticate, getMyUpline);

// @route   GET /api/users/downlines/search (MUST be before /downlines)
router.get('/downlines/search', authenticate, searchMyDownlines);

// @route   GET /api/users/downlines
router.get('/downlines', authenticate, getMyDownlines);

// @route   GET /api/users/tree
router.get('/tree', authenticate, getMyReferralTree);

// @route   GET /api/users/referrals/enriched
router.get('/referrals/enriched', authenticate, getEnrichedReferralData);

// @route   GET /api/users/referrals/stats
router.get('/referrals/stats', authenticate, getReferralStats);

module.exports = router;