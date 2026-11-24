// Vigente — API + servidor web (Node 22+, Express, SQLite nativo)
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const PLANS = {
  starter: { name: 'Starter', limit: 10, price: 0 },
  pro: { name: 'Pro', limit: 200, price: 49, stripePrice: process.env.STRIPE_PRICE_PRO },
  business: { name: 'Business', limit: Infinity, price: 149, stripePrice: process.env.STRIPE_PRICE_BUSINESS },
};

// ---------- Banco ----------
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'vigente.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  company TEXT, password_hash TEXT NOT NULL, plan TEXT DEFAULT 'starter',
  stripe_customer TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS contracts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, party TEXT, category TEXT, value REAL DEFAULT 0,
  start_date TEXT, end_date TEXT NOT NULL, auto_renew INTEGER DEFAULT 0,
  notice_days INTEGER DEFAULT 30, notes TEXT, last_alert TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_contracts_user ON contracts(user_id);`);

// ---------- App ----------
const app = express();

// Webhook do Stripe precisa do corpo bruto (vem antes do express.json)
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = await getStripe();
  if (!stripe) return res.status(501).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook inválido: ${e.message}`); }
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    db.prepare('UPDATE users SET plan=?, stripe_customer=? WHERE id=?')
      .run(obj.metadata.plan, obj.customer, Number(obj.metadata.user_id));
  }
  if (event.type === 'customer.subscription.deleted') {
    db.prepare("UPDATE users SET plan='starter' WHERE stripe_customer=?").run(obj.customer);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sign = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, company: u.company, plan: u.plan });
function auth(req, res, next) {
  try {
    const { id } = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    req.user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!req.user) throw new Error();
    next();
  } catch { res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
}
const bad = (res, msg) => res.status(400).json({ error: msg });

app.get('/api/health', (_q, r) => r.json({ ok: true }));

// ---------- Autenticação ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, company } = req.body || {};
  if (!name || !email || !password) return bad(res, 'Preencha nome, e-mail e senha.');
  if (password.length < 8) return bad(res, 'A senha precisa ter pelo menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase()))
    return bad(res, 'Já existe uma conta com esse e-mail.');
  const info = db.prepare('INSERT INTO users(name,email,company,password_hash) VALUES(?,?,?,?)')
    .run(name.trim(), email.toLowerCase().trim(), company || null, bcrypt.hashSync(password, 10));
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  res.json({ token: sign(u), user: publicUser(u) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return bad(res, 'E-mail ou senha incorretos.');
  res.json({ token: sign(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

// ---------- Contratos ----------
const FIELDS = ['title', 'party', 'category', 'value', 'start_date', 'end_date', 'auto_renew', 'notice_days', 'notes'];
function clean(b) {
  if (!b.title) throw new Error('Dê um nome ao contrato.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '')) throw new Error('Informe a data de término.');
  return FIELDS.map((f) => f === 'auto_renew' ? (b[f] ? 1 : 0)
    : f === 'value' ? Number(b[f]) || 0
    : f === 'notice_days' ? Math.max(0, Number(b[f]) || 30)
    : b[f] ?? null);
}

app.get('/api/contracts', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM contracts WHERE user_id=? ORDER BY end_date').all(req.user.id)));

app.post('/api/contracts', auth, (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) n FROM contracts WHERE user_id=?').get(req.user.id);
  if (n >= PLANS[req.user.plan].limit)
    return res.status(402).json({ error: `Seu plano permite ${PLANS[req.user.plan].limit} contratos. Faça upgrade para adicionar mais.` });
  try {
    const info = db.prepare(`INSERT INTO contracts(user_id,${FIELDS}) VALUES(?,${FIELDS.map(() => '?')})`)
      .run(req.user.id, ...clean(req.body || {}));
    res.json(db.prepare('SELECT * FROM contracts WHERE id=?').get(info.lastInsertRowid));
  } catch (e) { bad(res, e.message); }
});

app.put('/api/contracts/:id', auth, (req, res) => {
  try {
    const r = db.prepare(`UPDATE contracts SET ${FIELDS.map((f) => f + '=?')} WHERE id=? AND user_id=?`)
      .run(...clean(req.body || {}), req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Contrato não encontrado.' });
    res.json(db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id));
  } catch (e) { bad(res, e.message); }
});

app.delete('/api/contracts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM contracts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Assinaturas (Stripe) ----------
let _stripe;
async function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = new (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
app.post('/api/billing/checkout', auth, async (req, res) => {
  const plan = PLANS[req.body?.plan];
  const stripe = await getStripe();
  if (!plan?.stripePrice || !stripe) return res.status(501).json({ error: 'Pagamentos ainda não configurados (defina as chaves do Stripe no .env).' });
  const s = await stripe.checkout.sessions.create({
    mode: 'subscription', customer_email: req.user.email,
    line_items: [{ price: plan.stripePrice, quantity: 1 }],
    metadata: { user_id: String(req.user.id), plan: req.body.plan },
    success_url: `${APP_URL}/#app`, cancel_url: `${APP_URL}/#precos`,
  });
  res.json({ url: s.url });
});

// ---------- Alertas diários ----------
async function sendMail(to, subject, text) {
  if (!process.env.SMTP_HOST) return console.log(`[alerta] para ${to}: ${subject}`);
  const nm = (await import('nodemailer')).default;
  const t = nm.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}
export async function runAlerts(today = new Date()) {
  const iso = today.toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT c.*, u.email, u.name FROM contracts c JOIN users u ON u.id=c.user_id
    WHERE date(c.end_date, '-' || c.notice_days || ' days') <= date(?) AND date(c.end_date) >= date(?)
    AND (c.last_alert IS NULL OR c.last_alert < date(?, '-7 days'))`).all(iso, iso, iso);
  for (const c of rows) {
    const days = Math.round((new Date(c.end_date) - new Date(iso)) / 864e5);
    const verb = c.auto_renew ? 'renova automaticamente' : 'vence';
    await sendMail(c.email, `“${c.title}” ${verb} em ${days} dias`,
      `Olá ${c.name},\n\nO contrato “${c.title}” com ${c.party || 'a outra parte'} ${verb} em ${c.end_date}.\n` +
      `${c.auto_renew ? 'Se não quiser renovar, avise a outra parte antes do prazo de aviso.' : 'Decida agora se vai renovar ou renegociar.'}\n\n${APP_URL}/#app`);
    db.prepare('UPDATE contracts SET last_alert=? WHERE id=?').run(iso, c.id);
  }
  return rows.length;
}
if (process.env.NODE_ENV !== 'test') setInterval(() => runAlerts().catch(console.error), 6 * 36e5);

app.get('*', (_q, r) => r.sendFile(path.join(__dirname, 'public', 'index.html')));
if (process.env.NODE_ENV !== 'test') app.listen(PORT, () => { console.log(`Vigente em ${APP_URL}`); runAlerts(); });
export { app, db };
