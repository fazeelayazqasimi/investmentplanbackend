const mongoose = require('mongoose');

const rankSchema = new mongoose.Schema(
  {
    level: {
      type: Number,
      required: [true, 'Rank level is required'],
      unique: true,
      min: [1, 'Rank level must be at least 1'],
    },

    name: {
      type: String,
      required: [true, 'Rank name is required'],
      trim: true,
      maxlength: [50, 'Rank name cannot exceed 50 characters'],
    },

    symbol: {
      type: String,
      default: '',
    },

    color: {
      type: String,
      default: '#6366f1',
    },

    criteria: {
      selfDeposit: {
        type: Number,
        default: 0,
        min: [0, 'Self deposit criteria cannot be negative'],
      },
      directBusiness: {
        type: Number,
        default: 0,
        min: [0, 'Direct business criteria cannot be negative'],
      },
      totalTeamBusiness: {
        type: Number,
        default: 0,
        min: [0, 'Total team business criteria cannot be negative'],
      },
      legs: {
        type: Number,
        default: 0,
        min: [0, 'Legs criteria cannot be negative'],
      },
    },

    promotionType: {
      type: String,
      enum: ['AUTO', 'MANUAL'],
      default: 'AUTO',
    },

    autoPromotionCriteria: {
      requiredDirectRanks: {
        type: Number,
        default: 3,
        min: [1, 'Required direct ranks must be at least 1'],
      },
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    rankDowngradeEnabled: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

rankSchema.index({ isActive: 1 });

const Rank = mongoose.model('Rank', rankSchema);

module.exports = Rank;
