require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const transactionsCol = db.collection('transactions');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to fix`);

  const eligibleTypes = ['DIRECT_INCOME', 'LEVEL_INCOME', 'ROI', 'PROFIT_SHARE', 'SIGNUP_BONUS', 'UPLINE_SIGNUP_BONUS'];
  let updated = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;

    const eligibleTxs = await transactionsCol
      .find({
        user: userId,
        type: { $in: eligibleTypes },
        status: 'COMPLETED',
      })
      .project({ amount: 1 })
      .toArray();

    const totalEligible = eligibleTxs.reduce((s, t) => s + (t.amount || 0), 0);
    const rounded = Math.round(totalEligible * 100) / 100;
    const current = wallet.totalEligibleEarnings || 0;

    if (Math.abs(rounded - current) > 0.01) {
      await walletsCol.updateOne(
        { _id: wallet._id },
        { $set: { totalEligibleEarnings: rounded } }
      );
      console.log(
        `User ${userId}: totalEligibleEarnings ${current} -> ${rounded} (${eligibleTxs.length} eligible txs)`
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
