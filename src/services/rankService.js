const Rank = require('../models/Rank');
const UserRank = require('../models/UserRank');
const RankHistory = require('../models/RankHistory');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Investment = require('../models/Investment');

const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const getActiveRanks = async () => {
  return Rank.find({ isActive: true }).sort({ level: 1 }).lean();
};

const getAllRanks = async () => {
  return Rank.find({}).sort({ level: 1 }).lean();
};

const getUserRank = async (userId) => {
  return UserRank.findOne({ user: userId })
    .populate('rank')
    .populate('previousRank')
    .lean();
};

const getUserRankHistory = async (userId) => {
  return RankHistory.find({ user: userId })
    .populate('fromRank', 'name level symbol color')
    .populate('toRank', 'name level symbol color')
    .sort({ achievedAt: -1 })
    .lean();
};

const getUserRankData = async (userId) => {
  const wallet = await Wallet.findOne({ user: userId }).lean();
  const selfDeposit = wallet ? (wallet.totalInvestmentAmount || 0) : 0;

  const directDownlines = await User.find({ referredBy: userId }).select('_id').lean();
  const directIds = directDownlines.map((d) => d._id);

  let directBusiness = 0;
  let totalTeamBusiness = 0;
  const legs = directIds.length;

  if (directIds.length > 0) {
    const directInvestments = await Investment.aggregate([
      { $match: { user: { $in: directIds } } },
      { $group: { _id: null, total: { $sum: '$originalAmount' } } },
    ]);
    directBusiness = directInvestments[0]?.total || 0;

    const allDownlineIds = [userId, ...directIds];
    let currentParentIds = [...directIds];
    let level = 2;
    const MAX_DEPTH = 50;

    while (currentParentIds.length > 0 && level <= MAX_DEPTH) {
      const children = await User.find({ referredBy: { $in: currentParentIds } }).select('_id').lean();
      if (children.length === 0) break;
      children.forEach((c) => allDownlineIds.push(c._id));
      currentParentIds = children.map((c) => c._id);
      level += 1;
    }

    if (allDownlineIds.length > 0) {
      const teamInvestments = await Investment.aggregate([
        { $match: { user: { $in: allDownlineIds } } },
        { $group: { _id: null, total: { $sum: '$originalAmount' } } },
      ]);
      totalTeamBusiness = teamInvestments[0]?.total || 0;
    }
  }

  return {
    selfDeposit,
    directBusiness: roundToTwoDecimals(directBusiness),
    totalTeamBusiness: roundToTwoDecimals(totalTeamBusiness),
    legs,
  };
};

const checkRankCriteria = (userData, rank) => {
  const { criteria } = rank;
  return (
    userData.selfDeposit >= criteria.selfDeposit &&
    userData.directBusiness >= criteria.directBusiness &&
    userData.totalTeamBusiness >= criteria.totalTeamBusiness &&
    userData.legs >= criteria.legs
  );
};

const checkAutoPromotion = async (userId, rank) => {
  const requiredRanks = rank.autoPromotionCriteria?.requiredDirectRanks || 3;

  const previousLevel = rank.level - 1;
  if (previousLevel < 1) return { meets: true, qualifiedDirects: 0 };

  const previousRank = await Rank.findOne({ level: previousLevel }).lean();
  if (!previousRank) return { meets: false, qualifiedDirects: 0 };

  const directDownlines = await User.find({ referredBy: userId }).select('_id').lean();
  if (directDownlines.length === 0) return { meets: false, qualifiedDirects: 0 };

  const directIds = directDownlines.map((d) => d._id);

  const qualifiedCount = await UserRank.countDocuments({
    user: { $in: directIds },
    rank: previousRank._id,
  });

  return {
    meets: qualifiedCount >= requiredRanks,
    qualifiedDirects: qualifiedCount,
    requiredDirects: requiredRanks,
  };
};

const calculateUserRank = async (userId) => {
  const activeRanks = await getActiveRanks();
  if (activeRanks.length === 0) return { updated: false };

  const userData = await getUserRankData(userId);
  const currentUserRank = await UserRank.findOne({ user: userId }).lean();
  const currentRankLevel = currentUserRank?.rank
    ? (await Rank.findById(currentUserRank.rank).lean())?.level || 0
    : 0;

  let newRank = null;
  let reason = '';

  for (let i = activeRanks.length - 1; i >= 0; i--) {
    const rank = activeRanks[i];

    if (rank.level <= currentRankLevel) break;

    if (rank.promotionType === 'AUTO') {
      const autoCheck = await checkAutoPromotion(userId, rank);
      if (autoCheck.meets) {
        newRank = rank;
        reason = 'AUTO_PROMOTION';
        break;
      }
    } else {
      const meetsCriteria = checkRankCriteria(userData, rank);
      if (meetsCriteria) {
        newRank = rank;
        reason = 'CRITERIA_MET';
        break;
      }
    }
  }

  if (!newRank && currentRankLevel > 0) {
    const currentRank = await Rank.findById(currentUserRank.rank).lean();
    if (currentRank && currentRank.rankDowngradeEnabled) {
      const meetsCurrent = checkRankCriteria(userData, currentRank);
      if (!meetsCurrent) {
        const lowerRank = await Rank.findOne({ level: currentRank.level - 1, isActive: true }).lean();
        if (lowerRank) {
          newRank = lowerRank;
          reason = 'DOWNGRADE';
        } else {
          newRank = null;
          reason = 'DOWNGRADE';
        }
      }
    }
  }

  if (newRank && (!currentUserRank || currentUserRank.rank?.toString() !== newRank._id.toString())) {
    const previousRank = currentUserRank?.rank || null;

    if (reason === 'DOWNGRADE' && !newRank) {
      await UserRank.findOneAndUpdate(
        { user: userId },
        { rank: null, previousRank: previousRank, achievedAt: new Date() },
        { upsert: true }
      );
    } else {
      await UserRank.findOneAndUpdate(
        { user: userId },
        { rank: newRank._id, previousRank, achievedAt: new Date() },
        { upsert: true }
      );
    }

    await RankHistory.create({
      user: userId,
      fromRank: previousRank,
      toRank: newRank?._id || null,
      reason,
      details: userData,
      achievedAt: new Date(),
    });

    return { updated: true, newRank, reason };
  }

  return { updated: false };
};

const recalculateAllRanks = async () => {
  const allUsers = await User.find({ role: 'USER', accountStatus: 'ACTIVE' }).select('_id').lean();
  let processed = 0;
  let promoted = 0;
  let demoted = 0;

  for (const user of allUsers) {
    const before = await UserRank.findOne({ user: user._id }).lean();
    const result = await calculateUserRank(user._id);
    processed += 1;
    if (result.updated) {
      if (result.reason === 'DOWNGRADE') {
        demoted += 1;
      } else {
        promoted += 1;
      }
    }
  }

  return { processed, promoted, demoted };
};

module.exports = {
  getActiveRanks,
  getAllRanks,
  getUserRank,
  getUserRankHistory,
  getUserRankData,
  calculateUserRank,
  recalculateAllRanks,
  checkRankCriteria,
  checkAutoPromotion,
};
