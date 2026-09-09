const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');

/**
 * Rounds a number to 2 decimal places safely for currency values.
 */
const roundToTwoDecimals = (value) => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

/**
 * Credits (or debits) a specific balance field on a user's wallet and
 * creates a matching Transaction record — atomically, in a single
 * MongoDB transaction. This is the ONLY function that should ever
 * modify wallet balances.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {'mainBalance'|'roiBalance'|'commissionBalance'} params.balanceField
 * @param {number} params.amount - positive to credit, negative to debit
 * @param {'INVESTMENT'|'ROI'|'COMMISSION'|'DEPOSIT'|'WITHDRAWAL'|'ADJUSTMENT'} params.type
 * @param {string} [params.investmentId]
 * @param {string} [params.description]
 * @param {string} [params.reference]
 * @param {string} [params.createdBy] - null/omitted for system-generated
 * @param {import('mongoose').ClientSession} [params.session] - reuse an existing transaction session if provided
 * @returns {Promise<{ wallet: Object, transaction: Object }>}
 */
const adjustWalletBalance = async ({
  userId,
  balanceField,
  amount,
  type,
  investmentId = null,
  description = '',
  reference = null,
  createdBy = null,
  session: externalSession = null,
}) => {
  const validFields = ['mainBalance', 'roiBalance', 'commissionBalance', 'ewalletBalance', 'profitShareBalance', 'pendingCommissions', 'fundBalance'];
  if (!validFields.includes(balanceField)) {
    throw new Error(`Invalid wallet balance field: ${balanceField}`);
  }

  const roundedAmount = roundToTwoDecimals(amount);

  // Allow this function to participate in an existing transaction
  // (e.g. called from within roiService's session) or start its own.
  const ownSession = externalSession ? null : await mongoose.startSession();
  const session = externalSession || ownSession;

  const runLogic = async () => {
    let wallet = await Wallet.findOne({ user: userId }).session(session);

    if (!wallet) {
      const created = await Wallet.create([{ user: userId }], { session });
      wallet = created[0];
    }

    const newBalance = roundToTwoDecimals(wallet[balanceField] + roundedAmount);

    if (newBalance < 0) {
      const error = new Error('Insufficient balance for this transaction');
      error.statusCode = 400;
      throw error;
    }

    wallet[balanceField] = newBalance;

    // Track cumulative lifetime earnings for all credit types
    const creditTypes = ['ROI', 'COMMISSION', 'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE'];
    if (creditTypes.includes(type) && roundedAmount > 0) {
      wallet.totalEarnings = roundToTwoDecimals(wallet.totalEarnings + roundedAmount);
    }

    await wallet.save({ session });

    const transactionDocs = await Transaction.create(
      [
        {
          user: userId,
          investment: investmentId,
          amount: roundedAmount,
          type,
          status: 'COMPLETED',
          description,
          reference,
          createdBy,
        },
      ],
      { session }
    );

    return { wallet, transaction: transactionDocs[0] };
  };

  try {
    if (ownSession) {
      let result;
      await ownSession.withTransaction(async () => {
        result = await runLogic();
      });
      return result;
    }

    // Participating in a caller-provided session — no withTransaction wrapper,
    // the caller controls commit/abort.
    return await runLogic();
  } finally {
    if (ownSession) {
      ownSession.endSession();
    }
  }
};

/**
 * Fetches a user's wallet, creating one with zero balances if needed.
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
const getWallet = async (userId) => {
  const wallet = await Wallet.getOrCreateWallet(userId);
  return wallet;
};

/**
 * Fetches a paginated list of transactions for a user.
 *
 * @param {string} userId
 * @param {Object} options
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @param {string} [options.type] - optional filter
 * @returns {Promise<{transactions: Array, pagination: Object}>}
 */
const getUserTransactions = async (userId, { page = 1, limit = 20, type } = {}) => {
  const query = { user: userId };
  if (type) {
    query.type = type;
  }

  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'investment', select: 'originalAmount' })
      .lean(),
    Transaction.countDocuments(query),
  ]);

  return {
    transactions,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

/**
 * Submits a deposit request on behalf of a user. The request is stored as a
 * Transaction with type DEPOSIT and status PENDING. No balance is changed
 * until an admin approves it.
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} [description]
 * @returns {Promise<Object>} the pending transaction
 */
const requestDeposit = async (userId, amount, description = '') => {
  const roundedAmount = roundToTwoDecimals(amount);

  if (roundedAmount <= 0) {
    const error = new Error('Deposit amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const transaction = await Transaction.create({
    user: userId,
    amount: roundedAmount,
    type: 'DEPOSIT',
    status: 'PENDING',
    description: description || 'Deposit request',
    createdBy: userId,
  });

  return transaction;
};

/**
 * Approves a pending deposit request: credits the user's mainBalance and
 * marks the request COMPLETED. Runs atomically in a single session.
 *
 * @param {string} transactionId
 * @param {string} adminId
 * @returns {Promise<Object>} the updated transaction
 */
const approveDeposit = async (transactionId, adminId) => {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const tx = await Transaction.findById(transactionId).session(session);

      if (!tx) {
        const error = new Error('Deposit request not found');
        error.statusCode = 404;
        throw error;
      }
      if (tx.type !== 'DEPOSIT') {
        const error = new Error('Transaction is not a deposit request');
        error.statusCode = 400;
        throw error;
      }
      if (tx.status !== 'PENDING') {
        const error = new Error(`Deposit already ${tx.status.toLowerCase()}`);
        error.statusCode = 400;
        throw error;
      }

      let wallet = await Wallet.findOne({ user: tx.user }).session(session);
      if (!wallet) {
        const created = await Wallet.create([{ user: tx.user }], { session });
        wallet = created[0];
      }

      wallet.mainBalance = roundToTwoDecimals(wallet.mainBalance + tx.amount);
      await wallet.save({ session });

      tx.status = 'COMPLETED';
      tx.createdBy = adminId;
      tx.description = tx.description ? `${tx.description} (approved)` : 'Deposit approved';
      await tx.save({ session });

      result = tx;
    });

    return result;
  } finally {
    session.endSession();
  }
};

