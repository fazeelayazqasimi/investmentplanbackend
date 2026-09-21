const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const bonusService = require('../services/bonusService');

// ==========================================
// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
// ==========================================
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, referralCode, additionalEmails } = req.body;

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
        [{ name, email, phone, password, referredBy, additionalEmails: extraEmails }],
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
// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
// ==========================================
const logout = asyncHandler(async (req, res) => {
  // Stateless JWT: logout is handled client-side by discarding the token.
  // This endpoint exists for a consistent API contract and to allow
  // future enhancements (e.g. token blacklisting) without breaking clients.
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
  // req.user is attached by the auth middleware (next step)
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
  login,
  logout,
  getMe,
};