const User = require('../models/User');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');

/**
 * Rounds a number to 2 decimal places safely for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Fetches a user's profile by ID, excluding sensitive fields.
 * Optionally populates upline (referredBy) with minimal public info.
 *
 * @param {string} userId
 * @returns {Promise<Object>} safe user object
 */
const getUserProfile = async (userId) => {
  const user = await User.findById(userId).populate({
    path: 'referredBy',
    select: 'name email referralCode',
  });

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  return user.toSafeObject();
};

/**
 * Activates a user's account by deducting the activation fee from their
 * main wallet balance. One-time only — subsequent calls are rejected.
 *
 * @param {string} userId
 * @returns {Promise<{ transaction: Object, fee: number }>}
 */
const activateAccount = async (userId) => {
  const settings = await SystemSettings.getSettings();
  const fee = roundToTwoDecimals(settings.activationFee || 0);

  if (fee <= 0) {
    const error = new Error('Account activation is not required (fee is $0)');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  if (user.isActivated) {
    const error = new Error('Account is already activated');
    error.statusCode = 400;
    throw error;
  }

  const result = await walletService.adjustWalletBalance({
    userId,
    balanceField: 'mainBalance',
    amount: -fee,
    type: 'ACTIVATION_FEE',
    description: `One-time account activation fee - $${fee}`,
    createdBy: userId,
  });

  user.isActivated = true;
  await user.save();

  return { transaction: result.transaction, fee };
};

/**
 * Updates allowed profile fields for a user.
 * Restricts updates to a safe whitelist — role, referralCode,
 * accountStatus, password, etc. can NEVER be changed through this path.
 *
 * @param {string} userId
 * @param {Object} updates - raw update payload from request body
 * @returns {Promise<Object>} updated safe user object
 */
const updateUserProfile = async (userId, updates) => {
  const allowedFields = ['name', 'phone'];

  const sanitizedUpdates = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      sanitizedUpdates[field] = updates[field];
    }
  }

  if (Object.keys(sanitizedUpdates).length === 0) {
    const error = new Error('No valid fields provided to update');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findByIdAndUpdate(userId, sanitizedUpdates, {
    new: true,
    runValidators: true,
  }).populate({
    path: 'referredBy',
    select: 'name email referralCode',
  });

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  return user.toSafeObject();
};

/**
 * Builds the referral link for a given referral code.
 * Uses CLIENT_URL from environment configuration.
 *
 * @param {string} referralCode
 * @returns {string} full referral link
 */
const buildReferralLink = (referralCode) => {
  const baseUrl = process.env.CLIENT_URL || 'https://investmentplanfrontend.vercel.app';
  return `${baseUrl}/register?ref=${referralCode}`;
};

module.exports = {
  getUserProfile,
  updateUserProfile,
  buildReferralLink,
  activateAccount,
};

