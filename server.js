/* load .env if present (local dev) — Render env vars take precedence in prod */
const fs_env = require('fs');
try {
  for (const line of fs_env.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'danilka-secret';
const BOT_TOKEN = process.env.BOT_TOKEN || '';                       // Telegram bot token (Stars payments)
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN || '';         // @CryptoBot API token (crypto payments)
const RUB_PER_STAR = +(process.env.RUB_PER_STAR || 1.4);             // rough rub price of 1 Star
const RUB_USD = +(process.env.RUB_USD || 92);                        // rub per USDT for crypto pricing
const BOT_USERNAME = process.env.BOT_USERNAME || 'danilka_uc_bot';   // for referral links
const REF_BONUS = +(process.env.REF_BONUS || 50);                    // rub credited to referrer

const SESSIONS = new Set();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/app/'));
app.get('/app', (req, res) => res.redirect('/app/'));
app.get('/control-7f3a', (req, res) => res.redirect('/control-7f3a/'));

/* ---------- storage ---------- */
const DB = path.join(__dirname, 'data.json');
let db = { orders: [], balances: {}, pendingCrypto: {}, referrals: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {}
const persist = () => fs.writeFile(DB, JSON.stringify(db), () => {});

/* ---------- telegram initData auth ---------- */
const tgSecret = BOT_TOKEN ? crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest() : null;
function userId(req) {
  const raw = req.headers['x-init-data'];
  if (raw && tgSecret) {
    try {
      const params = new URLSearchParams(raw);
      const hash = params.get('hash');
      params.delete('hash');
      const dataCheckString = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join('\n');
      const calc = crypto.createHmac('sha256', tgSecret).update(dataCheckString).digest('hex');
      if (calc === hash) {
        const u = JSON.parse(params.get('user') || '{}');
        if (u.id) return 'tg' + u.id;
      }
    } catch {}
  }
  return 'guest'; // browser dev fallback (single shared guest account)
}
const bal = id => db.balances[id] || 0;
const credit = (id, rub) => { db.balances[id] = bal(id) + rub; persist(); };

/* ---------- admin auth ---------- */
const adminOnly = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (SESSIONS.has(t)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password.length === ADMIN_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD))) {
    const token = crypto.randomBytes(24).toString('hex');
    SESSIONS.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'wrong password' });
});

app.post('/api/logout', (req, res) => {
  SESSIONS.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

/* ---------- profile / balance ---------- */
app.get('/api/me', (req, res) => {
  const uid = userId(req);
  const code = uid.replace(/^tg/, '');
  const refCount = Object.values(db.referrals).filter(r => r.ref === code).length;
  return res.json({ id: uid, balance: bal(uid), refCode: code, refCount, refEarned: refCount * REF_BONUS, botUsername: BOT_USERNAME });
});

/* register referral (called once when app opened via ?start=refXXX) */
app.post('/api/referral', (req, res) => {
  const uid = userId(req);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!code || uid === 'tg' + code) return res.json({ ok: false });
  if (!db.referrals[uid]) {
    db.referrals[uid] = { ref: code, credited: false };
    persist();
  }
  res.json({ ok: true });
});

/* public shop stats */
app.get('/api/stats', (req, res) => res.json({
  totalOrders: db.orders.length,
  totalDone: db.orders.filter(o => o.status === 'done').length
}));

/* user's own orders */
app.get('/api/my/orders', (req, res) => {
  const uid = userId(req);
  res.json(db.orders.filter(o => o.uid === uid).slice(0, 10));
});

/* ---------- deposits ---------- */
// Telegram Stars invoice
app.post('/api/deposit/stars', async (req, res) => {
  const amount = Math.round(+req.body.amount || 0);
  if (!BOT_TOKEN) return res.status(503).json({ error: 'BOT_TOKEN not configured' });
  if (amount < 50 || amount > 100000) return res.status(400).json({ error: 'amount 50..100000 rub' });
  const uid = userId(req);
  const stars = Math.ceil(amount / RUB_PER_STAR);
  const payload = `dep:${uid}:${amount}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Пополнение баланса',
        description: `${amount.toLocaleString('ru-RU')} ₽ на баланс профиля`,
        payload,
        currency: 'XTR',
        prices: [{ label: `${amount.toLocaleString('ru-RU')} ₽`, amount: stars }],
      })
    });
    const j = await r.json();
    if (!j.ok) return res.status(502).json({ error: j.description || 'invoice failed' });
    res.json({ link: j.result, stars });
  } catch { res.status(502).json({ error: 'telegram api unreachable' }); }
});

// Crypto invoice via @CryptoBot (pay.crypt.bot)
app.post('/api/deposit/crypto', async (req, res) => {
  const amount = Math.round(+req.body.amount || 0);
  const asset = String(req.body.asset || 'USDT').toUpperCase();
  if (!CRYPTO_BOT_TOKEN) return res.status(503).json({ error: 'CRYPTO_BOT_TOKEN not configured' });
  if (amount < 50 || amount > 100000) return res.status(400).json({ error: 'amount 50..100000 rub' });
  if (!['USDT', 'TON', 'BTC', 'ETH'].includes(asset)) return res.status(400).json({ error: 'bad asset' });
  const uid = userId(req);
  const fiat = +(amount / RUB_USD).toFixed(2);
  try {
    const r = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN },
      body: JSON.stringify({
        currency_type: 'fiat', fiat: 'RUB', amount: amount, // fiat invoice, payer chooses asset
        description: `Пополнение ${amount} ₽`,
        payload: `dep:${uid}:${amount}`,
        allow_anonymous: false,
      })
    });
    const j = await r.json();
    if (!j.ok) return res.status(502).json({ error: j.error?.name || 'invoice failed' });
    db.pendingCrypto['c' + j.result.invoice_id] = { uid, amount, asset };
    persist();
    res.json({ invoiceId: j.result.invoice_id, payUrl: j.result.bot_invoice_url || j.result.pay_url });
  } catch { res.status(502).json({ error: 'cryptobot unreachable' }); }
});

// poll crypto invoice status; credit balance when paid
app.get('/api/deposit/crypto/check', async (req, res) => {
  const invoiceId = +req.query.invoice_id;
  const rec = db.pendingCrypto['c' + invoiceId];
  if (!CRYPTO_BOT_TOKEN || !rec) return res.json({ paid: false });
  try {
    const r = await fetch(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${invoiceId}`, {
      headers: { 'Crypto-Pay-API-Token': CRYPTO_BOT_TOKEN }
    });
    const j = await r.json();
    const inv = j?.result?.items?.[0];
    if (inv && inv.status === 'paid') {
      delete db.pendingCrypto['c' + invoiceId];
      credit(rec.uid, rec.amount);
      persist();
      return res.json({ paid: true, credited: rec.amount });
    }
  } catch {}
  res.json({ paid: false });
});

