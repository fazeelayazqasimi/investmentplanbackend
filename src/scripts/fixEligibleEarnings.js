require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const transactionsCol = db.collection('transactions');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to check`);

  let updated = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;

    // Find all PENDING_RELEASE transactions that credited mainBalance (positive amount)
    const releaseTxs = await transactionsCol
      .find({
        user: userId,
        type: 'PENDING_RELEASE',
        amount: { $gt: 0 },
        status: 'COMPLETED',
      })
      .toArray();

    if (releaseTxs.length === 0) continue;

    const totalReleased = releaseTxs.reduce((sum, tx) => sum + tx.amount, 0);
    const currentEligible = wallet.totalEligibleEarnings || 0;
    const newEligible = Math.round((currentEligible + totalReleased) * 100) / 100;

    if (newEligible !== currentEligible) {
      await walletsCol.updateOne(
        { _id: wallet._id },
        { $set: { totalEligibleEarnings: newEligible } }
      );
      console.log(
        `User ${userId}: totalEligibleEarnings ${currentEligible} -> ${newEligible} (${releaseTxs.length} releases, +$${totalReleased})`
      );
      updated++;
    }
  }

  console.log(`\nDone. ${updated} wallets updated.`);
  await mongoose.disconnect();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
