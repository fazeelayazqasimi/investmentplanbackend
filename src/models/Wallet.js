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

    // Cumulative lifetime earnings (ROI + commission combined).
    // This is a running total for display purposes — it does not
    // decrease even if balances are later withdrawn/spent, since it
    // represents "total earned," not "current balance."
    totalEarnings: {
      type: Number,
      default: 0,
      min: [0, 'Total earnings cannot be negative'],
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