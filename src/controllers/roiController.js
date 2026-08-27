const asyncHandler = require('express-async-handler');
const roiService = require('../services/roiService');

// ==========================================
// @desc    Get logged-in user's ROI history (across all investments)
// @route   GET /api/roi/history
// @access  Private (User)
// ==========================================
const getMyRoiHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const result = await roiService.getUserRoiHistory(req.user.id, {
    page: Number(page),
    limit: Number(limit),
  });

  res.status(200).json({
    success: true,
    message: 'ROI history fetched successfully',
    data: {
      history: result.history,
    },
    pagination: result.pagination,
  });
});

// ==========================================
// @desc    Get ROI history for a specific investment (must belong to user)
// @route   GET /api/investments/:id/roi-history
// @access  Private (User)
// ==========================================
const getInvestmentRoiHistory = asyncHandler(async (req, res) => {
  const history = await roiService.getInvestmentRoiHistory(
    req.params.id,
    req.user.id,
    false // enforce ownership check for regular users
  );

  res.status(200).json({
    success: true,
    message: 'Investment ROI history fetched successfully',
    data: {
      history,
    },
  });
});

module.exports = {
  getMyRoiHistory,
  getInvestmentRoiHistory,
};