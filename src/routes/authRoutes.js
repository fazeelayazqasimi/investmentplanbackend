const express = require('express');
const router = express.Router();

const {
  register,
  login,
  resendOtp,
  forgotPassword,
  resetPassword,
  logout,
  getMe,
} = require('../controllers/authController');
const {
  registerValidationRules,
  loginValidationRules,
} = require('../validators/authValidators');
const validateRequest = require('../middleware/validateRequest');
const { authenticate } = require('../middleware/authMiddleware');

// ==========================================
// PUBLIC ROUTES
// ==========================================

// @route   POST /api/auth/register
router.post('/register', registerValidationRules, validateRequest, register);

// @route   POST /api/auth/login
router.post('/login', loginValidationRules, validateRequest, login);

// @route   POST /api/auth/resend-otp (for password reset)
router.post('/resend-otp', resendOtp);

// @route   POST /api/auth/forgot-password
router.post('/forgot-password', forgotPassword);

// @route   POST /api/auth/reset-password
router.post('/reset-password', resetPassword);

// ==========================================
// PRIVATE ROUTES
// ==========================================

// @route   POST /api/auth/logout
router.post('/logout', authenticate, logout);

// @route   GET /api/auth/me
router.get('/me', authenticate, getMe);

module.exports = router;
