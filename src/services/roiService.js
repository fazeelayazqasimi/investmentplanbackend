const mongoose = require('mongoose');
const Investment = require('../models/Investment');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const ROIHistory = require('../models/ROIHistory');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');
const bonusService = require('./bonusService');
const { getCapStatus, pauseAllActive, pauseIfCapFull } = require('./capService');

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

  // Global 2X/3X cap full → pause ALL active investments immediately
  // (even on 0% days / before start date — cap is wallet-global).
  const preCapCheck = await pauseIfCapFull(investment.user);
  if (preCapCheck.paused) {
    return null;
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

      // Global 2X cap — ROI stops when total ROI earned >= totalInvestmentAmount * 2
      const totalMaxReturn = roundToTwoDecimals((wallet.totalInvestmentAmount || 0) * 2);
      const totalReturned = wallet.totalRoiEarned || 0;

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
      // cannot exceed totalLifetimeInvestment * 3.
      // ROI stops completely at 3X — no pending overflow.
      // ==========================================
      const ownInvestment = wallet.totalLifetimeInvestment || wallet.totalInvestmentAmount || 0;
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

      // If nothing to distribute — ROI cap hit, pause ALL active investments
      if (finalAppliedRoi <= 0) {
        await pauseAllActive(freshInvestment.user, session);
        return;
      }

      const newTotalReturned = roundToTwoDecimals(
        previousTotalReturned + finalAppliedRoi
      );
      const newRemainingReturn = roundToTwoDecimals(
        Math.max(0, totalMaxReturn - newTotalReturned)
      );

      // Update the investment record (for display/history purposes)
      freshInvestment.totalRoiEarned = roundToTwoDecimals(
        freshInvestment.totalRoiEarned + finalAppliedRoi
      );
      freshInvestment.totalReturned = roundToTwoDecimals(
        freshInvestment.totalReturned + finalAppliedRoi
      );

      await freshInvestment.save({ session });

      // Update wallet-level tracking
      const walletTotalMaxReturn = wallet.totalMaxReturn || 0;
      const walletReturnedBefore = wallet.totalReturned || 0;
      wallet.totalRoiEarned = roundToTwoDecimals((wallet.totalRoiEarned || 0) + finalAppliedRoi);
      wallet.totalReturned = roundToTwoDecimals((wallet.totalReturned || 0) + finalAppliedRoi);
      wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + finalAppliedRoi);

      // Detect 2X cycle completion at wallet level
      if (walletTotalMaxReturn > 0 && finalAppliedRoi > 0) {
        const wasBelow = walletReturnedBefore < walletTotalMaxReturn;
        const isAtOrAbove = wallet.totalReturned >= walletTotalMaxReturn;
        if (wasBelow && isAtOrAbove) {
          wallet.cycle2xCompletions = (wallet.cycle2xCompletions || 0) + 1;
        }
      }

      await wallet.save({ session });

      // After this credit, if either 2X or 3X cap is now full → pause ALL
      // active investments (session-safe: after wallet.save so the fresh
      // totals are visible to the in-session check).
      if (getCapStatus(wallet)) {
        await pauseAllActive(freshInvestment.user, session);
      }

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

        // Distribute profit share from ROI to uplines
        await bonusService.creditProfitShareFromRoi(
          freshInvestment.user,
          finalAppliedRoi,
          session,
          freshInvestment._id
        );
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

  // --- PENDING AUTO-RELEASE after daily ROI ---
  // For all users with pending commissions, check if pending can fit under 3X cap
  const wallets = await Wallet.find({ pendingCommissions: { $gt: 0 } });
  let releasedCount = 0;
  const pendingMultiplier = settings.pendingReleaseMultiplier || 3;

  for (const wallet of wallets) {
    const lifetimeInv = wallet.totalLifetimeInvestment || wallet.totalInvestmentAmount || 0;
    const cap3x = roundToTwoDecimals(lifetimeInv * 3);
    const eligible = wallet.totalEligibleEarnings || 0;
    const remaining = roundToTwoDecimals(Math.max(0, cap3x - eligible));
    const pending = wallet.pendingCommissions || 0;

    if (pending > 0 && remaining > 0) {
      const totalInv = lifetimeInv;
      const maxFromPending = roundToTwoDecimals(totalInv * pendingMultiplier);
      const releaseAmount = roundToTwoDecimals(Math.min(pending, maxFromPending, remaining));
      if (releaseAmount > 0) {
        wallet.pendingCommissions = roundToTwoDecimals(pending - releaseAmount);
        wallet.mainBalance = roundToTwoDecimals((wallet.mainBalance || 0) + releaseAmount);
        wallet.totalEligibleEarnings = roundToTwoDecimals(eligible + releaseAmount);
        await wallet.save();
        await Transaction.create({
          user: wallet.user,
          type: 'PENDING_RELEASE',
          amount: releaseAmount,
          balanceBefore: roundToTwoDecimals(pending),
          balanceAfter: roundToTwoDecimals(wallet.pendingCommissions),
          description: `Auto-released pending to main - $${releaseAmount} (${pendingMultiplier}× total investment $${totalInv}, remaining cap: $${remaining})`,
          status: 'COMPLETED',
        });
        // Release may have filled the 3X cap → pause all active investments
        if (getCapStatus(wallet)) {
          await pauseAllActive(wallet.user);
        }
        releasedCount++;
      }
    }
  }

  return { processed, skipped, errors, released: releasedCount };
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
 * admin-supplied percentage. Can be run any number of times — each run
 * credits all eligible active investments again (until 2X/3X caps).
 *
 * - Uses the supplied percentage directly (ignores schedule)
 * - Respects the 2X per-investment cap
 * - Respects the global 3X earnings cap
 * - No duplicate same-day block for manual runs
 * - Does NOT modify AUTO schedule configuration
 * - NEVER skips an active investment: cap-limited users get a partial
 *   credit of whatever remains of their limit (reported as CAPPED), and
 *   future-dated investments are credited immediately
 * - Returns a full per-user report (who was credited, who was held
 *   and why) so the admin UI can show exactly what happened
 *
 * @param {number} percentage - the ROI percentage to apply
 * @param {Date} [forDate=new Date()]
 * @param {string|null} [runId=null] - client-generated run identifier (ISO
 *   timestamp). When provided it is used as the roiDate for the WHOLE run,
 *   so a retried request re-uses the same { investment, roiDate } key and
 *   the unique index prevents double-crediting users that were already
 *   paid before an interrupted run.
 * @returns {Promise<Object>} run report with totalActive/processed/capped/
 *   skipped/failed/totalCredited/results[]/errors[]
 */
