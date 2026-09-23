const asyncHandler = require('express-async-handler');
const walletService = require('../services/walletService');
const Transaction = require('../models/Transaction');
const SystemSettings = require('../models/SystemSettings');
const User = require('../models/User');
const Investment = require('../models/Investment');

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

  const metadata = {};
  if (req.file) {
    metadata.proofImage = req.file.path;
    metadata.proofPublicId = req.file.filename;
  }

  const transaction = await walletService.requestDeposit(
    req.user.id,
    Number(amount),
    description,
    metadata
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
      fundTransferEnabled: settings.fundTransferEnabled,
      ewalletDownlineOfferEnabled: settings.ewalletDownlineOfferEnabled,
      ewalletMaxPercentage: settings.ewalletMaxPercentage,
      ewalletDownlineActivationEnabled: settings.ewalletDownlineActivationEnabled,
      ewalletDownlineDepositEnabled: settings.ewalletDownlineDepositEnabled,
      selfInvestmentEwalletMaxPercentage: settings.selfInvestmentEwalletMaxPercentage,
      withdrawalMinAmount: settings.withdrawalMinAmount || 0,
      withdrawalMaxAmount: settings.withdrawalMaxAmount || 0,
      withdrawalFeePercentage: settings.withdrawalFeePercentage || 0,
    },
  });
});

// ==========================================
// @desc    User requests a withdrawal (pending admin approval)
// @route   POST /api/wallet/withdraw
// @access  Private (User)
// ==========================================
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, balanceField = 'mainBalance', payoutMethod, payoutDetails, notes } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid amount' });
  }

  if (!payoutMethod) {
    return res.status(400).json({ success: false, message: 'Payout method is required (BANK or BEP20)' });
  }

  if (!payoutDetails) {
    return res.status(400).json({ success: false, message: 'Payout details are required' });
  }

  const transaction = await walletService.requestWithdrawal(req.user.id, {
    amount: Number(amount),
    balanceField,
    payoutMethod,
    payoutDetails,
    notes: notes || '',
  });

  res.status(201).json({
    success: true,
    message: 'Your withdrawal request has been submitted. Admin will review and approve within 72 hours.',
    data: { transaction },
  });
});

// ==========================================
// @desc    Get logged-in user's withdrawal requests
// @route   GET /api/wallet/withdrawals
// @access  Private (User)
// ==========================================
const getMyWithdrawals = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const match = { user: req.user.id, type: 'WITHDRAWAL' };
  if (status) match.status = status;

  const [transactions, total] = await Promise.all([
    Transaction.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(50, Number(limit)))
      .lean(),
    Transaction.countDocuments(match),
  ]);

  res.status(200).json({
    success: true,
    data: { transactions },
    pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
  });
});

// ==========================================
// @desc    Get pending commission details (who it came from, type, etc.)
// @route   GET /api/wallet/pending-commissions
// @access  Private (User)
// ==========================================
const getPendingCommissionDetails = asyncHandler(async (req, res) => {
  const transactions = await Transaction.find({
    user: req.user.id,
    type: { $in: ['PENDING_ROI', 'PENDING_NETWORK_COMMISSION'] },
  })
    .sort({ createdAt: -1 })
    .lean();

  // Enrich with source user info and investment details
  const enriched = await Promise.all(transactions.map(async (txn) => {
    const result = { ...txn };

    // If there's an investment reference, fetch investment details
    if (txn.investment) {
      const inv = await Investment.findById(txn.investment).select('originalAmount user').lean();
      if (inv) {
        result.investmentAmount = inv.originalAmount;
        // Fetch the investor's name if it's someone else's investment generating income
        if (inv.user && inv.user.toString() !== req.user.id.toString()) {
          const investor = await User.findById(inv.user).select('name email').lean();
          if (investor) {
            result.sourceUser = { name: investor.name, email: investor.email };
          }
        }
      }
    }

    // Use metadata if available (new transactions have this)
    if (txn.metadata?.percentage) {
      result.incomePercentage = txn.metadata.percentage;
    }
    if (txn.metadata?.investmentAmount) {
      result.sourceInvestmentAmount = txn.metadata.investmentAmount;
    }
    if (txn.metadata?.incomeType) {
      result.incomeType = txn.metadata.incomeType;
    }

    // Parse description for additional context (fallback for old transactions)
    if (!result.incomeType) {
      if (txn.description?.includes('profit share from ROI')) {
        result.incomeType = 'PROFIT_SHARE_FROM_ROI';
      } else if (txn.description?.includes('profit share')) {
        result.incomeType = 'PROFIT_SHARE';
      } else if (txn.description?.includes('network commission')) {
        result.incomeType = 'NETWORK_COMMISSION';
      } else if (txn.type === 'PENDING_ROI') {
        result.incomeType = 'ROI_OVERFLOW';
      }
    }

    return result;
  }));

  res.status(200).json({
    success: true,
    message: 'Pending commission details fetched successfully',
    data: { pendingCommissions: enriched },
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
  requestWithdrawal,
  getMyWithdrawals,
  getPendingCommissionDetails,
};