const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema(
  {
    bankName: {
      type: String,
      required: [true, 'Bank name is required'],
      trim: true,
      maxlength: [100, 'Bank name cannot exceed 100 characters'],
    },
    accountHolder: {
      type: String,
      required: [true, 'Account holder name is required'],
      trim: true,
      maxlength: [150, 'Account holder name cannot exceed 150 characters'],
    },
    accountNumber: {
      type: String,
      required: [true, 'Account number is required'],
      trim: true,
      maxlength: [30, 'Account number cannot exceed 30 characters'],
    },
    iban: {
      type: String,
      trim: true,
      default: '',
      maxlength: [34, 'IBAN cannot exceed 34 characters'],
    },
    accountType: {
      type: String,
      enum: ['BANK', 'JAZZCASH', 'EASYPAISA', 'OTHER'],
      default: 'BANK',
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
