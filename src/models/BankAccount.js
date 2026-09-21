const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema(
  {
    bankName: {
      type: String,
      trim: true,
      maxlength: [100, 'Bank name cannot exceed 100 characters'],
      default: '',
    },
    accountHolder: {
      type: String,
      trim: true,
      maxlength: [150, 'Account holder name cannot exceed 150 characters'],
      default: '',
    },
    accountNumber: {
      type: String,
      trim: true,
      maxlength: [30, 'Account number cannot exceed 30 characters'],
      default: '',
    },
    iban: {
      type: String,
      trim: true,
      default: '',
      maxlength: [34, 'IBAN cannot exceed 34 characters'],
    },
    accountType: {
      type: String,
      enum: ['LOCAL_BANK', 'BEP20'],
      default: 'LOCAL_BANK',
    },
    walletAddress: {
      type: String,
      trim: true,
      default: '',
      maxlength: [200, 'Wallet address cannot exceed 200 characters'],
    },
    qrCodeImage: {
      type: String,
      default: '',
    },
    qrCodePublicId: {
      type: String,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
      min: [0, 'Display order cannot be negative'],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
    },
  },
  {
    timestamps: true,
  }
);

bankAccountSchema.index({ isActive: 1, displayOrder: 1 });

const BankAccount = mongoose.model('BankAccount', bankAccountSchema);

module.exports = BankAccount;
