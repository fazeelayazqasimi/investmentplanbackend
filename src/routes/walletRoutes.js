const express = require('express');
const router = express.Router();

const {
  getMyWallet,
  getMyTransactions,
  requestDeposit,
  getPendingDeposits,
  approveDeposit,
  rejectDeposit,
  transferRoi,
  transferProfitShare,
} = require('../controllers/walletController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   GET /api/wallet
router.get('/', authenticate, getMyWallet);

// @route   GET /api/wallet/transactions
router.get('/transactions', authenticate, getMyTransactions);

// @route   POST /api/wallet/deposit  (user submits a deposit request)
router.post('/deposit', authenticate, requestDeposit);

// @route   POST /api/wallet/transfer/roi
router.post('/transfer/roi', authenticate, transferRoi);

// @route   POST /api/wallet/transfer/profit-share
router.post('/transfer/profit-share', authenticate, transferProfitShare);

// ==========================================
// ADMIN ROUTES (deposit approval workflow)
// ==========================================

// @route   GET /api/wallet/admin/deposits
router.get('/admin/deposits', authenticate, authorizeAdmin, getPendingDeposits);

// @route   POST /api/wallet/admin/deposits/:id/approve
router.post('/admin/deposits/:id/approve', authenticate, authorizeAdmin, approveDeposit);

// @route   POST /api/wallet/admin/deposits/:id/reject
router.post('/admin/deposits/:id/reject', authenticate, authorizeAdmin, rejectDeposit);

module.exports = router;