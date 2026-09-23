const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const VerificationCode = require('../models/VerificationCode');
const generateToken = require('../utils/generateToken');
const { sendOtpEmail } = require('../utils/emailService');
const bonusService = require('../services/bonusService');

// ==========================================
// Helper: Generate 4-digit OTP
// ==========================================
const generateOtp = () => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

// ==========================================
// Helper: Create and send OTP
// ==========================================
const createAndSendOtp = async (email, purpose) => {
  // Delete any existing unused codes for this email+purpose
  await VerificationCode.deleteMany({ email, purpose, used: false });

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 1 * 60 * 1000); // 1 minute

  await VerificationCode.create({ email, code, purpose, expiresAt });
  await sendOtpEmail(email, code, purpose);

  return code;
};

// ==========================================
// @desc    Send registration OTP (step 1: email only)
// @route   POST /api/auth/register/send-otp
// @access  Public
// ==========================================
const sendRegisterOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  const normalized = email.toLowerCase();

  // Reject already-registered emails at step 1
  const existingUser = await User.findOne({
    $or: [{ email: normalized }, { additionalEmails: normalized }],
  });
  if (existingUser) {
    res.status(409);
    throw new Error('An account with this email already exists');
  }

  // Rate limit: max 1 OTP per 60 seconds
  const recentCode = await VerificationCode.findOne({
    email: normalized,
    purpose: 'EMAIL_VERIFICATION',
    createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
  });
  if (recentCode) {
    res.status(429);
    throw new Error('Please wait 60 seconds before requesting a new code');
  }

  await createAndSendOtp(normalized, 'EMAIL_VERIFICATION');

  res.status(200).json({
    success: true,
    message: 'Verification code sent to your email',
  });
});

// ==========================================
// @desc    Register a new user (requires verified email token)
// @route   POST /api/auth/register
// @access  Public
// ==========================================
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, referralCode, additionalEmails, emailVerifyToken } = req.body;

  // Step 2 must be completed: verify signed email token (15-min expiry)
  if (!emailVerifyToken) {
    res.status(400);
    throw new Error('Email verification required. Please verify your email first.');
  }

  let decoded;
  try {
    decoded = jwt.verify(emailVerifyToken, process.env.JWT_SECRET);
  } catch (err) {
    res.status(400);
    throw new Error(
      err.name === 'TokenExpiredError'
        ? 'Email verification expired. Please verify your email again.'
        : 'Invalid email verification token'
    );
  }
  if (decoded.purpose !== 'EMAIL_VERIFICATION' || decoded.email !== email.toLowerCase()) {
    res.status(400);
    throw new Error('Invalid email verification token');
  }

  // Check for duplicate primary email
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    res.status(409);
    throw new Error('An account with this email already exists');
  }

  // Process additional emails: unique, valid, not duplicate of primary or each other
  const extraEmails = [];
  if (Array.isArray(additionalEmails)) {
    const emailSet = new Set([email.toLowerCase()]);
    for (const e of additionalEmails) {
      const normalized = e.toLowerCase().trim();
      if (!normalized) continue;
      if (emailSet.has(normalized)) {
        res.status(400);
        throw new Error(`Duplicate email: ${normalized}`);
      }
      emailSet.add(normalized);
      extraEmails.push(normalized);
    }
    // Check if any additional email already exists in DB
    if (extraEmails.length > 0) {
      const existingEmail = await User.findOne({
        $or: [
          { email: { $in: extraEmails } },
          { additionalEmails: { $in: extraEmails } },
        ],
      });
      if (existingEmail) {
        res.status(409);
        throw new Error('One of the additional emails is already registered');
      }
    }
  }

  // Resolve referral code to an upline user, if provided
  let referredBy = null;
  if (referralCode) {
    const upline = await User.findOne({ referralCode: referralCode.toUpperCase() });
    if (!upline) {
      res.status(400);
      throw new Error('Invalid referral code');
    }
    referredBy = upline._id;
  }

  // Create user + bonuses atomically in a single MongoDB session
  const session = await mongoose.startSession();
  try {
    let newUser;
    await session.withTransaction(async () => {
      newUser = await User.create(
        [{ name, email, phone, password, referredBy, additionalEmails: extraEmails, isEmailVerified: true }],
        { session }
      );

      // Process signup and upline bonuses (atomic with user creation)
      await bonusService.processRegistrationBonuses(
        newUser[0]._id,
        referredBy,
        session
      );
    });

    const user = newUser[0];
    const token = generateToken(user._id, user.role);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: user.toSafeObject(),
        token,
      },
    });
  } finally {
    session.endSession();
  }
});

