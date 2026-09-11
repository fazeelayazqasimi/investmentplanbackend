const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Wallet must belong to a user'],
      unique: true,
      index: true,
    },

    mainBalance: {
      type: Number,
      default: 0,
      min: [0, 'Main balance cannot be negative'],
    },

    roiBalance: {
      type: Number,
      default: 0,
      min: [0, 'ROI balance cannot be negative'],
    },

    commissionBalance: {
      type: Number,
      default: 0,
      min: [0, 'Commission balance cannot be negative'],
    },

    ewalletBalance: {
      type: Number,
      default: 0,
      min: [0, 'E-Wallet balance cannot be negative'],
    },

    profitShareBalance: {
      type: Number,
      default: 0,
      min: [0, 'Profit Share balance cannot be negative'],
    },

    pendingCommissions: {
      type: Number,
      default: 0,
      min: [0, 'Pending commissions cannot be negative'],
    },

    fundBalance: {
      type: Number,
      default: 0,
      min: [0, 'Fund balance cannot be negative'],
    },

    // Cumulative network income (Direct + Level + ProfitShare) earned by this user.
    // Used for 3X ALL-earnings cap enforcement.
    totalNetworkIncome: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Sum of downline investment amounts that generated network income
    // for this user. Used as the base for 3X cap calculation.
    eligibleInvestmentBase: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Cumulative lifetime earnings (ROI + commission + bonuses combined).
    // This is a running total for display purposes — it does not
    // decrease even if balances are later withdrawn/spent, since it
    // represents "total earned," not "current balance."
    totalEarnings: {
      type: Number,
      default: 0,
      min: [0, 'Total earnings cannot be negative'],
    },

    // Total amount invested by this user (sum of all investments).
    // Used for ROI 2X cap and 3X earnings cap calculations.
    totalInvestmentAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Maximum ROI return = totalInvestmentAmount * 2
    totalMaxReturn: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total ROI earned across all investments (for 2X cap tracking).
    totalRoiEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total amount returned to user from ROI (for 2X cap tracking).
    totalReturned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total profit share earned (for 3X cap tracking).
    totalProfitShareEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Unified eligible earnings for overall 3X cap.
    // Counts: ROI + Direct + Level + ProfitShare
    // Excludes: Signup Bonus, Upline Bonus, E-Wallet, Activation Fee, Fund transfers
    totalEligibleEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Fetches a user's wallet, creating one with zero balances if it
 * doesn't exist yet (e.g. first time any balance-affecting action
 * happens for that user).
 *
 * @param {string} userId
 * @returns {Promise<Object>} the wallet document
 */
walletSchema.statics.getOrCreateWallet = async function (userId) {
  let wallet = await this.findOne({ user: userId });

  if (!wallet) {
    wallet = await this.create({ user: userId });
  }

  return wallet;
};

const Wallet = mongoose.model('Wallet', walletSchema);

module.exports = Wallet;