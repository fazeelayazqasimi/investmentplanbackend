const User = require('../models/User');
const Investment = require('../models/Investment');
const ROIHistory = require('../models/ROIHistory');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');

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
    select: 'name email referralCode accountStatus isActivated createdAt',
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
    .select('name email referralCode accountStatus isActivated createdAt')
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

  const MAX_DEPTH = 50;

  while (currentLevelIds.length > 0 && level <= MAX_DEPTH) {
    const currentLevelUsers = await User.find({
      referredBy: { $in: currentLevelIds },
    })
      .select('name email referralCode accountStatus isActivated referredBy createdAt')
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
    .select('name email referralCode accountStatus isActivated createdAt')
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
      .select('name email referralCode accountStatus isActivated createdAt')
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

// ==========================================
// ENRICHED DATA FUNCTIONS
// ==========================================

/**
 * Fetches enriched direct downlines with investment, ROI, and income data.
 * Each member includes: user info, total investment, total ROI, direct income, last activity.
 *
 * @param {string} userId
 * @returns {Promise<Array>} array of enriched member objects
 */
const getEnrichedDirectDownlines = async (userId) => {
  const downlines = await User.find({ referredBy: userId })
    .select('name email referralCode accountStatus isActivated createdAt updatedAt')
    .sort({ createdAt: -1 })
    .lean();

  if (downlines.length === 0) return [];

  const memberIds = downlines.map((d) => d._id);

  const [investmentAgg, roiAgg, directIncomeTxns, wallets] = await Promise.all([
    Investment.aggregate([
      { $match: { user: { $in: memberIds } } },
      { $group: { _id: '$user', totalInvestment: { $sum: '$originalAmount' }, totalRoiEarned: { $sum: '$totalRoiEarned' }, investmentCount: { $sum: 1 }, lastInvestment: { $max: '$createdAt' } } },
    ]),
    ROIHistory.aggregate([
      { $match: { user: { $in: memberIds }, status: 'SUCCESS' } },
      { $group: { _id: '$user', totalRoiAmount: { $sum: '$roiAmount' }, roiCount: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { user: { $in: memberIds }, type: 'DIRECT_INCOME', status: 'COMPLETED' } },
      { $group: { _id: '$user', totalDirectIncome: { $sum: '$amount' }, txnCount: { $sum: 1 }, lastIncomeDate: { $max: '$createdAt' } } },
    ]),
    Wallet.find({ user: { $in: memberIds } })
      .select('user mainBalance roiBalance ewalletBalance profitShareBalance pendingCommissions fundBalance totalEarnings totalNetworkIncome')
      .lean(),
  ]);

  const investmentMap = {};
  investmentAgg.forEach((a) => { investmentMap[a._id.toString()] = a; });

  const roiMap = {};
  roiAgg.forEach((a) => { roiMap[a._id.toString()] = a; });

  const directIncomeMap = {};
  directIncomeTxns.forEach((a) => { directIncomeMap[a._id.toString()] = a; });

  const walletMap = {};
  wallets.forEach((w) => { walletMap[w.user.toString()] = w; });

  return downlines.map((d) => {
    const id = d._id.toString();
    const inv = investmentMap[id] || {};
    const roi = roiMap[id] || {};
    const inc = directIncomeMap[id] || {};
    const wallet = walletMap[id] || {};

    return {
      _id: d._id,
      name: d.name,
      email: d.email,
      referralCode: d.referralCode,
      accountStatus: d.accountStatus,
      isActivated: d.isActivated,
      createdAt: d.createdAt,
      lastActivity: d.updatedAt,
      totalInvestment: inv.totalInvestment || 0,
      investmentCount: inv.investmentCount || 0,
      lastInvestment: inv.lastInvestment || null,
      totalRoiEarned: roi.totalRoiAmount || inv.totalRoiEarned || 0,
      directIncome: inc.totalDirectIncome || 0,
      lastIncomeDate: inc.lastIncomeDate || null,
      wallet: {
        mainBalance: wallet.mainBalance || 0,
        roiBalance: wallet.roiBalance || 0,
        ewalletBalance: wallet.ewalletBalance || 0,
        profitShareBalance: wallet.profitShareBalance || 0,
        pendingCommissions: wallet.pendingCommissions || 0,
        fundBalance: wallet.fundBalance || 0,
        totalEarnings: wallet.totalEarnings || 0,
        totalNetworkIncome: wallet.totalNetworkIncome || 0,
      },
    };
  });
};

/**
 * Fetches enriched indirect (Level 2+) downlines with aggregated data.
 * Recursively finds ALL members below direct downlines (levels 2, 3, 4...).
 *
 * @param {string} userId
 * @returns {Promise<Array>} array of enriched indirect member objects
 */
const getEnrichedIndirectDownlines = async (userId) => {
  const directIds = (await User.find({ referredBy: userId }).select('_id').lean()).map((d) => d._id);

  if (directIds.length === 0) return [];

  // BFS to find ALL members below direct downlines (level 2+)
  const indirectUsers = [];
  let currentParentIds = [...directIds];
  let level = 2;

  const MAX_DEPTH = 50;

  while (currentParentIds.length > 0 && level <= MAX_DEPTH) {
    const children = await User.find({ referredBy: { $in: currentParentIds } })
      .select('name email referralCode accountStatus isActivated referredBy createdAt updatedAt')
      .lean();

    if (children.length === 0) break;

    children.forEach((u) => {
      indirectUsers.push({ ...u, level });
    });

    currentParentIds = children.map((u) => u._id);
    level += 1;
  }

  if (indirectUsers.length === 0) return [];

  const memberIds = indirectUsers.map((u) => u._id);

  const [investmentAgg, roiAgg, levelIncomeTxns, wallets] = await Promise.all([
    Investment.aggregate([
      { $match: { user: { $in: memberIds } } },
      { $group: { _id: '$user', totalInvestment: { $sum: '$originalAmount' }, totalRoiEarned: { $sum: '$totalRoiEarned' }, investmentCount: { $sum: 1 } } },
    ]),
    ROIHistory.aggregate([
      { $match: { user: { $in: memberIds }, status: 'SUCCESS' } },
      { $group: { _id: '$user', totalRoiAmount: { $sum: '$roiAmount' }, roiCount: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { user: { $in: memberIds }, type: 'LEVEL_INCOME', status: 'COMPLETED' } },
      { $group: { _id: '$user', totalLevelIncome: { $sum: '$amount' }, txnCount: { $sum: 1 }, lastIncomeDate: { $max: '$createdAt' } } },
    ]),
    Wallet.find({ user: { $in: memberIds } })
      .select('user mainBalance roiBalance ewalletBalance profitShareBalance pendingCommissions fundBalance totalEarnings totalNetworkIncome')
      .lean(),
  ]);

  const investmentMap = {};
  investmentAgg.forEach((a) => { investmentMap[a._id.toString()] = a; });

  const roiMap = {};
  roiAgg.forEach((a) => { roiMap[a._id.toString()] = a; });

  const levelIncomeMap = {};
  levelIncomeTxns.forEach((a) => { levelIncomeMap[a._id.toString()] = a; });

  const walletMap = {};
  wallets.forEach((w) => { walletMap[w.user.toString()] = w; });

  return indirectUsers.map((u) => {
    const id = u._id.toString();
    const inv = investmentMap[id] || {};
    const roi = roiMap[id] || {};
    const inc = levelIncomeMap[id] || {};
    const wallet = walletMap[id] || {};

    return {
      _id: u._id,
      name: u.name,
      email: u.email,
      referralCode: u.referralCode,
      accountStatus: u.accountStatus,
      isActivated: u.isActivated,
      createdAt: u.createdAt,
      lastActivity: u.updatedAt,
      parent: u.referredBy,
      level: u.level,
      totalInvestment: inv.totalInvestment || 0,
      investmentCount: inv.investmentCount || 0,
      totalRoiEarned: roi.totalRoiAmount || inv.totalRoiEarned || 0,
      levelIncome: inc.totalLevelIncome || 0,
      lastIncomeDate: inc.lastIncomeDate || null,
      wallet: {
        mainBalance: wallet.mainBalance || 0,
        roiBalance: wallet.roiBalance || 0,
        ewalletBalance: wallet.ewalletBalance || 0,
        profitShareBalance: wallet.profitShareBalance || 0,
        pendingCommissions: wallet.pendingCommissions || 0,
        fundBalance: wallet.fundBalance || 0,
        totalEarnings: wallet.totalEarnings || 0,
        totalNetworkIncome: wallet.totalNetworkIncome || 0,
      },
    };
  });
};

/**
 * Builds a complete enriched referral tree with investment, ROI, and income data.
 * Each node includes the user info plus financial data and a `children` array.
 *
 * @param {string} userId
 * @param {number} [maxDepth=10]
 * @returns {Promise<Object>} enriched nested tree object
 */
const getEnrichedReferralTree = async (userId, maxDepth = 10) => {
  const rootUser = await User.findById(userId)
    .select('name email referralCode accountStatus isActivated createdAt updatedAt')
    .lean();

  if (!rootUser) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const walletCache = new Map();

  const getWalletData = async (uid) => {
    const key = uid.toString();
    if (walletCache.has(key)) return walletCache.get(key);
    const w = await Wallet.findOne({ user: uid })
      .select('mainBalance roiBalance ewalletBalance profitShareBalance pendingCommissions fundBalance totalEarnings totalNetworkIncome')
      .lean();
    const data = w || { mainBalance: 0, roiBalance: 0, ewalletBalance: 0, profitShareBalance: 0, pendingCommissions: 0, fundBalance: 0, totalEarnings: 0, totalNetworkIncome: 0 };
    walletCache.set(key, data);
    return data;
  };

  const enrichNode = async (node, depth = 0) => {
    const [investmentData, roiData, directIncomeData, levelIncomeData, walletData] = await Promise.all([
      Investment.aggregate([
        { $match: { user: node._id } },
        { $group: { _id: null, totalInvestment: { $sum: '$originalAmount' }, totalRoiEarned: { $sum: '$totalRoiEarned' }, count: { $sum: 1 } } },
      ]),
      ROIHistory.aggregate([
        { $match: { user: node._id, status: 'SUCCESS' } },
        { $group: { _id: null, totalRoiAmount: { $sum: '$roiAmount' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { user: node._id, type: 'DIRECT_INCOME', status: 'COMPLETED' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { user: node._id, type: 'LEVEL_INCOME', status: 'COMPLETED' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      getWalletData(node._id),
    ]);

    const inv = investmentData[0] || { totalInvestment: 0, totalRoiEarned: 0, count: 0 };
    const roi = roiData[0] || { totalRoiAmount: 0, count: 0 };
    const di = directIncomeData[0] || { total: 0, count: 0 };
    const li = levelIncomeData[0] || { total: 0, count: 0 };

    let children = [];
    if (depth < maxDepth) {
      const childUsers = await User.find({ referredBy: node._id })
        .select('name email referralCode accountStatus isActivated createdAt updatedAt')
        .lean();

      children = await Promise.all(
        childUsers.map((child) => enrichNode(child, depth + 1))
      );
    }

    return {
      _id: node._id,
      name: node.name,
      email: node.email,
      referralCode: node.referralCode,
      accountStatus: node.accountStatus,
      isActivated: node.isActivated,
      createdAt: node.createdAt,
      lastActivity: node.updatedAt,
      level: depth,
      totalInvestment: inv.totalInvestment || 0,
      investmentCount: inv.count || 0,
      totalRoiEarned: roi.totalRoiAmount || inv.totalRoiEarned || 0,
      directIncome: di.total || 0,
      levelIncome: li.total || 0,
      wallet: walletData,
      children,
      truncated: depth >= maxDepth,
    };
  };

  return enrichNode(rootUser, 0);
};

/**
 * Returns comprehensive referral statistics.
 *
 * @param {string} userId
 * @returns {Promise<Object>} stats object
 */
const getReferralStats = async (userId) => {
  const allDownlines = await getAllDownlines(userId);

  const directMembers = allDownlines.filter((d) => d.level === 1);
  const indirectMembers = allDownlines.filter((d) => d.level >= 2);

  const allIds = allDownlines.map((d) => d.user._id.toString());

  let totalTeamInvestment = 0;
  let activeDirectCount = 0;
  let inactiveDirectCount = 0;
  let activeIndirectCount = 0;
  let inactiveIndirectCount = 0;

  if (allIds.length > 0) {
    const investmentAgg = await Investment.aggregate([
      { $match: { user: { $in: allIds.map((id) => new (require('mongoose').Types.ObjectId)(id)) } } },
      { $group: { _id: null, total: { $sum: '$originalAmount' } } },
    ]);
    totalTeamInvestment = investmentAgg[0]?.total || 0;
  }

  directMembers.forEach((d) => {
    if (d.user.isActivated && d.user.accountStatus === 'ACTIVE') {
      activeDirectCount++;
    } else {
      inactiveDirectCount++;
    }
  });

  indirectMembers.forEach((d) => {
    if (d.user.isActivated && d.user.accountStatus === 'ACTIVE') {
      activeIndirectCount++;
    } else {
      inactiveIndirectCount++;
    }
  });

  return {
    totalMembers: allDownlines.length,
    directCount: directMembers.length,
    indirectCount: indirectMembers.length,
    activeDirectCount,
    inactiveDirectCount,
    activeIndirectCount,
    inactiveIndirectCount,
    activeTotalCount: activeDirectCount + activeIndirectCount,
    inactiveTotalCount: inactiveDirectCount + inactiveIndirectCount,
    totalTeamInvestment,
  };
};

module.exports = {
  getUpline,
  getDirectDownlines,
  getAllDownlines,
  getReferralTree,
  getDownlineCounts,
  getEnrichedDirectDownlines,
  getEnrichedIndirectDownlines,
  getEnrichedReferralTree,
  getReferralStats,
};