/**
 * Migration Script: fixPendingRelease.js
 *
 * Recalculates pendingCommissions and totalEligibleEarnings from
 * the source of truth (transactions). Fixes any discrepancies
 * caused by the old ROI pending release that had no multiplier limit.
 *
 * Usage:
 *   node src/scripts/fixPendingRelease.js           # Dry run (report only)
 *   node src/scripts/fixPendingRelease.js --fix      # Actually apply fixes
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--fix');

const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const transactionsCol = db.collection('transactions');
  const investmentsCol = db.collection('investments');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to check`);
  if (DRY_RUN) console.log('--- DRY RUN (no changes will be written) ---\n');

  let fixed = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;

    // --- Step 1: Recalculate pendingCommissions from transactions ---
    // Money INTO pending: PENDING_NETWORK_COMMISSION
    const pendingInTxs = await transactionsCol
      .find({ user: userId, type: 'PENDING_NETWORK_COMMISSION', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingIn = round(pendingInTxs.reduce((s, t) => s + (t.amount || 0), 0));

    // Money OUT of pending: PENDING_RELEASE
    const pendingOutTxs = await transactionsCol
      .find({ user: userId, type: 'PENDING_RELEASE', status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const totalPendingOut = round(pendingOutTxs.reduce((s, t) => s + (t.amount || 0), 0));

    const correctPending = round(Math.max(0, totalPendingIn - totalPendingOut));
    const currentPending = wallet.pendingCommissions || 0;

    // --- Step 2: Recalculate totalEligibleEarnings from transactions ---
    // Eligible types that count toward 3X cap
    const eligibleTypes = ['ROI', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE', 'PENDING_RELEASE'];
    const eligibleTxs = await transactionsCol
      .find({ user: userId, type: { $in: eligibleTypes }, status: 'COMPLETED' })
      .project({ amount: 1 })
      .toArray();
    const correctEligible = round(eligibleTxs.reduce((s, t) => s + (t.amount || 0), 0));
    const currentEligible = wallet.totalEligibleEarnings || 0;

    // --- Step 3: Recalculate totalInvestmentAmount ---
    const activeInvs = await investmentsCol
      .find({ user: userId, status: 'ACTIVE' })
      .project({ originalAmount: 1 })
      .toArray();
    const correctTotalInv = round(activeInvs.reduce((s, i) => s + (i.originalAmount || 0), 0));
    const currentTotalInv = wallet.totalInvestmentAmount || 0;

    // --- Step 4: Recalculate mainBalance correction ---
    // If pending was over-released, mainBalance has excess
    // If pending was under-released, mainBalance is short
    const pendingDiff = round(currentPending - correctPending);
    // pendingDiff > 0 means pending is HIGH (need to decrease pending, increase main)
    // pendingDiff < 0 means pending is LOW (need to increase pending, decrease main)
    const mainAdjustment = round(-pendingDiff);

    // --- Step 5: Check if anything needs fixing ---
    const pendingChanged = Math.abs(currentPending - correctPending) > 0.01;
    const eligibleChanged = Math.abs(currentEligible - correctEligible) > 0.01;
    const invChanged = Math.abs(currentTotalInv - correctTotalInv) > 0.01;

    if (pendingChanged || eligibleChanged || invChanged) {
      console.log(`=== User ${userId} ===`);
      if (pendingChanged) {
        console.log(`  pendingCommissions: ${currentPending} -> ${correctPending} (in: ${totalPendingIn}, out: ${totalPendingOut})`);
      }
      if (eligibleChanged) {
        console.log(`  totalEligibleEarnings: ${currentEligible} -> ${correctEligible}`);
      }
      if (invChanged) {
        console.log(`  totalInvestmentAmount: ${currentTotalInv} -> ${correctTotalInv}`);
      }
      if (Math.abs(mainAdjustment) > 0.01) {
        console.log(`  mainBalance adjustment: ${mainAdjustment > 0 ? '+' : ''}${mainAdjustment}`);
      }

      if (!DRY_RUN) {
        const update = {};
        if (pendingChanged) update.pendingCommissions = correctPending;
        if (eligibleChanged) update.totalEligibleEarnings = correctEligible;
        if (invChanged) {
          update.totalInvestmentAmount = correctTotalInv;
          update.totalMaxReturn = round(correctTotalInv * 2);
        }
        // Adjust mainBalance to compensate for pending correction
        if (Math.abs(mainAdjustment) > 0.01) {
          update.mainBalance = round((wallet.mainBalance || 0) + mainAdjustment);
        }
        await walletsCol.updateOne({ _id: wallet._id }, { $set: update });
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
