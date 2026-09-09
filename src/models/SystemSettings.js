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
    // E-WALLET SETTINGS
    // ==========================================
    ewalletEnabled: {
      type: Boolean,
      default: true,
    },
    ewalletUsageEnabled: {
      type: Boolean,
      default: false,
    },
    signupBonusAmount: {
      type: Number,
      default: 10,
      min: [0, 'Signup bonus cannot be negative'],
    },
    uplineSignupBonusAmount: {
      type: Number,
      default: 5,
      min: [0, 'Upline bonus cannot be negative'],
    },

    // ==========================================
    // ACTIVATION SETTINGS
    // ==========================================
    activationFee: {
      type: Number,
      default: 10,
      min: [0, 'Activation fee cannot be negative'],
    },

    // ==========================================
    // INCOME SETTINGS
    // ==========================================
    directIncomePercentage: {
      type: Number,
      default: 10,
      min: [0, 'Direct income percentage cannot be negative'],
      max: [100, 'Direct income percentage cannot exceed 100'],
    },
    levelIncomePercentage: {
      type: Number,
      default: 5,
      min: [0, 'Level income percentage cannot be negative'],
      max: [100, 'Level income percentage cannot exceed 100'],
    },

    // ==========================================
    // ROI TRANSFER SETTINGS
    // ==========================================
    roiTransferEnabled: {
      type: Boolean,
      default: true,
    },
    roiTransferDay: {
      type: Number,
      default: 1,
      min: [1, 'Transfer day must be at least 1'],
      max: [31, 'Transfer day cannot exceed 31'],
    },

    // ==========================================
    // PROFIT SHARE SETTINGS
    // ==========================================
    profitShareTransferEnabled: {
      type: Boolean,
      default: true,
    },
    profitShareTransferDay: {
      type: Number,
      default: 15,
      min: [1, 'Transfer day must be at least 1'],
      max: [31, 'Transfer day cannot exceed 31'],
    },
    profitShareDistributionMethod: {
      type: String,
      enum: ['EQUAL', 'PROPORTIONAL'],
      default: 'EQUAL',
    },

    // ==========================================
    // FUND WALLET SETTINGS
    // ==========================================
    fundTransferEnabled: {
      type: Boolean,
      default: false,
    },

  },
  {
    timestamps: true,
  }
);

/**
 * Fetches the single settings document, creating it with defaults
 * if it doesn't exist yet (e.g. on first server run).
 *
 * @returns {Promise<Object>} the settings document
 */
systemSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ singletonKey: 'GLOBAL_SETTINGS' });

  if (!settings) {
    settings = await this.create({
      singletonKey: 'GLOBAL_SETTINGS',
    });
  }

  return settings;
};

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

module.exports = SystemSettings;