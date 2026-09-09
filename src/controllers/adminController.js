const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Investment = require('../models/Investment');
const Transaction = require('../models/Transaction');
const ROIHistory = require('../models/ROIHistory');
const SystemSettings = require('../models/SystemSettings');
const roiService = require('../services/roiService');
const walletService = require('../services/walletService');
const { roundToTwoDecimals } = require('../services/walletService');
const bonusService = require('../services/bonusService');

// ==========================================
// @desc    List all users (admin only)
// @route   GET /api/admin/users
// @access  Private (Admin)
// ==========================================
const listUsers = asyncHandler(async (req, res) => {
  const { search, role, status, page = 1, limit = 50 } = req.query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const lim = Math.min(200, Number(limit));

  const match = {};
  if (role) match.role = role;
  if (status) match.accountStatus = status;
  if (search) {
    const re = new RegExp(search, 'i');
    match.$or = [{ name: re }, { email: re }, { phone: re }];
  }

  const [rows, total] = await Promise.all([
    User.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: lim },
      {
        $lookup: {
          from: 'wallets',
          localField: '_id',
          foreignField: 'user',
          as: 'wallet',
        },
      },
      {
        $lookup: {
          from: 'transactions',
          localField: '_id',
          foreignField: 'user',
          as: 'txns',
        },
      },
      {
        $addFields: {
          mainBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.mainBalance', 0] }, 0] },
          roiBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.roiBalance', 0] }, 0] },
          commissionBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.commissionBalance', 0] }, 0] },
          ewalletBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.ewalletBalance', 0] }, 0] },
          profitShareBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.profitShareBalance', 0] }, 0] },
          pendingCommissions: { $ifNull: [{ $arrayElemAt: ['$wallet.pendingCommissions', 0] }, 0] },
          fundBalance: { $ifNull: [{ $arrayElemAt: ['$wallet.fundBalance', 0] }, 0] },
          totalDeposited: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$txns',
                    as: 't',
                    cond: { $and: [{ $eq: ['$$t.type', 'DEPOSIT'] }, { $eq: ['$$t.status', 'COMPLETED'] }] },
                  },
                },
                as: 'x',
                in: '$$x.amount',
              },
            },
          },
          totalInvested: {
            $sum: {
              $map: {
                input: { $filter: { input: '$txns', as: 't', cond: { $eq: ['$$t.type', 'INVESTMENT'] } } },
                as: 'x',
                in: { $abs: '$$x.amount' },
              },
            },
          },
          totalRoi: {
            $sum: {
              $map: {
                input: { $filter: { input: '$txns', as: 't', cond: { $eq: ['$$t.type', 'ROI'] } } },
                as: 'x',
                in: '$$x.amount',
              },
            },
          },
          totalCommission: {
            $sum: {
              $map: {
                input: { $filter: { input: '$txns', as: 't', cond: { $eq: ['$$t.type', 'COMMISSION'] } } },
                as: 'x',
                in: '$$x.amount',
              },
            },
          },
        },
      },
      {
        $project: {
          password: 0,
          __v: 0,
          wallet: 0,
          txns: 0,
        },
      },
    ]),
    User.countDocuments(match),
  ]);

  res.status(200).json({
    success: true,
    message: 'Users fetched successfully',
    data: {
      users: rows,
      total,
      page: Number(page),
      limit: lim,
      totalPages: Math.ceil(total / lim),
    },
  });
});

