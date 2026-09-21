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

    // ==========================================
    // AUTO DAILY ROI (Vercel Cron)
    // ==========================================
    autoRoiEnabled: {
      type: Boolean,
      default: false,
    },
    autoRoiTime: {
      type: String,
      default: '04:00',
    },
    lastAutoRoiRun: {
      type: Date,
      default: null,
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
    // SELF-INVESTMENT E-WALLET MAX PERCENTAGE
    // ==========================================
    selfInvestmentEwalletMaxPercentage: {
      type: Number,
      default: 0,
      min: [0, 'Percentage cannot be negative'],
      max: [100, 'Percentage cannot exceed 100'],
    },

    // ==========================================
    // INCOME SETTINGS
    // ==========================================
    // Legacy flat fields (kept for backward compatibility)
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
    // MULTI-LEVEL INCOME CONFIGURATION
    // ==========================================
    // Authoritative source for level income percentages.
    // Each entry: { level: Number (1-based sequential), percentage: Number (0-100) }
    levels: [{
      level: { type: Number, required: true, min: 1 },
      percentage: { type: Number, default: 0, min: 0, max: 100 },
    }],

    // ==========================================
    // PROFIT SHARE LEVEL CONFIGURATION
    // ==========================================
    // Upline-based profit share distribution percentages.
    // Each entry: { level: Number (1-based sequential), percentage: Number (0-100) }
    profitShareLevels: [{
      level: { type: Number, required: true, min: 1 },
      percentage: { type: Number, default: 0, min: 0, max: 100 },
    }],

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

    // ==========================================
    // E-WALLET DOWNLINE INVESTMENT OFFER
    // ==========================================
    ewalletDownlineOfferEnabled: {
      type: Boolean,
      default: false,
    },
    ewalletMaxPercentage: {
      type: Number,
      default: 0,
      min: [0, 'Percentage cannot be negative'],
      max: [100, 'Percentage cannot exceed 100'],
    },

    // ==========================================
    // E-WALLET DOWNLINE ACTIVATION
    // ==========================================
    ewalletDownlineActivationEnabled: {
      type: Boolean,
      default: false,
    },

    // ==========================================
    // E-WALLET DOWNLINE DEPOSIT
    // ==========================================
    ewalletDownlineDepositEnabled: {
      type: Boolean,
      default: false,
    },

    // ==========================================
    // DAY-WISE ROI SCHEDULE (numbered investment days)
    // ==========================================
    roiDays: {
      type: Number,
      default: 0,
      min: [0, 'ROI days cannot be negative'],
      max: [365, 'ROI days cannot exceed 365'],
    },
    dayWiseRoiSchedule: [{
      day: { type: Number },
      percentage: { type: Number, default: 0, min: 0, max: 100 },
    }],

    // ==========================================
    // PENDING RELEASE SETTINGS
    // ==========================================
    pendingReleaseMultiplier: {
      type: Number,
      default: 3,
      min: [0, 'Pending release multiplier cannot be negative'],
      max: [100, 'Pending release multiplier cannot exceed 100'],
    },

    // ==========================================
    // RANK SETTINGS
    // ==========================================
    rankEnabled: {
      type: Boolean,
      default: false,
    },
    rankRecalculationTrigger: {
      type: String,
      enum: ['AUTO', 'MANUAL', 'LOGIN'],
      default: 'AUTO',
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

  // Auto-migrate: if levels array is empty/missing, seed from legacy fields
  if (!settings.levels || settings.levels.length === 0) {
    const l1 = settings.directIncomePercentage || 10;
    const l2 = settings.levelIncomePercentage || 5;
    settings.levels = [
      { level: 1, percentage: l1 },
      { level: 2, percentage: l2 },
    ];
    await settings.save();
  }

  // Auto-migrate: if profitShareLevels is empty/missing, seed with default
  if (!settings.profitShareLevels || settings.profitShareLevels.length === 0) {
    settings.profitShareLevels = [{ level: 1, percentage: 3 }];
    await settings.save();
  }

  return settings;
};

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

module.exports = SystemSettings;