/**
 * Rejects a pending deposit request. No balance change occurs.
 *
 * @param {string} transactionId
 * @param {string} adminId
 * @returns {Promise<Object>} the updated transaction
 */
const rejectDeposit = async (transactionId, adminId) => {
  const tx = await Transaction.findById(transactionId);

  if (!tx) {
    const error = new Error('Deposit request not found');
    error.statusCode = 404;
    throw error;
  }
  if (tx.type !== 'DEPOSIT') {
    const error = new Error('Transaction is not a deposit request');
    error.statusCode = 400;
    throw error;
  }
  if (tx.status !== 'PENDING') {
    const error = new Error(`Deposit already ${tx.status.toLowerCase()}`);
    error.statusCode = 400;
    throw error;
  }

  tx.status = 'REJECTED';
  tx.createdBy = adminId;
  tx.description = tx.description ? `${tx.description} (rejected)` : 'Deposit rejected';
  await tx.save();

  return tx;
};

// ==========================================
// ROI TRANSFER - ROI Wallet -> Main Wallet
// ==========================================
const transferRoiToMain = async (userId, adminOverride = false) => {
  const SystemSettings = require('../models/SystemSettings');
  const settings = await SystemSettings.getSettings();

  if (!settings.roiTransferEnabled && !adminOverride) {
    const error = new Error('ROI transfer is currently disabled by admin');
    error.statusCode = 400;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user: userId }).session(session);
      if (!wallet) {
        const error = new Error('Wallet not found');
        error.statusCode = 404;
        throw error;
      }

      if (wallet.roiBalance <= 0) {
        const error = new Error('No ROI balance available to transfer');
        error.statusCode = 400;
        throw error;
      }

      const amount = wallet.roiBalance;
      wallet.roiBalance = 0;
      wallet.mainBalance = roundToTwoDecimals(wallet.mainBalance + amount);
      await wallet.save({ session });

      const tx = await Transaction.create(
        [{
          user: userId,
          amount,
          type: 'ROI_TRANSFER',
          status: 'COMPLETED',
          description: `ROI transfer from ROI Wallet to Main Wallet - $${amount}`,
          reference: null,
          createdBy: null,
        }],
        { session }
      );

      result = { amount, transaction: tx[0] };
    });
    return result;
  } finally {
    session.endSession();
  }
};

// ==========================================
// PROFIT SHARE TRANSFER - Profit Share Wallet -> Main Wallet
// ==========================================
const transferProfitShareToMain = async (userId, adminOverride = false) => {
  const SystemSettings = require('../models/SystemSettings');
  const settings = await SystemSettings.getSettings();

  if (!settings.profitShareTransferEnabled && !adminOverride) {
    const error = new Error('Profit Share transfer is currently disabled by admin');
    error.statusCode = 400;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user: userId }).session(session);
      if (!wallet) {
        const error = new Error('Wallet not found');
        error.statusCode = 404;
        throw error;
      }

      if (wallet.profitShareBalance <= 0) {
        const error = new Error('No Profit Share balance available to transfer');
        error.statusCode = 400;
        throw error;
      }

      const amount = wallet.profitShareBalance;
      wallet.profitShareBalance = 0;
      wallet.mainBalance = roundToTwoDecimals(wallet.mainBalance + amount);
      await wallet.save({ session });

      const tx = await Transaction.create(
        [{
          user: userId,
          amount,
          type: 'PROFIT_SHARE_TRANSFER',
          status: 'COMPLETED',
          description: `Profit Share transfer from Profit Share Wallet to Main Wallet - $${amount}`,
          reference: null,
          createdBy: null,
        }],
        { session }
      );

      result = { amount, transaction: tx[0] };
    });
    return result;
  } finally {
    session.endSession();
  }
};

