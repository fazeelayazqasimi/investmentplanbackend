const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const SystemSettings = require('../models/SystemSettings');
const walletService = require('./walletService');

/**
 * Rounds a number to 2 decimal places safely for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Processes registration bonuses (signup bonus + upline bonus).
 * Called from authController.register inside the same MongoDB session
 * as user creation, so it's fully atomic.
 *
 * Duplicate protection:
 * - Checks for existing SIGNUP_BONUS transaction for the new user
 * - Checks for existing UPLINE_SIGNUP_BONUS transaction with reference=newUserId
 *
 * E-Wallet rule:
 * - If ewalletEnabled is false, no E-Wallet credits are made.
 * - Existing balances are NEVER touched when disabled.
 *
 * @param {string} userId - the newly registered user's ID
 * @param {string|null} uplineId - the referrer's ID (null if no referral)
 * @param {import('mongoose').ClientSession} session - caller's MongoDB session
 * @returns {Promise<{ userBonus: Object|null, uplineBonus: Object|null }>}
 */
const processRegistrationBonuses = async (userId, uplineId, session) => {
  const settings = await SystemSettings.getSettings();

  // If E-Wallet is disabled, skip all bonus crediting
  if (!settings.ewalletEnabled) {
    return { userBonus: null, uplineBonus: null };
  }

  let userBonus = null;
  let uplineBonus = null;

  // --- Signup bonus for new user ---
  const existingSignupBonus = await Transaction.findOne({
    user: userId,
    type: 'SIGNUP_BONUS',
  }).session(session);

  if (!existingSignupBonus && settings.signupBonusAmount > 0) {
    const result = await walletService.adjustWalletBalance({
      userId,
      balanceField: 'ewalletBalance',
      amount: settings.signupBonusAmount,
      type: 'SIGNUP_BONUS',
      description: `Signup bonus - $${settings.signupBonusAmount}`,
      reference: null,
      createdBy: null,
      session,
    });
    userBonus = result.transaction;
  }

  // --- Upline bonus for referrer ---
  if (uplineId && settings.uplineSignupBonusAmount > 0) {
    // Duplicate protection: check if this specific referral already triggered a bonus
    const existingUplineBonus = await Transaction.findOne({
      user: uplineId,
      type: 'UPLINE_SIGNUP_BONUS',
      reference: userId.toString(),
    }).session(session);

    if (!existingUplineBonus) {
      const result = await walletService.adjustWalletBalance({
        userId: uplineId,
        balanceField: 'ewalletBalance',
        amount: settings.uplineSignupBonusAmount,
        type: 'UPLINE_SIGNUP_BONUS',
        description: `Upline signup bonus for referral - $${settings.uplineSignupBonusAmount}`,
        reference: userId.toString(),
        createdBy: null,
        session,
      });
      uplineBonus = result.transaction;
    }
  }

  return { userBonus, uplineBonus };
};

/**
 * Credits direct income to a user's Main Wallet instantly.
 * Called when someone in the user's downline makes an investment.
 *
 * Phase 2 changes:
 * - Skips if recipient is not activated (isActivated === false)
 * - Enforces 3X network income cap: cumulative Direct+Level income
 *   cannot exceed 3× eligibleInvestmentBase
 * - Overflow goes to pendingCommissions instead of mainBalance
 *
 * @param {string} directUplineId - the direct upline who receives the income
 * @param {number} investmentAmount - the actual investment amount (after activation fee)
 * @param {import('mongoose').ClientSession} session - caller's MongoDB session
 * @param {string} [investmentId] - the investment that generated this income
 * @returns {Promise<Object|null>} { mainCredited, pendingCredited, transaction, pendingTransaction } or null
 */
