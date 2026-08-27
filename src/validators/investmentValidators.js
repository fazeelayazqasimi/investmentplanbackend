const { body, param } = require('express-validator');

// ==========================================
// CREATE INVESTMENT VALIDATION RULES
// (used by both user self-investment and admin-added investment)
// ==========================================
const createInvestmentValidationRules = [
  body('amount')
    .notEmpty()
    .withMessage('Investment amount is required')
    .isFloat({ gt: 0 })
    .withMessage('Investment amount must be a number greater than zero'),

  body('plan')
    .trim()
    .notEmpty()
    .withMessage('Investment plan/type is required')
    .isLength({ max: 100 })
    .withMessage('Plan name cannot exceed 100 characters'),

  body('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be a valid date'),
];

// ==========================================
// ADMIN CREATE INVESTMENT FOR USER - additionally requires userId
// ==========================================
const adminCreateInvestmentValidationRules = [
  body('userId')
    .notEmpty()
    .withMessage('User ID is required')
    .isMongoId()
    .withMessage('Invalid user ID'),

  ...createInvestmentValidationRules,
];

// ==========================================
// ADMIN UPDATE INVESTMENT VALIDATION RULES
// ==========================================
const updateInvestmentValidationRules = [
  body('status')
    .optional()
    .isIn(['ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED'])
    .withMessage('Invalid status value'),

  body('plan')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Plan name must be between 1 and 100 characters'),

  body('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be a valid date'),
];

// ==========================================
// VALIDATE MONGO ID IN ROUTE PARAM
// ==========================================
const validateInvestmentIdParam = [
  param('id').isMongoId().withMessage('Invalid investment ID'),
];

const validateUserIdParam = [
  param('userId').isMongoId().withMessage('Invalid user ID'),
];

module.exports = {
  createInvestmentValidationRules,
  adminCreateInvestmentValidationRules,
  updateInvestmentValidationRules,
  validateInvestmentIdParam,
  validateUserIdParam,
};