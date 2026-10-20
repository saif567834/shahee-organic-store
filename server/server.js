require('dotenv').config();
const express = require('express'), mongoose = require('mongoose'), crypto = require('crypto'), helmet = require('helmet'),
  rateLimit = require('express-rate-limit'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'),
  bcrypt = require('bcryptjs'), Razorpay = require('razorpay'), path = require('path'), { z } = require('zod');
const { Product, Order, User, Event } = require('./models');
const E = process.env, PROD = E.NODE_ENV === 'production';
for (const k of ['MONGODB_URI', 'JWT_SECRET']) if (!E[k]) { console.error('Missing env: ' + k); process.exit(1); }
const SHIP = +E.SHIPPING_PAISE || 0, FREE = +E.FREE_SHIPPING_ABOVE_PAISE || 0;
const rzp = E.RAZORPAY_KEY_ID && E.RAZORPAY_KEY_SECRET ? new Razorpay({ key_id: E.RAZORPAY_KEY_ID, key_secret: E.RAZORPAY_KEY_SECRET }) : null;
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const release = async o => { // give stock back exactly once
  const r = await Order.findOneAndUpdate({ _id: o._id, stockReleased: { $ne: true } }, { stockReleased: true });
  if (r) for (const i of o.items) await Product.updateOne({ sku: i.sku }, { $inc: { stock: i.qty } });
};

const app = express(); app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'], scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  connectSrc: ["'self'", 'https://*.razorpay.com'] } } }));

// --- Razorpay webhook (raw body, signature, idempotent) ---
app.post('/api/payments/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const id = req.get('x-razorpay-event-id');
    if (!E.RAZORPAY_WEBHOOK_SECRET || !id || !eq(hmac(E.RAZORPAY_WEBHOOK_SECRET, req.body), req.get('x-razorpay-signature') || '')) return res.status(400).json({ error: 'Bad signature' });
    try { await Event.create({ eventId: id }); } catch (e) { if (e.code === 11000) return res.json({ ok: true, duplicate: true }); throw e; }
    const ev = JSON.parse(req.body), pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if (pay) {
      const o = await Order.findOne({ rzpOrderId: pay.order_id });
      if (o && ev.event === 'payment.captured' && pay.amount === o.totalPaise) await Order.updateOne({ _id: o._id }, { paymentStatus: 'PAID', rzpPaymentId: pay.id });
      if (o && ev.event === 'payment.failed' && o.paymentStatus !== 'PAID') await Order.updateOne({ _id: o._id }, { paymentStatus: 'FAILED' });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use(express.json({ limit: '20kb' })); app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 6e4, limit: 120 }));
app.use(express.static(path.join(__dirname, '../public')));

// --- Public ---
app.get('/api/products', async (_q, r, n) => { try { r.json(await Product.find({ active: true }).select('sku name pricePaise stock -_id')); } catch (e) { n(e); } });

const OrderIn = z.object({
  items: z.array(z.object({ sku: z.string().max(20), qty: z.number().int().min(1).max(20) })).min(1).max(10),
  customer: z.object({ name: z.string().trim().min(3).max(80), phone: z.string().regex(/^[6-9]\d{9}$/), email: z.string().email().max(100).optional().or(z.literal('')),
    pin: z.string().regex(/^[1-9]\d{5}$/), address: z.string().trim().min(10).max(300) }),
  method: z.enum(['COD', 'RAZORPAY'])
});
app.post('/api/orders', rateLimit({ windowMs: 6e5, limit: 20 }), async (req, res, next) => {
  try {
    const b = OrderIn.parse(req.body);
    if (b.method === 'RAZORPAY' && !rzp) return res.status(503).json({ error: 'Online payment is not configured' });
    const items = [], taken = []; let sub = 0;
    try { // prices and stock always come from the database; stock is reserved atomically
      for (const i of b.items) {
        const p = await Product.findOneAndUpdate({ sku: i.sku, active: true, stock: { $gte: i.qty } }, { $inc: { stock: -i.qty } });
        if (!p) throw Object.assign(new Error('Item unavailable or out of stock: ' + i.sku), { status: 409 });
        taken.push(i); items.push({ sku: p.sku, name: p.name, unitPaise: p.pricePaise, qty: i.qty }); sub += p.pricePaise * i.qty;
      }
    } catch (e) { for (const i of taken) await Product.updateOne({ sku: i.sku }, { $inc: { stock: i.qty } }); throw e; }
    const ship = FREE && sub >= FREE ? 0 : SHIP, total = sub + ship;
    const o = await Order.create({ number: 'SH' + Date.now().toString(36).toUpperCase() + crypto.randomInt(100, 999), items, customer: b.customer,
      subtotalPaise: sub, shippingPaise: ship, totalPaise: total, method: b.method, paymentStatus: b.method === 'COD' ? 'COD_PENDING' : 'UNPAID' });
    const out = { order: { number: o.number, totalPaise: total, paymentStatus: o.paymentStatus } };
    if (b.method === 'RAZORPAY') {
      try {
        const r = await rzp.orders.create({ amount: total, currency: 'INR', receipt: o.number });
        o.rzpOrderId = r.id; await o.save(); out.razorpay = { key: E.RAZORPAY_KEY_ID, orderId: r.id, amount: total };
      } catch (e) { o.status = 'CANCELLED'; o.paymentStatus = 'FAILED'; await o.save(); await release(o); throw Object.assign(new Error('Could not start payment'), { status: 502 }); }
    }
    res.status(201).json(out);
  } catch (e) { next(e); }
});

