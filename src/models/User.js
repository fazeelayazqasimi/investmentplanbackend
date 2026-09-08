const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        'Please provide a valid email address',
      ],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // Never returned in queries by default
    },
    role: {
      type: String,
      enum: ['USER', 'ADMIN'],
      default: 'USER',
    },
    referralCode: {
      type: String,
      unique: true,
      uppercase: true,
      index: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    accountStatus: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    isActivated: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// ==========================================
// MIDDLEWARE - Hash password before saving
// ==========================================
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MIDDLEWARE - Generate unique referral code before saving
// ==========================================
userSchema.pre('save', async function (next) {
  if (!this.isNew || this.referralCode) {
    return next();
  }

  try {
    let code;
    let isUnique = false;

    while (!isUnique) {
      code = generateReferralCode();
      const existingUser = await mongoose.models.User.findOne({ referralCode: code });
      if (!existingUser) {
        isUnique = true;
      }
    }

    this.referralCode = code;
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Generates a random alphanumeric referral code.
 * Example: FZL82K9
 */
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const randomBytes = crypto.randomBytes(7);

  for (let i = 0; i < 7; i++) {
    code += chars[randomBytes[i] % chars.length];
  }

  return code;
}

// ==========================================
// INSTANCE METHOD - Compare entered password with hashed password
// ==========================================
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// ==========================================
// INSTANCE METHOD - Return safe user object (no password)
// ==========================================
userSchema.methods.toSafeObject = function () {
  const userObject = this.toObject();
  delete userObject.password;
  delete userObject.__v;
  return userObject;
};

const User = mongoose.model('User', userSchema);

module.exports = User;