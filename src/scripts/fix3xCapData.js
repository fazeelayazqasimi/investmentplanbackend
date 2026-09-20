/**
 * Migration Script: fix3xCapData.js
 *
 * Fixes data after 3X cap change:
 * 1. Recalculates pendingCommissions & totalEligibleEarnings from transactions
 * 2. Clears eligibleInvestmentBase (no longer used for cap calculation)
 *
 * Usage:
 *   node src/scripts/fix3xCapData.js           # Dry run (report only)
 *   node src/scripts/fix3xCapData.js --fix      # Actually apply fixes
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--fix');

const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const transactionsCol = db.collection('transactions');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to check`);
  if (DRY_RUN) console.log('--- DRY RUN (no changes will be written) ---\n');

  let fixed = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;
    const updates = {};

    // --- Step 1: Recalculate pendingCommissions from transactions ---
    const pendingInTxs = await transactionsCol
      .find({ user: userId, type: 'PENDING_NETWORK_COMMISSION', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingIn = round(pendingInTxs.reduce((s, t) => s + (t.amount || 0), 0));

    const pendingOutTxs = await transactionsCol
      .find({ user: userId, type: 'PENDING_RELEASE', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingOut = round(pendingOutTxs.reduce((s, t) => s + (t.amount || 0), 0));

    const correctPending = round(Math.max(0, totalPendingIn - totalPendingOut));
    const currentPending = wallet.pendingCommissions || 0;

    if (Math.abs(currentPending - correctPending) > 0.01) {
      console.log(`User ${userId}: pendingCommissions ${currentPending} -> ${correctPending}`);
      updates.pendingCommissions = correctPending;
    }

    // --- Step 2: Recalculate totalEligibleEarnings from transactions ---
    const eligibleTypes = ['ROI', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE', 'PENDING_RELEASE'];
    const eligibleTxs = await transactionsCol
      .find({ user: userId, type: { $in: eligibleTypes }, status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const correctEligible = round(eligibleTxs.reduce((s, t) => s + (t.amount || 0), 0));
    const currentEligible = wallet.totalEligibleEarnings || 0;

    if (Math.abs(currentEligible - correctEligible) > 0.01) {
      console.log(`User ${userId}: totalEligibleEarnings ${currentEligible} -> ${correctEligible}`);
      updates.totalEligibleEarnings = correctEligible;
    }

    // --- Step 3: Clear eligibleInvestmentBase (no longer used for 3X cap) ---
    if (wallet.eligibleInvestmentBase && wallet.eligibleInvestmentBase > 0) {
      console.log(`User ${userId}: eligibleInvestmentBase ${wallet.eligibleInvestmentBase} -> 0 (cleared)`);
      updates.eligibleInvestmentBase = 0;
    }

    // --- Apply updates ---
    if (Object.keys(updates).length > 0) {
      if (!DRY_RUN) {
        await walletsCol.updateOne({ _id: wallet._id }, { $set: updates });
        console.log(`  -> FIXED`);
      } else {
        console.log(`  -> Would fix (run with --fix to apply)`);
      }
      fixed++;
    } else {
      skipped++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total wallets: ${wallets.length}`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Already correct: ${skipped}`);
  if (DRY_RUN) console.log('\nRun with --fix to apply changes.');
  await mongoose.disconnect();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
