const mongoose = require('mongoose');
const User = require('../models/User');

// Transaction types where `reference` holds the OTHER user's ObjectId
// (the counterparty of a user-to-user transfer).
const COUNTERPARTY_TYPES = new Set([
  'FUND_TRANSFER_SENT',
  'FUND_TRANSFER_RECEIVED',
]);

/**
 * Attaches `counterpartyUser: { _id, name, email }` to fund-transfer
 * transactions by resolving the user id stored in `reference`.
 * Does nothing for other transaction types.
 *
 * @param {Array<Object>} transactions - lean transaction docs (mutated in place)
 * @returns {Promise<Array<Object>>}
 */
const resolveCounterpartyUsers = async (transactions) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return transactions || [];
  }

  const ids = [];
  for (const txn of transactions) {
    if (!txn || !COUNTERPARTY_TYPES.has(txn.type) || !txn.reference) continue;
    if (mongoose.Types.ObjectId.isValid(txn.reference)) {
      ids.push(txn.reference);
    }
  }
  if (ids.length === 0) return transactions;

  const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));

  for (const txn of transactions) {
    if (!txn || !COUNTERPARTY_TYPES.has(txn.type) || !txn.reference) continue;
    const other = byId.get(String(txn.reference));
    txn.counterpartyUser = other
      ? { _id: other._id, name: other.name, email: other.email }
      : null;
  }

  return transactions;
};

module.exports = { resolveCounterpartyUsers, COUNTERPARTY_TYPES };