// ==========================================
// @desc    Get full detail for a single user (admin only)
// @route   GET /api/admin/users/:id
// @access  Private (Admin)
// ==========================================
const getUserDetail = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error('Invalid user ID');
  }

  const user = await User.findById(userId).select('-password');
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const wallet = await Wallet.findOne({ user: userId });

  const [deposits, transactions, investments, roiHistory, downlines, totals] = await Promise.all([
    Transaction.find({ user: userId, type: 'DEPOSIT' }).sort({ createdAt: -1 }).limit(50).lean(),
    Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(50).lean(),
    Investment.find({ user: userId }).sort({ createdAt: -1 }).lean({ virtuals: true }),
    ROIHistory.find({ user: userId }).sort({ roiDate: -1 }).limit(50).populate({ path: 'investment', select: 'originalAmount' }).lean(),
    User.find({ referredBy: userId }).select('name email accountStatus createdAt').lean(),
    Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: { type: '$type', status: '$status' },
          total: {
            $sum: {
              $cond: [{ $eq: ['$type', 'INVESTMENT'] }, { $abs: '$amount' }, '$amount'],
            },
          },
        },
      },
    ]),
  ]);

  const sumMap = {};
  totals.forEach((t) => {
    sumMap[`${t._id.type}:${t._id.status}`] = t.total;
  });

  const financialSummary = {
    mainBalance: wallet ? wallet.mainBalance : 0,
    roiBalance: wallet ? wallet.roiBalance : 0,
    commissionBalance: wallet ? wallet.commissionBalance : 0,
    ewalletBalance: wallet ? wallet.ewalletBalance : 0,
    profitShareBalance: wallet ? wallet.profitShareBalance : 0,
    pendingCommissions: wallet ? wallet.pendingCommissions : 0,
    fundBalance: wallet ? wallet.fundBalance : 0,
    totalNetworkIncome: wallet ? wallet.totalNetworkIncome : 0,
    eligibleInvestmentBase: wallet ? wallet.eligibleInvestmentBase : 0,
    network3xCap: wallet ? roundToTwoDecimals((wallet.eligibleInvestmentBase || 0) * 3) : 0,
    totalDeposited: sumMap['DEPOSIT:COMPLETED'] || 0,
    totalInvested: sumMap['INVESTMENT:COMPLETED'] || 0,
    totalRoi: sumMap['ROI:COMPLETED'] || 0,
    totalCommission: sumMap['COMMISSION:COMPLETED'] || 0,
    totalEarnings: wallet ? wallet.totalEarnings : 0,
  };

  const upline = user.referredBy
    ? await User.findById(user.referredBy).select('name email').lean()
    : null;

  res.status(200).json({
    success: true,
    message: 'User detail fetched successfully',
    data: {
      user,
      wallet: wallet || null,
      financialSummary,
      deposits,
      transactions,
      investments,
      roiHistory,
      referrals: { upline, downlines },
    },
  });
});

// ==========================================
// @desc    List all investments across users (admin only)
// @route   GET /api/admin/investments
// @access  Private (Admin)
// ==========================================
const listInvestments = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 20 } = req.query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const lim = Math.min(100, Number(limit));

  const pipeline = [
    {
      $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user' },
    },
    { $unwind: '$user' },
  ];

  const match = {};
  if (status) match.status = status;
  if (search) {
    const re = new RegExp(search, 'i');
    match.$or = [{ 'user.name': re }, { 'user.email': re }];
  }
  pipeline.push({ $match: match });

  const countPipeline = [...pipeline, { $count: 'total' }];
  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: lim },
    { $project: { 'user.password': 0, 'user.__v': 0 } }
  );

  const [investments, countRes] = await Promise.all([
    Investment.aggregate(pipeline),
    Investment.aggregate(countPipeline),
  ]);

  const total = countRes[0] ? countRes[0].total : 0;

  res.status(200).json({
    success: true,
    message: 'Investments fetched successfully',
    data: {
      investments,
      pagination: {
        page: Number(page),
        limit: lim,
        total,
        totalPages: Math.ceil(total / lim),
      },
    },
  });
});

