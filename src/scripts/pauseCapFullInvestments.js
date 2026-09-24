require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--fix');
const roundToTwoDecimals = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * One-time migration: pauses ACTIVE investments of users whose 2X ROI cap
 * or 3X earnings cap is already full (existing data).
 *
 * Usage:
 *   node src/scripts/pauseCapFullInvestments.js          (dry run)
 *   node src/scripts/pauseCapFullInvestments.js --fix    (apply)
 */

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const investmentsCol = db.collection('investments');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to check`);
  if (DRY_RUN) console.log('--- DRY RUN (pass --fix to apply) ---\n');

  let pausedCount = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    const activeInv = wallet.totalInvestmentAmount || 0;
    const lifetimeInv = wallet.totalLifetimeInvestment || activeInv || 0;
    if (activeInv <= 0 && lifetimeInv <= 0) {
      skipped++;
      continue;
    }

    const cap2x = activeInv > 0 ? roundToTwoDecimals(activeInv * 2) : 0;
    const cap3x = lifetimeInv > 0 ? roundToTwoDecimals(lifetimeInv * 3) : 0;
    const roiEarned = wallet.totalRoiEarned || 0;
    const returned = wallet.totalReturned || 0;
    const eligible = wallet.totalEligibleEarnings || 0;

    const full2x = cap2x > 0 && Math.max(roiEarned, returned) >= cap2x;
    const full3x = cap3x > 0 && eligible >= cap3x;

    if (!full2x && !full3x) {
      skipped++;
      continue;
    }

    const activeInvs = await investmentsCol
      .find({ user: wallet.user, status: 'ACTIVE' })
      .project({ originalAmount: 1 })
      .toArray();

    if (activeInvs.length === 0) {
      skipped++;
      continue;
    }

    const whichCap = full2x && full3x ? '2X+3X' : full2x ? '2X' : '3X';
    console.log(
      `User ${wallet.user}: ${whichCap} cap full (inv: $${activeInv}, lifetime: $${lifetimeInv}, roi: $${roiEarned}, eligible: $${eligible}) — pausing ${activeInvs.length} active investment(s)`
    );

    if (!DRY_RUN) {
      await investmentsCol.updateMany(
        { user: wallet.user, status: 'ACTIVE' },
        { $set: { status: 'PAUSED' } }
      );
    }
    pausedCount += activeInvs.length;
  }

  console.log(
    `\n${DRY_RUN ? 'Would pause' : 'Paused'} ${pausedCount} investments across cap-full users. ${skipped} wallets skipped.`
  );
  if (DRY_RUN) {
    console.log('Run again with --fix to apply.');
  }
  await mongoose.disconnect();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