const Verify = z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() });
app.post('/api/payments/razorpay/verify', async (req, res, next) => {
  try {
    const b = Verify.parse(req.body);
    if (!eq(hmac(E.RAZORPAY_KEY_SECRET || '', b.razorpay_order_id + '|' + b.razorpay_payment_id), b.razorpay_signature)) return res.status(400).json({ error: 'Invalid signature' });
    const o = await Order.findOneAndUpdate({ rzpOrderId: b.razorpay_order_id, status: { $ne: 'CANCELLED' } }, { paymentStatus: 'PAID', rzpPaymentId: b.razorpay_payment_id });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true, number: o.number });
  } catch (e) { next(e); }
});

app.get('/api/orders/track', async (req, res, next) => { // ownership = order number + phone
  try {
    const q = z.object({ number: z.string().max(30), phone: z.string().regex(/^\d{10}$/) }).parse(req.query);
    const o = await Order.findOne({ number: q.number, 'customer.phone': q.phone });
    if (!o) return res.status(404).json({ error: 'Order not found' });
    res.json({ number: o.number, status: o.status, paymentStatus: o.paymentStatus, totalPaise: o.totalPaise, items: o.items, courier: o.courier, trackingNo: o.trackingNo });
  } catch (e) { next(e); }
});

// --- Admin auth (admin is created only by `npm run seed`) ---
app.post('/api/auth/login', rateLimit({ windowMs: 9e5, limit: 10 }), async (req, res, next) => {
  try {
    const b = z.object({ email: z.string().email().max(100), password: z.string().min(1).max(100) }).parse(req.body);
    const u = await User.findOne({ email: b.email.toLowerCase() });
    if (!u || !(await bcrypt.compare(b.password, u.hash))) return res.status(401).json({ error: 'Invalid credentials' });
    res.cookie('t', jwt.sign({ id: u.id, role: u.role }, E.JWT_SECRET, { expiresIn: '8h' }), { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 288e5 });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/auth/logout', (_q, r) => { r.clearCookie('t'); r.json({ ok: true }); });
const admin = (req, res, next) => { try { if (jwt.verify(req.cookies.t || '', E.JWT_SECRET).role !== 'admin') throw 0; next(); } catch { res.status(401).json({ error: 'Unauthorized' }); } };
const oid = (req, res, next) => mongoose.isValidObjectId(req.params.id) ? next() : res.status(400).json({ error: 'Bad id' });

app.get('/api/admin/orders', admin, async (_q, r, n) => { try { r.json(await Order.find().sort('-createdAt').limit(200)); } catch (e) { n(e); } });
app.patch('/api/admin/orders/:id', admin, oid, async (req, res, next) => {
  try {
    const b = z.object({ status: z.enum(['PLACED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED']).optional(), paymentStatus: z.literal('COD_COLLECTED').optional(),
      courier: z.string().max(80).optional(), trackingNo: z.string().max(80).optional() }).parse(req.body);
    const o = await Order.findById(req.params.id); if (!o) return res.status(404).json({ error: 'Not found' });
    if (b.paymentStatus && o.method !== 'COD') return res.status(400).json({ error: 'Only COD orders can be marked collected' });
    if (b.status === 'CANCELLED' && o.paymentStatus === 'PAID') return res.status(400).json({ error: 'Paid order: refund via Razorpay dashboard first' });
    Object.assign(o, b); await o.save(); if (o.status === 'CANCELLED') await release(o); res.json(o);
  } catch (e) { next(e); }
});
app.get('/api/admin/products', admin, async (_q, r, n) => { try { r.json(await Product.find()); } catch (e) { n(e); } });
app.patch('/api/admin/products/:id', admin, oid, async (req, res, next) => {
  try {
    const b = z.object({ pricePaise: z.number().int().min(100).max(1e7).optional(), stock: z.number().int().min(0).max(1e6).optional(), active: z.boolean().optional(), name: z.string().max(120).optional() }).parse(req.body);
    res.json(await Product.findByIdAndUpdate(req.params.id, { $set: b }, { new: true }));
  } catch (e) { next(e); }
});

app.use('/api', (_q, r) => r.status(404).json({ error: 'Not found' }));
app.use((e, _q, res, _n) => {
  if (e.name === 'ZodError') return res.status(400).json({ error: 'Please check the form: ' + e.issues.map(i => i.path.join('.')).join(', ') });
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' });
});

// release reservations of unpaid online orders after 30 minutes
setInterval(async () => {
  try {
    const old = await Order.find({ method: 'RAZORPAY', paymentStatus: { $in: ['UNPAID', 'FAILED'] }, status: { $ne: 'CANCELLED' }, createdAt: { $lt: new Date(Date.now() - 18e5) } });
    for (const o of old) { await Order.updateOne({ _id: o._id, paymentStatus: { $ne: 'PAID' } }, { status: 'CANCELLED', paymentStatus: 'FAILED' }); await release(o); }
  } catch (e) { console.error(e); }
}, 3e5).unref();

mongoose.connect(E.MONGODB_URI).then(() => app.listen(E.PORT || 3000, () => console.log('Shahee store on :' + (E.PORT || 3000)))).catch(e => { console.error(e.message); process.exit(1); });
