const express = require('express');
const router = express.Router();

const {
  createInvestment,
  getPlans,
  getMyInvestments,
  getInvestmentDetails,
} = require('../controllers/investmentController');
const { getInvestmentRoiHistory } = require('../controllers/roiController');
const {
  createInvestmentValidationRules,
  validateInvestmentIdParam,
} = require('../validators/investmentValidators');
const validateRequest = require('../middleware/validateRequest');
const { authenticate } = require('../middleware/authMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   POST /api/investments
router.post(
  '/',
  authenticate,
  createInvestmentValidationRules,
  validateRequest,
  createInvestment
);

// @route   GET /api/investments/plans
router.get('/plans', authenticate, getPlans);

// @route   GET /api/investments
router.get('/', authenticate, getMyInvestments);

// @route   GET /api/investments/:id
router.get(
  '/:id',
  authenticate,
  validateInvestmentIdParam,
  validateRequest,
  getInvestmentDetails
);

// @route   GET /api/investments/:id/roi-history
router.get(
  '/:id/roi-history',
  authenticate,
  validateInvestmentIdParam,
  validateRequest,
  getInvestmentRoiHistory
);

module.exports = router;