require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  const walletsCol = db.collection('wallets');
  const investmentsCol = db.collection('investments');

  const wallets = await walletsCol.find({}).toArray();
  console.log(`Found ${wallets.length} wallets to fix`);

  let updated = 0;

  for (const wallet of wallets) {
    const userId = wallet.user;

    const activeInvs = await investmentsCol
      .find({ user: userId, status: 'ACTIVE' })
      .project({ originalAmount: 1 })
      .toArray();

    const totalActive = activeInvs.reduce((s, i) => s + (i.originalAmount || 0), 0);
    const rounded = Math.round(totalActive * 100) / 100;
    const current = wallet.totalInvestmentAmount || 0;

    if (rounded !== current) {
      await walletsCol.updateOne(
        { _id: wallet._id },
        {
          $set: {
            totalInvestmentAmount: rounded,
            totalMaxReturn: rounded * 2,
          },
        }
      );
      console.log(
        `User ${userId}: totalInvestmentAmount ${current} -> ${rounded} (active: ${activeInvs.length})`
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
