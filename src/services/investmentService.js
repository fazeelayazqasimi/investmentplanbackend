const mongoose = require('mongoose');
const Investment = require('../models/Investment');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');
const bonusService = require('./bonusService');
const { getCapStatus, pauseAllActive } = require('./capService');

/**
 * Rounds a number to 2 decimal places safely, avoiding common
 * floating-point artifacts for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Creates a new investment.
 *
 * For self-service (USER) creation this enforces the allowUserInvestment
 * setting, verifies the user has sufficient main balance, and deducts the
 * investment amount from the wallet atomically (a single MongoDB session).
 * The frontend-supplied amount is NEVER trusted — the balance check and
 * deduction happen server-side.
 *
 * @param {Object} params
 * @param {string} params.targetUserId - the user the investment belongs to
 * @param {string} params.createdByUserId - who is creating it (self or admin)
 * @param {string} params.createdByRole - 'USER' or 'ADMIN'
 * @param {number} params.amount
 * @param {string} [params.startDate]
 * @returns {Promise<Object>} the created investment
 */
const createInvestment = async ({
  targetUserId,
  createdByUserId,
  createdByRole,
  amount,
  startDate,
  walletBreakdown,
}) => {
  const settings = await SystemSettings.getSettings();
  const roundedAmount = roundToTwoDecimals(amount);

  // Enforce allowUserInvestment setting for self-service creation only.
  if (createdByRole === 'USER' && !settings.allowUserInvestment) {
    const error = new Error(
      'Self-service investment creation is currently disabled. Please contact an administrator.'
    );
    error.statusCode = 403;
    throw error;
  }

  // Parse wallet breakdown (multi-wallet split)
  const mainAmt = roundToTwoDecimals(Number(walletBreakdown?.main) || 0);
  const ewalletAmt = roundToTwoDecimals(Number(walletBreakdown?.ewallet) || 0);
  const fundAmt = roundToTwoDecimals(Number(walletBreakdown?.fund) || 0);
  const hasBreakdown = walletBreakdown && (mainAmt > 0 || ewalletAmt > 0 || fundAmt > 0);

  // If breakdown provided, validate it sums to total
  if (hasBreakdown) {
    const breakdownTotal = roundToTwoDecimals(mainAmt + ewalletAmt + fundAmt);
    if (Math.abs(breakdownTotal - roundedAmount) > 0.01) {
      const error = new Error(`Wallet split ($${breakdownTotal}) must equal investment amount ($${roundedAmount})`);
      error.statusCode = 400;
      throw error;
    }

    // Self-investment: E-Wallet payment option must be enabled by admin
    if (createdByRole === 'USER' && ewalletAmt > 0 && !settings.ewalletInvestmentEnabled) {
      const error = new Error('E-Wallet for investment is currently disabled by admin');
      error.statusCode = 400;
      throw error;
    }

    // Self-investment E-Wallet max percentage enforcement
    if (createdByRole === 'USER' && settings.ewalletInvestmentEnabled && ewalletAmt > 0 && settings.selfInvestmentEwalletMaxPercentage > 0) {
      const maxEwallet = roundToTwoDecimals(roundedAmount * settings.selfInvestmentEwalletMaxPercentage / 100);
      if (ewalletAmt > maxEwallet) {
        const error = new Error(`E-Wallet cannot exceed ${settings.selfInvestmentEwalletMaxPercentage}% of investment amount (max $${maxEwallet})`);
        error.statusCode = 400;
        throw error;
      }
    }
  }

  // Use ROI settings based on mode
  const roiPercentage = settings.roiMode === 'DAY_WISE' ? 0 : (settings.overallRoiPercentage || 0);
  const durationDays = settings.roiMode === 'DAY_WISE' ? (settings.roiDays || null) : null;

  const computedStartDate = startDate ? new Date(startDate) : new Date();
  const computedEndDate = durationDays
    ? new Date(computedStartDate.getTime() + durationDays * 24 * 60 * 60 * 1000)
    : null;

  const session = await mongoose.startSession();

  try {
    let investment;

    await session.withTransaction(async () => {
      // Re-check balance inside the transaction (authoritative, server-side).
      const wallet = await Wallet.findOne({ user: targetUserId }).session(session);
      const availableMain = wallet ? wallet.mainBalance : 0;
      const availableEwallet = wallet ? wallet.ewalletBalance : 0;
      const availableFund = wallet ? wallet.fundBalance : 0;

      if (hasBreakdown) {
        // Validate each wallet has sufficient balance
        if (mainAmt > availableMain) {
          const error = new Error(`Insufficient Main Wallet balance. Available: $${availableMain}`);
          error.statusCode = 400;
          throw error;
        }
        if (ewalletAmt > availableEwallet) {
          const error = new Error(`Insufficient E-Wallet balance. Available: $${availableEwallet}`);
          error.statusCode = 400;
          throw error;
        }
        if (fundAmt > availableFund) {
          const error = new Error(`Insufficient Fund Wallet balance. Available: $${availableFund}`);
          error.statusCode = 400;
          throw error;
        }
      } else {
        // Legacy: deduct all from main balance
        if (availableMain < roundedAmount) {
          const error = new Error('Insufficient main balance for this investment');
          error.statusCode = 400;
          throw error;
        }
      }

      // --- ACCOUNT ACTIVATION CHECK ---
      const user = await User.findById(targetUserId).session(session);
      if (user && !user.isActivated) {
        const error = new Error(
          'Please activate your account first before investing. Go to Dashboard > Activate Account.'
        );
        error.statusCode = 400;
        throw error;
      }

      // Create investment with full amount
      investment = await Investment.create(
        [
          {
            user: targetUserId,
            originalAmount: roundedAmount,
            maxReturnAmount: roundToTwoDecimals(roundedAmount * 2),
            totalRoiEarned: 0,
            totalReturned: 0,
            status: 'ACTIVE',
            roiMode: settings.roiMode,
            roiPercentage,
            dayWiseRoiSchedule: settings.roiMode === 'DAY_WISE' ? settings.dayWiseRoiSchedule : [],
            durationDays,
            startDate: computedStartDate,
            endDate: computedEndDate,
            createdBy: createdByUserId,
          },
        ],
        { session }
      );

      if (hasBreakdown) {
        // Deduct from each wallet separately
        if (mainAmt > 0) {
          await walletService.adjustWalletBalance({
            userId: targetUserId,
            balanceField: 'mainBalance',
            amount: -mainAmt,
            type: 'INVESTMENT',
            investmentId: investment[0]._id,
            description: `Investment from Main Wallet: $${mainAmt}`,
            createdBy: createdByUserId,
            session,
          });
        }
        if (ewalletAmt > 0) {
          await walletService.adjustWalletBalance({
            userId: targetUserId,
            balanceField: 'ewalletBalance',
            amount: -ewalletAmt,
            type: 'INVESTMENT',
            investmentId: investment[0]._id,
            description: `Investment from E-Wallet: $${ewalletAmt}`,
            createdBy: createdByUserId,
            session,
          });
        }
        if (fundAmt > 0) {
          await walletService.adjustWalletBalance({
            userId: targetUserId,
            balanceField: 'fundBalance',
            amount: -fundAmt,
            type: 'INVESTMENT',
            investmentId: investment[0]._id,
            description: `Investment from Fund Wallet: $${fundAmt}`,
            createdBy: createdByUserId,
            session,
          });
        }
      } else {
        // Legacy: deduct all from main balance
        await walletService.adjustWalletBalance({
          userId: targetUserId,
          balanceField: 'mainBalance',
          amount: -roundedAmount,
          type: 'INVESTMENT',
          investmentId: investment[0]._id,
          description: `Investment: $${roundedAmount}`,
          createdBy: createdByUserId,
          session,
        });
      }

      // Update wallet total investment tracking for ROI 2X cap
      let userWallet = await Wallet.findOne({ user: targetUserId }).session(session);
      if (!userWallet) {
        const created = await Wallet.create([{ user: targetUserId }], { session });
        userWallet = created[0];
      }

      // ACTIVE sum → 2X cap; lifetime sum (all statuses) → 3X cap
      const allInvs = await Investment.find({
        user: targetUserId
      }).select('originalAmount status').session(session).lean();
      const totalActive = allInvs
        .filter((i) => i.status === 'ACTIVE')
        .reduce((s, i) => s + (i.originalAmount || 0), 0);
      const totalLifetime = allInvs.reduce((s, i) => s + (i.originalAmount || 0), 0);

      userWallet.totalInvestmentAmount = roundToTwoDecimals(totalActive);
      userWallet.totalLifetimeInvestment = roundToTwoDecimals(totalLifetime);
      userWallet.totalMaxReturn = roundToTwoDecimals(totalActive * 2);
      // Reset 2X progress on reinvestment — fresh cycle starts
      userWallet.totalRoiEarned = 0;
      userWallet.totalReturned = 0;
      // totalEligibleEarnings — DO NOT reset, 3X tracking continues

      // --- PENDING AUTO-RELEASE ---
      // Release pending commissions up to (newInvestment × pendingReleaseMultiplier)
      const pendingAmount = userWallet.pendingCommissions || 0;
      const pendingMultiplier = settings.pendingReleaseMultiplier || 3;
      const maxFromPending = roundToTwoDecimals(roundedAmount * pendingMultiplier);
      if (pendingAmount > 0) {
        const releaseAmount = roundToTwoDecimals(Math.min(pendingAmount, maxFromPending));
        if (releaseAmount > 0) {
          userWallet.pendingCommissions = roundToTwoDecimals(pendingAmount - releaseAmount);
          userWallet.mainBalance = roundToTwoDecimals((userWallet.mainBalance || 0) + releaseAmount);
          userWallet.totalEligibleEarnings = roundToTwoDecimals((userWallet.totalEligibleEarnings || 0) + releaseAmount);
          await userWallet.save({ session });
          await Transaction.create([{
            user: targetUserId,
            type: 'PENDING_RELEASE',
            amount: releaseAmount,
            balanceBefore: roundToTwoDecimals(pendingAmount),
            balanceAfter: roundToTwoDecimals(userWallet.pendingCommissions),
            description: `Pending released to main - $${releaseAmount} (${pendingMultiplier}× investment $${roundedAmount})`,
            status: 'COMPLETED',
          }], { session });
        }
      } else {
        await userWallet.save({ session });
      }

      // Pending release may have filled the 3X cap → pause all active investments
      if (getCapStatus(userWallet)) {
        await pauseAllActive(targetUserId, session);
      }

      // --- LEVEL INCOME (all configured levels) ---
      // Traverse upline chain for every configured level in settings.levels.
      // Level 1 = direct upline (creditDirectIncome), Level 2+ = indirect (creditLevelIncomeForLevel).
      // Inactive uplines receive nothing. Own investment never generates self-income.
      if (user && user.referredBy) {
        const sortedLevels = [...(settings.levels || [])].sort((a, b) => a.level - b.level);
        let currentUserId = user.referredBy.toString();

        for (const levelConfig of sortedLevels) {
          if (!currentUserId) break;

          if (levelConfig.level === 1) {
            await bonusService.creditDirectIncome(
              currentUserId,
              roundedAmount,
              session,
              investment[0]._id
            );
          } else {
            await bonusService.creditLevelIncomeForLevel(
              levelConfig.level,
              currentUserId,
              roundedAmount,
              session,
              investment[0]._id
            );
          }

          const currentUser = await User.findById(currentUserId).session(session);
          currentUserId = (currentUser && currentUser.referredBy) ? currentUser.referredBy.toString() : null;
        }
      }
    });

    return investment[0];
  } finally {
    session.endSession();
  }
};

