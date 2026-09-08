const asyncHandler = require('express-async-handler');
const referralService = require('../services/referralService');

// ==========================================
// @desc    Get logged-in user's upline
// @route   GET /api/users/upline
// @access  Private
// ==========================================
const getMyUpline = asyncHandler(async (req, res) => {
  const upline = await referralService.getUpline(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Upline fetched successfully',
    data: {
      upline,
    },
  });
});

// ==========================================
// @desc    Get logged-in user's direct downlines + counts
// @route   GET /api/users/downlines
// @access  Private
// ==========================================
const getMyDownlines = asyncHandler(async (req, res) => {
  const directDownlines = await referralService.getDirectDownlines(req.user.id);
  const counts = await referralService.getDownlineCounts(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Downlines fetched successfully',
    data: {
      directDownlines,
      directCount: counts.directCount,
      totalCount: counts.totalCount,
    },
  });
});

// ==========================================
// @desc    Get logged-in user's complete referral tree
// @route   GET /api/users/tree
// @access  Private
// ==========================================
const getMyReferralTree = asyncHandler(async (req, res) => {
  const tree = await referralService.getReferralTree(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Referral tree fetched successfully',
    data: {
      tree,
    },
  });
});

// ==========================================
// @desc    Get enriched referral data (stats, direct, indirect, tree)
// @route   GET /api/users/referrals/enriched
// @access  Private
// ==========================================
const getEnrichedReferralData = asyncHandler(async (req, res) => {
  const [stats, directDownlines, indirectDownlines, tree] = await Promise.all([
    referralService.getReferralStats(req.user.id),
    referralService.getEnrichedDirectDownlines(req.user.id),
    referralService.getEnrichedIndirectDownlines(req.user.id),
    referralService.getEnrichedReferralTree(req.user.id),
  ]);

  res.status(200).json({
    success: true,
    message: 'Enriched referral data fetched successfully',
    data: {
      stats,
      directDownlines,
      indirectDownlines,
      tree,
    },
  });
});

// ==========================================
// @desc    Get enriched referral stats only
// @route   GET /api/users/referrals/stats
// @access  Private
// ==========================================
const getReferralStats = asyncHandler(async (req, res) => {
  const stats = await referralService.getReferralStats(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Referral stats fetched successfully',
    data: {
      stats,
    },
  });
});

module.exports = {
  getMyUpline,
  getMyDownlines,
  getMyReferralTree,
  getEnrichedReferralData,
  getReferralStats,
};
