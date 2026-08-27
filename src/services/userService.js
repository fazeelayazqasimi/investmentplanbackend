const User = require('../models/User');

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
  const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  return `${baseUrl}/register?ref=${referralCode}`;
};

module.exports = {
  getUserProfile,
  updateUserProfile,
  buildReferralLink,
};

