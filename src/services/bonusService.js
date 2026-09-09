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
 * @returns {Promise<Object|null>} { mainCredited, pendingCredited, transaction, pendingTransaction } or null
 */
const creditDirectIncome = async (directUplineId, investmentAmount, session) => {
  const settings = await SystemSettings.getSettings();
  const percentage = settings.directIncomePercentage || 0;

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

  // 3X network income cap enforcement
  const currentNetworkIncome = wallet.totalNetworkIncome || 0;
  const currentBase = wallet.eligibleInvestmentBase || 0;
  const newBase = roundToTwoDecimals(currentBase + investmentAmount);
  const cap = roundToTwoDecimals(newBase * 3);
  const newTotalAfterCredit = roundToTwoDecimals(currentNetworkIncome + incomeAmount);

  let mainCredited = 0;
  let pendingCredited = 0;
  let mainTransaction = null;
  let pendingTransaction = null;

  if (newTotalAfterCredit <= cap) {
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
      session,
    });
    mainTransaction = result.transaction;
  } else {
    // Over cap — split between main and pending
    const allowedAmount = roundToTwoDecimals(Math.max(0, cap - currentNetworkIncome));
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
        session,
      });
      pendingTransaction = pendingResult.transaction;
    }
  }

  // Update tracking fields atomically
  wallet.totalNetworkIncome = roundToTwoDecimals(currentNetworkIncome + incomeAmount);
  wallet.eligibleInvestmentBase = newBase;
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
 * @returns {Promise<Object|null>} { mainCredited, pendingCredited, transaction, pendingTransaction } or null
 */
const creditLevelIncome = async (level2UplineId, investmentAmount, session) => {
  const settings = await SystemSettings.getSettings();
  const percentage = settings.levelIncomePercentage || 0;

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

  // 3X network income cap enforcement
  const currentNetworkIncome = wallet.totalNetworkIncome || 0;
  const currentBase = wallet.eligibleInvestmentBase || 0;
  const newBase = roundToTwoDecimals(currentBase + investmentAmount);
  const cap = roundToTwoDecimals(newBase * 3);
  const newTotalAfterCredit = roundToTwoDecimals(currentNetworkIncome + incomeAmount);

  let mainCredited = 0;
  let pendingCredited = 0;
  let mainTransaction = null;
  let pendingTransaction = null;

  if (newTotalAfterCredit <= cap) {
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
      session,
    });
    mainTransaction = result.transaction;
  } else {
    // Over cap — split between main and pending
    const allowedAmount = roundToTwoDecimals(Math.max(0, cap - currentNetworkIncome));
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
        session,
      });
      pendingTransaction = pendingResult.transaction;
    }
  }

  // Update tracking fields atomically
  wallet.totalNetworkIncome = roundToTwoDecimals(currentNetworkIncome + incomeAmount);
  wallet.eligibleInvestmentBase = newBase;
  await wallet.save({ session });

  return { mainCredited, pendingCredited, mainTransaction, pendingTransaction };
};

/**
 * Distributes profit share from platform revenue to all active users.
 * Admin-triggered only. Each user's share goes to their Profit Share Wallet.
 *
 * 3X CAP ENFORCEMENT: Total earnings (Direct + Level + Profit Share) cannot
 * exceed 3x the user's eligible investment base. Overflow goes to pendingCommissions.
 *
 * Distribution methods:
 * - EQUAL: total amount divided equally among all active users
 * - PROPORTIONAL: distributed based on each user's total investment amount
 *
 * @param {number} totalAmount - total amount to distribute
 * @param {string} adminId - admin who triggered the distribution
 * @param {string} method - 'EQUAL' or 'PROPORTIONAL' (optional, uses settings default)
 * @returns {Promise<{ distributed: number, userCount: number, method: string }>}
 */
