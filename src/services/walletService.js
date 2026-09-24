const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const SystemSettings = require('../models/SystemSettings');
const User = require('../models/User');
const {
  sendDepositApprovedEmail,
  sendDepositRejectedEmail,
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
} = require('../utils/emailService');

/**
 * Fire-safe user email: looks up the user's email and sends.
 * Never throws — email failure must not break the main action.
 */
const notifyUserByEmail = async (userId, sendFn) => {
  try {
    const user = await User.findById(userId).select('email');
    if (user && user.email) {
      await sendFn(user.email);
    }
  } catch (err) {
    console.error('Email notification failed:', err.message);
  }
};

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
  metadata = null,
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

    // Track cumulative lifetime earnings for all credit types.
    const creditTypes = ['ROI', 'COMMISSION', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE', 'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS', 'PENDING_RELEASE', 'PENDING_NETWORK_COMMISSION'];
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
          metadata,
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
      .populate({ path: 'investment', select: 'originalAmount user', populate: { path: 'user', select: 'name email' } })
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
const requestDeposit = async (userId, amount, description = '', metadata = {}) => {
  const roundedAmount = roundToTwoDecimals(amount);

  if (roundedAmount <= 0) {
    const error = new Error('Deposit amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const txData = {
    user: userId,
    amount: roundedAmount,
    type: 'DEPOSIT',
    status: 'PENDING',
    description: description || 'Deposit request',
    createdBy: userId,
  };

  if (metadata.proofImage) {
    txData.proofImage = metadata.proofImage;
    txData.proofPublicId = metadata.proofPublicId;
  }

  const transaction = await Transaction.create(txData);

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

    await notifyUserByEmail(result.user, (email) =>
      sendDepositApprovedEmail(email, result.amount)
    );

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

  await notifyUserByEmail(tx.user, (email) =>
    sendDepositRejectedEmail(email, tx.amount)
  );

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
// MAIN WALLET -> FUND WALLET TRANSFER
// ==========================================
const transferMainToFund = async (userId, amount) => {
  const SystemSettings = require('../models/SystemSettings');
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

      if (wallet.mainBalance < roundedAmount) {
        const error = new Error('Insufficient Main Wallet balance');
        error.statusCode = 400;
        throw error;
      }

      wallet.mainBalance = roundToTwoDecimals(wallet.mainBalance - roundedAmount);
      wallet.fundBalance = roundToTwoDecimals(wallet.fundBalance + roundedAmount);
      await wallet.save({ session });

      const senderTx = await Transaction.create(
        [{
          user: userId,
          amount: -roundedAmount,
          type: 'MAIN_TO_FUND_TRANSFER',
          status: 'COMPLETED',
          description: `Transfer from Main Wallet to Fund Wallet - $${roundedAmount}`,
          reference: null,
          createdBy: null,
        }],
        { session }
      );

      const receiverTx = await Transaction.create(
        [{
          user: userId,
          amount: roundedAmount,
          type: 'MAIN_TO_FUND_TRANSFER',
          status: 'COMPLETED',
          description: `Received from Main Wallet - $${roundedAmount}`,
          reference: null,
          createdBy: null,
        }],
        { session }
      );

      result = {
        amount: roundedAmount,
        mainBalance: wallet.mainBalance,
        fundBalance: wallet.fundBalance,
        senderTransaction: senderTx[0],
        receiverTransaction: receiverTx[0],
      };
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

  // Verify receiver is in sender's downline tree
  const referralService = require('./referralService');
  const allDownlines = await referralService.getAllDownlines(senderId);
  const receiverIdStr = receiverId.toString();
  const isDownline = allDownlines.some(
    (d) => d.user._id.toString() === receiverIdStr
  );
  if (!isDownline) {
    const error = new Error('You can only transfer Fund Wallet balance to users in your downline');
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

/**
 * Deposits funds from sender's E-Wallet to a downline user's mainBalance.
 * Direct credit — no admin approval needed.
 *
 * @param {string} senderId - the user paying
 * @param {string} receiverId - the downline user receiving the deposit
 * @param {number} amount - deposit amount
 * @returns {Promise<Object>}
 */
const depositForDownline = async (senderId, receiverId, amount) => {
  const SystemSettings = require('../models/SystemSettings');
  const User = require('../models/User');
  const referralService = require('./referralService');

  const settings = await SystemSettings.getSettings();

  if (!settings.ewalletDownlineDepositEnabled) {
    const error = new Error('Downline deposit via E-Wallet is currently disabled by admin');
    error.statusCode = 400;
    throw error;
  }

  const roundedAmount = roundToTwoDecimals(amount);
  if (roundedAmount <= 0) {
    const error = new Error('Deposit amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  if (!receiverId) {
    const error = new Error('Receiver ID is required');
    error.statusCode = 400;
    throw error;
  }

  if (senderId === receiverId) {
    const error = new Error('You cannot deposit to your own account');
    error.statusCode = 400;
    throw error;
  }

  const sender = await User.findById(senderId);
  if (!sender) {
    const error = new Error('Sender not found');
    error.statusCode = 404;
    throw error;
  }

  const receiver = await User.findById(receiverId);
  if (!receiver) {
    const error = new Error('Receiver not found');
    error.statusCode = 404;
    throw error;
  }

  // Verify receiver is in sender's downline tree
  const allDownlines = await referralService.getAllDownlines(senderId);
  const receiverIdStr = receiverId.toString();
  const isDownline = allDownlines.some(
    (d) => (d.user?._id || d._id)?.toString() === receiverIdStr
  );
  if (!isDownline) {
    const error = new Error('You can only deposit for users in your downline');
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
      if (senderWallet.ewalletBalance < roundedAmount) {
        const error = new Error(`Insufficient E-Wallet balance. Available: $${senderWallet.ewalletBalance}`);
        error.statusCode = 400;
        throw error;
      }

      // Debit sender's E-Wallet
      senderWallet.ewalletBalance = roundToTwoDecimals(senderWallet.ewalletBalance - roundedAmount);
      await senderWallet.save({ session });

      // Credit receiver's mainBalance
      let receiverWallet = await Wallet.findOne({ user: receiverId }).session(session);
      if (!receiverWallet) {
        const created = await Wallet.create([{ user: receiverId }], { session });
        receiverWallet = created[0];
      }
      receiverWallet.mainBalance = roundToTwoDecimals(receiverWallet.mainBalance + roundedAmount);
      await receiverWallet.save({ session });

      // Sender transaction
      const senderTx = await Transaction.create(
        [{
          user: senderId,
          amount: -roundedAmount,
          type: 'E_WALLET_DOWNLINE_DEPOSIT_SENT',
          status: 'COMPLETED',
          description: `Deposit sent to ${receiver.name || receiver.email} - $${roundedAmount} from E-Wallet`,
          reference: receiverId.toString(),
          createdBy: senderId,
        }],
        { session }
      );

      // Receiver transaction
      const receiverTx = await Transaction.create(
        [{
          user: receiverId,
          amount: roundedAmount,
          type: 'E_WALLET_DOWNLINE_DEPOSIT_RECEIVED',
          status: 'COMPLETED',
          description: `Deposit received from ${sender.name || sender.email} - $${roundedAmount}`,
          reference: senderId.toString(),
          createdBy: senderId,
        }],
        { session }
      );

      result = {
        amount: roundedAmount,
        senderTransaction: senderTx[0],
        receiverTransaction: receiverTx[0],
        senderBalance: senderWallet.ewalletBalance,
        receiverBalance: receiverWallet.mainBalance,
        receiver: { id: receiver._id, name: receiver.name, email: receiver.email },
      };
    });
    return result;
  } finally {
    session.endSession();
  }
};

// ==========================================
// WITHDRAWAL REQUEST (pending admin approval)
// ==========================================
const requestWithdrawal = async (userId, { amount, balanceField, payoutMethod, payoutDetails, notes = '' }) => {
  const roundedAmount = roundToTwoDecimals(amount);

  if (roundedAmount <= 0) {
    const error = new Error('Withdrawal amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }

  const validFields = ['mainBalance'];
  if (!validFields.includes(balanceField)) {
    const error = new Error('Withdrawal is only allowed from Main Wallet');
    error.statusCode = 400;
    throw error;
  }

  const validMethods = ['BANK', 'BEP20'];
  if (!validMethods.includes(payoutMethod)) {
    const error = new Error('Invalid payout method. Must be BANK or BEP20');
    error.statusCode = 400;
    throw error;
  }

  const session = await mongoose.startSession();

  try {
    let transaction;

    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user: userId }).session(session);
      if (!wallet) {
        const error = new Error('Wallet not found');
        error.statusCode = 404;
        throw error;
      }

      const currentBalance = wallet[balanceField] || 0;
      if (currentBalance < roundedAmount) {
        const error = new Error(`Insufficient balance. Available: $${currentBalance}`);
        error.statusCode = 400;
        throw error;
      }

      // Check withdrawal min amount limit
      const settings = await SystemSettings.getSettings();
      if (settings.withdrawalMinAmount > 0 && roundedAmount < settings.withdrawalMinAmount) {
        const error = new Error(`Minimum withdrawal amount is $${settings.withdrawalMinAmount}. You entered: $${roundedAmount}`);
        error.statusCode = 400;
        throw error;
      }

      // Check withdrawal max amount limit
      if (settings.withdrawalMaxAmount > 0 && roundedAmount > settings.withdrawalMaxAmount) {
        const error = new Error(`Maximum withdrawal amount is $${settings.withdrawalMaxAmount}. You entered: $${roundedAmount}`);
        error.statusCode = 400;
        throw error;
      }

      // Compute withdrawal fee (deducted from amount; user receives net)
      const feePercentage = Number(settings.withdrawalFeePercentage) || 0;
      const fee = roundToTwoDecimals((roundedAmount * feePercentage) / 100);
      const netAmount = roundToTwoDecimals(roundedAmount - fee);

      const metadata = {
        payoutMethod,
        payoutDetails,
        notes,
        balanceField,
        feePercentage,
        fee,
        netAmount,
        balanceHeld: true,
      };

      const description = fee > 0
        ? `Withdrawal request: $${roundedAmount} from ${balanceField} via ${payoutMethod} (fee ${feePercentage}% = $${fee}, net $${netAmount})`
        : `Withdrawal request: $${roundedAmount} from ${balanceField} via ${payoutMethod}`;

      // Deduct balance immediately (held until admin approve/reject)
      wallet[balanceField] = roundToTwoDecimals(currentBalance - roundedAmount);
      await wallet.save({ session });

      const [tx] = await Transaction.create([{
        user: userId,
        amount: roundedAmount,
        type: 'WITHDRAWAL',
        status: 'PENDING',
        description,
        createdBy: userId,
        metadata,
      }], { session });

      transaction = tx;
    });

    return transaction;
  } finally {
    session.endSession();
  }
};

// ==========================================
// APPROVE WITHDRAWAL (admin approves)
// New requests (metadata.balanceHeld): balance already deducted at request time.
// Legacy requests (no balanceHeld flag): debit now (old behavior).
// ==========================================
const approveWithdrawal = async (transactionId, adminId) => {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const tx = await Transaction.findById(transactionId).session(session);

      if (!tx) {
        const error = new Error('Withdrawal request not found');
        error.statusCode = 404;
        throw error;
      }
      if (tx.type !== 'WITHDRAWAL') {
        const error = new Error('Transaction is not a withdrawal request');
        error.statusCode = 400;
        throw error;
      }
      if (tx.status !== 'PENDING') {
        const error = new Error(`Withdrawal already ${tx.status.toLowerCase()}`);
        error.statusCode = 400;
        throw error;
      }

      const balanceField = tx.metadata?.balanceField || 'mainBalance';
      const alreadyHeld = tx.metadata?.balanceHeld === true;

      let wallet = await Wallet.findOne({ user: tx.user }).session(session);
      if (!wallet) {
        const error = new Error('User wallet not found');
        error.statusCode = 404;
        throw error;
      }

      if (!alreadyHeld) {
        // Legacy pending withdrawal: balance was never held, debit now
        const currentBalance = wallet[balanceField] || 0;
        if (currentBalance < tx.amount) {
          const error = new Error(`Insufficient balance. Available: $${currentBalance}`);
          error.statusCode = 400;
          throw error;
        }
        wallet[balanceField] = roundToTwoDecimals(currentBalance - tx.amount);
      }

      wallet.totalWithdrawn = roundToTwoDecimals((wallet.totalWithdrawn || 0) + tx.amount);
      await wallet.save({ session });

      tx.status = 'COMPLETED';
      tx.createdBy = adminId;
      tx.description = tx.description ? `${tx.description} (approved)` : 'Withdrawal approved';
      await tx.save({ session });

      result = tx;
    });

    await notifyUserByEmail(result.user, (email) =>
      sendWithdrawalApprovedEmail(email, result.amount, result.metadata?.netAmount ?? null)
    );

    return result;
  } finally {
    session.endSession();
  }
};

