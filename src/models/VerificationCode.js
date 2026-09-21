const mongoose = require('mongoose');

const verificationCodeSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: [true, 'Verification code is required'],
      length: [4, 'Code must be 4 digits'],
    },
    purpose: {
      type: String,
      enum: ['EMAIL_VERIFICATION', 'PASSWORD_RESET'],
      required: [true, 'Purpose is required'],
    },
    used: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      required: [true, 'Expiry time is required'],
      index: { expires: 0 }, // TTL index: auto-delete after expiry
    },
  },
  {
    timestamps: true,
  }
);

verificationCodeSchema.index({ email: 1, purpose: 1 });

const VerificationCode = mongoose.model('VerificationCode', verificationCodeSchema);

module.exports = VerificationCode;