// Telegram bot webhook: Stars successful_payment credits balance
app.post('/api/tg-webhook', (req, res) => {
  const upd = req.body || {};
  if (upd.pre_checkout_query) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: upd.pre_checkout_query.id, ok: true })
    }).catch(() => {});
    return res.json({ ok: true });
  }
  const p = upd.message?.successful_payment;
  if (p) {
    const m = /^dep:(.+):(\d+)$/.exec(p.invoice_payload || '');
    if (m) credit(m[1], +m[2]);
  }
  res.json({ ok: true });
});

/* ---------- orders ---------- */
app.get('/api/orders', (req, res) => res.json(db.orders));

app.post('/api/orders', (req, res) => {
  const { pid, nick, uc, bonus, price, pay, logo } = req.body || {};
  if (!pid || !nick || !uc) return res.status(400).json({ error: 'pid, nick, uc required' });
  const uid = userId(req);
  if (pay === 'Баланс' && bal(uid) < +price) return res.status(402).json({ error: 'insufficient balance' });
  const order = {
    id: 'DUC-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    uid,
    pid: String(pid).slice(0, 32), nick: String(nick).slice(0, 32),
    uc: +uc || 0, bonus: bonus || '', price: +price || 0,
    pay: String(pay || 'Карта').slice(0, 32),
    logo: typeof logo === 'string' && logo.length < 3_000_000 ? logo : null,
    status: 'new', ts: Date.now(),
  };
  if (pay === 'Баланс') { db.balances[uid] = bal(uid) - +price; }
  /* referral bonus: referrer gets REF_BONUS on referred user's first order */
  const refRec = db.referrals[uid];
  if (refRec && !refRec.credited) {
    const referrerId = 'tg' + refRec.ref;
    if (db.balances[referrerId] !== undefined || referrerId !== uid) {
      db.balances[referrerId] = bal(referrerId) + REF_BONUS;
      refRec.credited = true;
    }
  }
  db.orders.unshift(order);
  persist();
  res.json(order);
});

app.patch('/api/orders/:id', adminOnly, (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (['new', 'done'].includes(req.body.status)) o.status = req.body.status;
  persist();
  res.json(o);
});

app.delete('/api/orders/:id', adminOnly, (req, res) => {
  db.orders = db.orders.filter(x => x.id !== req.params.id);
  persist();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('DANILKA UC running on :' + PORT));
