const mongoose = require('mongoose');
const Investment = require('../models/Investment');
const Wallet = require('../models/Wallet');
const ROIHistory = require('../models/ROIHistory');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * Rounds a number to 2 decimal places safely for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Normalizes a date to midnight UTC — this is the canonical "ROI date"
 * used for duplicate-distribution prevention.
 */
const normalizeToMidnightUTC = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Calculates the day number for an investment (1-based).
 * Day 1 = startDate, Day 2 = startDate + 1, etc.
 */
const getDayNumber = (startDate, forDate) => {
  const start = normalizeToMidnightUTC(startDate);
  const current = normalizeToMidnightUTC(forDate);
  return Math.floor((current - start) / (1000 * 60 * 60 * 24)) + 1;
};

/**
 * Determines the applicable ROI percentage based on system settings
 * and investment-specific schedule.
 *
 * @param {Object} settings - SystemSettings document
 * @param {Date} forDate
 * @param {Object} [investment] - Investment document (for day-wise schedule snapshot)
 * @returns {{ percentage: number, dayName: string, dayNumber: number }}
 */
const getApplicableRoiPercentage = (settings, forDate, investment = null) => {
  const dayName = DAY_NAMES[new Date(forDate).getUTCDay()];

  // If investment has a day-wise schedule snapshot, use numbered days
  if (investment && investment.roiMode === 'DAY_WISE' && investment.dayWiseRoiSchedule && investment.dayWiseRoiSchedule.length > 0) {
    const dayNumber = getDayNumber(investment.startDate, forDate);
    const entry = investment.dayWiseRoiSchedule.find(e => e.day === dayNumber);
    if (entry) {
      return { percentage: entry.percentage, dayName: `day_${dayNumber}`, dayNumber };
    }
    return { percentage: 0, dayName: `day_${dayNumber}`, dayNumber };
  }

  // Fallback: day-of-week for OVERALL mode or legacy investments without schedule
  if (settings.roiMode === 'DAY_WISE') {
    const percentage = settings.dayWiseRoi[dayName] || 0;
    return { percentage, dayName };
  }

  // OVERALL mode
  return { percentage: settings.overallRoiPercentage || 0, dayName };
};

/**
 * Processes ROI for a single investment for a given date.
 * Enforces the 2X cap and duplicate-distribution prevention.
 * Also credits the user's wallet (roiBalance) and creates a matching
 * Transaction record, atomically within the same session.
 *
 * This function is idempotent: calling it twice for the same
 * investment + date will succeed once and safely no-op the second time.
 *
 * @param {Object} investment - Investment document (must be ACTIVE)
 * @param {Object} settings - SystemSettings document
 * @param {Date} forDate - the date this ROI distribution is for
 * @returns {Promise<Object|null>} the created ROIHistory record, or null if skipped
 */
