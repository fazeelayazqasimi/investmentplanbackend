const asyncHandler = require('express-async-handler');
const userService = require('../services/userService');

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

module.exports = {
  getProfile,
  updateProfile,
};