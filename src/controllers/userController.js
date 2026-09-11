const asyncHandler = require('express-async-handler');
const userService = require('../services/userService');
const SystemSettings = require('../models/SystemSettings');
const Wallet = require('../models/Wallet');

// ==========================================
// @desc    Get logged-in user's profile
// @route   GET /api/users/profile
// @access  Private
// ==========================================
const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserProfile(req.user.id);

  const referralLink = userService.buildReferralLink(user.referralCode);

  res.status(200).json({
    success: true,
    message: 'Profile fetched successfully',
    data: {
      user,
      referralLink,
    },
  });
});

// ==========================================
// @desc    Update logged-in user's profile
// @route   PUT /api/users/profile
// @access  Private
// ==========================================
const updateProfile = asyncHandler(async (req, res) => {
  const updatedUser = await userService.updateUserProfile(req.user.id, req.body);

  const referralLink = userService.buildReferralLink(updatedUser.referralCode);

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: {
      user: updatedUser,
      referralLink,
    },
  });
});

// ==========================================
// @desc    Activate account (deducts fee from main wallet)
// @route   POST /api/users/activate
// @access  Private
// ==========================================
const activateAccount = asyncHandler(async (req, res) => {
  const { walletSource } = req.body;
  const result = await userService.activateAccount(req.user.id, walletSource || 'mainBalance');

  if (result.alreadyActivated) {
    return res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  const walletName = result.walletSource === 'fundBalance' ? 'Fund Wallet' : 'Main Wallet';
  res.status(200).json({
    success: true,
    message: `Account activated successfully. $${result.fee} deducted from ${walletName}.`,
    data: result,
  });
});

// ==========================================
// @desc    Public config for users (activation fee, etc.)
// @route   GET /api/users/config
// @access  Private (any logged-in user)
// ==========================================
const getPublicConfig = asyncHandler(async (req, res) => {
  const settings = await SystemSettings.getSettings();

  res.status(200).json({
    success: true,
    data: {
      activationFee: settings.activationFee || 0,
    },
  });
});

// ==========================================
// @desc    Get progress data for 2X and 3X milestones
// @route   GET /api/users/progress
// @access  Private (User)
// ==========================================
const getProgressData = asyncHandler(async (req, res) => {
  const wallet = await Wallet.findOne({ user: req.user.id });

  const totalInvestment = wallet ? (wallet.totalInvestmentAmount || 0) : 0;
  const totalMaxReturn = wallet ? (wallet.totalMaxReturn || 0) : 0;
  const totalReturned = wallet ? (wallet.totalReturned || 0) : 0;
  const totalEarnings = wallet ? (wallet.totalEarnings || 0) : 0;
  const eligibleBase = wallet ? (wallet.eligibleInvestmentBase || 0) : 0;
  const networkIncome = wallet ? (wallet.totalNetworkIncome || 0) : 0;
  const profitShareEarned = wallet ? (wallet.totalProfitShareEarned || 0) : 0;
  const totalAllEarnings = Math.round((networkIncome + profitShareEarned) * 100) / 100;

  // 2X Milestone: ROI cap (total investment * 2)
  const milestone2x = totalMaxReturn;
  const progress2x = totalReturned;
  const remaining2x = Math.max(0, milestone2x - progress2x);
  const percentage2x = milestone2x > 0 ? Math.min(100, Math.round((progress2x / milestone2x) * 100)) : 0;

  // 3X Milestone: Total earnings cap (eligible base * 3)
  const milestone3x = eligibleBase * 3;
  const progress3x = totalAllEarnings;
  const remaining3x = Math.max(0, milestone3x - progress3x);
  const percentage3x = milestone3x > 0 ? Math.min(100, Math.round((progress3x / milestone3x) * 100)) : 0;

  res.status(200).json({
    success: true,
    data: {
      totalInvestment,
      milestone2x,
      progress2x,
      remaining2x,
      percentage2x,
      milestone3x,
      progress3x,
      remaining3x,
      percentage3x,
      totalEarnings,
    },
  });
});

module.exports = {
  getProfile,
  updateProfile,
  activateAccount,
  getPublicConfig,
  getProgressData,
};