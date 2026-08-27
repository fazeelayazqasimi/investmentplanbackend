const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');

// ==========================================
// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
// ==========================================
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, referralCode } = req.body;

  // Check for duplicate email
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    res.status(409);
    throw new Error('An account with this email already exists');
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

  // Create user (password hashing + referral code generation
  // happen automatically via Mongoose pre-save middleware)
  const user = await User.create({
    name,
    email,
    phone,
    password,
    referredBy,
  });

  const token = generateToken(user._id, user.role);

  res.status(201).json({
    success: true,
    message: 'Registration successful',
    data: {
      user: user.toSafeObject(),
      token,
    },
  });
});

// ==========================================
// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
// ==========================================
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Explicitly select password since schema excludes it by default
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

  if (!user) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const isPasswordCorrect = await user.comparePassword(password);

  if (!isPasswordCorrect) {
    res.status(401);
    throw new Error('Invalid email or password');
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