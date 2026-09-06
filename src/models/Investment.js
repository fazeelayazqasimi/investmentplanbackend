const mongoose = require('mongoose');

const investmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Investment must belong to a user'],
      index: true,
    },

    // Plan/type is a free-form label for now — no fixed plan catalog
    // has been specified, so we keep this flexible rather than
    // inventing a plans system.
    plan: {
      type: String,
      required: [true, 'Investment plan/type is required'],
      trim: true,
    },

    originalAmount: {
      type: Number,
      required: [true, 'Original investment amount is required'],
      min: [0.01, 'Investment amount must be greater than zero'],
    },

    // Maximum return is always 2x the original amount.
    // Stored explicitly (not just computed on the fly) so historical
    // investments remain accurate even if business rules change later.
    maxReturnAmount: {
      type: Number,
      required: true,
      min: [0, 'Max return amount cannot be negative'],
    },

    totalRoiEarned: {
      type: Number,
      default: 0,
      min: [0, 'Total ROI earned cannot be negative'],
    },

    totalReturned: {
      type: Number,
      default: 0,
      min: [0, 'Total returned cannot be negative'],
    },

    status: {
      type: String,
      enum: ['ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED'],
      default: 'ACTIVE',
      index: true,
    },

    // Snapshot of which ROI mode applied when this investment was
    // created/processed — kept for audit purposes since global
    // settings can change over time but history must stay accurate.
    roiMode: {
      type: String,
      enum: ['DAY_WISE', 'OVERALL'],
      required: [true, 'ROI mode is required'],
    },

    // ROI percentage applied to this investment (snapshot at creation time,
    // sourced from the selected plan / system settings). Used for reporting.
    roiPercentage: {
      type: Number,
      default: 0,
      min: [0, 'ROI percentage cannot be negative'],
      max: [100, 'ROI percentage cannot exceed 100'],
    },

    // Plan duration in days (snapshot at creation time). Used to compute endDate.
    durationDays: {
      type: Number,
      default: null,
    },

    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
      default: Date.now,
    },

    endDate: {
      type: Date,
      default: null,
    },

    completionDate: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ==========================================
// INDEXES
// ==========================================
investmentSchema.index({ user: 1, status: 1 });

// ==========================================
// VIRTUAL - Remaining ROI (derived, not stored)
// ==========================================
investmentSchema.virtual('remainingReturn').get(function () {
  return Math.max(0, roundToTwoDecimals(this.maxReturnAmount - this.totalReturned));
});

// ==========================================
// VIRTUAL - Completion percentage (derived, not stored)
// ==========================================
investmentSchema.virtual('completionPercentage').get(function () {
  if (this.maxReturnAmount <= 0) return 0;
  const percentage = (this.totalReturned / this.maxReturnAmount) * 100;
  return Math.min(100, roundToTwoDecimals(percentage));
});

investmentSchema.set('toJSON', { virtuals: true });
investmentSchema.set('toObject', { virtuals: true });

/**
 * Rounds a number to 2 decimal places safely, avoiding common
 * floating-point artifacts (e.g. 0.1 + 0.2 issues) for currency values.
 */
function roundToTwoDecimals(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const Investment = mongoose.model('Investment', investmentSchema);

module.exports = Investment;