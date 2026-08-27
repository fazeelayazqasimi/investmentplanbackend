require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const col = mongoose.connection.db.collection('wallets');
  await col.dropIndex('userId_1_type_1').catch((e) => console.log('drop userId_1_type_1:', e.message));
  await col.dropIndex('userId_1').catch((e) => console.log('drop userId_1:', e.message));
  const r = await col.deleteMany({ user: { $exists: false } });
  console.log('Removed old-format wallet docs:', r.deletedCount);
  const indexes = await col.indexes();
  console.log('Remaining indexes:', indexes.map((i) => i.name).join(', '));
  await mongoose.disconnect();
}).catch((e) => { console.error(e); process.exit(1); });