// ==========================================
// REJECT WITHDRAWAL (admin rejects → refund held balance)
// ==========================================
const rejectWithdrawal = async (transactionId, adminId, reason = '') => {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      const tx = await Transaction.findById(transactionId).session(session);

      if (!tx) {
        const error = new Error('Withdrawal request not found');
        error.statusCode = 404;
        throw error;
      }
      if (tx.type !== 'WITHDRAWAL') {
        const error = new Error('Transaction is not a withdrawal request');
        error.statusCode = 400;
        throw error;
      }
      if (tx.status !== 'PENDING') {
        const error = new Error(`Withdrawal already ${tx.status.toLowerCase()}`);
        error.statusCode = 400;
        throw error;
      }

      const balanceField = tx.metadata?.balanceField || 'mainBalance';
      const alreadyHeld = tx.metadata?.balanceHeld === true;

      // Refund amount that was held (deducted) at request time
      if (alreadyHeld) {
        const wallet = await Wallet.findOne({ user: tx.user }).session(session);
        if (!wallet) {
          const error = new Error('User wallet not found');
          error.statusCode = 404;
          throw error;
        }
        wallet[balanceField] = roundToTwoDecimals((wallet[balanceField] || 0) + tx.amount);
        await wallet.save({ session });
      }

      tx.status = 'REJECTED';
      tx.createdBy = adminId;
      tx.description = reason ? `Withdrawal rejected: ${reason}` : 'Withdrawal rejected';
      if (tx.metadata) {
        tx.metadata.rejectionReason = reason;
        tx.metadata.balanceHeld = false;
      } else {
        tx.metadata = { rejectionReason: reason, balanceHeld: false };
      }
      await tx.save({ session });

      result = tx;
    });

    await notifyUserByEmail(result.user, (email) =>
      sendWithdrawalRejectedEmail(email, result.amount, reason)
    );

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
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  roundToTwoDecimals,
  transferRoiToMain,
  transferMainToFund,
  transferProfitShareToMain,
  adminTriggerRoiTransfer,
  adminTriggerProfitShareTransfer,
  transferFundToUser,
  depositForDownline,
};