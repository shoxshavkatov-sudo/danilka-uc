const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// admin password from env (set in Render dashboard)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'danilka-secret';
const SESSIONS = new Set(); // active admin tokens (in-memory)

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/app/'));
app.get('/app', (req, res) => res.redirect('/app/'));
app.get('/control-7f3a', (req, res) => res.redirect('/control-7f3a/'));

/* ---------- order storage (JSON file) ---------- */
const DB = path.join(__dirname, 'data.json');
let orders = [];
try { orders = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}

const persist = () => fs.writeFile(DB, JSON.stringify(orders), () => {});
const adminOnly = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (SESSIONS.has(t)) return next();
  res.status(401).json({ error: 'unauthorized' });
};

/* ---------- auth ---------- */
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  // simple timing-safe-ish compare
  if (password && password.length === ADMIN_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD))) {
    const token = crypto.randomBytes(24).toString('hex');
    SESSIONS.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'wrong password' });
});

app.post('/api/logout', (req, res) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  SESSIONS.delete(t);
  res.json({ ok: true });
});

/* ---------- orders ---------- */
// public: create + read own list (single-user shop — same feed)
app.get('/api/orders', (req, res) => res.json(orders));

app.post('/api/orders', (req, res) => {
  const { pid, nick, uc, bonus, price, pay, logo } = req.body || {};
  if (!pid || !nick || !uc) return res.status(400).json({ error: 'pid, nick, uc required' });
  const order = {
    id: 'DUC-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    pid: String(pid).slice(0, 32), nick: String(nick).slice(0, 32),
    uc: +uc || 0, bonus: bonus || '', price: +price || 0,
    pay: String(pay || 'Карта').slice(0, 32),
    logo: typeof logo === 'string' && logo.length < 3_000_000 ? logo : null,
    status: 'new', ts: Date.now(),
  };
  orders.unshift(order);
  persist();
  res.json(order);
});

// admin only: update status / delete
app.patch('/api/orders/:id', adminOnly, (req, res) => {
  const o = orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (['new', 'done'].includes(req.body.status)) o.status = req.body.status;
  persist();
  res.json(o);
});

app.delete('/api/orders/:id', adminOnly, (req, res) => {
  orders = orders.filter(x => x.id !== req.params.id);
  persist();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('DANILKA UC running on :' + PORT));