/**
 * Fetches a paginated list of investments belonging to a specific user.
 *
 * @param {string} userId
 * @param {Object} options
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {string} [options.status] - optional status filter
 * @returns {Promise<{investments: Array, stats: Object, pagination: Object}>}
 */
const getUserInvestments = async (userId, { page = 1, limit = 20, status } = {}) => {
  const query = { user: userId };
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;

  const [investments, total, allStats, activeStats] = await Promise.all([
    Investment.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    Investment.countDocuments(query),
    Investment.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: '$originalAmount' }, count: { $sum: 1 } } },
    ]),
    Investment.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), status: 'ACTIVE' } },
      { $group: { _id: null, total: { $sum: '$originalAmount' }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    investments,
    stats: {
      totalInvestment: allStats[0]?.total || 0,
      totalInvestmentCount: allStats[0]?.count || 0,
      activeInvestment: activeStats[0]?.total || 0,
      activeInvestmentCount: activeStats[0]?.count || 0,
    },
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

/**
 * Fetches a single investment by ID, ensuring it belongs to the
 * requesting user (unless bypassOwnershipCheck is true, for admin use).
 *
 * @param {string} investmentId
 * @param {string} userId
 * @param {boolean} [bypassOwnershipCheck=false]
 * @returns {Promise<Object>} the investment
 */
const getInvestmentById = async (investmentId, userId, bypassOwnershipCheck = false) => {
  if (!mongoose.Types.ObjectId.isValid(investmentId)) {
    const error = new Error('Invalid investment ID');
    error.statusCode = 400;
    throw error;
  }

  const investment = await Investment.findById(investmentId).lean({ virtuals: true });

  if (!investment) {
    const error = new Error('Investment not found');
    error.statusCode = 404;
    throw error;
  }

  if (!bypassOwnershipCheck && investment.user.toString() !== userId.toString()) {
    const error = new Error('You are not authorized to view this investment');
    error.statusCode = 403;
    throw error;
  }

  return investment;
};

/**
 * Creates an investment for a downline user using the sender's E-Wallet
 * (and optionally Main Wallet) for payment.
 *
 * Rules:
 * - E-Wallet offer must be enabled by admin
 * - Receiver must be in sender's downline tree
 * - E-Wallet contribution cannot exceed admin-set percentage
 * - Sender must have sufficient balances
 * - Investment amount is the FULL amount (not reduced by E-Wallet)
 *
 * @param {Object} params
 * @param {string} params.senderId - the user paying
 * @param {string} params.receiverId - the downline user receiving the investment
 * @param {number} params.amount - total investment amount
 * @param {number} params.ewalletAmount - portion paid from sender's E-Wallet
 * @param {string} [params.startDate]
 * @returns {Promise<Object>} the created investment
 */
const createDownlineInvestmentWithEwallet = async ({
  senderId,
  receiverId,
  amount,
  ewalletAmount,
  startDate,
}) => {
  const settings = await SystemSettings.getSettings();
  const roundedAmount = roundToTwoDecimals(amount);
  const roundedEwallet = roundToTwoDecimals(ewalletAmount || 0);

  if (roundedAmount <= 0) {
    const error = new Error('Investment amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }
  if (roundedEwallet < 0) {
    const error = new Error('E-Wallet amount cannot be negative');
    error.statusCode = 400;
    throw error;
  }

  // Verify E-Wallet offer is enabled
  if (!settings.ewalletDownlineOfferEnabled) {
    const error = new Error('E-Wallet downline investment offer is currently disabled');
    error.statusCode = 400;
    throw error;
  }

  // Verify downline relationship
  const referralService = require('./referralService');
  const allDownlines = await referralService.getAllDownlines(senderId);
  const isDownline = allDownlines.some(d => d.user._id.toString() === receiverId);
  if (!isDownline || senderId === receiverId) {
    const error = new Error('You can only invest for users in your downline');
    error.statusCode = 400;
    throw error;
  }

  // Verify E-Wallet percentage limit
  const maxEwalletAllowed = roundToTwoDecimals((roundedAmount * settings.ewalletMaxPercentage) / 100);
  if (roundedEwallet > maxEwalletAllowed) {
    const error = new Error(`E-Wallet contribution cannot exceed ${settings.ewalletMaxPercentage}% of investment ($${maxEwalletAllowed})`);
    error.statusCode = 400;
    throw error;
  }

  const mainWalletNeeded = roundToTwoDecimals(roundedAmount - roundedEwallet);

  // Check receiver is activated
  const receiver = await User.findById(receiverId);
  if (!receiver || !receiver.isActivated) {
    const error = new Error('Receiver account must be activated before investing');
    error.statusCode = 400;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let investment;
    await session.withTransaction(async () => {
      // Verify sender balances inside transaction
      const senderWallet = await Wallet.findOne({ user: senderId }).session(session);
      if (!senderWallet) {
        const error = new Error('Sender wallet not found');
        error.statusCode = 404;
        throw error;
      }
      if (roundedEwallet > 0 && senderWallet.ewalletBalance < roundedEwallet) {
        const error = new Error('Insufficient E-Wallet balance');
        error.statusCode = 400;
        throw error;
      }
      if (mainWalletNeeded > 0 && senderWallet.mainBalance < mainWalletNeeded) {
        const error = new Error('Insufficient Main Wallet balance');
        error.statusCode = 400;
        throw error;
      }

  const computedStartDate = startDate ? new Date(startDate) : new Date();
  const computedEndDate = durationDays ? new Date(computedStartDate.getTime() + durationDays * 24 * 60 * 60 * 1000) : null;

      // Create investment for receiver
      investment = await Investment.create(
        [
          {
            user: receiverId,
            originalAmount: roundedAmount,
            maxReturnAmount: roundToTwoDecimals(roundedAmount * 2),
            totalRoiEarned: 0,
            totalReturned: 0,
            status: 'ACTIVE',
            roiMode: settings.roiMode,
            roiPercentage: settings.overallRoiPercentage || 0,
            dayWiseRoiSchedule: settings.roiMode === 'DAY_WISE' ? settings.dayWiseRoiSchedule : [],
            durationDays: null,
            startDate: computedStartDate,
            endDate: null,
            createdBy: senderId,
          },
        ],
        { session }
      );

      // Debit E-Wallet from sender
      if (roundedEwallet > 0) {
        await walletService.adjustWalletBalance({
          userId: senderId,
          balanceField: 'ewalletBalance',
          amount: -roundedEwallet,
          type: 'E_WALLET_DOWNLINE_INVESTMENT',
          investmentId: investment[0]._id,
          description: `E-Wallet contribution for downline investment - $${roundedEwallet}`,
          createdBy: senderId,
          session,
        });
      }

      // Debit Main Wallet from sender
      if (mainWalletNeeded > 0) {
        await walletService.adjustWalletBalance({
          userId: senderId,
          balanceField: 'mainBalance',
          amount: -mainWalletNeeded,
          type: 'INVESTMENT',
          investmentId: investment[0]._id,
          description: `Investment for downline - $${mainWalletNeeded}`,
          createdBy: senderId,
          session,
        });
      }

      // Update receiver wallet tracking
      let receiverWallet = await Wallet.findOne({ user: receiverId }).session(session);
      if (!receiverWallet) {
        const created = await Wallet.create([{ user: receiverId }], { session });
        receiverWallet = created[0];
      }

      // ACTIVE sum → 2X cap; lifetime sum (all statuses) → 3X cap
      const receiverAllInvs = await Investment.find({
        user: receiverId
      }).select('originalAmount status').session(session).lean();
      const receiverTotalActive = receiverAllInvs
        .filter((i) => i.status === 'ACTIVE')
        .reduce((s, i) => s + (i.originalAmount || 0), 0);
      const receiverTotalLifetime = receiverAllInvs.reduce((s, i) => s + (i.originalAmount || 0), 0);

      receiverWallet.totalInvestmentAmount = roundToTwoDecimals(receiverTotalActive);
      receiverWallet.totalLifetimeInvestment = roundToTwoDecimals(receiverTotalLifetime);
      receiverWallet.totalMaxReturn = roundToTwoDecimals(receiverTotalActive * 2);
      // Reset 2X progress on reinvestment — fresh cycle starts
      receiverWallet.totalRoiEarned = 0;
      receiverWallet.totalReturned = 0;
      // totalEligibleEarnings — DO NOT reset, 3X tracking continues

      // --- PENDING AUTO-RELEASE ---
      // Release pending commissions up to (newInvestment × pendingReleaseMultiplier)
      const receiverPending = receiverWallet.pendingCommissions || 0;
      const receiverPendingMultiplier = settings.pendingReleaseMultiplier || 3;
      const receiverMaxFromPending = roundToTwoDecimals(roundedAmount * receiverPendingMultiplier);
      if (receiverPending > 0) {
        const releaseAmount = roundToTwoDecimals(Math.min(receiverPending, receiverMaxFromPending));
        if (releaseAmount > 0) {
          receiverWallet.pendingCommissions = roundToTwoDecimals(receiverPending - releaseAmount);
          receiverWallet.mainBalance = roundToTwoDecimals((receiverWallet.mainBalance || 0) + releaseAmount);
          receiverWallet.totalEligibleEarnings = roundToTwoDecimals((receiverWallet.totalEligibleEarnings || 0) + releaseAmount);
          await receiverWallet.save({ session });
          await Transaction.create([{
            user: receiverId,
            type: 'PENDING_RELEASE',
            amount: releaseAmount,
            balanceBefore: roundToTwoDecimals(receiverPending),
            balanceAfter: roundToTwoDecimals(receiverWallet.pendingCommissions),
            description: `Pending released to main - $${releaseAmount} (${receiverPendingMultiplier}× investment $${roundedAmount})`,
            status: 'COMPLETED',
          }], { session });
        }
      } else {
        await receiverWallet.save({ session });
      }

      // Pending release may have filled the 3X cap → pause all active investments
      if (getCapStatus(receiverWallet)) {
        await pauseAllActive(receiverId, session);
      }

      // --- LEVEL INCOME (all configured levels) for receiver's uplines ---
      if (receiver.referredBy) {
        const sortedLevels = [...(settings.levels || [])].sort((a, b) => a.level - b.level);
        let currentUserId = receiver.referredBy.toString();

        for (const levelConfig of sortedLevels) {
          if (!currentUserId) break;

          if (levelConfig.level === 1) {
            await bonusService.creditDirectIncome(
              currentUserId,
              roundedAmount,
              session,
              investment[0]._id
            );
          } else {
            await bonusService.creditLevelIncomeForLevel(
              levelConfig.level,
              currentUserId,
              roundedAmount,
              session,
              investment[0]._id
            );
          }

          const currentUser = await User.findById(currentUserId).session(session);
          currentUserId = (currentUser && currentUser.referredBy) ? currentUser.referredBy.toString() : null;
        }
      }
    });

    return investment[0];
  } finally {
    session.endSession();
  }
};

module.exports = {
  createInvestment,
  getUserInvestments,
  getInvestmentById,
  createDownlineInvestmentWithEwallet,
  roundToTwoDecimals,
};