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
  distributeProfitShare,
  triggerRoiTransfer,
  triggerProfitShareTransfer,
} = require('../controllers/adminController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');

// All admin routes require authentication + admin role
router.use(authenticate, authorizeAdmin);

// Users
router.get('/users', listUsers);
router.get('/users/:id', getUserDetail);

// Investments (platform-wide)
router.get('/investments', listInvestments);

// Transactions (platform-wide)
router.get('/transactions', listTransactions);

// Stats + settings
router.get('/stats', getStats);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);

// ROI processing
router.post('/roi/process', processRoi);

// ROI Transfer
router.post('/roi/transfer', triggerRoiTransfer);

// Profit Share
router.post('/profit-share/distribute', distributeProfitShare);
router.post('/profit-share/transfer', triggerProfitShareTransfer);

module.exports = router;