const creditDirectIncome = async (directUplineId, investmentAmount, session, investmentId = null) => {
  const settings = await SystemSettings.getSettings();
  const level1Config = (settings.levels || []).find(l => l.level === 1);
  const percentage = level1Config ? level1Config.percentage : (settings.directIncomePercentage || 0);

  if (percentage <= 0 || !directUplineId) {
    return null;
  }

  const incomeAmount = roundToTwoDecimals((investmentAmount * percentage) / 100);

  if (incomeAmount <= 0) {
    return null;
  }

  // Check activation status — inactive users get nothing
  const upline = await User.findById(directUplineId).session(session);
  if (!upline || !upline.isActivated) {
    return null;
  }

  // Fetch wallet inside session for atomic cap check
  let wallet = await Wallet.findOne({ user: directUplineId }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ user: directUplineId }], { session });
    wallet = created[0];
  }

  // Unified 3X earnings cap enforcement
  const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
  const ownInvestment = wallet.totalInvestmentAmount || 0;
  const cap3x = roundToTwoDecimals(ownInvestment * 3);
  const newTotalAfterCredit = roundToTwoDecimals(currentEligibleEarnings + incomeAmount);

  let mainCredited = 0;
  let pendingCredited = 0;
  let mainTransaction = null;
  let pendingTransaction = null;

  if (newTotalAfterCredit <= cap3x) {
    // Under cap — full amount to main balance
    mainCredited = incomeAmount;
    const result = await walletService.adjustWalletBalance({
      userId: directUplineId,
      balanceField: 'mainBalance',
      amount: incomeAmount,
      type: 'DIRECT_INCOME',
      description: `Direct income (${percentage}%) from downline investment - $${incomeAmount}`,
      reference: null,
      createdBy: null,
      investmentId,
      metadata: { investmentAmount, percentage },
      session,
    });
    mainTransaction = result.transaction;
  } else {
    // Over cap — split between main and pending
    const allowedAmount = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));
    pendingCredited = roundToTwoDecimals(incomeAmount - allowedAmount);

    if (allowedAmount > 0) {
      mainCredited = allowedAmount;
      const result = await walletService.adjustWalletBalance({
        userId: directUplineId,
        balanceField: 'mainBalance',
        amount: allowedAmount,
        type: 'DIRECT_INCOME',
        description: `Direct income (${percentage}%) from downline investment - $${allowedAmount} (capped)`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage },
        session,
      });
      mainTransaction = result.transaction;
    }

    if (pendingCredited > 0) {
      const pendingResult = await walletService.adjustWalletBalance({
        userId: directUplineId,
        balanceField: 'pendingCommissions',
        amount: pendingCredited,
        type: 'PENDING_NETWORK_COMMISSION',
        description: `Pending network commission (3X cap overflow) - $${pendingCredited}`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage, incomeType: 'DIRECT_INCOME' },
        session,
      });
      pendingTransaction = pendingResult.transaction;
    }
  }

  // Update tracking fields atomically — only ACTUALLY CREDITED amount counts
  wallet.totalEligibleEarnings = roundToTwoDecimals(currentEligibleEarnings + mainCredited);
  await wallet.save({ session });

  return { mainCredited, pendingCredited, mainTransaction, pendingTransaction };
};

/**
 * Credits level 2 (indirect) income to a user's Main Wallet instantly.
 * Called when someone 2 levels down makes an investment.
 *
 * Level 1 = Direct upline (gets direct income)
 * Level 2 = Indirect upline (gets level income)
 *
 * Phase 2 changes:
 * - Skips if recipient is not activated (isActivated === false)
 * - Enforces 3X network income cap
 * - Overflow goes to pendingCommissions
 *
 * @param {string} level2UplineId - the level 2 upline who receives the income
 * @param {number} investmentAmount - the actual investment amount (after activation fee)
 * @param {import('mongoose').ClientSession} session - caller's MongoDB session
 * @param {string} [investmentId] - the investment that generated this income
 * @returns {Promise<Object|null>} { mainCredited, pendingCredited, transaction, pendingTransaction } or null
 */