// ==========================================
// @desc    List all transactions across users (admin only)
// @route   GET /api/admin/transactions
// @access  Private (Admin)
// ==========================================
const listTransactions = asyncHandler(async (req, res) => {
  const { type, page = 1, limit = 20 } = req.query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const lim = Math.min(100, Number(limit));

  const pipeline = [
    {
      $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user' },
    },
    { $unwind: '$user' },
  ];

  const match = {};
  if (type) match.type = type;
  pipeline.push({ $match: match });

  const countPipeline = [...pipeline, { $count: 'total' }];
  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: lim },
    { $project: { 'user.password': 0, 'user.__v': 0 } }
  );

  const [transactions, countRes] = await Promise.all([
    Transaction.aggregate(pipeline),
    Transaction.aggregate(countPipeline),
  ]);

  const total = countRes[0] ? countRes[0].total : 0;

  res.status(200).json({
    success: true,
    message: 'Transactions fetched successfully',
    data: {
      transactions,
      pagination: {
        page: Number(page),
        limit: lim,
        total,
        totalPages: Math.ceil(total / lim),
      },
    },
  });
});

// ==========================================
// @desc    Platform statistics for admin dashboard (admin only)
// @route   GET /api/admin/stats
// @access  Private (Admin)
// ==========================================
const getStats = asyncHandler(async (req, res) => {
  const [totalUsers, totalAdmins, pendingDeposits, activeInvestments, totalInvestments] = await Promise.all([
    User.countDocuments({ role: 'USER' }),
    User.countDocuments({ role: 'ADMIN' }),
    Transaction.countDocuments({ type: 'DEPOSIT', status: 'PENDING' }),
    Investment.countDocuments({ status: 'ACTIVE' }),
    Investment.countDocuments(),
  ]);

  const [depositedAgg, investedAgg, roiAgg, commissionAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { type: 'INVESTMENT', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
    ]),
    Transaction.aggregate([
      { $match: { type: 'ROI', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { type: 'COMMISSION', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const totalDeposited = depositedAgg[0] ? depositedAgg[0].total : 0;
  const totalInvested = investedAgg[0] ? investedAgg[0].total : 0;
  const totalRoiDistributed = roiAgg[0] ? roiAgg[0].total : 0;
  const totalCommission = commissionAgg[0] ? commissionAgg[0].total : 0;

  // ---- Monthly trend buckets (last 6 months) ----
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const buckets = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets[key] = { month: key, users: 0, deposits: 0, investments: 0, roi: 0 };
  }

  const [signups, depositTrend, investmentTrend, roiTrend] = await Promise.all([
    User.find({ createdAt: { $gte: sixMonthsAgo } }).select('createdAt').lean(),
    Transaction.aggregate([
      { $match: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          total: { $sum: '$amount' },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { type: 'INVESTMENT', status: 'COMPLETED', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          total: { $sum: '$amount' },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { type: 'ROI', status: 'COMPLETED', createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          total: { $sum: '$amount' },
        },
      },
    ]),
  ]);

  signups.forEach((u) => {
    const key = `${u.createdAt.getFullYear()}-${String(u.createdAt.getMonth() + 1).padStart(2, '0')}`;
    if (buckets[key]) buckets[key].users += 1;
  });
  depositTrend.forEach((d) => {
    if (buckets[d._id]) buckets[d._id].deposits = d.total;
  });
  investmentTrend.forEach((d) => {
    if (buckets[d._id]) buckets[d._id].investments = d.total;
  });
  roiTrend.forEach((d) => {
    if (buckets[d._id]) buckets[d._id].roi = d.total;
  });

  const signupTrend = Object.values(buckets).map((b) => ({ month: b.month, users: b.users }));
  const depositTrendData = Object.values(buckets).map((b) => ({ month: b.month, deposits: b.deposits }));
  const investmentTrendData = Object.values(buckets).map((b) => ({ month: b.month, investments: b.investments }));
  const roiDistribution = Object.values(buckets).map((b) => ({ month: b.month, roi: b.roi }));

  res.status(200).json({
    success: true,
    message: 'Stats fetched successfully',
    data: {
      totalUsers,
      totalAdmins,
      pendingDeposits,
      activeInvestments,
      totalInvestments,
      totalDeposited,
      totalInvested,
      totalRoiDistributed,
      totalCommission,
      signupTrend,
      depositTrend: depositTrendData,
      investmentTrend: investmentTrendData,
      roiDistribution,
      usersVsAdmins: [
        { name: 'Users', value: totalUsers },
        { name: 'Admins', value: totalAdmins },
      ],
    },
  });
});

// ==========================================
// @desc    Get system settings (admin only)
// @route   GET /api/admin/settings
// @access  Private (Admin)
// ==========================================
const getSettings = asyncHandler(async (req, res) => {
  const settings = await SystemSettings.getSettings();
  res.status(200).json({
    success: true,
    message: 'Settings fetched successfully',
    data: { settings },
  });
});

// ==========================================
// @desc    Update system settings (admin only)
// @route   PUT /api/admin/settings
// @access  Private (Admin)
// ==========================================
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await SystemSettings.getSettings();
  const body = req.body || {};

  const allowedScalars = [
    'allowUserInvestment',
    'roiMode',
    'roiProcessingEnabled',
    'overallRoiPercentage',
    // E-Wallet
    'ewalletEnabled',
    'ewalletUsageEnabled',
    'signupBonusAmount',
    'uplineSignupBonusAmount',
    // Activation
    'activationFee',
    // Income
    'directIncomePercentage',
    'levelIncomePercentage',
    // ROI Transfer
    'roiTransferEnabled',
    'roiTransferDay',
    // Profit Share
    'profitShareTransferEnabled',
    'profitShareTransferDay',
    'profitShareDistributionMethod',
    // Fund Wallet
    'fundTransferEnabled',
  ];
  allowedScalars.forEach((key) => {
    if (body[key] !== undefined) settings[key] = body[key];
  });

  if (body.dayWiseRoi) {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    days.forEach((d) => {
      if (body.dayWiseRoi[d] !== undefined) settings.dayWiseRoi[d] = body.dayWiseRoi[d];
    });
  }

  settings.updatedBy = req.user.id;
  await settings.save();

  res.status(200).json({
    success: true,
    message: 'Settings updated successfully',
    data: { settings },
  });
});

// ==========================================
// @desc    Manually trigger ROI processing for today (admin only)
// @route   POST /api/admin/roi/process
// @access  Private (Admin)
// ==========================================
const processRoi = asyncHandler(async (req, res) => {
  const result = await roiService.processAllActiveInvestments(new Date());
  res.status(200).json({
    success: true,
    message: 'ROI processing completed',
    data: result,
  });
});

// ==========================================
// @desc    Distribute profit share to all users (admin only)
// @route   POST /api/admin/profit-share/distribute
// @access  Private (Admin)
// ==========================================
const distributeProfitShare = asyncHandler(async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || amount <= 0) {
    res.status(400);
    throw new Error('Distribution amount must be greater than zero');
  }
  const result = await bonusService.distributeProfitShare(
    Number(amount),
    req.user.id,
    method
  );
  res.status(200).json({
    success: true,
    message: 'Profit share distributed successfully',
    data: result,
  });
});

// ==========================================
// @desc    Trigger ROI transfer for all eligible users (admin only)
// @route   POST /api/admin/roi/transfer
// @access  Private (Admin)
// ==========================================
const triggerRoiTransfer = asyncHandler(async (req, res) => {
  const result = await walletService.adminTriggerRoiTransfer();
  res.status(200).json({
    success: true,
    message: 'ROI transfer triggered',
    data: result,
  });
});

// ==========================================
// @desc    Trigger profit share transfer for all eligible users (admin only)
// @route   POST /api/admin/profit-share/transfer
// @access  Private (Admin)
// ==========================================
const triggerProfitShareTransfer = asyncHandler(async (req, res) => {
  const result = await walletService.adminTriggerProfitShareTransfer();
  res.status(200).json({
    success: true,
    message: 'Profit share transfer triggered',
    data: result,
  });
});

// ==========================================
// @desc    Platform-wide referral network stats (admin only)
// @route   GET /api/admin/referrals/stats
// @access  Private (Admin)
// ==========================================
const getAdminReferralStats = asyncHandler(async (req, res) => {
  const totalMembers = await User.countDocuments({ role: 'USER' });
  const activeMembers = await User.countDocuments({ role: 'USER', accountStatus: 'ACTIVE', isActivated: true });
  const inactiveMembers = totalMembers - activeMembers;

  const directRelationships = await User.countDocuments({ referredBy: { $ne: null }, role: 'USER' });

  // Count total indirect relationships (all levels below direct)
  let totalIndirect = 0;
  const directUserIds = await User.find({ role: 'USER' }).select('_id').lean();
  const allIds = directUserIds.map((u) => u._id.toString());

  // BFS to count indirect relationships
  let currentParentIds = allIds;
  let level = 1;
  while (currentParentIds.length > 0 && level <= 50) {
    const children = await User.find({ referredBy: { $in: currentParentIds }, role: 'USER' }).select('_id').lean();
    if (children.length === 0) break;
    totalIndirect += children.length;
    currentParentIds = children.map((u) => u._id.toString());
    level += 1;
  }

  // Total team investment (all user investments)
  const investmentAgg = await Investment.aggregate([
    { $match: { status: 'ACTIVE' } },
    { $group: { _id: null, total: { $sum: '$originalAmount' } } },
  ]);
  const totalTeamInvestment = investmentAgg[0]?.total || 0;

  // Total network income generated (all direct + level income)
  const [directIncomeAgg, levelIncomeAgg, pendingAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'DIRECT_INCOME', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { type: 'LEVEL_INCOME', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Wallet.aggregate([
      { $group: { _id: null, total: { $sum: '$pendingCommissions' } } },
    ]),
  ]);

  const totalDirectIncome = directIncomeAgg[0]?.total || 0;
  const totalLevelIncome = levelIncomeAgg[0]?.total || 0;
  const totalNetworkIncome = totalDirectIncome + totalLevelIncome;
  const pendingCommissions = pendingAgg[0]?.total || 0;

  // Average team size
  const avgTeamSize = directRelationships > 0 ? (directRelationships + totalIndirect) / totalMembers : 0;

  res.status(200).json({
    success: true,
    message: 'Admin referral stats fetched successfully',
    data: {
      totalMembers,
      activeMembers,
      inactiveMembers,
      totalDirectRelationships: directRelationships,
      totalIndirectRelationships: totalIndirect,
      totalTeamInvestment,
      totalNetworkIncome,
      totalDirectIncome,
      totalLevelIncome,
      pendingCommissions,
      averageTeamSize: Math.round(avgTeamSize * 10) / 10,
    },
  });
});

// ==========================================
// @desc    Search users for referral explorer (admin only)
// @route   GET /api/admin/referrals/search
// @access  Private (Admin)
// ==========================================
const searchAdminReferralMembers = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 1) {
    return res.status(200).json({ success: true, data: { users: [] } });
  }

  const re = new RegExp(q.trim(), 'i');
  const users = await User.find({
    role: 'USER',
    $or: [{ name: re }, { email: re }, { referralCode: re }],
  })
    .select('name email referralCode accountStatus isActivated createdAt referredBy')
    .limit(20)
    .lean();

  // Enrich each user with direct child count and investment data
  const userIds = users.map((u) => u._id);
  const [directCounts, investmentAgg] = await Promise.all([
    User.aggregate([
      { $match: { referredBy: { $in: userIds } } },
      { $group: { _id: '$referredBy', count: { $sum: 1 } } },
    ]),
    Investment.aggregate([
      { $match: { user: { $in: userIds } } },
      { $group: { _id: '$user', totalInvestment: { $sum: '$originalAmount' } } },
    ]),
  ]);

  const directCountMap = {};
  directCounts.forEach((d) => { directCountMap[d._id.toString()] = d.count; });

  const investmentMap = {};
  investmentAgg.forEach((a) => { investmentMap[a._id.toString()] = a.totalInvestment; });

  res.status(200).json({
    success: true,
    data: {
      users: users.map((u) => ({
        ...u,
        directChildCount: directCountMap[u._id.toString()] || 0,
        totalInvestment: investmentMap[u._id.toString()] || 0,
      })),
    },
  });
});

