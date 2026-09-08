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
    ROIHistory.find({ user: userId }).sort({ roiDate: -1 }).limit(50).populate({ path: 'investment', select: 'plan originalAmount' }).lean(),
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
    totalDeposited: sumMap['DEPOSIT:COMPLETED'] || 0,
    totalInvested: sumMap['INVESTMENT:COMPLETED'] || 0,
    totalRoi: sumMap['ROI:COMPLETED'] || 0,
    totalCommission: sumMap['COMMISSION:COMPLETED'] || 0,
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
    match.$or = [{ 'user.name': re }, { 'user.email': re }, { plan: re }];
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

  if (Array.isArray(body.plans)) {
    settings.plans = body.plans;
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
};
