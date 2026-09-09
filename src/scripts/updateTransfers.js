// Run: node src/scripts/updateTransfers.js
// Enables ROI Transfer and Profit Share Transfer in existing database settings.
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const SystemSettings = require(path.join(__dirname, '..', 'models', 'SystemSettings'));

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI is missing in .env');
  process.exit(1);
}

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const settings = await SystemSettings.findOne({ singletonKey: 'GLOBAL_SETTINGS' });
  if (!settings) {
    console.log('No settings found. Defaults will apply on next server start (transfers ON).');
    await mongoose.disconnect();
    process.exit(0);
  }

  settings.roiTransferEnabled = true;
  settings.profitShareTransferEnabled = true;
  await settings.save();

  console.log('Updated successfully:');
  console.log('  roiTransferEnabled: true');
  console.log('  profitShareTransferEnabled: true');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