// ==========================================
// @desc    Get enriched referral tree for any user (admin only)
// @route   GET /api/admin/referrals/tree/:userId
// @access  Private (Admin)
// ==========================================
const getAdminReferralTree = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { maxDepth = 10 } = req.query;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error('Invalid user ID');
  }

  const rootUser = await User.findById(userId)
    .select('name email referralCode accountStatus isActivated createdAt updatedAt')
    .lean();

  if (!rootUser) {
    res.status(404);
    throw new Error('User not found');
  }

  const walletCache = new Map();
  const depth = Math.min(Number(maxDepth), 20);

  const getWalletData = async (uid) => {
    const key = uid.toString();
    if (walletCache.has(key)) return walletCache.get(key);
    const w = await Wallet.findOne({ user: uid })
      .select('totalEarnings totalNetworkIncome pendingCommissions')
      .lean();
    const data = w || { totalEarnings: 0, totalNetworkIncome: 0, pendingCommissions: 0 };
    walletCache.set(key, data);
    return data;
  };

  const enrichNode = async (node, currentDepth) => {
    const [investmentData, roiData, directIncomeData, levelIncomeData, walletData, directCount] = await Promise.all([
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
      User.countDocuments({ referredBy: node._id }),
    ]);

    const inv = investmentData[0] || { totalInvestment: 0, totalRoiEarned: 0, count: 0 };
    const roi = roiData[0] || { totalRoiAmount: 0, count: 0 };
    const di = directIncomeData[0] || { total: 0, count: 0 };
    const li = levelIncomeData[0] || { total: 0, count: 0 };

    let children = [];
    if (currentDepth < depth) {
      const childUsers = await User.find({ referredBy: node._id })
        .select('name email referralCode accountStatus isActivated createdAt updatedAt')
        .lean();
      children = await Promise.all(
        childUsers.map((child) => enrichNode(child, currentDepth + 1))
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
      level: currentDepth,
      totalInvestment: inv.totalInvestment || 0,
      investmentCount: inv.count || 0,
      totalRoiEarned: roi.totalRoiAmount || inv.totalRoiEarned || 0,
      directIncome: di.total || 0,
      levelIncome: li.total || 0,
      directCount,
      totalTeamCount: 0, // will be computed in children
      wallet: walletData,
      children,
      truncated: currentDepth >= depth,
    };
  };

  // Build tree and compute total team counts bottom-up
  const tree = await enrichNode(rootUser, 0);

  const computeTeamCount = (node) => {
    let count = 0;
    if (node.children) {
      node.children.forEach((child) => {
        count += 1 + computeTeamCount(child);
      });
    }
    node.totalTeamCount = count;
    return count;
  };
  computeTeamCount(tree);

  res.status(200).json({
    success: true,
    message: 'Admin referral tree fetched successfully',
    data: { tree },
  });
});

