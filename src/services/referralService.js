const User = require('../models/User');

/**
 * Fetches the upline (direct sponsor) of a given user.
 * Returns null if the user has no upline (top of the tree).
 *
 * @param {string} userId
 * @returns {Promise<Object|null>} safe upline user object or null
 */
const getUpline = async (userId) => {
  const user = await User.findById(userId).populate({
    path: 'referredBy',
    select: 'name email referralCode accountStatus createdAt',
  });

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  return user.referredBy || null;
};

/**
 * Fetches only the direct downlines (level 1) of a given user.
 *
 * @param {string} userId
 * @returns {Promise<Array>} array of safe user objects
 */
const getDirectDownlines = async (userId) => {
  const downlines = await User.find({ referredBy: userId })
    .select('name email referralCode accountStatus createdAt')
    .lean();

  return downlines;
};

/**
 * Recursively fetches ALL downlines (direct + indirect) of a given user
 * using breadth-first traversal. Each result includes its depth/level
 * relative to the root user (1 = direct, 2 = indirect via a direct, etc).
 *
 * Uses level-by-level queries (not one query per user) to keep this
 * reasonably efficient for moderately sized trees.
 *
 * @param {string} userId
 * @returns {Promise<Array>} flat array of { user, level } objects
 */
const getAllDownlines = async (userId) => {
  const rootUser = await User.findById(userId);
  if (!rootUser) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const allDownlines = [];
  let currentLevelIds = [userId];
  let level = 1;

  const MAX_DEPTH = 50; // safety guard against pathological/corrupt data

  while (currentLevelIds.length > 0 && level <= MAX_DEPTH) {
    const currentLevelUsers = await User.find({
      referredBy: { $in: currentLevelIds },
    })
      .select('name email referralCode accountStatus referredBy createdAt')
      .lean();

    if (currentLevelUsers.length === 0) {
      break;
    }

    currentLevelUsers.forEach((u) => {
      allDownlines.push({ user: u, level });
    });

    currentLevelIds = currentLevelUsers.map((u) => u._id);
    level += 1;
  }

  return allDownlines;
};

/**
 * Builds a complete nested referral tree starting from a given user.
 * Each node contains the user's safe info plus a `children` array.
 *
 * @param {string} userId
 * @param {number} [maxDepth=10] - safety limit on tree depth
 * @returns {Promise<Object>} nested tree object
 */
const getReferralTree = async (userId, maxDepth = 10) => {
  const rootUser = await User.findById(userId)
    .select('name email referralCode accountStatus createdAt')
    .lean();

  if (!rootUser) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const buildNode = async (node, currentDepth) => {
    if (currentDepth >= maxDepth) {
      return { ...node, children: [], truncated: true };
    }

    const children = await User.find({ referredBy: node._id })
      .select('name email referralCode accountStatus createdAt')
      .lean();

    const childNodes = await Promise.all(
      children.map((child) => buildNode(child, currentDepth + 1))
    );

    return { ...node, children: childNodes };
  };

  return buildNode(rootUser, 0);
};

/**
 * Returns summary counts: direct downline count and total downline count.
 * Used by the dashboard.
 *
 * @param {string} userId
 * @returns {Promise<{directCount: number, totalCount: number}>}
 */
const getDownlineCounts = async (userId) => {
  const directCount = await User.countDocuments({ referredBy: userId });
  const allDownlines = await getAllDownlines(userId);

  return {
    directCount,
    totalCount: allDownlines.length,
  };
};

module.exports = {
  getUpline,
  getDirectDownlines,
  getAllDownlines,
  getReferralTree,
  getDownlineCounts,
};