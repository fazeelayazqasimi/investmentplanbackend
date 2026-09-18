const asyncHandler = require('express-async-handler');
const Rank = require('../models/Rank');
const UserRank = require('../models/UserRank');
const RankHistory = require('../models/RankHistory');
const rankService = require('../services/rankService');

const getRanks = asyncHandler(async (req, res) => {
  const ranks = await rankService.getAllRanks();
  res.status(200).json({ success: true, data: ranks });
});

const createRank = asyncHandler(async (req, res) => {
  const { level, name, symbol, color, criteria, promotionType, autoPromotionCriteria, rankDowngradeEnabled } = req.body;

  const existing = await Rank.findOne({ level });
  if (existing) {
    const error = new Error('A rank with this level already exists');
    error.statusCode = 400;
    throw error;
  }

  const rank = await Rank.create({
    level,
    name,
    symbol: symbol || '',
    color: color || '#6366f1',
    criteria: criteria || {},
    promotionType: promotionType || 'AUTO',
    autoPromotionCriteria: autoPromotionCriteria || { requiredDirectRanks: 3 },
    rankDowngradeEnabled: rankDowngradeEnabled !== undefined ? rankDowngradeEnabled : true,
    createdBy: req.user.id,
  });

  res.status(201).json({ success: true, data: rank });
});

const updateRank = asyncHandler(async (req, res) => {
  const { name, symbol, color, criteria, promotionType, autoPromotionCriteria, isActive, rankDowngradeEnabled } = req.body;

  const rank = await Rank.findById(req.params.id);
  if (!rank) {
    const error = new Error('Rank not found');
    error.statusCode = 404;
    throw error;
  }

  if (name !== undefined) rank.name = name;
  if (symbol !== undefined) rank.symbol = symbol;
  if (color !== undefined) rank.color = color;
  if (criteria !== undefined) rank.criteria = criteria;
  if (promotionType !== undefined) rank.promotionType = promotionType;
  if (autoPromotionCriteria !== undefined) rank.autoPromotionCriteria = autoPromotionCriteria;
  if (isActive !== undefined) rank.isActive = isActive;
  if (rankDowngradeEnabled !== undefined) rank.rankDowngradeEnabled = rankDowngradeEnabled;

  await rank.save();
  res.status(200).json({ success: true, data: rank });
});

const deleteRank = asyncHandler(async (req, res) => {
  const rank = await Rank.findById(req.params.id);
  if (!rank) {
    const error = new Error('Rank not found');
    error.statusCode = 404;
    throw error;
  }

  await UserRank.deleteMany({ rank: rank._id });
  await Rank.findByIdAndDelete(req.params.id);

  res.status(200).json({ success: true, message: 'Rank deleted successfully' });
});

const toggleRank = asyncHandler(async (req, res) => {
  const rank = await Rank.findById(req.params.id);
  if (!rank) {
    const error = new Error('Rank not found');
    error.statusCode = 404;
    throw error;
  }

  rank.isActive = !rank.isActive;
  await rank.save();

  res.status(200).json({ success: true, data: rank });
});

const recalculateRanks = asyncHandler(async (req, res) => {
  const result = await rankService.recalculateAllRanks();
  res.status(200).json({
    success: true,
    message: `Recalculation complete: ${result.processed} processed, ${result.promoted} promoted, ${result.demoted} demoted`,
    data: result,
  });
});

const getMyRank = asyncHandler(async (req, res) => {
  const userRank = await rankService.getUserRank(req.user.id);
  const rankData = await rankService.getUserRankData(req.user.id);
  const allRanks = await rankService.getActiveRanks();

  res.status(200).json({
    success: true,
    data: {
      userRank,
      rankData,
      allRanks,
    },
  });
});

const getMyRankHistory = asyncHandler(async (req, res) => {
  const history = await rankService.getUserRankHistory(req.user.id);
  res.status(200).json({ success: true, data: history });
});

const getAllRanksPublic = asyncHandler(async (req, res) => {
  const ranks = await rankService.getActiveRanks();
  res.status(200).json({ success: true, data: ranks });
});

module.exports = {
  getRanks,
  createRank,
  updateRank,
  deleteRank,
  toggleRank,
  recalculateRanks,
  getMyRank,
  getMyRankHistory,
  getAllRanksPublic,
};
