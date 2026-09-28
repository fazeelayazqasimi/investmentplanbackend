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
  transferMainToFund,
  transferProfitShare,
  transferFund,
  getTransferSettings,
  sendWithdrawalOtp,
  verifyWithdrawalOtp,
  requestWithdrawal,
  getMyWithdrawals,
  getPendingCommissionDetails,
} = require('../controllers/walletController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');
const { uploadDepositProof } = require('../middleware/uploadMiddleware');

// ==========================================
// PRIVATE ROUTES (all require authentication)
// ==========================================

// @route   GET /api/wallet
router.get('/', authenticate, getMyWallet);

// @route   GET /api/wallet/transfer-settings
router.get('/transfer-settings', authenticate, getTransferSettings);

// @route   GET /api/wallet/transactions
router.get('/transactions', authenticate, getMyTransactions);

// @route   GET /api/wallet/pending-commissions
router.get('/pending-commissions', authenticate, getPendingCommissionDetails);

// @route   POST /api/wallet/deposit  (user submits a deposit request)
router.post('/deposit', authenticate, uploadDepositProof, requestDeposit);

// @route   POST /api/wallet/transfer/roi
router.post('/transfer/roi', authenticate, transferRoi);

// @route   POST /api/wallet/transfer/main-to-fund
router.post('/transfer/main-to-fund', authenticate, transferMainToFund);

// @route   POST /api/wallet/transfer/profit-share
router.post('/transfer/profit-share', authenticate, transferProfitShare);

// @route   POST /api/wallet/transfer/fund
router.post('/transfer/fund', authenticate, transferFund);

// @route   POST /api/wallet/withdraw/otp  (send OTP to email)
router.post('/withdraw/otp', authenticate, sendWithdrawalOtp);

// @route   POST /api/wallet/withdraw/verify-otp  (verify OTP -> token)
router.post('/withdraw/verify-otp', authenticate, verifyWithdrawalOtp);

// @route   POST /api/wallet/withdraw  (requires verified withdrawToken)
router.post('/withdraw', authenticate, requestWithdrawal);

// @route   GET /api/wallet/withdrawals
router.get('/withdrawals', authenticate, getMyWithdrawals);

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