const creditLevelIncome = async (level2UplineId, investmentAmount, session, investmentId = null) => {
  const settings = await SystemSettings.getSettings();
  const level2Config = (settings.levels || []).find(l => l.level === 2);
  const percentage = level2Config ? level2Config.percentage : (settings.levelIncomePercentage || 0);

  if (percentage <= 0 || !level2UplineId) {
    return null;
  }

  const incomeAmount = roundToTwoDecimals((investmentAmount * percentage) / 100);

  if (incomeAmount <= 0) {
    return null;
  }

  // Check activation status — inactive users get nothing
  const upline = await User.findById(level2UplineId).session(session);
  if (!upline || !upline.isActivated) {
    return null;
  }

  // Fetch wallet inside session for atomic cap check
  let wallet = await Wallet.findOne({ user: level2UplineId }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ user: level2UplineId }], { session });
    wallet = created[0];
  }

  // Unified 3X earnings cap enforcement
  const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
  const currentBase = wallet.eligibleInvestmentBase || 0;
  const newBase = roundToTwoDecimals(currentBase + investmentAmount);
  const cap3x = roundToTwoDecimals(newBase * 3);
  const newTotalAfterCredit = roundToTwoDecimals(currentEligibleEarnings + incomeAmount);

  let mainCredited = 0;
  let pendingCredited = 0;
  let mainTransaction = null;
  let pendingTransaction = null;

  if (newTotalAfterCredit <= cap3x) {
    // Under cap — full amount to main balance
    mainCredited = incomeAmount;
    const result = await walletService.adjustWalletBalance({
      userId: level2UplineId,
      balanceField: 'mainBalance',
      amount: incomeAmount,
      type: 'LEVEL_INCOME',
      description: `Level income (${percentage}%) from indirect downline investment - $${incomeAmount}`,
      reference: null,
      createdBy: null,
      investmentId,
      metadata: { investmentAmount, percentage },
      session,
    });
    mainTransaction = result.transaction;
  } else {
    // Over cap — split between main and pending
    const allowedAmount = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));
    pendingCredited = roundToTwoDecimals(incomeAmount - allowedAmount);

    if (allowedAmount > 0) {
      mainCredited = allowedAmount;
      const result = await walletService.adjustWalletBalance({
        userId: level2UplineId,
        balanceField: 'mainBalance',
        amount: allowedAmount,
        type: 'LEVEL_INCOME',
        description: `Level income (${percentage}%) from indirect downline investment - $${allowedAmount} (capped)`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage },
        session,
      });
      mainTransaction = result.transaction;
    }

    if (pendingCredited > 0) {
      const pendingResult = await walletService.adjustWalletBalance({
        userId: level2UplineId,
        balanceField: 'pendingCommissions',
        amount: pendingCredited,
        type: 'PENDING_NETWORK_COMMISSION',
        description: `Pending network commission (3X cap overflow) - $${pendingCredited}`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage, incomeType: 'LEVEL_INCOME' },
        session,
      });
      pendingTransaction = pendingResult.transaction;
    }
  }

  // Update tracking fields atomically — only ACTUALLY CREDITED amount counts
  wallet.totalEligibleEarnings = roundToTwoDecimals(currentEligibleEarnings + mainCredited);
  wallet.eligibleInvestmentBase = newBase;
  await wallet.save({ session });

  return { mainCredited, pendingCredited, mainTransaction, pendingTransaction };
};

/**
 * Credits level income for a specific configured level to an upline's Main Wallet.
 * Called for Level 2+ (Level 1 uses creditDirectIncome).
 *
 * Reads the percentage from settings.levels for the given level number.
 * Enforces the same 3X cap as all other eligible income.
 *
 * @param {number} level - the configured level number (2, 3, 4, ...)
 * @param {string} uplineId - the upline who receives this level's income
 * @param {number} investmentAmount - the actual investment amount
 * @param {import('mongoose').ClientSession} session - caller's MongoDB session
 * @param {string} [investmentId] - the investment that generated this income
 * @returns {Promise<Object|null>} { mainCredited, pendingCredited, mainTransaction, pendingTransaction } or null
 */
