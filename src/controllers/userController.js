const asyncHandler = require('express-async-handler');
const userService = require('../services/userService');
const walletService = require('../services/walletService');
const referralService = require('../services/referralService');
const SystemSettings = require('../models/SystemSettings');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const { cloudinary } = require('../middleware/uploadMiddleware');

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
// @desc    Upload/update logged-in user's profile photo
// @route   PUT /api/users/profile/photo
// @access  Private
// ==========================================
const updateProfilePhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('Profile photo is required');
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (user.avatarPublicId) {
    try {
      await cloudinary.uploader.destroy(user.avatarPublicId);
    } catch (_) { /* old photo cleanup is best-effort */ }
  }

  user.avatar = req.file.path;
  user.avatarPublicId = req.file.filename;
  await user.save();

  res.status(200).json({
    success: true,
    message: 'Profile photo updated successfully',
    data: {
      user: user.toSafeObject(),
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
  const totalRoiEarned = wallet ? (wallet.totalRoiEarned || 0) : 0;
  const totalEligibleEarnings = wallet ? (wallet.totalEligibleEarnings || 0) : 0;
  const cycle2xCompletions = wallet ? (wallet.cycle2xCompletions || 0) : 0;
  const eligibleInvestmentBase = wallet ? (wallet.eligibleInvestmentBase || 0) : 0;

  // 2X Milestone: ROI cap (total investment * 2) — GLOBAL
  const milestone2x = totalInvestment * 2;
  const progress2x = totalRoiEarned;
  const remaining2x = Math.max(0, milestone2x - progress2x);
  const percentage2x = milestone2x > 0 ? Math.min(100, Math.round((progress2x / milestone2x) * 100)) : 0;

  // 3X Milestone: Total earnings cap — based on user's own investment only
  const milestone3x = totalInvestment * 3;
  const progress3x = totalEligibleEarnings;
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
      cycle2xCompletions,
      milestone3x,
      progress3x,
      remaining3x,
      percentage3x,
    },
  });
});

// ==========================================
// @desc    Search logged-in user's downlines by email/name (for fund transfer)
// @route   GET /api/users/downlines/search
// @access  Private (User)
// ==========================================
const searchMyDownlines = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 1) {
    return res.status(200).json({
      success: true,
      data: { users: [] },
    });
  }

  const allDownlines = await referralService.getAllDownlines(req.user.id);

  if (allDownlines.length === 0) {
    return res.status(200).json({
      success: true,
      data: { users: [] },
    });
  }

  const downlineIds = allDownlines.map((d) => d.user._id);

  const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');

  const matchedUsers = await User.find({
    _id: { $in: downlineIds },
    $or: [{ name: re }, { email: re }],
  })
    .select('name email accountStatus isActivated')
    .limit(10)
    .lean();

  // Fetch wallet balances for matched users
  const matchedIds = matchedUsers.map((u) => u._id);
  const wallets = await Wallet.find({ user: { $in: matchedIds } })
    .select('user mainBalance roiBalance ewalletBalance profitShareBalance fundBalance')
    .lean();

  const walletMap = {};
  wallets.forEach((w) => { walletMap[w.user.toString()] = w; });

  const usersWithBalance = matchedUsers.map((u) => {
    const w = walletMap[u._id.toString()] || {};
    const totalBalance = (w.mainBalance || 0) + (w.roiBalance || 0) + (w.ewalletBalance || 0) + (w.profitShareBalance || 0) + (w.fundBalance || 0);
    return {
      _id: u._id,
      name: u.name,
      email: u.email,
      accountStatus: u.accountStatus,
      isActivated: u.isActivated,
      totalBalance: Math.round((totalBalance + Number.EPSILON) * 100) / 100,
    };
  });

  res.status(200).json({
    success: true,
    data: { users: usersWithBalance },
  });
});

// ==========================================
// @desc    Activate a downline account using sender's E-Wallet
// @route   POST /api/users/activate-downline
// @access  Private (User)
// ==========================================
const activateDownline = asyncHandler(async (req, res) => {
  const { receiverId } = req.body;

  if (!receiverId) {
    res.status(400);
    throw new Error('Receiver ID is required');
  }

  const result = await userService.activateDownlineAccount(req.user.id, receiverId);

  if (result.alreadyActivated) {
    return res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  }

  res.status(200).json({
    success: true,
    message: `Downline account activated successfully. $${result.fee} deducted from your E-Wallet.`,
    data: result,
  });
});

// ==========================================
// @desc    Deposit to a downline account using sender's E-Wallet
// @route   POST /api/users/deposit-downline
// @access  Private (User)
// ==========================================
const depositDownline = asyncHandler(async (req, res) => {
  const { receiverId, amount } = req.body;

  if (!receiverId) {
    res.status(400);
    throw new Error('Receiver ID is required');
  }
  if (!amount || Number(amount) <= 0) {
    res.status(400);
    throw new Error('Deposit amount must be greater than zero');
  }

  const result = await walletService.depositForDownline(req.user.id, receiverId, Number(amount));

  res.status(200).json({
    success: true,
    message: `$${result.amount} deposited to ${result.receiver.name || result.receiver.email} successfully.`,
    data: result,
  });
});

module.exports = {
  getProfile,
  updateProfile,
  updateProfilePhoto,
  activateAccount,
  activateDownline,
  depositDownline,
  getPublicConfig,
  getProgressData,
  searchMyDownlines,
};