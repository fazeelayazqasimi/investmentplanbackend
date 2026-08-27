const mongoose = require('mongoose');
const Investment = require('../models/Investment');
const Wallet = require('../models/Wallet');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');

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
 * @param {string} [params.plan] - plan name (free text or matched to catalog)
 * @param {string} [params.planId] - ObjectId of a catalog plan
 * @param {string} [params.startDate]
 * @returns {Promise<Object>} the created investment
 */
const createInvestment = async ({
  targetUserId,
  createdByUserId,
  createdByRole,
  amount,
  plan,
  planId,
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

  // Resolve plan metadata (ROI % + duration) from the catalog when possible,
  // falling back to the global overall ROI percentage for free-text plans.
  let resolvedPlanName = plan || 'Custom';
  let roiPercentage = settings.overallRoiPercentage || 0;
  let durationDays = null;

  if (settings.plans && settings.plans.length) {
    const match =
      (planId && settings.plans.find((p) => p._id && p._id.toString() === planId.toString())) ||
      settings.plans.find((p) => p.name === plan);

    if (match) {
      resolvedPlanName = match.name;
      roiPercentage = match.roiPercentage;
      durationDays = match.durationDays;
    }
  }

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
      const available = wallet ? wallet.mainBalance : 0;

      if (available < roundedAmount) {
        const error = new Error('Insufficient main balance for this investment');
        error.statusCode = 400;
        throw error;
      }

      investment = await Investment.create(
        [
          {
            user: targetUserId,
            plan: resolvedPlanName,
            originalAmount: roundedAmount,
            maxReturnAmount: roundToTwoDecimals(roundedAmount * 2),
            totalRoiEarned: 0,
            totalReturned: 0,
            status: 'ACTIVE',
            roiMode: settings.roiMode,
            roiPercentage,
            durationDays,
            startDate: computedStartDate,
            endDate: computedEndDate,
            createdBy: createdByUserId,
          },
        ],
        { session }
      );

      // Deduct from main balance atomically within the same session.
      // adjustWalletBalance throws on insufficient funds — which aborts the
      // whole transaction, so the investment is never left dangling.
      await walletService.adjustWalletBalance({
        userId: targetUserId,
        balanceField: 'mainBalance',
        amount: -roundedAmount,
        type: 'INVESTMENT',
        investmentId: investment[0]._id,
        description: `Investment: ${resolvedPlanName}`,
        createdBy: createdByUserId,
        session,
      });
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

module.exports = {
  createInvestment,
  getUserInvestments,
  getInvestmentById,
  roundToTwoDecimals,
};