// ==========================================
// ADMIN TRIGGER - Process ROI transfer for ALL eligible users
// ==========================================
const adminTriggerRoiTransfer = async () => {
  const SystemSettings = require('../models/SystemSettings');
  const settings = await SystemSettings.getSettings();

  if (!settings.roiTransferEnabled) {
    const error = new Error('ROI transfer is currently disabled');
    error.statusCode = 400;
    throw error;
  }

  const wallets = await Wallet.find({ roiBalance: { $gt: 0 } });
  let processed = 0;
  let totalAmount = 0;
  const errors = [];

  for (const wallet of wallets) {
    try {
      const result = await transferRoiToMain(wallet.user, true);
      processed++;
      totalAmount = roundToTwoDecimals(totalAmount + result.amount);
    } catch (error) {
      errors.push({ userId: wallet.user.toString(), message: error.message });
    }
  }

  return { processed, totalAmount, errors };
};

// ==========================================
// ADMIN TRIGGER - Process Profit Share transfer for ALL eligible users
// ==========================================
const adminTriggerProfitShareTransfer = async () => {
  const SystemSettings = require('../models/SystemSettings');
  const settings = await SystemSettings.getSettings();

  if (!settings.profitShareTransferEnabled) {
    const error = new Error('Profit Share transfer is currently disabled');
    error.statusCode = 400;
    throw error;
  }

  const wallets = await Wallet.find({ profitShareBalance: { $gt: 0 } });
  let processed = 0;
  let totalAmount = 0;
  const errors = [];

  for (const wallet of wallets) {
    try {
      const result = await transferProfitShareToMain(wallet.user, true);
      processed++;
      totalAmount = roundToTwoDecimals(totalAmount + result.amount);
    } catch (error) {
      errors.push({ userId: wallet.user.toString(), message: error.message });
    }
  }

  return { processed, totalAmount, errors };
};

// ==========================================
// FUND WALLET TRANSFER - User to User
// ==========================================
const transferFundToUser = async (senderId, receiverId, amount) => {
  const SystemSettings = require('../models/SystemSettings');
  const User = require('../models/User');
  const settings = await SystemSettings.getSettings();

  if (!settings.fundTransferEnabled) {
    const error = new Error('Fund Wallet transfers are currently disabled by admin');
    error.statusCode = 400;
    throw error;
  }

  const roundedAmount = roundToTwoDecimals(amount);
  if (roundedAmount <= 0) {
    const error = new Error('Transfer amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  if (senderId === receiverId) {
    const error = new Error('Cannot transfer to yourself');
    error.statusCode = 400;
    throw error;
  }

  const receiver = await User.findById(receiverId);
  if (!receiver) {
    const error = new Error('Receiver not found');
    error.statusCode = 404;
    throw error;
  }
  if (receiver.accountStatus !== 'ACTIVE') {
    const error = new Error('Receiver account is not active');
    error.statusCode = 400;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const senderWallet = await Wallet.findOne({ user: senderId }).session(session);
      if (!senderWallet) {
        const error = new Error('Sender wallet not found');
        error.statusCode = 404;
        throw error;
      }
      if (senderWallet.fundBalance < roundedAmount) {
        const error = new Error('Insufficient Fund Wallet balance');
        error.statusCode = 400;
        throw error;
      }

      senderWallet.fundBalance = roundToTwoDecimals(senderWallet.fundBalance - roundedAmount);
      await senderWallet.save({ session });

      let receiverWallet = await Wallet.findOne({ user: receiverId }).session(session);
      if (!receiverWallet) {
        const created = await Wallet.create([{ user: receiverId }], { session });
        receiverWallet = created[0];
      }
      receiverWallet.fundBalance = roundToTwoDecimals(receiverWallet.fundBalance + roundedAmount);
      await receiverWallet.save({ session });

      const senderTx = await Transaction.create(
        [{
          user: senderId,
          amount: -roundedAmount,
          type: 'FUND_TRANSFER_SENT',
          status: 'COMPLETED',
          description: `Fund transfer sent to ${receiver.name} - $${roundedAmount}`,
          reference: receiverId.toString(),
          createdBy: senderId,
        }],
        { session }
      );

      const receiverTx = await Transaction.create(
        [{
          user: receiverId,
          amount: roundedAmount,
          type: 'FUND_TRANSFER_RECEIVED',
          status: 'COMPLETED',
          description: `Fund transfer received from user - $${roundedAmount}`,
          reference: senderId.toString(),
          createdBy: senderId,
        }],
        { session }
      );

      result = {
        amount: roundedAmount,
        senderTransaction: senderTx[0],
        receiverTransaction: receiverTx[0],
        senderBalance: senderWallet.fundBalance,
        receiverBalance: receiverWallet.fundBalance,
      };
    });
    return result;
  } finally {
    session.endSession();
  }
};

module.exports = {
  adjustWalletBalance,
  getWallet,
  getUserTransactions,
  requestDeposit,
  approveDeposit,
  rejectDeposit,
  roundToTwoDecimals,
  transferRoiToMain,
  transferProfitShareToMain,
  adminTriggerRoiTransfer,
  adminTriggerProfitShareTransfer,
  transferFundToUser,
};