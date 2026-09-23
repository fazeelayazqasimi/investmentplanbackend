const Investment = require('../models/Investment');
const Wallet = require('../models/Wallet');

/**
 * Rounds a number to 2 decimal places safely for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Evaluates a wallet against the global 2X ROI cap and 3X earnings cap.
 *
 * - 2X full: totalRoiEarned (or totalReturned) >= totalInvestmentAmount * 2
 * - 3X full: totalEligibleEarnings >= totalInvestmentAmount * 3
 *
 * @param {Object|null} wallet
 * @returns {'2X'|'3X'|null} which cap is full, or null if neither (or no investment base)
 */
const getCapStatus = (wallet) => {
  if (!wallet) return null;

  const totalInv = wallet.totalInvestmentAmount || 0;
  if (totalInv <= 0) return null;

  const cap2x = roundToTwoDecimals(totalInv * 2);
  const cap3x = roundToTwoDecimals(totalInv * 3);
  const roiEarned = wallet.totalRoiEarned || 0;
  const returned = wallet.totalReturned || 0;
  const eligible = wallet.totalEligibleEarnings || 0;

  if (cap2x > 0 && (roiEarned >= cap2x || returned >= cap2x)) return '2X';
  if (cap3x > 0 && eligible >= cap3x) return '3X';

  return null;
};

/**
 * Pauses ALL of a user's ACTIVE investments (cap is wallet-global, so
 * every active investment must stop when either cap is hit).
 *
 * @param {string} userId
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<number>} modified count
 */
const pauseAllActive = async (userId, session = null) => {
  if (!userId) return 0;

  const result = await Investment.updateMany(
    { user: userId, status: 'ACTIVE' },
    { $set: { status: 'PAUSED' } },
    session ? { session } : {}
  );
  return result.modifiedCount || 0;
};

/**
 * If the user's 2X or 3X cap is already full, pauses ALL their ACTIVE
 * investments immediately. Safe/no-op when caps are not full.
 *
 * @param {string} userId
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<{ paused: boolean, cap: '2X'|'3X'|null, modifiedCount: number }>}
 */
const pauseIfCapFull = async (userId, session = null) => {
  if (!userId) return { paused: false, cap: null, modifiedCount: 0 };

  const query = Wallet.findOne({ user: userId });
  if (session) query.session(session);
  const wallet = await query;

  const cap = getCapStatus(wallet);
  if (!cap) return { paused: false, cap: null, modifiedCount: 0 };

  const modifiedCount = await pauseAllActive(userId, session);
  return { paused: true, cap, modifiedCount };
};

module.exports = {
  getCapStatus,
  pauseAllActive,
  pauseIfCapFull,
  roundToTwoDecimals,
};
