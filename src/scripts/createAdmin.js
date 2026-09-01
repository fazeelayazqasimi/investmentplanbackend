// Run: node src/scripts/createAdmin.js [email] [password]
// Creates (or promotes) an ADMIN user so you can log in at /login.
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const User = require(path.join(__dirname, '..', 'models', 'User'));

const email = process.argv[2] || 'admin@example.com';
const password = process.argv[3] || 'Admin@123';
const name = process.argv[4] || 'Admin';
const phone = process.argv[5] || '+10000000000';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI is missing in .env');
  process.exit(1);
}

(async () => {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    existing.role = 'ADMIN';
    await existing.save();
    console.log(`Promoted existing user "${email}" to ADMIN.`);
  } else {
    const user = new User({ name, email, phone, password, role: 'ADMIN' });
    await user.save();
    console.log(`Created new ADMIN user "${email}".`);
  }

  console.log('-----------------------------------------');
  console.log('Admin login credentials:');
  console.log('  Email:   ', email);
  console.log('  Password:', password);
  console.log('-----------------------------------------');
  console.log('Then open https://investmentplanfrontend.vercel.app/login and log in.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
