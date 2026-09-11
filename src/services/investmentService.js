const mongoose = require('mongoose');
const Investment = require('../models/Investment');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');
const bonusService = require('./bonusService');

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

  // Use global ROI settings
  const roiPercentage = settings.overallRoiPercentage || 0;
  const durationDays = null;

  const computedStartDate = startDate ? new Date(startDate) : new Date();

  const session = await mongoose.startSession();

  try {
    let investment;

    await session.withTransaction(async () => {
      // Re-check balance inside the transaction (authoritative, server-side).
      const wallet = await Wallet.findOne({ user: targetUserId }).session(session);
      const available = wallet ? wallet.mainBalance : 0;

      if (available < roundedAmount) {
        const error = new Error('Insufficient main balance for this investment');
        error.statusCode = 400;
        throw error;
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
            endDate: null,
            createdBy: createdByUserId,
          },
        ],
        { session }
      );

      // Deduct investment amount from main balance
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

      // Update wallet total investment tracking for ROI 2X cap
      let userWallet = await Wallet.findOne({ user: targetUserId }).session(session);
      if (!userWallet) {
        const created = await Wallet.create([{ user: targetUserId }], { session });
        userWallet = created[0];
      }
      userWallet.totalInvestmentAmount = roundToTwoDecimals((userWallet.totalInvestmentAmount || 0) + roundedAmount);
      userWallet.totalMaxReturn = roundToTwoDecimals(userWallet.totalInvestmentAmount * 2);
      await userWallet.save({ session });

      // --- DIRECT & LEVEL INCOME ---
      // Income goes to the investor's uplines, NOT to the investor
      if (user && user.referredBy) {
        // Direct income -> direct upline (Level 1)
        await bonusService.creditDirectIncome(
          user.referredBy,
          roundedAmount,
          session
        );

        // Level 2 income -> indirect upline (Level 2)
        const directUpline = await User.findById(user.referredBy).session(session);
        if (directUpline && directUpline.referredBy) {
          await bonusService.creditLevelIncome(
            directUpline.referredBy,
            roundedAmount,
            session
          );
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
 * @returns {Promise<{investments: Array, pagination: Object}>}
 */
const getUserInvestments = async (userId, { page = 1, limit = 20, status } = {}) => {
  const query = { user: userId };
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;

  const [investments, total] = await Promise.all([
    Investment.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    Investment.countDocuments(query),
  ]);

  return {
    investments,
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
      receiverWallet.totalInvestmentAmount = roundToTwoDecimals((receiverWallet.totalInvestmentAmount || 0) + roundedAmount);
      receiverWallet.totalMaxReturn = roundToTwoDecimals(receiverWallet.totalInvestmentAmount * 2);
      await receiverWallet.save({ session });

      // Direct & Level income for receiver's uplines
      if (receiver.referredBy) {
        await bonusService.creditDirectIncome(
          receiver.referredBy,
          roundedAmount,
          session
        );
        const directUpline = await User.findById(receiver.referredBy).session(session);
        if (directUpline && directUpline.referredBy) {
          await bonusService.creditLevelIncome(
            directUpline.referredBy,
            roundedAmount,
            session
          );
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