const processManualRoi = async (percentage, forDate = new Date(), runId = null) => {
  if (!percentage || percentage <= 0) {
    const error = new Error('ROI percentage must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const settings = await SystemSettings.getSettings();

  if (!settings.roiProcessingEnabled) {
    return {
      totalActive: 0,
      processed: 0,
      capped: 0,
      skipped: 0,
      failed: 0,
      totalCredited: 0,
      results: [],
      errors: [],
      message: 'ROI processing is disabled',
    };
  }

  // Single roiDate for the entire run (NOT midnight-normalized) so repeat
  // manual runs on the same day get a fresh unique { investment, roiDate }
  // key. When runId is supplied (client retry), the SAME timestamp is reused
  // so the unique index makes the retry idempotent instead of double-paying.
  let roiDate = forDate instanceof Date ? forDate : new Date(forDate);
  if (runId) {
    const parsed = new Date(runId);
    if (!isNaN(parsed.getTime())) roiDate = parsed;
  }

  const activeInvestments = await Investment.find({ status: 'ACTIVE' });

  // Resolve display info (name/email) in a separate query so investment.user
  // stays a plain ObjectId (and is never nulled out for deleted users).
  const userIds = [...new Set(activeInvestments.map((i) => String(i.user)))];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }, 'name email').lean()
    : [];
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  // Group investments per user so one user's investments never run
  // concurrently (they share a single wallet document in their transactions).
  const groupsByUser = new Map();
  for (const investment of activeInvestments) {
    const key = String(investment.user);
    if (!groupsByUser.has(key)) groupsByUser.set(key, []);
    groupsByUser.get(key).push(investment);
  }

  let processed = 0;
  let capped = 0;
  let skipped = 0;
  let failed = 0;
  let totalCredited = 0;
  const errors = [];
  const results = [];

  const CONCURRENCY = 5;

  const processInvestment = async (investment) => {
    const userId = String(investment.user);
    const userDoc = userMap.get(userId) || null;
    const entry = {
      userId,
      name: (userDoc && userDoc.name) || '',
      email: (userDoc && userDoc.email) || '',
      investmentId: investment._id.toString(),
      amount: investment.originalAmount,
      credited: 0,
      status: 'SKIPPED',
      reason: '',
    };

    try {
      const outcome = await processManualInvestmentRoi(investment, percentage, roiDate, settings);
      entry.credited = roundToTwoDecimals(outcome.appliedRoiAmount || 0);
      entry.status = outcome.status;
      entry.reason = outcome.reason || '';

      if (outcome.status === 'CREDITED' || outcome.status === 'CAPPED') {
        // Paid = actually credited (>0). CAPPED covers partial credits AND
        // cap-full-with-nothing-left — both are holds, never "skipped".
        if (entry.credited > 0) {
          processed += 1;
          totalCredited = roundToTwoDecimals(totalCredited + entry.credited);
        }
        if (outcome.status === 'CAPPED') capped += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      entry.status = 'FAILED';
      entry.reason = error.message;
      errors.push({ investmentId: entry.investmentId, userId, message: error.message });
    }

    results.push(entry);
  };

  // Worker pool: a few users at a time, investments of each user sequential.
  const userGroups = [...groupsByUser.values()];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(CONCURRENCY, userGroups.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < userGroups.length) {
      const group = userGroups[cursor];
      cursor += 1;
      for (const investment of group) {
        await processInvestment(investment);
      }
    }
  });
  await Promise.all(workers);

  const statusOrder = { CREDITED: 0, CAPPED: 1, SKIPPED: 2, FAILED: 3 };
  results.sort((a, b) => {
    const byStatus = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    return String(a.name).localeCompare(String(b.name));
  });

  return {
    totalActive: activeInvestments.length,
    processed,
    capped,
    skipped,
    failed,
    totalCredited,
    results,
    errors,
  };
};