// ==========================================
// @desc    Verify email with OTP
// @route   POST /api/auth/verify-email
// @access  Public
// ==========================================
const verifyEmail = asyncHandler(async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    res.status(400);
    throw new Error('Email and verification code are required');
  }

  const verification = await VerificationCode.findOne({
    email: email.toLowerCase(),
    purpose: 'EMAIL_VERIFICATION',
    used: false,
  }).sort({ createdAt: -1 });

  if (!verification) {
    res.status(400);
    throw new Error('No verification code found. Please request a new one.');
  }

  if (verification.expiresAt < new Date()) {
    res.status(400);
    throw new Error('Verification code has expired. Please request a new one.');
  }

  if (verification.code !== code.toString()) {
    res.status(400);
    throw new Error('Invalid verification code');
  }

  // Mark code as used
  verification.used = true;
  await verification.save();

  // User doesn't exist yet (register step 2) — issue a short-lived signed
  // token that register (step 3) must present to prove email ownership.
  const emailVerifyToken = jwt.sign(
    { email: email.toLowerCase(), purpose: 'EMAIL_VERIFICATION' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  res.status(200).json({
    success: true,
    message: 'Email verified successfully',
    data: {
      emailVerifyToken,
    },
  });
});

// ==========================================
// @desc    Resend OTP (verification or password reset)
// @route   POST /api/auth/resend-otp
// @access  Public
// ==========================================
const resendOtp = asyncHandler(async (req, res) => {
  const { email, purpose = 'EMAIL_VERIFICATION' } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  // Rate limit: max 1 OTP per 60 seconds
  const recentCode = await VerificationCode.findOne({
    email: email.toLowerCase(),
    purpose,
    createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
  });

  if (recentCode) {
    res.status(429);
    throw new Error('Please wait 60 seconds before requesting a new code');
  }

  await createAndSendOtp(email.toLowerCase(), purpose);

  res.status(200).json({
    success: true,
    message: 'Verification code sent to your email',
  });
});

// ==========================================
// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
// ==========================================
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Search by primary email OR any additional email
  const user = await User.findOne({
    $or: [
      { email: email.toLowerCase() },
      { additionalEmails: email.toLowerCase() },
    ],
  }).select('+password');

  if (!user) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const isPasswordCorrect = await user.comparePassword(password);

  if (!isPasswordCorrect) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  if (user.accountStatus === 'DELETED') {
    res.status(403);
    throw new Error('This account has been deleted. Please contact support.');
  }

  // Auto-reactivate suspended users when timeline expires
  if (user.accountStatus === 'SUSPENDED' && user.suspendedUntil && new Date() > user.suspendedUntil) {
    user.accountStatus = 'ACTIVE';
    user.suspendedUntil = null;
    await user.save();
  }

  if (user.accountStatus !== 'ACTIVE') {
    res.status(403);
    throw new Error('Your account is not active. Please contact support.');
  }

  const token = generateToken(user._id, user.role);

  res.status(200).json({
    success: true,
    message: 'Login successful',
    data: {
      user: user.toSafeObject(),
      token,
    },
  });
});

// ==========================================
// @desc    Forgot password - send OTP
// @route   POST /api/auth/forgot-password
// @access  Public
// ==========================================
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    // Don't reveal if user exists or not
    res.status(200).json({
      success: true,
      message: 'If an account exists with this email, a verification code has been sent.',
    });
    return;
  }

  await createAndSendOtp(email.toLowerCase(), 'PASSWORD_RESET');

  res.status(200).json({
    success: true,
    message: 'If an account exists with this email, a verification code has been sent.',
  });
});

// ==========================================
// @desc    Reset password with OTP
// @route   POST /api/auth/reset-password
// @access  Public
// ==========================================
const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    res.status(400);
    throw new Error('Email, verification code, and new password are required');
  }

  if (newPassword.length < 8) {
    res.status(400);
    throw new Error('Password must be at least 8 characters');
  }

  const verification = await VerificationCode.findOne({
    email: email.toLowerCase(),
    purpose: 'PASSWORD_RESET',
    used: false,
  }).sort({ createdAt: -1 });

  if (!verification) {
    res.status(400);
    throw new Error('No verification code found. Please request a new one.');
  }

  if (verification.expiresAt < new Date()) {
    res.status(400);
    throw new Error('Verification code has expired. Please request a new one.');
  }

  if (verification.code !== code.toString()) {
    res.status(400);
    throw new Error('Invalid verification code');
  }

  // Mark code as used
  verification.used = true;
  await verification.save();

  // Update password
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.password = newPassword;
  await user.save();

  res.status(200).json({
    success: true,
    message: 'Password reset successfully. You can now login with your new password.',
  });
});

// ==========================================
// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
// ==========================================
const logout = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logout successful',
  });
});

// ==========================================
// @desc    Get current logged-in user
// @route   GET /api/auth/me
// @access  Private
// ==========================================
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.status(200).json({
    success: true,
    message: 'Current user fetched successfully',
    data: {
      user: user.toSafeObject(),
    },
  });
});

module.exports = {
  register,
  sendRegisterOtp,
  verifyEmail,
  resendOtp,
  login,
  forgotPassword,
  resetPassword,
  logout,
  getMe,
};