// ==========================================
// @desc    Get member detail with upline path and downline summary (admin only)
// @route   GET /api/admin/referrals/member/:userId
// @access  Private (Admin)
// ==========================================
const getAdminReferralMemberDetail = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error('Invalid user ID');
  }

  const user = await User.findById(userId)
    .select('name email referralCode accountStatus isActivated createdAt updatedAt referredBy')
    .lean();

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Build upline path
  const uplinePath = [];
  let currentId = user.referredBy;
  const maxUplineDepth = 20;
  let depth = 0;
  while (currentId && depth < maxUplineDepth) {
    const upline = await User.findById(currentId)
      .select('name email referralCode accountStatus isActivated referredBy')
      .lean();
    if (!upline) break;
    uplinePath.unshift(upline);
    currentId = upline.referredBy;
    depth += 1;
  }

  // Get direct downlines
  const directDownlines = await User.find({ referredBy: userId })
    .select('name email referralCode accountStatus isActivated createdAt')
    .lean();

  // Get total downline count (BFS)
  let totalDownlineCount = 0;
  let currentLevelIds = [userId];
  let bfsLevel = 1;
  while (currentLevelIds.length > 0 && bfsLevel <= 50) {
    const children = await User.find({ referredBy: { $in: currentLevelIds } }).select('_id').lean();
    if (children.length === 0) break;
    totalDownlineCount += children.length;
    currentLevelIds = children.map((c) => c._id);
    bfsLevel += 1;
  }

  // Get financial data
  const [wallet, investmentAgg, roiAgg, directIncomeAgg, levelIncomeAgg] = await Promise.all([
    Wallet.findOne({ user: userId })
      .select('mainBalance roiBalance ewalletBalance profitShareBalance pendingCommissions fundBalance totalEarnings totalNetworkIncome eligibleInvestmentBase')
      .lean(),
    Investment.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: null, totalInvestment: { $sum: '$originalAmount' }, totalRoiEarned: { $sum: '$totalRoiEarned' }, count: { $sum: 1 } } },
    ]),
    ROIHistory.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), status: 'SUCCESS' } },
      { $group: { _id: null, totalRoiAmount: { $sum: '$roiAmount' } } },
    ]),
    Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), type: 'DIRECT_INCOME', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), type: 'LEVEL_INCOME', status: 'COMPLETED' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const inv = investmentAgg[0] || {};
  const roiData = roiAgg[0] || {};

  res.status(200).json({
    success: true,
    message: 'Member detail fetched successfully',
    data: {
      user,
      wallet: wallet || null,
      uplinePath,
      directDownlines: directDownlines.map((d) => ({
        _id: d._id,
        name: d.name,
        referralCode: d.referralCode,
        accountStatus: d.accountStatus,
        isActivated: d.isActivated,
      })),
      totalDownlineCount,
      directDownlineCount: directDownlines.length,
      financial: {
        totalInvestment: inv.totalInvestment || 0,
        investmentCount: inv.count || 0,
        totalRoiEarned: roiData.totalRoiAmount || inv.totalRoiEarned || 0,
        directIncome: directIncomeAgg[0]?.total || 0,
        levelIncome: levelIncomeAgg[0]?.total || 0,
        totalNetworkIncome: wallet?.totalNetworkIncome || 0,
        pendingCommissions: wallet?.pendingCommissions || 0,
        totalEarnings: wallet?.totalEarnings || 0,
      },
    },
  });
});

