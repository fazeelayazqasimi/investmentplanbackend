const express = require('express');
const router = express.Router();

const {
  getActiveAccounts,
  getAllAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
} = require('../controllers/bankAccountController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');

// @route   GET /api/bank-accounts  (public - user deposit page)
router.get('/', getActiveAccounts);

// @route   GET /api/admin/bank-accounts  (admin - all accounts)
router.get('/admin', authenticate, authorizeAdmin, getAllAccounts);

// @route   POST /api/admin/bank-accounts  (admin - add account)
router.post('/admin', authenticate, authorizeAdmin, createAccount);

// @route   PUT /api/admin/bank-accounts/:id  (admin - update)
router.put('/admin/:id', authenticate, authorizeAdmin, updateAccount);

// @route   DELETE /api/admin/bank-accounts/:id  (admin - delete)
router.delete('/admin/:id', authenticate, authorizeAdmin, deleteAccount);

module.exports = router;