const creditLevelIncomeForLevel = async (level, uplineId, investmentAmount, session, investmentId = null) => {
  const settings = await SystemSettings.getSettings();
  const levelConfig = (settings.levels || []).find(l => l.level === level);
  const percentage = levelConfig ? levelConfig.percentage : 0;

  if (percentage <= 0 || !uplineId) {
    return null;
  }

  const incomeAmount = roundToTwoDecimals((investmentAmount * percentage) / 100);

  if (incomeAmount <= 0) {
    return null;
  }

  // Check activation status — inactive users get nothing
  const upline = await User.findById(uplineId).session(session);
  if (!upline || !upline.isActivated) {
    return null;
  }

  // Fetch wallet inside session for atomic cap check
  let wallet = await Wallet.findOne({ user: uplineId }).session(session);
  if (!wallet) {
    const created = await Wallet.create([{ user: uplineId }], { session });
    wallet = created[0];
  }

  // Unified 3X earnings cap enforcement
  const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
  const ownInvestment = wallet.totalInvestmentAmount || 0;
  const cap3x = roundToTwoDecimals(ownInvestment * 3);
  const newTotalAfterCredit = roundToTwoDecimals(currentEligibleEarnings + incomeAmount);

  let mainCredited = 0;
  let pendingCredited = 0;
  let mainTransaction = null;
  let pendingTransaction = null;

  if (newTotalAfterCredit <= cap3x) {
    // Under cap — full amount to main balance
    mainCredited = incomeAmount;
    const result = await walletService.adjustWalletBalance({
      userId: uplineId,
      balanceField: 'mainBalance',
      amount: incomeAmount,
      type: 'LEVEL_INCOME',
      description: `Level ${level} income (${percentage}%) from downline investment - $${incomeAmount}`,
      reference: null,
      createdBy: null,
      investmentId,
      metadata: { investmentAmount, percentage, level },
      session,
    });
    mainTransaction = result.transaction;
  } else {
    // Over cap — split between main and pending
    const allowedAmount = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));
    pendingCredited = roundToTwoDecimals(incomeAmount - allowedAmount);

    if (allowedAmount > 0) {
      mainCredited = allowedAmount;
      const result = await walletService.adjustWalletBalance({
        userId: uplineId,
        balanceField: 'mainBalance',
        amount: allowedAmount,
        type: 'LEVEL_INCOME',
        description: `Level ${level} income (${percentage}%) from downline investment - $${allowedAmount} (capped)`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage, level },
        session,
      });
      mainTransaction = result.transaction;
    }

    if (pendingCredited > 0) {
      const pendingResult = await walletService.adjustWalletBalance({
        userId: uplineId,
        balanceField: 'pendingCommissions',
        amount: pendingCredited,
        type: 'PENDING_NETWORK_COMMISSION',
        description: `Pending network commission (3X cap overflow) - $${pendingCredited}`,
        reference: null,
        createdBy: null,
        investmentId,
        metadata: { investmentAmount, percentage, incomeType: 'LEVEL_INCOME', level },
        session,
      });
      pendingTransaction = pendingResult.transaction;
    }
  }

  // Update tracking fields atomically — only ACTUALLY CREDITED amount counts
  wallet.totalEligibleEarnings = roundToTwoDecimals(currentEligibleEarnings + mainCredited);
  await wallet.save({ session });

  return { mainCredited, pendingCredited, mainTransaction, pendingTransaction };
};

/**
 * Distributes profit share from platform revenue to uplines based on
 * configured profitShareLevels. Admin-triggered only.
 *
 * For each eligible user's investment, traverses their upline chain
 * and distributes the configured percentage at each level.
 *
 * 3X CAP ENFORCEMENT: Total eligible earnings cannot exceed 3x eligibleInvestmentBase.
 * Overflow goes to pendingCommissions.
 *
 * @param {number} totalAmount - total amount to distribute (used as source)
 * @param {string} adminId - admin who triggered the distribution
 * @returns {Promise<{ distributed: number, userCount: number, levels: number }>}
 */
