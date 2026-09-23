const { body } = require('express-validator');

// ==========================================
// REGISTRATION VALIDATION RULES
// ==========================================
const registerValidationRules = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[0-9\s\-()]{7,20}$/)
    .withMessage('Please provide a valid phone number'),

  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),

  body('confirmPassword')
    .notEmpty()
    .withMessage('Please confirm your password')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),

  body('emailVerifyToken')
    .notEmpty()
    .withMessage('Email verification is required'),

  body('referralCode')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 4, max: 20 })
    .withMessage('Invalid referral code format')
    .isAlphanumeric()
    .withMessage('Referral code must be alphanumeric'),

  body('additionalEmails')
    .optional()
    .isArray({ max: 4 })
    .withMessage('Maximum 4 additional emails allowed'),
  body('additionalEmails.*')
    .optional()
    .isEmail()
    .withMessage('Each additional email must be valid')
    .normalizeEmail(),
];

// ==========================================
// LOGIN VALIDATION RULES
// ==========================================
const loginValidationRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('password').notEmpty().withMessage('Password is required'),
];

// ==========================================
// SEND REGISTRATION OTP VALIDATION RULES (step 1)
// ==========================================
const sendOtpValidationRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
];

// ==========================================
// VERIFY EMAIL VALIDATION RULES (step 2)
// ==========================================
const verifyEmailValidationRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('code')
    .trim()
    .notEmpty()
    .withMessage('Verification code is required')
    .isLength({ min: 4, max: 4 })
    .withMessage('Verification code must be 4 digits')
    .isNumeric()
    .withMessage('Verification code must be numeric'),
];

module.exports = {
  registerValidationRules,
  loginValidationRules,
  sendOtpValidationRules,
  verifyEmailValidationRules,
};