/**
 * Processes manual ROI for a single investment using a fixed percentage.
 * Uses the same 2X and 3X cap logic as automatic processing, but takes
 * the percentage directly from the admin instead of from the schedule.
 *
 * @param {Object} investment - Investment document (must be ACTIVE)
 * @param {number} percentage - the admin-supplied ROI percentage
 * @param {Date} roiDate - the run timestamp used as the ROI date
 * @param {Object} settings - SystemSettings document
 * @returns {Promise<{ status: 'CREDITED'|'CAPPED'|'SKIPPED', reason: string, appliedRoiAmount: number }>}
 */
const processManualInvestmentRoi = async (investment, percentage, roiDate, settings) => {
  if (investment.status !== 'ACTIVE') {
    return { status: 'SKIPPED', reason: 'Investment is not ACTIVE', appliedRoiAmount: 0 };
  }

  // NOTE: no pre-cap skip and no future-start skip here — manual ROI must
  // never skip an active investment. Cap-full users get a partial credit of
  // whatever remains (possibly 0 → reported as CAPPED, never SKIPPED), and
  // future-dated investments are credited immediately on admin request.

  // Never round down to zero — guarantee at least the minimum unit so no
  // active investment can be skipped for amount reasons.
  let rawRoiAmount = roundToTwoDecimals((investment.originalAmount * percentage) / 100);
  if (!(rawRoiAmount > 0)) {
    rawRoiAmount = 0.01;
  }

  const session = await mongoose.startSession();

  try {
    let result = null;
    let heldReason = null;

    await session.withTransaction(async () => {
      const freshInvestment = await Investment.findById(investment._id).session(session);
      if (!freshInvestment) {
        heldReason = 'Investment was removed during this run';
        return;
      }
      if (freshInvestment.status !== 'ACTIVE') {
        // Paused mid-run by the 2X/3X cap (pauseAllActive) — reported as
        // CAPPED, never SKIPPED.
        heldReason = 'Paused during this run — 2X/3X cap reached';
        return;
      }

      let wallet = await Wallet.findOne({ user: freshInvestment.user }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ user: freshInvestment.user }], { session });
        wallet = created[0];
      }

      // Global 2X cap enforcement.
      // When the wallet's investment base is 0/missing (stale data), the cap
      // cannot be evaluated — pay the full amount instead of blocking the
      // payment (mirrors the 3X logic below, which only applies for base > 0).
      const investedBase2x = wallet.totalInvestmentAmount || 0;
      const totalMaxReturn = roundToTwoDecimals(investedBase2x * 2);
      const previousTotalReturned = wallet.totalRoiEarned || 0;
      const remainingBeforeThisRoi = roundToTwoDecimals(totalMaxReturn - previousTotalReturned);

      let appliedRoiAmount = rawRoiAmount;
      let status = 'SUCCESS';

      if (investedBase2x > 0) {
        if (rawRoiAmount > remainingBeforeThisRoi && remainingBeforeThisRoi > 0) {
          appliedRoiAmount = remainingBeforeThisRoi;
          status = 'CAPPED';
        } else if (remainingBeforeThisRoi <= 0) {
          appliedRoiAmount = 0;
          status = 'CAPPED';
        }
      }

      appliedRoiAmount = roundToTwoDecimals(Math.max(0, appliedRoiAmount));

      // 3X cap enforcement — base = total lifetime investment (all statuses)
      const ownInvestment = wallet.totalLifetimeInvestment || wallet.totalInvestmentAmount || 0;
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

      // If nothing to distribute — ROI cap hit, pause ALL active investments.
      // Reported as CAPPED (not skipped) so manual runs never show a skip.
      if (finalAppliedRoi <= 0) {
        await pauseAllActive(freshInvestment.user, session);
        heldReason = '2X/3X cap reached — no amount remaining (investments paused)';
        return;
      }

      const newTotalReturned = roundToTwoDecimals(previousTotalReturned + finalAppliedRoi);
      const newRemainingReturn = roundToTwoDecimals(Math.max(0, totalMaxReturn - newTotalReturned));

      freshInvestment.totalRoiEarned = roundToTwoDecimals(freshInvestment.totalRoiEarned + finalAppliedRoi);
      freshInvestment.totalReturned = roundToTwoDecimals(freshInvestment.totalReturned + finalAppliedRoi);

      await freshInvestment.save({ session });

      wallet.totalRoiEarned = roundToTwoDecimals((wallet.totalRoiEarned || 0) + finalAppliedRoi);
      wallet.totalReturned = roundToTwoDecimals((wallet.totalReturned || 0) + finalAppliedRoi);
      wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + finalAppliedRoi);

      // Detect 2X cycle completion at wallet level
      const walletTotalMaxReturn2 = wallet.totalMaxReturn || 0;
      const walletReturnedBefore2 = wallet.totalReturned - finalAppliedRoi;
      if (walletTotalMaxReturn2 > 0 && finalAppliedRoi > 0) {
        const wasBelow2 = walletReturnedBefore2 < walletTotalMaxReturn2;
        const isAtOrAbove2 = wallet.totalReturned >= walletTotalMaxReturn2;
        if (wasBelow2 && isAtOrAbove2) {
          wallet.cycle2xCompletions = (wallet.cycle2xCompletions || 0) + 1;
        }
      }

      await wallet.save({ session });

      // After this credit, if either 2X or 3X cap is now full → pause ALL
      // active investments
      if (getCapStatus(wallet)) {
        await pauseAllActive(freshInvestment.user, session);
      }

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

        // Distribute profit share from ROI to uplines
        await bonusService.creditProfitShareFromRoi(
          freshInvestment.user,
          finalAppliedRoi,
          session,
          freshInvestment._id
        );
      }

      const isPartial = finalAppliedRoi < rawRoiAmount;
      result = {
        appliedRoiAmount: finalAppliedRoi,
        status: isPartial ? 'CAPPED' : 'CREDITED',
        reason: isPartial ? 'Partial credit — 2X/3X cap limit reached' : '',
      };
    });

    if (result) return result;

    // Nothing was credited in this attempt — always a cap/removal hold,
    // never a skip.
    return {
      status: 'CAPPED',
      reason: heldReason || '2X/3X cap reached — no amount remaining',
      appliedRoiAmount: 0,
    };
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate { investment, roiDate }: this investment was already paid
      // in this same run (e.g. a retry after a timeout). Surface the
      // previously credited amount as a success — never a skip, never a
      // double payment.
      const existing = await ROIHistory.findOne({ investment: investment._id, roiDate }).lean();
      if (existing) {
        const creditedAmount = roundToTwoDecimals(existing.roiAmount || 0);
        return {
          status: creditedAmount >= rawRoiAmount ? 'CREDITED' : 'CAPPED',
          reason: 'Already credited in this run (retry) — not paid twice',
          appliedRoiAmount: creditedAmount,
        };
      }
      // Duplicate key from anything else — surface as FAILED (retryable),
      // never silently swallowed.
      throw error;
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