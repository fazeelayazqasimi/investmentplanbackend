const asyncHandler = require('express-async-handler');
const investmentService = require('../services/investmentService');

// ==========================================
// @desc    Create a new investment (self-service)
// @route   POST /api/investments
// @access  Private (User)
// ==========================================
const createInvestment = asyncHandler(async (req, res) => {
  const { amount, startDate } = req.body;

  const investment = await investmentService.createInvestment({
    targetUserId: req.user.id,
    createdByUserId: req.user.id,
    createdByRole: req.user.role,
    amount,
    startDate,
  });

  res.status(201).json({
    success: true,
    message: 'Investment created successfully',
    data: {
      investment,
    },
  });
});

// ==========================================
// @desc    Get logged-in user's investments (paginated, filterable by status)
// @route   GET /api/investments
// @access  Private (User)
// ==========================================
const getMyInvestments = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;

  const result = await investmentService.getUserInvestments(req.user.id, {
    page: Number(page),
    limit: Number(limit),
    status,
  });

  res.status(200).json({
    success: true,
    message: 'Investments fetched successfully',
    data: {
      investments: result.investments,
    },
    pagination: result.pagination,
  });
});

// ==========================================
// @desc    Get a single investment's details (must belong to requester)
// @route   GET /api/investments/:id
// @access  Private (User)
// ==========================================
const getInvestmentDetails = asyncHandler(async (req, res) => {
  const investment = await investmentService.getInvestmentById(
    req.params.id,
    req.user.id,
    false // enforce ownership check for regular users
  );

  res.status(200).json({
    success: true,
    message: 'Investment details fetched successfully',
    data: {
      investment,
    },
  });
});

module.exports = {
  createInvestment,
  getMyInvestments,
  getInvestmentDetails,
};