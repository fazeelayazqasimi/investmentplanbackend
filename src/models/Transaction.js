const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Transaction must belong to a user'],
      index: true,
    },

    // Optional — only set for transactions tied to a specific investment
    // (e.g. INVESTMENT, ROI). Not applicable to DEPOSIT/WITHDRAWAL/ADJUSTMENT.
    investment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Investment',
      default: null,
      index: true,
    },

    amount: {
      type: Number,
      required: [true, 'Transaction amount is required'],
    },

    type: {
      type: String,
      enum: [
        'INVESTMENT', 'ROI', 'COMMISSION', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT',
        'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS', 'ACTIVATION_FEE',
        'DIRECT_INCOME', 'LEVEL_INCOME',
        'ROI_TRANSFER', 'PROFIT_SHARE', 'PROFIT_SHARE_TRANSFER',
        'E_WALLET_USAGE',
        'PENDING_ROI', 'PENDING_NETWORK_COMMISSION',
        'FUND_TRANSFER_SENT', 'FUND_TRANSFER_RECEIVED',
      ],
      required: [true, 'Transaction type is required'],
      index: true,
    },

    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
      default: 'COMPLETED',
    },

    description: {
      type: String,
      trim: true,
      default: '',
    },

    // Optional external/internal reference (e.g. ROIHistory ID,
    // admin action ID, or a future payment gateway reference).
    // Kept as a free-form string since the source varies by type.
    reference: {
      type: String,
      trim: true,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      // null = system-generated (e.g. automatic ROI distribution)
      // set  = admin-initiated (e.g. manual adjustment)
    },
  },
  {
    timestamps: true,
  }
);

// ==========================================
// INDEXES for common queries
// ==========================================
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ investment: 1, type: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;