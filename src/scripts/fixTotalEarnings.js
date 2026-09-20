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

    // Find all credit transactions that should count towards totalEarnings
    const creditTypes = ['ROI', 'COMMISSION', 'DIRECT_INCOME', 'LEVEL_INCOME', 'PROFIT_SHARE', 'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS', 'PENDING_RELEASE', 'PENDING_NETWORK_COMMISSION'];
    const creditTxs = await transactionsCol
      .find({
        user: userId,
        type: { $in: creditTypes },
        amount: { $gt: 0 },
        status: 'COMPLETED',
      })
      .toArray();

    const totalFromTxs = creditTxs.reduce((sum, tx) => sum + tx.amount, 0);
    const roundedTotal = Math.round(totalFromTxs * 100) / 100;
    const currentTotal = wallet.totalEarnings || 0;

    if (Math.abs(roundedTotal - currentTotal) > 0.01) {
      await walletsCol.updateOne(
        { _id: wallet._id },
        { $set: { totalEarnings: roundedTotal } }
      );
      console.log(
        `User ${userId}: totalEarnings ${currentTotal} -> ${roundedTotal} (${creditTxs.length} txs)`
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
