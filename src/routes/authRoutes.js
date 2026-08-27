const express = require('express');
const router = express.Router();

const { register, login, logout, getMe } = require('../controllers/authController');
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

// ==========================================
// PRIVATE ROUTES
// ==========================================

// @route   POST /api/auth/logout
router.post('/logout', authenticate, logout);

// @route   GET /api/auth/me
router.get('/me', authenticate, getMe);

module.exports = router;