/**
 * Migration Script: fixSaifData.js
 *
 * Fixes saif's wallet data:
 * - Recalculates eligibleInvestmentBase from downline investments
 * - Recalculates totalEligibleEarnings from transactions
 * - Fixes pendingCommissions from transaction history
 *
 * Usage:
 *   node src/scripts/fixSaifData.js              # Dry run
 *   node src/scripts/fixSaifData.js --fix        # Apply fixes
 *   node src/scripts/fixSaifData.js --user EMAIL # Fix specific user by email
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--fix');
const targetEmail = process.argv.includes('--user') ? process.argv[process.argv.indexOf('--user') + 1] : null;

const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const transactionsCol = db.collection('transactions');
  const investmentsCol = db.collection('investments');
  const usersCol = db.collection('users');

  // Find target user(s)
  let users;
  if (targetEmail) {
    const u = await usersCol.findOne({ email: targetEmail });
    if (!u) { console.log(`User not found: ${targetEmail}`); await mongoose.disconnect(); return; }
    users = [u];
    console.log(`Fixing user: ${targetEmail} (${u._id})`);
  } else {
    users = await usersCol.find({}).toArray();
    console.log(`Checking all ${users.length} users`);
  }
  if (DRY_RUN) console.log('--- DRY RUN ---\n');

  let fixed = 0;

  for (const user of users) {
    const userId = user._id;
    const wallet = await walletsCol.findOne({ user: userId });
    if (!wallet) continue;

    // 1. Recalculate eligibleInvestmentBase from downline investments
    // Find all users who referred someone, then find those referrals' investments
    const downlines = await usersCol.find({ referredBy: userId }).toArray();
    const downlineIds = downlines.map(d => d._id);

    let eligibleBase = 0;
    if (downlineIds.length > 0) {
      const downlineInvestments = await investmentsCol
        .find({ user: { $in: downlineIds }, status: 'ACTIVE' })
        .project({ originalAmount: 1 })
        .toArray();
      eligibleBase = round(downlineInvestments.reduce((s, i) => s + (i.originalAmount || 0), 0));
    }

    // 2. Recalculate totalEligibleEarnings from transactions
    const eligibleTypes = ['ROI', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE', 'PENDING_RELEASE', 'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS'];
    const eligibleTxs = await transactionsCol
      .find({ user: userId, type: { $in: eligibleTypes }, status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const correctEligible = round(eligibleTxs.reduce((s, t) => s + (t.amount || 0), 0));

    // 3. Recalculate pendingCommissions from transactions
    const pendingIn = await transactionsCol
      .find({ user: userId, type: 'PENDING_NETWORK_COMMISSION', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingIn = round(pendingIn.reduce((s, t) => s + (t.amount || 0), 0));

    const pendingOut = await transactionsCol
      .find({ user: userId, type: 'PENDING_RELEASE', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingOut = round(pendingOut.reduce((s, t) => s + (t.amount || 0), 0));
    const correctPending = round(Math.max(0, totalPendingIn - totalPendingOut));

    // 4. Recalculate totalInvestmentAmount
    const activeInvs = await investmentsCol
      .find({ user: userId, status: 'ACTIVE' })
      .project({ originalAmount: 1 })
      .toArray();
    const correctTotalInv = round(activeInvs.reduce((s, i) => s + (i.originalAmount || 0), 0));

    // Check changes
    const baseChanged = Math.abs((wallet.eligibleInvestmentBase || 0) - eligibleBase) > 0.01;
    const eligibleChanged = Math.abs((wallet.totalEligibleEarnings || 0) - correctEligible) > 0.01;
    const pendingChanged = Math.abs((wallet.pendingCommissions || 0) - correctPending) > 0.01;
    const invChanged = Math.abs((wallet.totalInvestmentAmount || 0) - correctTotalInv) > 0.01;

    if (baseChanged || eligibleChanged || pendingChanged || invChanged) {
      console.log(`=== ${user.email || userId} ===`);
      if (baseChanged) console.log(`  eligibleInvestmentBase: ${wallet.eligibleInvestmentBase || 0} -> ${eligibleBase} (${downlines.length} downlines)`);
      if (eligibleChanged) console.log(`  totalEligibleEarnings: ${wallet.totalEligibleEarnings || 0} -> ${correctEligible}`);
      if (pendingChanged) console.log(`  pendingCommissions: ${wallet.pendingCommissions || 0} -> ${correctPending}`);
      if (invChanged) console.log(`  totalInvestmentAmount: ${wallet.totalInvestmentAmount || 0} -> ${correctTotalInv}`);

      if (!DRY_RUN) {
        const update = {};
        if (baseChanged) update.eligibleInvestmentBase = eligibleBase;
        if (eligibleChanged) update.totalEligibleEarnings = correctEligible;
        if (pendingChanged) update.pendingCommissions = correctPending;
        if (invChanged) {
          update.totalInvestmentAmount = correctTotalInv;
          update.totalMaxReturn = round(correctTotalInv * 2);
        }
        await walletsCol.updateOne({ _id: wallet._id }, { $set: update });
        console.log(`  -> FIXED`);
      } else {
        console.log(`  -> Would fix`);
      }
      fixed++;
    }
  }

  console.log(`\nDone. ${fixed} wallets ${DRY_RUN ? 'would be' : ''} updated.`);
  await mongoose.disconnect();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
