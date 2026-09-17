const express = require('express');
const router = express.Router();

const {
  listUsers,
  getUserDetail,
  listInvestments,
  listTransactions,
  getStats,
  getSettings,
  updateSettings,
  processRoi,
  processRoiManual,
  distributeProfitShare,
  triggerRoiTransfer,
  triggerProfitShareTransfer,
  getAdminReferralStats,
  searchAdminReferralMembers,
  getAdminReferralTree,
  getAdminReferralMemberDetail,
  getAdminReferralMembers,
  deactivateUser,
  suspendUser,
  activateUser,
  deleteUser,
  updateUserCredentials,
  adjustUserWallet,
  requestWithdrawal,
  listWithdrawals,
} = require('../controllers/adminController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');

// All admin routes require authentication + admin role
router.use(authenticate, authorizeAdmin);

// Referral Network Management
router.get('/referrals/stats', getAdminReferralStats);
router.get('/referrals/search', searchAdminReferralMembers);
router.get('/referrals/members', getAdminReferralMembers);
router.get('/referrals/member/:userId', getAdminReferralMemberDetail);
router.get('/referrals/tree/:userId', getAdminReferralTree);

// Users
router.get('/users', listUsers);
router.get('/users/:id', getUserDetail);
router.patch('/users/:id/activate', activateUser);
router.patch('/users/:id/deactivate', deactivateUser);
router.patch('/users/:id/suspend', suspendUser);
router.delete('/users/:id', deleteUser);
router.patch('/users/:id/credentials', updateUserCredentials);
router.post('/users/:id/wallet/adjust', adjustUserWallet);
router.post('/users/:id/withdraw', requestWithdrawal);

// Investments (platform-wide)
router.get('/investments', listInvestments);

// Withdrawals
router.get('/withdrawals', listWithdrawals);

// Transactions (platform-wide)
router.get('/transactions', listTransactions);

// Stats + settings
router.get('/stats', getStats);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);

// ROI processing
router.post('/roi/process', processRoi);
router.post('/roi/process-manual', processRoiManual);

// ROI Transfer
router.post('/roi/transfer', triggerRoiTransfer);

// Profit Share
router.post('/profit-share/distribute', distributeProfitShare);
router.post('/profit-share/transfer', triggerProfitShareTransfer);

module.exports = router;
