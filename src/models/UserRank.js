const mongoose = require('mongoose');

const userRankSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      unique: true,
      index: true,
    },

    rank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rank',
      default: null,
    },

    achievedAt: {
      type: Date,
      default: Date.now,
    },

    previousRank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rank',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const UserRank = mongoose.model('UserRank', userRankSchema);

module.exports = UserRank;