const distributeProfitShare = async (totalAmount, adminId) => {
  const settings = await SystemSettings.getSettings();

  if (!settings.profitShareTransferEnabled) {
    const error = new Error('Profit Share distribution is currently disabled by admin');
    error.statusCode = 400;
    throw error;
  }

  const psLevels = settings.profitShareLevels || [];
  if (psLevels.length === 0) {
    const error = new Error('No profit share levels configured');
    error.statusCode = 400;
    throw error;
  }

  const roundedTotal = roundToTwoDecimals(totalAmount);
  if (roundedTotal <= 0) {
    const error = new Error('Distribution amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  // Find all users who have investments (potential profit share recipients' downlines)
  const Transaction = require('../models/Transaction');
  const investedAgg = await Transaction.aggregate([
    { $match: { type: 'INVESTMENT', status: 'COMPLETED' } },
    { $group: { _id: '$user', total: { $sum: '$amount' } } },
  ]);

  // Map investor userId -> total invested amount
  const investorMap = {};
  investedAgg.forEach((a) => {
    investorMap[a._id.toString()] = a.total;
  });

  if (Object.keys(investorMap).length === 0) {
    return { distributed: 0, userCount: 0, levels: psLevels.length };
  }

  // Collect all unique upline recipients and their expected amounts
  // Key: uplineId, Value: { totalAmount, description }
  const uplineRecipients = new Map();

  for (const [investorId, investedAmount] of Object.entries(investorMap)) {
    // For each investor, distribute to their upline chain according to profitShareLevels
    for (const psLevel of psLevels) {
      // Walk up the chain to find the upline at this level
      let currentId = investorId;
      let uplineAtLevel = null;

      for (let hop = 0; hop < psLevel.level; hop++) {
        const u = await User.findById(currentId).select('referredBy').lean();
        if (!u || !u.referredBy) break;
        currentId = u.referredBy.toString();
        if (hop === psLevel.level - 1) {
          uplineAtLevel = currentId;
        }
      }

      if (!uplineAtLevel) continue;

      const shareAmount = roundToTwoDecimals((investedAmount * psLevel.percentage) / 100);
      if (shareAmount <= 0) continue;

      const key = uplineAtLevel;
      if (!uplineRecipients.has(key)) {
        uplineRecipients.set(key, { totalAmount: 0, details: [] });
      }
      const entry = uplineRecipients.get(key);
      entry.totalAmount = roundToTwoDecimals(entry.totalAmount + shareAmount);
      entry.details.push({ investorId, level: psLevel.level, percentage: psLevel.percentage, shareAmount, investedAmount });
    }
  }

  const session = await require('mongoose').startSession();

  try {
    let distributed = 0;
    let userCount = 0;

    await session.withTransaction(async () => {
      for (const [uplineId, { totalAmount: uplineTotal, details }] of uplineRecipients) {
        if (uplineTotal <= 0) continue;

        // Check activation — inactive uplines get nothing
        const upline = await User.findById(uplineId).session(session);
        if (!upline || !upline.isActivated) continue;

        // Fetch wallet for 3X cap check
        let wallet = await Wallet.findOne({ user: uplineId }).session(session);
        if (!wallet) {
          const created = await Wallet.create([{ user: uplineId }], { session });
          wallet = created[0];
        }

        const ownInvestment = wallet.totalInvestmentAmount || 0;
        const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
        const cap3x = roundToTwoDecimals(ownInvestment * 3);
        const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));

        const allowedAmount = roundToTwoDecimals(Math.min(uplineTotal, remaining3x));
        const pendingAmount = roundToTwoDecimals(uplineTotal - allowedAmount);

        if (allowedAmount > 0) {
          await walletService.adjustWalletBalance({
            userId: uplineId,
            balanceField: 'profitShareBalance',
            amount: allowedAmount,
            type: 'PROFIT_SHARE',
            description: `Profit share distribution - $${allowedAmount}`,
            reference: `dist_${Date.now()}`,
            createdBy: adminId,
            session,
          });
          distributed = roundToTwoDecimals(distributed + allowedAmount);
          userCount++;
        }

        if (pendingAmount > 0) {
          await walletService.adjustWalletBalance({
            userId: uplineId,
            balanceField: 'pendingCommissions',
            amount: pendingAmount,
            type: 'PENDING_NETWORK_COMMISSION',
            description: `Pending profit share (3X cap overflow) - $${pendingAmount}`,
            reference: `dist_${Date.now()}`,
            createdBy: adminId,
            metadata: { incomeType: 'PROFIT_SHARE', details },
            session,
          });
        }

        // Track only ACTUALLY CREDITED amount in eligible earnings
        wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + allowedAmount);
        wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + uplineTotal);
        await wallet.save({ session });
      }
    });

    return { distributed, userCount, levels: psLevels.length };
  } finally {
    session.endSession();
  }
};

/**
 * Credits profit share to uplines from ROI earnings.
 * Called automatically after ROI is credited to the investor.
 * Traverses the investor's upline chain and distributes based on
 * configured profitShareLevels. Goes to profitShareBalance wallet.
 *
 * 3X CAP ENFORCEMENT: Total eligible earnings cannot exceed 3x totalInvestmentAmount.
 * Overflow goes to pendingCommissions.
 *
 * @param {string} investorId - the user who earned ROI
 * @param {number} roiAmount - the ROI amount (not investment amount)
 * @param {import('mongoose').ClientSession} session - caller's MongoDB session
 * @param {string} [investmentId] - the investment that generated this ROI
 * @returns {Promise<{ distributed: number, recipients: number }>}
 */
