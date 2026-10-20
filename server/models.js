const m = require('mongoose'), S = m.Schema;
const Product = m.model('Product', new S({ sku: { type: String, unique: true }, name: String, pricePaise: { type: Number, min: 0 }, stock: { type: Number, min: 0 }, active: { type: Boolean, default: true } }, { timestamps: true }));
const Order = m.model('Order', new S({
  number: { type: String, unique: true },
  items: [{ sku: String, name: String, unitPaise: Number, qty: Number }],
  customer: { name: String, phone: String, email: String, pin: String, address: String },
  subtotalPaise: Number, shippingPaise: Number, totalPaise: Number,
  method: { type: String, enum: ['COD', 'RAZORPAY'] },
  paymentStatus: { type: String, enum: ['UNPAID', 'PAID', 'FAILED', 'COD_PENDING', 'COD_COLLECTED'], default: 'UNPAID' },
  status: { type: String, enum: ['PLACED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED'], default: 'PLACED' },
  rzpOrderId: { type: String, index: true }, rzpPaymentId: String, courier: String, trackingNo: String, stockReleased: Boolean
}, { timestamps: true }));
const User = m.model('User', new S({ email: { type: String, unique: true }, hash: String, role: { type: String, default: 'admin' } }));
const Event = m.model('Event', new S({ eventId: { type: String, unique: true } }, { timestamps: true }));
module.exports = { Product, Order, User, Event };
