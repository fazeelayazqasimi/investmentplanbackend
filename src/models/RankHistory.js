const mongoose = require('mongoose');

const rankHistorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      index: true,
    },

    fromRank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rank',
      default: null,
    },

    toRank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rank',
      required: [true, 'To rank is required'],
    },

    reason: {
      type: String,
      enum: ['CRITERIA_MET', 'AUTO_PROMOTION', 'ADMIN_OVERRIDE', 'DOWNGRADE'],
      required: [true, 'Reason is required'],
    },

    details: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    achievedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

rankHistorySchema.index({ user: 1, achievedAt: -1 });

const RankHistory = mongoose.model('RankHistory', rankHistorySchema);

module.exports = RankHistory;