const creditProfitShareFromRoi = async (investorId, roiAmount, session, investmentId = null) => {
  const settings = await SystemSettings.getSettings();

  const psLevels = settings.profitShareLevels || [];
  if (psLevels.length === 0) {
    return { distributed: 0, recipients: 0 };
  }

  const roundedAmount = roundToTwoDecimals(roiAmount);
  if (roundedAmount <= 0) {
    return { distributed: 0, recipients: 0 };
  }

  const User = require('../models/User');
  const investor = await User.findById(investorId).session(session);
  if (!investor || !investor.referredBy) {
    return { distributed: 0, recipients: 0 };
  }

  let distributed = 0;
  let recipients = 0;

  // Start from investor's direct upline and walk sequentially —
  // each iteration = next upline in chain (same logic as level income).
  let currentUserId = investor.referredBy.toString();

  for (const psLevel of psLevels) {
    if (!currentUserId) break;

    const shareAmount = roundToTwoDecimals((roundedAmount * psLevel.percentage) / 100);
    if (shareAmount <= 0) {
      const currentUser = await User.findById(currentUserId).session(session);
      currentUserId = (currentUser && currentUser.referredBy) ? currentUser.referredBy.toString() : null;
      continue;
    }

    const upline = await User.findById(currentUserId).session(session);
    if (!upline || !upline.isActivated) {
      const currentUser = await User.findById(currentUserId).session(session);
      currentUserId = (currentUser && currentUser.referredBy) ? currentUser.referredBy.toString() : null;
      continue;
    }

    let wallet = await Wallet.findOne({ user: currentUserId }).session(session);
    if (!wallet) {
      const created = await Wallet.create([{ user: currentUserId }], { session });
      wallet = created[0];
    }

    const ownInvestment = wallet.totalInvestmentAmount || 0;
    const currentEligibleEarnings = wallet.totalEligibleEarnings || 0;
    const cap3x = roundToTwoDecimals(ownInvestment * 3);
    const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - currentEligibleEarnings));

    const allowedAmount = roundToTwoDecimals(Math.min(shareAmount, remaining3x));
    const pendingAmount = roundToTwoDecimals(shareAmount - allowedAmount);

    if (allowedAmount > 0) {
      await walletService.adjustWalletBalance({
        userId: currentUserId,
        balanceField: 'profitShareBalance',
        amount: allowedAmount,
        type: 'PROFIT_SHARE',
        description: `Profit share (${psLevel.percentage}%) from downline ROI - $${allowedAmount}`,
        reference: investmentId ? investmentId.toString() : null,
        createdBy: null,
        investmentId,
        session,
      });
      distributed = roundToTwoDecimals(distributed + allowedAmount);
      recipients++;
    }

    if (pendingAmount > 0) {
      await walletService.adjustWalletBalance({
        userId: currentUserId,
        balanceField: 'pendingCommissions',
        amount: pendingAmount,
        type: 'PENDING_NETWORK_COMMISSION',
        description: `Pending profit share from ROI (3X cap overflow) - $${pendingAmount}`,
        reference: investmentId ? investmentId.toString() : null,
        createdBy: null,
        investmentId,
        metadata: { incomeType: 'PROFIT_SHARE_FROM_ROI', percentage: psLevel.percentage },
        session,
      });
    }

    wallet.totalEligibleEarnings = roundToTwoDecimals((wallet.totalEligibleEarnings || 0) + allowedAmount);
    wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + shareAmount);
    await wallet.save({ session });

    // Advance to next upline in chain
    const currentUser = await User.findById(currentUserId).session(session);
    currentUserId = (currentUser && currentUser.referredBy) ? currentUser.referredBy.toString() : null;
  }

  return { distributed, recipients };
};

module.exports = {
  processRegistrationBonuses,
  creditDirectIncome,
  creditLevelIncome,
  creditLevelIncomeForLevel,
  distributeProfitShare,
  creditProfitShareFromRoi,
  roundToTwoDecimals,
};
