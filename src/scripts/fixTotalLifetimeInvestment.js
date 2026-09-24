/**
 * Migration Script: fixTotalLifetimeInvestment.js
 *
 * Backfills wallet.totalLifetimeInvestment = sum of ALL investments
 * (any status) for every user. Used as the 3X earnings cap base.
 *
 * Usage:
 *   node src/scripts/fixTotalLifetimeInvestment.js           # Dry run (report only)
 *   node src/scripts/fixTotalLifetimeInvestment.js --fix     # Actually apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--fix');
const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const investmentsCol = db.collection('investments');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to check`);
  if (DRY_RUN) console.log('--- DRY RUN (no changes will be written) ---\n');

  let fixed = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;

    const invs = await investmentsCol
      .find({ user: userId })
      .project({ originalAmount: 1 })
      .toArray();

    const correctLifetime = round(invs.reduce((s, i) => s + (i.originalAmount || 0), 0));
    const currentLifetime = wallet.totalLifetimeInvestment || 0;

    if (Math.abs(currentLifetime - correctLifetime) > 0.01) {
      console.log(`User ${userId}: totalLifetimeInvestment ${currentLifetime} -> ${correctLifetime}`);
      if (!DRY_RUN) {
        await walletsCol.updateOne(
          { _id: wallet._id },
          { $set: { totalLifetimeInvestment: correctLifetime } }
        );
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
