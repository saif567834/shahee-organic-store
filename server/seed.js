require('dotenv').config();
const mongoose = require('mongoose'), bcrypt = require('bcryptjs'), { Product, User } = require('./models');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  for (const p of [{ sku: 's200', name: 'SHAHEE Ayurvedic Hair Oil 200 ml', pricePaise: 49900, stock: 100 }, { sku: 's500', name: 'SHAHEE Ayurvedic Hair Oil 500 ml', pricePaise: 99900, stock: 100 }])
    await Product.updateOne({ sku: p.sku }, { $setOnInsert: p }, { upsert: true });
  const { ADMIN_EMAIL: e, ADMIN_PASSWORD: pw } = process.env;
  if (e && pw && pw.length >= 10) { await User.updateOne({ email: e.toLowerCase() }, { $set: { hash: await bcrypt.hash(pw, 12), role: 'admin' } }, { upsert: true }); console.log('Admin ready:', e); }
  else console.log('Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ chars) to create the admin.');
  console.log('Products seeded.'); process.exit(0);
})();
