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

  // If investment has a day-wise schedule snapshot, use numbered days with cycling
  if (investment && investment.roiMode === 'DAY_WISE' && investment.dayWiseRoiSchedule && investment.dayWiseRoiSchedule.length > 0) {
    const dayNumber = getDayNumber(investment.startDate, forDate);
    const cycleLength = investment.dayWiseRoiSchedule.length;
    const effectiveDay = cycleLength > 0 ? ((dayNumber - 1) % cycleLength) + 1 : dayNumber;
    const entry = investment.dayWiseRoiSchedule.find(e => e.day === effectiveDay);
    if (entry) {
      return { percentage: entry.percentage, dayName: `day_${effectiveDay}`, dayNumber: effectiveDay, cycleDay: dayNumber };
    }
    return { percentage: 0, dayName: `day_${effectiveDay}`, dayNumber: effectiveDay, cycleDay: dayNumber };
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

  // Only process ROI on or after the investment's start date.
  // We intentionally do NOT check endDate here — the 2X cap (maxReturnAmount)
  // is the real termination condition. The modulo cycling logic in
  // getApplicableRoiPercentage already handles repeating day schedules.
  const startMid = investment.startDate ? normalizeToMidnightUTC(investment.startDate) : null;
  if (startMid && roiDate < startMid) return null;

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

      // Per-investment 2X cap — ROI stops completely, no pending overflow
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

      // Phase 2: 2X cap enforcement — ROI stops completely, no pending
      let appliedRoiAmount = rawRoiAmount;
      let status = 'SUCCESS';

      if (rawRoiAmount > remainingBeforeThisRoi && remainingBeforeThisRoi > 0) {
        appliedRoiAmount = remainingBeforeThisRoi;
        status = 'CAPPED';
      } else if (remainingBeforeThisRoi <= 0) {
        appliedRoiAmount = 0;
        status = 'CAPPED';
      }

      appliedRoiAmount = roundToTwoDecimals(Math.max(0, appliedRoiAmount));

      // ==========================================
      // GLOBAL 3X CAP ENFORCEMENT
      // Total eligible earnings (ROI + Direct + Level + ProfitShare)
      // cannot exceed totalInvestmentAmount * 3.
      // ROI stops completely at 3X — no pending overflow.
      // ==========================================
      const ownInvestment = wallet.totalInvestmentAmount || 0;
      const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
      const cap3x = roundToTwoDecimals(ownInvestment * 3);

      let finalAppliedRoi = appliedRoiAmount;

      if (ownInvestment > 0 && appliedRoiAmount > 0) {
        const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));
        if (remaining3x <= 0) {
          finalAppliedRoi = 0;
        } else if (appliedRoiAmount > remaining3x) {
          finalAppliedRoi = remaining3x;
        }
      }

      finalAppliedRoi = roundToTwoDecimals(Math.max(0, finalAppliedRoi));

      // If nothing to distribute, skip
      if (finalAppliedRoi <= 0) {
        return;
      }

      const newTotalReturned = roundToTwoDecimals(
        previousTotalReturned + finalAppliedRoi
      );
      const newRemainingReturn = roundToTwoDecimals(
        Math.max(0, totalMaxReturn - newTotalReturned)
      );
      const isNowComplete = newTotalReturned >= totalMaxReturn;

      // Update the investment record (for display/history purposes)
      freshInvestment.totalRoiEarned = roundToTwoDecimals(
        freshInvestment.totalRoiEarned + finalAppliedRoi
      );
      freshInvestment.totalReturned = roundToTwoDecimals(
        freshInvestment.totalReturned + finalAppliedRoi
      );

      if (isNowComplete) {
        freshInvestment.status = 'COMPLETED';
        freshInvestment.completionDate = new Date();
      }

      await freshInvestment.save({ session });

      // Update wallet-level tracking
      wallet.totalRoiEarned = roundToTwoDecimals((wallet.totalRoiEarned || 0) + finalAppliedRoi);
      wallet.totalReturned = roundToTwoDecimals((wallet.totalReturned || 0) + finalAppliedRoi);
      wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + finalAppliedRoi);
      await wallet.save({ session });

      // Create the ROI ledger record
      const records = await ROIHistory.create(
        [
          {
            user: freshInvestment.user,
            investment: freshInvestment._id,
            roiPercentage: percentage,
            roiAmount: finalAppliedRoi,
            originalInvestmentAmount: freshInvestment.originalAmount,
            previousTotalReturned,
            newTotalReturned,
            remainingReturn: newRemainingReturn,
            roiDate,
            roiDay: dayName,
            roiMode: freshInvestment.roiMode || settings.roiMode,
            transactionType: 'ROI',
            status,
          },
        ],
        { session }
      );

      createdRecord = records[0];

      // Credit the applied ROI to roiBalance (within 2X + 3X caps)
      if (finalAppliedRoi > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'roiBalance',
          amount: finalAppliedRoi,
          type: 'ROI',
          investmentId: freshInvestment._id,
          description: `ROI credit (${percentage}%) for investment on ${roiDate.toISOString().split('T')[0]}`,
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

/**
 * Processes ROI manually for ALL active investments using a single
 * admin-supplied percentage. This is a one-time action for today.
 *
 * - Uses the supplied percentage directly (ignores schedule)
 * - Respects the 2X per-investment cap
 * - Respects the global 3X earnings cap
 * - Prevents duplicate same-day processing
 * - Does NOT modify AUTO schedule configuration
 *
 * @param {number} percentage - the ROI percentage to apply
 * @param {Date} [forDate=new Date()]
 * @returns {Promise<{ processed: number, skipped: number, failed: number, totalCredited: number, errors: Array }>}
 */
const processManualRoi = async (percentage, forDate = new Date()) => {
  if (!percentage || percentage <= 0) {
    const error = new Error('ROI percentage must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const settings = await SystemSettings.getSettings();

  if (!settings.roiProcessingEnabled) {
    return { processed: 0, skipped: 0, failed: 0, totalCredited: 0, errors: [], message: 'ROI processing is disabled' };
  }

  const roiDate = normalizeToMidnightUTC(forDate);
  const activeInvestments = await Investment.find({ status: 'ACTIVE' });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let totalCredited = 0;
  const errors = [];

  for (const investment of activeInvestments) {
    try {
      const result = await processManualInvestmentRoi(investment, percentage, roiDate);
      if (result) {
        processed += 1;
        totalCredited = roundToTwoDecimals(totalCredited + result.appliedRoiAmount);
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push({ investmentId: investment._id.toString(), message: error.message });
    }
  }

  return { processed, skipped, failed, totalCredited, errors };
};

/**
 * Processes manual ROI for a single investment using a fixed percentage.
 * Uses the same 2X and 3X cap logic as automatic processing, but takes
 * the percentage directly from the admin instead of from the schedule.
 *
 * @param {Object} investment - Investment document (must be ACTIVE)
 * @param {number} percentage - the admin-supplied ROI percentage
 * @param {Date} roiDate - the normalized ROI date
 * @returns {Promise<Object|null>} result with appliedRoiAmount, or null if skipped
 */
const processManualInvestmentRoi = async (investment, percentage, roiDate) => {
  if (investment.status !== 'ACTIVE') {
    return null;
  }

  const startMid = investment.startDate ? normalizeToMidnightUTC(investment.startDate) : null;
  if (startMid && roiDate < startMid) return null;

  const rawRoiAmount = roundToTwoDecimals((investment.originalAmount * percentage) / 100);
  if (rawRoiAmount <= 0) {
    return null;
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const freshInvestment = await Investment.findById(investment._id).session(session);
      if (!freshInvestment || freshInvestment.status !== 'ACTIVE') {
        return;
      }

      let wallet = await Wallet.findOne({ user: freshInvestment.user }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ user: freshInvestment.user }], { session });
        wallet = created[0];
      }

      // 2X cap enforcement
      const totalMaxReturn = freshInvestment.maxReturnAmount;
      const totalReturned = freshInvestment.totalReturned || 0;
      const previousTotalReturned = totalReturned;
      const remainingBeforeThisRoi = roundToTwoDecimals(totalMaxReturn - previousTotalReturned);

      let appliedRoiAmount = rawRoiAmount;
      let pendingRoiAmount = 0;
      let status = 'SUCCESS';

      if (rawRoiAmount > remainingBeforeThisRoi && remainingBeforeThisRoi > 0) {
        appliedRoiAmount = remainingBeforeThisRoi;
        pendingRoiAmount = roundToTwoDecimals(rawRoiAmount - remainingBeforeThisRoi);
        status = 'CAPPED';
      } else if (remainingBeforeThisRoi <= 0) {
        appliedRoiAmount = 0;
        pendingRoiAmount = rawRoiAmount;
        status = 'CAPPED';
      }

      appliedRoiAmount = roundToTwoDecimals(Math.max(0, appliedRoiAmount));

      // 3X cap enforcement
      const eligibleBase = wallet.eligibleInvestmentBase || 0;
      const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
      const cap3x = roundToTwoDecimals(eligibleBase * 3);

      let finalAppliedRoi = appliedRoiAmount;
      let overflowToPending = roundToTwoDecimals(pendingRoiAmount);

      if (eligibleBase > 0 && appliedRoiAmount > 0) {
        const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));
        if (remaining3x <= 0) {
          overflowToPending = roundToTwoDecimals(overflowToPending + appliedRoiAmount);
          finalAppliedRoi = 0;
        } else if (appliedRoiAmount > remaining3x) {
          overflowToPending = roundToTwoDecimals(overflowToPending + (appliedRoiAmount - remaining3x));
          finalAppliedRoi = remaining3x;
        }
      }

      finalAppliedRoi = roundToTwoDecimals(Math.max(0, finalAppliedRoi));

      if (finalAppliedRoi <= 0 && overflowToPending <= 0) {
        return;
      }

      const newTotalReturned = roundToTwoDecimals(previousTotalReturned + finalAppliedRoi);
      const newRemainingReturn = roundToTwoDecimals(Math.max(0, totalMaxReturn - newTotalReturned));
      const isNowComplete = newTotalReturned >= totalMaxReturn;

      freshInvestment.totalRoiEarned = roundToTwoDecimals(freshInvestment.totalRoiEarned + finalAppliedRoi);
      freshInvestment.totalReturned = roundToTwoDecimals(freshInvestment.totalReturned + finalAppliedRoi);

      if (isNowComplete) {
        freshInvestment.status = 'COMPLETED';
        freshInvestment.completionDate = new Date();
      }

      await freshInvestment.save({ session });

      wallet.totalRoiEarned = roundToTwoDecimals((wallet.totalRoiEarned || 0) + finalAppliedRoi);
      wallet.totalReturned = roundToTwoDecimals((wallet.totalReturned || 0) + finalAppliedRoi);
      wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + finalAppliedRoi);
      await wallet.save({ session });

      const records = await ROIHistory.create(
        [
          {
            user: freshInvestment.user,
            investment: freshInvestment._id,
            roiPercentage: percentage,
            roiAmount: finalAppliedRoi,
            originalInvestmentAmount: freshInvestment.originalAmount,
            previousTotalReturned,
            newTotalReturned,
            remainingReturn: newRemainingReturn,
            roiDate,
            roiDay: 'manual',
            roiMode: freshInvestment.roiMode || settings.roiMode,
            transactionType: 'ROI',
            status,
          },
        ],
        { session }
      );

      const createdRecord = records[0];

      if (finalAppliedRoi > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'roiBalance',
          amount: finalAppliedRoi,
          type: 'ROI',
          investmentId: freshInvestment._id,
          description: `Manual ROI credit (${percentage}%) for investment on ${roiDate.toISOString().split('T')[0]}`,
          reference: createdRecord._id.toString(),
          createdBy: null,
          session,
        });
      }

      if (pendingRoiAmount > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'pendingCommissions',
          amount: pendingRoiAmount,
          type: 'PENDING_ROI',
          investmentId: freshInvestment._id,
          description: `Pending ROI (2X cap overflow) manual on ${roiDate.toISOString().split('T')[0]} - $${pendingRoiAmount}`,
          reference: createdRecord._id.toString(),
          createdBy: null,
          session,
        });
      }

      const network3xOverflow = roundToTwoDecimals(overflowToPending - pendingRoiAmount);
      if (network3xOverflow > 0) {
        await walletService.adjustWalletBalance({
          userId: freshInvestment.user,
          balanceField: 'pendingCommissions',
          amount: network3xOverflow,
          type: 'PENDING_NETWORK_COMMISSION',
          investmentId: freshInvestment._id,
          description: `Pending ROI (3X global cap overflow) manual on ${roiDate.toISOString().split('T')[0]} - $${network3xOverflow}`,
          reference: createdRecord._id.toString(),
          createdBy: null,
          session,
        });
      }

      result = { appliedRoiAmount: finalAppliedRoi, status };
    });

    return result;
  } catch (error) {
    if (error.code === 11000) {
      return null;
    }
    throw error;
  } finally {
    session.endSession();
  }
};

module.exports = {
  processInvestmentRoi,
  processAllActiveInvestments,
  processManualRoi,
  getInvestmentRoiHistory,
  getUserRoiHistory,
  getApplicableRoiPercentage,
  roundToTwoDecimals,
  normalizeToMidnightUTC,
};