const processInvestmentRoi = async (investment, settings, forDate) => {
  if (investment.status !== 'ACTIVE') {
    return null; // Never process ROI for non-active investments
  }

  const roiDate = normalizeToMidnightUTC(forDate);

  // Only distribute ROI on days that fall within the investment's active window.
  const startMid = investment.startDate ? normalizeToMidnightUTC(investment.startDate) : null;
  const endMid = investment.endDate ? normalizeToMidnightUTC(investment.endDate) : null;
  if (startMid && roiDate < startMid) return null;
  if (endMid && roiDate > endMid) return null;

  // Get ROI percentage using investment's snapshot schedule if available
  const globalRoi = getApplicableRoiPercentage(settings, roiDate, investment);
  const percentage = globalRoi.percentage;
  const dayName = globalRoi.dayName;

  // No ROI configured for this day/mode — nothing to do
  if (!percentage || percentage <= 0) {
    return null;
  }

  const session = await mongoose.startSession();

  try {
    let createdRecord = null;

    await session.withTransaction(async () => {
      // Re-fetch investment inside the transaction to get the latest state
      // and prevent race conditions from concurrent processing.
      const freshInvestment = await Investment.findById(investment._id).session(session);

      if (!freshInvestment || freshInvestment.status !== 'ACTIVE') {
        return; // Completed/cancelled between initial fetch and now — abort safely
      }

      // Fetch wallet for display tracking and 3X cap
      let wallet = await Wallet.findOne({ user: freshInvestment.user }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ user: freshInvestment.user }], { session });
        wallet = created[0];
      }

      // Per-investment 2X cap (NOT wallet-level)
      const totalMaxReturn = freshInvestment.maxReturnAmount; // already = originalAmount * 2
      const totalReturned = freshInvestment.totalReturned || 0;

      const rawRoiAmount = roundToTwoDecimals(
        (freshInvestment.originalAmount * percentage) / 100
      );

      if (rawRoiAmount <= 0) {
        return;
      }

      const previousTotalReturned = totalReturned;
      const remainingBeforeThisRoi = roundToTwoDecimals(
        totalMaxReturn - previousTotalReturned
      );

      // Phase 2: 2X cap enforcement with pending overflow (wallet-level)
      let appliedRoiAmount = rawRoiAmount;
      let pendingRoiAmount = 0;
      let status = 'SUCCESS';

      if (rawRoiAmount > remainingBeforeThisRoi && remainingBeforeThisRoi > 0) {
        // Cap hit — credit what fits, overflow to pending
        appliedRoiAmount = remainingBeforeThisRoi;
        pendingRoiAmount = roundToTwoDecimals(rawRoiAmount - remainingBeforeThisRoi);
        status = 'CAPPED';
      } else if (remainingBeforeThisRoi <= 0) {
        // Already at 2X — entire amount goes to pending
        appliedRoiAmount = 0;
        pendingRoiAmount = rawRoiAmount;
        status = 'CAPPED';
      }

      appliedRoiAmount = roundToTwoDecimals(Math.max(0, appliedRoiAmount));

      // If nothing to distribute at all (no ROI, no pending), skip
      if (appliedRoiAmount <= 0 && pendingRoiAmount <= 0) {
        return;
      }

      const newTotalReturned = roundToTwoDecimals(
        previousTotalReturned + appliedRoiAmount
      );
      const newRemainingReturn = roundToTwoDecimals(
        Math.max(0, totalMaxReturn - newTotalReturned)
      );
      const isNowComplete = newTotalReturned >= totalMaxReturn;

      // Update the investment record (for display/history purposes)
      freshInvestment.totalRoiEarned = roundToTwoDecimals(
        freshInvestment.totalRoiEarned + appliedRoiAmount
      );
      freshInvestment.totalReturned = roundToTwoDecimals(
        freshInvestment.totalReturned + appliedRoiAmount
      );

      if (isNowComplete) {
        freshInvestment.status = 'COMPLETED';
        freshInvestment.completionDate = new Date();
      }

      await freshInvestment.save({ session });

      // Update wallet-level tracking (display purposes and 3X cap)
      wallet.totalRoiEarned = roundToTwoDecimals((wallet.totalRoiEarned || 0) + appliedRoiAmount);
      wallet.totalReturned = roundToTwoDecimals((wallet.totalReturned || 0) + appliedRoiAmount);
      wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + appliedRoiAmount);
      await wallet.save({ session });

      // Create the ROI ledger record
      const records = await ROIHistory.create(
        [
          {
            user: freshInvestment.user,
            investment: freshInvestment._id,
            roiPercentage: percentage,
            roiAmount: appliedRoiAmount,
            originalInvestmentAmount: freshInvestment.originalAmount,
            previousTotalReturned,
            newTotalReturned,
            remainingReturn: newRemainingReturn,
            roiDate,
            roiDay: dayName,
            roiMode: settings.roiMode,
            transactionType: 'ROI',
            status,
          },
        ],
        { session }
      );

      createdRecord = records[0];

      // Credit the applied ROI to roiBalance (within 2X cap)
      if (appliedRoiAmount > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'roiBalance',
          amount: appliedRoiAmount,
          type: 'ROI',
          investmentId: freshInvestment._id,
          description: `ROI credit (${percentage}%) for investment on ${roiDate.toISOString().split('T')[0]}`,
          reference: createdRecord._id.toString(),
          createdBy: null,
          session,
        });
      }

      // Phase 2: Credit overflow ROI to pendingCommissions (beyond 2X cap)
      if (pendingRoiAmount > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'pendingCommissions',
          amount: pendingRoiAmount,
          type: 'PENDING_ROI',
          investmentId: freshInvestment._id,
          description: `Pending ROI (2X cap overflow) for investment on ${roiDate.toISOString().split('T')[0]} - $${pendingRoiAmount}`,
          reference: createdRecord._id.toString(),
          createdBy: null,
          session,
        });
      }
    });

    return createdRecord;
  } catch (error) {
    // Duplicate distribution attempt for this investment + date —
    // this is expected/safe behavior, not a failure. Treat as a no-op.
    if (error.code === 11000) {
      return null;
    }
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Processes ROI for ALL active investments for a given date (defaults
 * to today). This is the entry point that a future cron job will call.
 *
 * @param {Date} [forDate=new Date()]
 * @returns {Promise<{ processed: number, skipped: number, errors: Array }>}
 */
const processAllActiveInvestments = async (forDate = new Date()) => {
  const settings = await SystemSettings.getSettings();

  if (!settings.roiProcessingEnabled) {
    return { processed: 0, skipped: 0, errors: [], message: 'ROI processing is disabled' };
  }

  const activeInvestments = await Investment.find({ status: 'ACTIVE' });

  let processed = 0;
  let skipped = 0;
  const errors = [];

  for (const investment of activeInvestments) {
    try {
      const result = await processInvestmentRoi(investment, settings, forDate);
      if (result) {
        processed += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      errors.push({ investmentId: investment._id.toString(), message: error.message });
    }
  }

  return { processed, skipped, errors };
};

/**
 * Fetches ROI history for a specific investment (must belong to the
 * requesting user, unless bypassOwnershipCheck is true for admin use).
 */
const getInvestmentRoiHistory = async (investmentId, userId, bypassOwnershipCheck = false) => {
  const investment = await Investment.findById(investmentId).lean();

  if (!investment) {
    const error = new Error('Investment not found');
    error.statusCode = 404;
    throw error;
  }

  if (!bypassOwnershipCheck && investment.user.toString() !== userId.toString()) {
    const error = new Error('You are not authorized to view this ROI history');
    error.statusCode = 403;
    throw error;
  }

  const history = await ROIHistory.find({ investment: investmentId })
    .sort({ roiDate: -1 })
    .lean();

  return history;
};

/**
 * Fetches all ROI history for a specific user across all their investments.
 */
const getUserRoiHistory = async (userId, { page = 1, limit = 20 } = {}) => {
  const skip = (page - 1) * limit;

  const [history, total] = await Promise.all([
    ROIHistory.find({ user: userId })
      .sort({ roiDate: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'investment', select: 'originalAmount status' })
      .lean(),
    ROIHistory.countDocuments({ user: userId }),
  ]);

  return {
    history,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

module.exports = {
  processInvestmentRoi,
  processAllActiveInvestments,
  getInvestmentRoiHistory,
  getUserRoiHistory,
  getApplicableRoiPercentage,
  roundToTwoDecimals,
  normalizeToMidnightUTC,
};