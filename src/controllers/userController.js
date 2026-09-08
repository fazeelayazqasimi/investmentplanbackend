const asyncHandler = require('express-async-handler');
const userService = require('../services/userService');
const SystemSettings = require('../models/SystemSettings');

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
  const result = await userService.activateAccount(req.user.id);

  res.status(200).json({
    success: true,
    message: `Account activated successfully. $${result.fee} deducted from main wallet.`,
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

module.exports = {
  getProfile,
  updateProfile,
  activateAccount,
  getPublicConfig,
};