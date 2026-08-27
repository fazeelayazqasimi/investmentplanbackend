const mongoose = require('mongoose');

const roiHistorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      index: true,
    },

    investment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Investment',
      required: [true, 'Investment is required'],
      index: true,
    },

    roiPercentage: {
      type: Number,
      required: [true, 'ROI percentage is required'],
      min: [0, 'ROI percentage cannot be negative'],
    },

    roiAmount: {
      type: Number,
      required: [true, 'ROI amount is required'],
      min: [0, 'ROI amount cannot be negative'],
    },

    originalInvestmentAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    previousTotalReturned: {
      type: Number,
      required: true,
      min: 0,
    },

    newTotalReturned: {
      type: Number,
      required: true,
      min: 0,
    },

    remainingReturn: {
      type: Number,
      required: true,
      min: 0,
    },

    // The calendar date this ROI distribution is FOR (normalized to
    // midnight UTC), not the timestamp it was processed at. This is
    // the field the duplicate-prevention unique index relies on.
    roiDate: {
      type: Date,
      required: [true, 'ROI date is required'],
      index: true,
    },

    // Day of week name, stored for readability/reporting (derived from
    // roiDate at creation time, relevant mainly for DAY_WISE mode).
    roiDay: {
      type: String,
      enum: [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ],
      required: [true, 'ROI day is required'],
    },

    roiMode: {
      type: String,
      enum: ['DAY_WISE', 'OVERALL'],
      required: [true, 'ROI mode is required'],
    },

    transactionType: {
      type: String,
      enum: ['ROI'],
      default: 'ROI',
    },

    status: {
      type: String,
      enum: ['SUCCESS', 'CAPPED', 'SKIPPED'],
      default: 'SUCCESS',
      // SUCCESS = full calculated ROI applied
      // CAPPED  = ROI was reduced because it would have exceeded the 2X limit
      // SKIPPED = investment was already completed, no ROI applied (rare,
      //           kept for audit trail if this state is ever reached)
    },
  },
  {
    timestamps: true,
  }
);

// ==========================================
// UNIQUE INDEX - Prevents duplicate ROI distribution
// for the same investment on the same date, at the database level.
// ==========================================
roiHistorySchema.index({ investment: 1, roiDate: 1 }, { unique: true });

// ==========================================
// ADDITIONAL INDEXES for common queries
// ==========================================
roiHistorySchema.index({ user: 1, roiDate: -1 });
roiHistorySchema.index({ investment: 1, roiDate: -1 });

const ROIHistory = mongoose.model('ROIHistory', roiHistorySchema);

module.exports = ROIHistory;