const distributeProfitShare = async (totalAmount, adminId, method = null) => {
  const settings = await SystemSettings.getSettings();
  const distributionMethod = method || settings.profitShareDistributionMethod || 'EQUAL';

  const roundedTotal = roundToTwoDecimals(totalAmount);
  if (roundedTotal <= 0) {
    const error = new Error('Distribution amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const activeUsers = await User.find({ role: 'USER', accountStatus: 'ACTIVE' }).lean();
  if (activeUsers.length === 0) {
    return { distributed: 0, userCount: 0, method: distributionMethod };
  }

  const session = await require('mongoose').startSession();

  try {
    let distributed = 0;
    let userCount = 0;

    await session.withTransaction(async () => {
      if (distributionMethod === 'EQUAL') {
        const perUser = roundToTwoDecimals(roundedTotal / activeUsers.length);

        for (const user of activeUsers) {
          if (perUser > 0) {
            // 3X CAP CHECK: Total earnings (Direct + Level + ProfitShare) cannot exceed 3x eligibleInvestmentBase
            const wallet = await Wallet.findOne({ user: user._id }).session(session);
            const eligibleBase = wallet ? (wallet.eligibleInvestmentBase || 0) : 0;
            const currentNetworkIncome = wallet ? (wallet.totalNetworkIncome || 0) : 0;
            const currentProfitShareEarned = wallet ? (wallet.totalProfitShareEarned || 0) : 0;
            const totalCurrentEarnings = roundToTwoDecimals(currentNetworkIncome + currentProfitShareEarned);
            const cap3x = roundToTwoDecimals(eligibleBase * 3);
            const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - totalCurrentEarnings));

            if (remaining3x <= 0) {
              // Already at 3x cap - all goes to pendingCommissions
              if (perUser > 0) {
                await walletService.adjustWalletBalance({
                  userId: user._id,
                  balanceField: 'pendingCommissions',
                  amount: perUser,
                  type: 'PENDING_NETWORK_COMMISSION',
                  description: `Pending profit share (3X cap overflow) - $${perUser}`,
                  reference: `dist_${Date.now()}`,
                  createdBy: adminId,
                  session,
                });
                // Still track profit share earned even though it's pending
                if (wallet) {
                  wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + perUser);
                  await wallet.save({ session });
                }
              }
              continue;
            }

            const allowedAmount = roundToTwoDecimals(Math.min(perUser, remaining3x));
            const pendingAmount = roundToTwoDecimals(perUser - allowedAmount);

            if (allowedAmount > 0) {
              await walletService.adjustWalletBalance({
                userId: user._id,
                balanceField: 'profitShareBalance',
                amount: allowedAmount,
                type: 'PROFIT_SHARE',
                description: `Profit share distribution (equal) - $${allowedAmount}`,
                reference: `dist_${Date.now()}`,
                createdBy: adminId,
                session,
              });
              distributed = roundToTwoDecimals(distributed + allowedAmount);
              userCount++;
            }

            if (pendingAmount > 0) {
              await walletService.adjustWalletBalance({
                userId: user._id,
                balanceField: 'pendingCommissions',
                amount: pendingAmount,
                type: 'PENDING_NETWORK_COMMISSION',
                description: `Pending profit share (3X cap overflow) - $${pendingAmount}`,
                reference: `dist_${Date.now()}`,
                createdBy: adminId,
                session,
              });
            }

            // Track profit share earned (both allowed + pending)
            if (wallet) {
              wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + perUser);
              await wallet.save({ session });
            }
          }
        }
      } else {
        // PROPORTIONAL: based on total invested amount
        const Transaction = require('../models/Transaction');
        const mongoose = require('mongoose');

        const investedAgg = await Transaction.aggregate([
          { $match: { type: 'INVESTMENT', status: 'COMPLETED' } },
          { $group: { _id: '$user', total: { $sum: '$amount' } } },
        ]);

        const investMap = {};
        let totalInvested = 0;
        investedAgg.forEach((a) => {
          investMap[a._id.toString()] = a.total;
          totalInvested += a.total;
        });

        if (totalInvested <= 0) {
          return;
        }

        for (const user of activeUsers) {
          const userInvested = investMap[user._id.toString()] || 0;
          if (userInvested > 0) {
            const share = roundToTwoDecimals((userInvested / totalInvested) * roundedTotal);
            if (share > 0) {
              // 3X CAP CHECK
              const wallet = await Wallet.findOne({ user: user._id }).session(session);
              const eligibleBase = wallet ? (wallet.eligibleInvestmentBase || 0) : 0;
              const currentNetworkIncome = wallet ? (wallet.totalNetworkIncome || 0) : 0;
              const currentProfitShareEarned = wallet ? (wallet.totalProfitShareEarned || 0) : 0;
              const totalCurrentEarnings = roundToTwoDecimals(currentNetworkIncome + currentProfitShareEarned);
              const cap3x = roundToTwoDecimals(eligibleBase * 3);
              const remaining3x = roundToTwoDecimals(Math.max(0, cap3x - totalCurrentEarnings));

              if (remaining3x <= 0) {
                if (share > 0) {
                  await walletService.adjustWalletBalance({
                    userId: user._id,
                    balanceField: 'pendingCommissions',
                    amount: share,
                    type: 'PENDING_NETWORK_COMMISSION',
                    description: `Pending profit share (3X cap overflow) - $${share}`,
                    reference: `dist_${Date.now()}`,
                    createdBy: adminId,
                    session,
                  });
                  if (wallet) {
                    wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + share);
                    await wallet.save({ session });
                  }
                }
                continue;
              }

              const allowedAmount = roundToTwoDecimals(Math.min(share, remaining3x));
              const pendingAmount = roundToTwoDecimals(share - allowedAmount);

              if (allowedAmount > 0) {
                await walletService.adjustWalletBalance({
                  userId: user._id,
                  balanceField: 'profitShareBalance',
                  amount: allowedAmount,
                  type: 'PROFIT_SHARE',
                  description: `Profit share distribution (proportional) - $${allowedAmount}`,
                  reference: `dist_${Date.now()}`,
                  createdBy: adminId,
                  session,
                });
                distributed = roundToTwoDecimals(distributed + allowedAmount);
                userCount++;
              }

              if (pendingAmount > 0) {
                await walletService.adjustWalletBalance({
                  userId: user._id,
                  balanceField: 'pendingCommissions',
                  amount: pendingAmount,
                  type: 'PENDING_NETWORK_COMMISSION',
                  description: `Pending profit share (3X cap overflow) - $${pendingAmount}`,
                  reference: `dist_${Date.now()}`,
                  createdBy: adminId,
                  session,
                });
              }

              if (wallet) {
                wallet.totalProfitShareEarned = roundToTwoDecimals((wallet.totalProfitShareEarned || 0) + share);
                await wallet.save({ session });
              }
            }
          }
        }
      }
    });

    return { distributed, userCount, method: distributionMethod };
  } finally {
    session.endSession();
  }
};

module.exports = {
  processRegistrationBonuses,
  creditDirectIncome,
  creditLevelIncome,
  distributeProfitShare,
  roundToTwoDecimals,
};
