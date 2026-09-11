const asyncHandler = require('express-async-handler');
const walletService = require('../services/walletService');
const Transaction = require('../models/Transaction');
const SystemSettings = require('../models/SystemSettings');

// ==========================================
// @desc    Get logged-in user's wallet balances
// @route   GET /api/wallet
// @access  Private (User)
// ==========================================
const getMyWallet = asyncHandler(async (req, res) => {
  const wallet = await walletService.getWallet(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Wallet fetched successfully',
    data: {
      wallet,
    },
  });
});

// ==========================================
// @desc    Get logged-in user's transaction history (paginated, filterable)
// @route   GET /api/transactions
// @access  Private (User)
// ==========================================
const getMyTransactions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, type } = req.query;

  const result = await walletService.getUserTransactions(req.user.id, {
    page: Number(page),
    limit: Number(limit),
    type,
  });

  res.status(200).json({
    success: true,
    message: 'Transactions fetched successfully',
    data: {
      transactions: result.transactions,
    },
    pagination: result.pagination,
  });
});

// ==========================================
// @desc    Request a deposit (pending admin approval)
// @route   POST /api/wallet/deposit
// @access  Private (User)
// ==========================================
const requestDeposit = asyncHandler(async (req, res) => {
  const { amount, description } = req.body;

  const transaction = await walletService.requestDeposit(
    req.user.id,
    Number(amount),
    description
  );

  res.status(201).json({
    success: true,
    message: 'Deposit request submitted for approval',
    data: { transaction },
  });
});

// ==========================================
// @desc    List pending deposit requests (admin approval queue)
// @route   GET /api/wallet/admin/deposits
// @access  Private (Admin)
// ==========================================
const getPendingDeposits = asyncHandler(async (req, res) => {
  const deposits = await Transaction.find({ type: 'DEPOSIT', status: 'PENDING' })
    .sort({ createdAt: -1 })
    .populate({ path: 'user', select: 'name email' })
    .lean();

  res.status(200).json({
    success: true,
    message: 'Pending deposits fetched successfully',
    data: { deposits },
  });
});

// ==========================================
// @desc    Approve a pending deposit request
// @route   POST /api/wallet/admin/deposits/:id/approve
// @access  Private (Admin)
// ==========================================
const approveDeposit = asyncHandler(async (req, res) => {
  const transaction = await walletService.approveDeposit(req.params.id, req.user.id);

  res.status(200).json({
    success: true,
    message: 'Deposit approved and credited to wallet',
    data: { transaction },
  });
});

// ==========================================
// @desc    Reject a pending deposit request
// @route   POST /api/wallet/admin/deposits/:id/reject
// @access  Private (Admin)
// ==========================================
const rejectDeposit = asyncHandler(async (req, res) => {
  const transaction = await walletService.rejectDeposit(req.params.id, req.user.id);

  res.status(200).json({
    success: true,
    message: 'Deposit request rejected',
    data: { transaction },
  });
});

// ==========================================
// @desc    Transfer ROI Wallet -> Main Wallet
// @route   POST /api/wallet/transfer/roi
// @access  Private (User)
// ==========================================
const transferRoi = asyncHandler(async (req, res) => {
  const result = await walletService.transferRoiToMain(req.user.id);

  res.status(200).json({
    success: true,
    message: 'ROI transferred to main wallet successfully',
    data: result,
  });
});

// ==========================================
// @desc    Transfer Profit Share Wallet -> Main Wallet
// @route   POST /api/wallet/transfer/profit-share
// @access  Private (User)
// ==========================================
const transferProfitShare = asyncHandler(async (req, res) => {
  const result = await walletService.transferProfitShareToMain(req.user.id);

  res.status(200).json({
    success: true,
    message: 'Profit Share transferred to main wallet successfully',
    data: result,
  });
});

// ==========================================
// @desc    Transfer Main Wallet -> Fund Wallet
// @route   POST /api/wallet/transfer/main-to-fund
// @access  Private (User)
// ==========================================
const transferMainToFund = asyncHandler(async (req, res) => {
  const { amount } = req.body;

  if (!amount || Number(amount) <= 0) {
    res.status(400);
    throw new Error('Transfer amount must be greater than zero');
  }

  const result = await walletService.transferMainToFund(req.user.id, Number(amount));

  res.status(200).json({
    success: true,
    message: 'Funds transferred from Main Wallet to Fund Wallet',
    data: result,
  });
});

// ==========================================
// @desc    Transfer Fund Wallet to another user
// @route   POST /api/wallet/transfer/fund
// @access  Private (User)
// ==========================================
const transferFund = asyncHandler(async (req, res) => {
  const { receiverId, amount } = req.body;

  if (!receiverId) {
    res.status(400);
    throw new Error('Receiver ID is required');
  }
  if (!amount || Number(amount) <= 0) {
    res.status(400);
    throw new Error('Transfer amount must be greater than zero');
  }

  const result = await walletService.transferFundToUser(
    req.user.id,
    receiverId,
    Number(amount)
  );

  res.status(200).json({
    success: true,
    message: 'Fund transfer successful',
    data: result,
  });
});

// ==========================================
// @desc    Get transfer settings (ROI & Profit Share)
// @route   GET /api/wallet/transfer-settings
// @access  Private (User)
// ==========================================
const getTransferSettings = asyncHandler(async (req, res) => {
  const settings = await SystemSettings.getSettings();

  res.status(200).json({
    success: true,
    message: 'Transfer settings fetched successfully',
    data: {
      roiTransferEnabled: settings.roiTransferEnabled,
      profitShareTransferEnabled: settings.profitShareTransferEnabled,
    },
  });
});

module.exports = {
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
};