
require('dotenv').config();

const dns = require('node:dns');
dns.setServers(['1.1.1.1', '8.8.8.8']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Product, User } = require('./models');

(async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is missing from your .env file');
    }

    await mongoose.connect(process.env.MONGODB_URI);

    const products = [
      {
        sku: 's200',
        name: 'SHAHEE Ayurvedic Hair Oil 200 ml',
        pricePaise: 49900,
        stock: 100
      },
      {
        sku: 's500',
        name: 'SHAHEE Ayurvedic Hair Oil 500 ml',
        pricePaise: 99900,
        stock: 100
      }
    ];

    for (const product of products) {
      await Product.updateOne(
        { sku: product.sku },
        { $setOnInsert: product },
        { upsert: true }
      );
    }

    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;

    if (email && password && password.length >= 10) {
      await User.updateOne(
        { email: email.toLowerCase() },
        {
          $set: {
            hash: await bcrypt.hash(password, 12),
            role: 'admin'
          }
        },
        { upsert: true }
      );

      console.log('Admin ready:', email);
    } else {
      console.log(
        'Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ chars) to create the admin.'
      );
    }

    console.log('Products seeded.');
  } catch (error) {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
