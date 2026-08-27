const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema(
  {
    // Fixed singleton key — ensures only one settings document ever exists
    singletonKey: {
      type: String,
      default: 'GLOBAL_SETTINGS',
      unique: true,
      immutable: true,
    },

    // ==========================================
    // INVESTMENT SETTINGS
    // ==========================================
    allowUserInvestment: {
      type: Boolean,
      default: false, // conservative default: only admins can add investments until enabled
    },

    // ==========================================
    // ROI SETTINGS
    // ==========================================
    roiMode: {
      type: String,
      enum: ['DAY_WISE', 'OVERALL'],
      default: 'OVERALL',
    },

    roiProcessingEnabled: {
      type: Boolean,
      default: false, // ROI distribution off by default until admin explicitly enables it
    },

    // Overall/default ROI percentage (used when roiMode === 'OVERALL')
    overallRoiPercentage: {
      type: Number,
      default: 0,
      min: [0, 'ROI percentage cannot be negative'],
      max: [100, 'ROI percentage cannot exceed 100'],
    },

    // Day-wise ROI percentages (used when roiMode === 'DAY_WISE')
    dayWiseRoi: {
      monday: { type: Number, default: 0, min: 0, max: 100 },
      tuesday: { type: Number, default: 0, min: 0, max: 100 },
      wednesday: { type: Number, default: 0, min: 0, max: 100 },
      thursday: { type: Number, default: 0, min: 0, max: 100 },
      friday: { type: Number, default: 0, min: 0, max: 100 },
      saturday: { type: Number, default: 0, min: 0, max: 100 },
      sunday: { type: Number, default: 0, min: 0, max: 100 },
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ==========================================
    // INVESTMENT PLANS CATALOG
    // (used by the user-facing plan selection UI)
    // ==========================================
    plans: [
      {
        name: { type: String, required: true, trim: true },
        roiPercentage: {
          type: Number,
          required: true,
          min: [0, 'ROI percentage cannot be negative'],
          max: [100, 'ROI percentage cannot exceed 100'],
        },
        durationDays: { type: Number, required: true, min: [1, 'Duration must be at least 1 day'] },
        minAmount: { type: Number, default: 100, min: [0, 'Minimum amount cannot be negative'] },
        maxAmount: { type: Number, default: 1000000, min: [0, 'Maximum amount cannot be negative'] },
        description: { type: String, default: '', trim: true },
        active: { type: Boolean, default: true },
      },
    ],
  },
  {
    timestamps: true,
  }
);

/**
 * Fetches the single settings document, creating it with defaults
 * if it doesn't exist yet (e.g. on first server run). Seeds a default
 * set of investment plans so the UI has something to display.
 *
 * @returns {Promise<Object>} the settings document
 */
systemSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ singletonKey: 'GLOBAL_SETTINGS' });

  if (!settings) {
    settings = await this.create({
      singletonKey: 'GLOBAL_SETTINGS',
      plans: [
        {
          name: 'Starter Plan',
          roiPercentage: 1,
          durationDays: 30,
          minAmount: 100,
          maxAmount: 5000,
          description: 'Entry-level plan with daily ROI accrual.',
          active: true,
        },
        {
          name: 'Growth Plan',
          roiPercentage: 2,
          durationDays: 60,
          minAmount: 5000,
          maxAmount: 50000,
          description: 'Balanced plan for growing portfolios.',
          active: true,
        },
        {
          name: 'Premium Plan',
          roiPercentage: 3,
          durationDays: 90,
          minAmount: 50000,
          maxAmount: 500000,
          description: 'High-yield plan for serious investors.',
          active: true,
        },
      ],
    });
  }

  return settings;
};

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

module.exports = SystemSettings;