// ==========================================
// @desc    Get paginated/sorted member list for admin (admin only)
// @route   GET /api/admin/referrals/members
// @access  Private (Admin)
// ==========================================
const getAdminReferralMembers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    search,
    status,
    activated,
    hasInvestment,
    minInvestment,
    maxInvestment,
    joinFrom,
    joinTo,
    sort = 'createdAt',
    order = 'desc',
  } = req.query;

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const lim = Math.min(200, Number(limit));

  const match = { role: 'USER' };
  if (status) match.accountStatus = status;
  if (activated !== undefined) match.isActivated = activated === 'true';
  if (search) {
    const re = new RegExp(search, 'i');
    match.$or = [{ name: re }, { email: re }, { referralCode: re }];
  }
  if (joinFrom || joinTo) {
    match.createdAt = {};
    if (joinFrom) match.createdAt.$gte = new Date(joinFrom);
    if (joinTo) match.createdAt.$lte = new Date(joinTo);
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'wallets',
        localField: '_id',
        foreignField: 'user',
        as: 'wallet',
      },
    },
    {
      $lookup: {
        from: 'investments',
        localField: '_id',
        foreignField: 'user',
        as: 'investments',
      },
    },
    {
      $lookup: {
        from: 'transactions',
        localField: '_id',
        foreignField: 'user',
        as: 'transactions',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'referredBy',
        foreignField: '_id',
        as: 'sponsor',
      },
    },
    {
      $addFields: {
        walletData: { $arrayElemAt: ['$wallet', 0] },
        totalInvestment: {
          $sum: '$investments.originalAmount',
        },
        totalRoiEarned: {
          $sum: '$investments.totalRoiEarned',
        },
        investmentCount: { $size: '$investments' },
        directIncome: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$transactions',
                  as: 't',
                  cond: { $and: [{ $eq: ['$$t.type', 'DIRECT_INCOME'] }, { $eq: ['$$t.status', 'COMPLETED'] }] },
                },
              },
              as: 'x',
              in: '$$x.amount',
            },
          },
        },
        indirectIncome: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$transactions',
                  as: 't',
                  cond: { $and: [{ $eq: ['$$t.type', 'LEVEL_INCOME'] }, { $eq: ['$$t.status', 'COMPLETED'] }] },
                },
              },
              as: 'x',
              in: '$$x.amount',
            },
          },
        },
        pendingCommissions: { $ifNull: ['$walletData.pendingCommissions', 0] },
        totalEarnings: { $ifNull: ['$walletData.totalEarnings', 0] },
        sponsorName: { $arrayElemAt: ['$sponsor.name', 0] },
        sponsorReferralCode: { $arrayElemAt: ['$sponsor.referralCode', 0] },
      },
    },
  ];

  // Investment filters
  if (hasInvestment === 'true') {
    pipeline.push({ $match: { investmentCount: { $gt: 0 } } });
  } else if (hasInvestment === 'false') {
    pipeline.push({ $match: { investmentCount: 0 } });
  }
  if (minInvestment) {
    pipeline.push({ $match: { totalInvestment: { $gte: Number(minInvestment) } } });
  }
  if (maxInvestment) {
    pipeline.push({ $match: { totalInvestment: { $lte: Number(maxInvestment) } } });
  }

  // Count pipeline
  const countPipeline = [...pipeline, { $count: 'total' }];

  // Sorting
  const sortField = {
    name: 'name',
    createdAt: 'createdAt',
    totalInvestment: 'totalInvestment',
    totalRoiEarned: 'totalRoiEarned',
    directIncome: 'directIncome',
    indirectIncome: 'indirectIncome',
    totalEarnings: 'totalEarnings',
  }[sort] || 'createdAt';
  const sortOrder = order === 'asc' ? 1 : -1;

  pipeline.push(
    { $sort: { [sortField]: sortOrder } },
    { $skip: skip },
    { $limit: lim },
    {
      $project: {
        password: 0,
        __v: 0,
        wallet: 0,
        investments: 0,
        transactions: 0,
        sponsor: 0,
      },
    }
  );

  const [rows, countRes] = await Promise.all([
    User.aggregate(pipeline),
    User.aggregate(countPipeline),
  ]);

  const total = countRes[0] ? countRes[0].total : 0;

  res.status(200).json({
    success: true,
    message: 'Referral members fetched successfully',
    data: {
      members: rows,
      total,
      page: Number(page),
      limit: lim,
      totalPages: Math.ceil(total / lim),
    },
  });
});

module.exports = {
  listUsers,
  getUserDetail,
  listInvestments,
  listTransactions,
  getStats,
  getSettings,
  updateSettings,
  processRoi,
  distributeProfitShare,
  triggerRoiTransfer,
  triggerProfitShareTransfer,
  getAdminReferralStats,
  searchAdminReferralMembers,
  getAdminReferralTree,
  getAdminReferralMemberDetail,
  getAdminReferralMembers,
};
