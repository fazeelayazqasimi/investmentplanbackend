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
  const validFields = ['mainBalance', 'roiBalance', 'commissionBalance'];
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

    // Track cumulative lifetime earnings for ROI and COMMISSION credits only
    if ((type === 'ROI' || type === 'COMMISSION') && roundedAmount > 0) {
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
      .populate({ path: 'investment', select: 'plan originalAmount' })
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

module.exports = {
  adjustWalletBalance,
  getWallet,
  getUserTransactions,
  requestDeposit,
  approveDeposit,
  rejectDeposit,
  roundToTwoDecimals,
};