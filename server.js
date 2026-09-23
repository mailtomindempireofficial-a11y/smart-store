// Smart Store — خادم ذاتي: API + مزامنة تلقائية + تسويق مجاني
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { searchProducts } = require('./lib/aliexpress');
const { sendCampaign, newProductsHtml, buildSitemap } = require('./lib/marketing');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA = path.join(__dirname, 'data');
const P_FILE = path.join(DATA, 'products.json');
const S_FILE = path.join(DATA, 'subscribers.json');
try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }
const emailOk = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// عرض المنتجات (يضعها المتجر بنفسه بعد المزامنة)
app.get('/api/products', (req, res) => {
  try {
    const items = readJson(P_FILE, []);
    const q = String(req.query.q || '').toLowerCase();
    res.json({ count: items.length, items: q ? items.filter((p) => p.title.toLowerCase().includes(q)) : items });
  } catch (e) { res.status(500).json({ error: 'read-failed' }); }
});

// اشتراك نشرة (التسويق المجاني يعتمد عليها)
app.post('/api/subscribe', (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ error: 'invalid-email' });
    const list = readJson(S_FILE, []);
    if (!list.includes(email)) { list.push(email); writeJson(S_FILE, list); }
    res.json({ ok: true, count: list.length });
  } catch (e) { res.status(500).json({ error: 'subscribe-failed' }); }
});

// مزامنة يدوية + مجدولة: تجلب المنتجات وتسوق لها تلقائياً
app.post('/api/sync', async (req, res) => {
  try {
    const kw = process.env.ALI_KEYWORDS || 'watch';
    const size = Number(process.env.ALI_PAGE_SIZE || 20);
    const { items, mode } = await searchProducts({ keywords: kw, pageSize: size });
    const old = readJson(P_FILE, []);
    const oldIds = new Set(old.map((p) => p.id));
    const fresh = items.filter((p) => !oldIds.has(p.id));
    const merged = [...fresh, ...old].slice(0, 200);
    writeJson(P_FILE, merged);
    let mailed = { sent: 0, reason: 'no-new' };
    if (fresh.length) {
      const subs = readJson(S_FILE, []);
      mailed = await sendCampaign({
        toList: subs,
        subject: `وصل حديثاً: ${fresh.length} منتجات جديدة`,
        html: newProductsHtml(fresh, process.env.STORE_URL || 'http://localhost:3000'),
      });
    }
    res.json({ ok: true, mode, new: fresh.length, total: merged.length, mailed });
  } catch (e) { console.error(e); res.status(500).json({ error: 'sync-failed', detail: e.message }); }
});

app.get('/sitemap.xml', (req, res) => {
  try {
    res.type('text/xml').send(buildSitemap(process.env.STORE_URL || 'http://localhost:3000', readJson(P_FILE, [])));
  } catch { res.status(500).end(); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, mode: (process.env.ALI_APP_KEY ? 'aliexpress' : 'demo') }));

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`Smart-Store on http://localhost:${PORT}`));
  const everyH = Number(process.env.SYNC_EVERY_HOURS || 6);
  setInterval(async () => {
    try {
      const kw = process.env.ALI_KEYWORDS || 'watch';
      const { items } = await searchProducts({ keywords: kw, pageSize: Number(process.env.ALI_PAGE_SIZE || 20) });
      const old = readJson(P_FILE, []);
      const ids = new Set(old.map((p) => p.id));
      const fresh = items.filter((p) => !ids.has(p.id));
      if (fresh.length) {
        writeJson(P_FILE, [...fresh, ...old].slice(0, 200));
        await sendCampaign({ toList: readJson(S_FILE, []), subject: `وصل حديثاً: ${fresh.length} منتجات`, html: newProductsHtml(fresh, process.env.STORE_URL || 'http://localhost:3000') });
        console.log(`[auto-sync] +${fresh.length}`);
      }
    } catch (e) { console.error('[auto-sync-fail]', e.message); }
  }, everyH * 3600 * 1000);
}
module.exports = app;
