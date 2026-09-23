// Smart Store — خادم ذاتي: API + مزامنة تلقائية + تسويق مجاني
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { searchProducts } = require('./lib/aliexpress');
const { sendCampaign, newProductsHtml, welcomeHtml, postToTelegram, buildSitemap, escHtml } = require('./lib/marketing');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// نبضة تشخيص: تسجل نسخة الصفحة التي يحملها الزائر فعلاً
app.get('/api/ping', (req, res) => {
  try {
    fs.appendFileSync(path.join(DATA, 'views.log'),
      `${new Date().toISOString()} v=${String(req.query.v || '?').slice(0, 20)} ua=${String(req.headers['user-agent'] || '').slice(0, 120)}\n`);
  } catch {}
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const P_FILE = path.join(DATA, 'products.json');
const S_FILE = path.join(DATA, 'subscribers.json');
const R_FILE = path.join(DATA, 'reviews.json');
const C_FILE = path.join(DATA, 'clicks.json');
const SA_FILE = path.join(DATA, 'sales.json');
const AR_FILE = path.join(DATA, 'articles.json');
try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, v) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); }
// حماية: لا تمسح ملفاً موجوداً فيه بيانات لو فشلت القراءة
function readProducts() { try { const d = readGuarded(P_FILE); return Array.isArray(d) ? d : []; } catch { return []; } }
function readGuarded(f) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (f === P_FILE && Array.isArray(d) && !d.length) {
      const b = latestBackup();
      if (b) { fs.copyFileSync(b, f); console.log(`[restore] products from ${path.basename(b)}`); return JSON.parse(fs.readFileSync(f, 'utf8')); }
    }
    return d;
  }
  catch {
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 10) throw new Error('data-unavailable');
      if (f === P_FILE) { const b = latestBackup(); if (b) { fs.copyFileSync(b, f); return JSON.parse(fs.readFileSync(f, 'utf8')); } }
    } catch (e) { if (e.message === 'data-unavailable') throw e; }
    return null;
  }
}
// نسخ احتياطية دوارة لمنتجات المتجر (آخر 3 نسخ)
function latestBackup() {
  for (let i = 1; i <= 3; i++) { const b = path.join(DATA, `products.bak${i}.json`); try { if (fs.existsSync(b)) return b; } catch {} }
  return null;
}
function backupProducts(items) {
  try {
    if (!Array.isArray(items) || !items.length) return;
    for (let i = 3; i > 1; i--) {
      const a = path.join(DATA, `products.bak${i - 1}.json`), c = path.join(DATA, `products.bak${i}.json`);
      if (fs.existsSync(a)) fs.copyFileSync(a, c);
    }
    fs.writeFileSync(path.join(DATA, 'products.bak1.json'), JSON.stringify(items));
  } catch (e) { console.error('backup-fail', e.message); }
}
const emailOk = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const storeUrl = () => (process.env.STORE_URL || 'http://localhost:3000').replace(/\/$/, '');
// تصنيف تلقائي من عنوان المنتج (للفلاتر وروابط SEO)
function categoryOf(p) {
  const t = `${p.title || ''}`.toLowerCase();
  if (/watch|earbud|headphone|speaker|charger|cable|phone|laptop|keyboard|mouse|lamp|led|light/.test(t)) return 'إلكترونيات';
  if (/shirt|dress|shoe|bag|jacket|jean|watch/.test(t)) return 'أزياء';
  if (/cream|lotion|perfume|makeup|beauty|skin/.test(t)) return 'تجميل';
  if (/toy|doll|game|lego/.test(t)) return 'ألعاب';
  if (/chair|table|sofa|kitchen|home|decor/.test(t)) return 'منزل';
  return 'عام';
}
function ratingOf(id, reviews) {
  const list = (reviews || []).filter((r) => r.id === id);
  if (!list.length) return { avg: 0, count: 0 };
  return { avg: Math.round((list.reduce((a, r) => a + r.rating, 0) / list.length) * 10) / 10, count: list.length };
}
function withMeta(items) {
  const reviews = readJson(R_FILE, []);
  return items.map((p) => ({ ...p, category: p.category || categoryOf(p), rating: ratingOf(p.id, reviews) }));
}
// ما يراه الزوار فقط — بدون بيانات العمولة والأرباح (سرية)
function publicProduct(p) {
  const imgs = (Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : [])).slice(0, 20);
  const st = getSettings().store;
  return { id: p.id, title: p.title, price: p.price, oldPrice: p.oldPrice, image: imgs[0] || '', images: imgs, video: p.video || '', category: p.category, rating: p.rating, source: p.source,
    priceDisplay: conv(p.price, st.currency), oldDisplay: p.oldPrice ? conv(p.oldPrice, st.currency) : 0, currency: curCode(st.currency), symbol: sym(st.currency) };
}
const adminOk = (req) => String(req.query.key || req.body?.key || '') === getAdminPass();
function getAdminPass() {
  try {
    const s = JSON.parse(fs.readFileSync(SET_FILE, 'utf8'));
    if (s.adminPass) return String(s.adminPass);
  } catch {}
  return String(process.env.ADMIN_PASS || 'admin123');
}
const commOf = (p) => Number(p.commission ?? process.env.ALI_DEFAULT_COMMISSION ?? 8);
// اللغات والعملات: صندوق للمتجر + صندوق للوحة (مستقلان)
const SET_FILE = path.join(DATA, 'settings.json');
const CURR = {
  USD: { rate: 1, sym: '$' }, EUR: { rate: 0.92, sym: '€' }, GBP: { rate: 0.79, sym: '£' },
  EGP: { rate: 50.8, sym: 'ج.م' }, SAR: { rate: 3.75, sym: 'ر.س' }, AED: { rate: 3.67, sym: 'د.إ' },
};
function getSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SET_FILE, 'utf8'));
    const out = {
      store: { lang: s.store?.lang === 'en' ? 'en' : 'ar', currency: CURR[s.store?.currency] ? s.store.currency : 'USD' },
      admin: { lang: s.admin?.lang === 'en' ? 'en' : 'ar', currency: CURR[s.admin?.currency] ? s.admin.currency : 'USD' },
    };
    if (s.adminPass) out.adminPass = String(s.adminPass);
    return out;
  } catch { return { store: { lang: 'ar', currency: 'USD' }, admin: { lang: 'ar', currency: 'USD' } }; }
}
const curCode = (c) => (CURR[c] ? c : 'USD');
const conv = (usd, code) => Math.round(Number(usd || 0) * CURR[curCode(code)].rate * 100) / 100;
const sym = (code) => CURR[curCode(code)].sym;
// رفع الملفات إلى مجلد البيانات (دائم على الاستضافات المجانية) ويُعرض عبر /uploads
const UP_DIR = path.join(DATA, 'uploads');
try { fs.mkdirSync(UP_DIR, { recursive: true }); } catch {}
try {
  const legacy = path.join(__dirname, 'public', 'uploads');
  if (legacy !== UP_DIR && fs.existsSync(legacy)) {
    fs.readdirSync(legacy).forEach((f) => {
      if (f === '.gitkeep') return;
      const a = path.join(legacy, f), c = path.join(UP_DIR, f);
      try { if (!fs.existsSync(c)) fs.copyFileSync(a, c); } catch {}
    });
  }
} catch {}
app.use('/uploads', express.static(UP_DIR));
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UP_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '').toLowerCase() || '').replace(/[^a-z0-9.]/g, '').slice(0, 8) || '.bin';
    cb(null, `u${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const IMG_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VID_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];
const upImages = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 20 }, fileFilter: (req, f, cb) => cb(null, IMG_MIME.includes(f.mimetype)) }).array('images', 20);
const upVideo = multer({ storage, limits: { fileSize: 80 * 1024 * 1024, files: 1 }, fileFilter: (req, f, cb) => cb(null, VID_MIME.includes(f.mimetype)) }).single('video');
const urlOk = (s) => /^(https?:\/\/|\/uploads\/)/i.test(String(s || '').trim());

// عرض المنتجات مع بحث + تصنيف + ترتيب (تفاعلي حقيقي)
app.get('/api/products', (req, res) => {
  try {
    let items = withMeta(readProducts());
    const q = String(req.query.q || '').toLowerCase().trim();
    const cat = String(req.query.cat || '').trim();
    const sort = String(req.query.sort || 'new');
    if (q) items = items.filter((p) => `${p.title} ${p.category}`.toLowerCase().includes(q));
    if (cat) items = items.filter((p) => p.category === cat);
    if (sort === 'price_asc') items = [...items].sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') items = [...items].sort((a, b) => b.price - a.price);
    else if (sort === 'rating') items = [...items].sort((a, b) => b.rating.avg - a.rating.avg);
    const all = withMeta(readProducts());
    const cats = {};
    all.forEach((p) => { cats[p.category] = (cats[p.category] || 0) + 1; });
    res.json({
      count: items.length, total: all.length, items: items.map(publicProduct),
      categories: Object.entries(cats).map(([name, count]) => ({ name, count })),
    });
  } catch (e) { res.status(500).json({ error: 'read-failed' }); }
});

// اشتراك نشرة + ايميل ترحيب تلقائي (Brevo مجاني 300/يوم بدون بطاقة)
app.post('/api/subscribe', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!emailOk(email)) return res.status(400).json({ error: 'invalid-email' });
    const list = readJson(S_FILE, []);
    const isNew = !list.includes(email);
    if (isNew) {
      list.push(email); writeJson(S_FILE, list);
      sendCampaign({ toList: [email], subject: 'أهلاً بك في متجرك الذكي', html: welcomeHtml(storeUrl()) })
        .catch((e) => console.error('welcome-fail', e.message));
    }
    res.json({ ok: true, count: list.length });
  } catch (e) { res.status(500).json({ error: 'subscribe-failed' }); }
});

// تقييمات العملاء (تبني الثقة وتغذي تقييمات Google)
app.post('/api/reviews', (req, res) => {
  try {
    const id = String(req.body?.id || '');
    const name = String(req.body?.name || 'زائر').slice(0, 40);
    const rating = Number(req.body?.rating);
    const text = String(req.body?.text || '').slice(0, 500);
    if (!id || !(rating >= 1 && rating <= 5) || !text.trim()) return res.status(400).json({ error: 'invalid-review' });
    const all = readJson(R_FILE, []);
    all.push({ id, name: name.trim() || 'زائر', rating, text: text.trim(), at: new Date().toISOString() });
    writeJson(R_FILE, all.slice(-1000));
    res.json({ ok: true, rating: ratingOf(id, all) });
  } catch (e) { res.status(500).json({ error: 'review-failed' }); }
});

// رابط الشراء عبر المتجر: يحسب نقرة ثم يحول لرابط العمولة (تتبع حقيقي)
app.get('/go/:id', (req, res) => {
  try {
    const p = readProducts().find((x) => String(x.id) === String(req.params.id));
    const clicks = readJson(C_FILE, {});
    clicks[String(req.params.id)] = (clicks[String(req.params.id)] || 0) + 1;
    writeJson(C_FILE, clicks);
    let dest = String(p?.url || '/').trim().replace(/[\r\n\t]+/g, '');
    if (!/^https?:\/\//i.test(dest)) dest = '/';
    res.redirect(dest);
  } catch { res.redirect('/'); }
});

// لوحة الإدارة (بكلمة سر): منتجات حقيقية + أرباح
app.get('/admin', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', 'admin.html')));

function stats(code = 'USD') {
  const products = withMeta(readProducts());
  const clicks = readJson(C_FILE, {});
  const sales = readJson(SA_FILE, []);
  let tClicks = 0, tSales = 0, tRevenue = 0, tProfit = 0;
  const rows = products.map((p) => {
    const c = clicks[String(p.id)] || 0;
    const s = sales.filter((x) => String(x.id) === String(p.id));
    const revenue = s.reduce((a, x) => a + Number(x.amount || 0), 0);
    const profit = s.reduce((a, x) => a + Number(x.amount || 0) * Number(x.commission ?? commOf(p)) / 100, 0);
    tClicks += c; tSales += s.length; tRevenue += revenue; tProfit += profit;
    return { id: p.id, title: p.title, price: p.price, commission: commOf(p), clicks: c, sales: s.length, revenue: conv(revenue, code), profit: conv(profit, code) };
  });
  return { rows, totals: { clicks: tClicks, sales: tSales, revenue: conv(tRevenue, code), profit: conv(tProfit, code) }, currency: curCode(code), symbol: sym(code) };
}

app.get('/api/admin/stats', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const code = getSettings().admin.currency;
  res.json({ ok: true, ...stats(code) });
});

// إعدادات اللغة والعملة للجميع (عام) + للإدارة (بكلمة السر)
app.get('/api/settings-public', (req, res) => {
  const s = getSettings();
  res.json({ lang: s.store.lang, dir: s.store.lang === 'en' ? 'ltr' : 'rtl', currency: s.store.currency });
});
app.get('/api/admin/settings', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, ...getSettings(), currencies: Object.keys(CURR) });
});
app.post('/api/admin/settings', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const cur = getSettings();
    for (const scope of ['store', 'admin']) {
      const v = req.body?.[scope];
      if (!v) continue;
      if (v.lang === 'ar' || v.lang === 'en') cur[scope].lang = v.lang;
      if (CURR[v.currency]) cur[scope].currency = v.currency;
    }
    writeJson(SET_FILE, cur);
    res.json({ ok: true, store: cur.store, admin: cur.admin });
  } catch (e) { res.status(500).json({ error: 'save-failed' }); }
});

// تغيير كلمة سر اللوحة من داخل اللوحة
app.post('/api/admin/passwd', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const np = String(req.body?.new || '');
    if (np.length < 6) return res.status(400).json({ error: 'too-short' });
    const cur = getSettings();
    cur.adminPass = np;
    writeJson(SET_FILE, cur);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'save-failed' }); }
});

// نسخة احتياطية كاملة بضغطة (منتجات+مشتركين+تقييمات+مبيعات+إعدادات+مقالات)
app.get('/api/admin/backup', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    res.set('Content-Disposition', `attachment; filename="store-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      at: new Date().toISOString(),
      products: readProducts(), subscribers: readJson(S_FILE, []),
      reviews: readJson(R_FILE, []), clicks: readJson(C_FILE, {}),
      sales: readJson(SA_FILE, []), settings: getSettings(),
      articles: readJson(AR_FILE, []),
    });
  } catch (e) { res.status(500).json({ error: 'backup-failed' }); }
});

// بيانات المنتجات الكاملة للتعديل (للإدارة فقط)
app.get('/api/admin/products', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, items: readProducts() });
});

// رفع صور من الجهاز (حتى 20 صورة، 5MB للصورة)
app.post('/api/admin/upload-images', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  upImages(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload-failed', detail: err.message });
    const files = (req.files || []).filter((f) => f.size > 0);
    if (!files.length) return res.status(400).json({ error: 'no-images' });
    res.json({ ok: true, urls: files.map((f) => `/uploads/${f.filename}`) });
  });
});

// تنظيف ملفات الرفع غير المستخدمة في أي منتج (تحرير مساحة)
app.post('/api/admin/upload-cleanup', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const used = new Set();
    readProducts().forEach((p) => {
      [p.image, ...(Array.isArray(p.images) ? p.images : []), p.video].forEach((u) => {
        const m = String(u || '').match(/^\/uploads\/([^/]+)$/);
        if (m) used.add(m[1]);
      });
    });
    let removed = 0;
    fs.readdirSync(UP_DIR).forEach((f) => {
      if (f === '.gitkeep' || used.has(f)) return;
      try { fs.unlinkSync(path.join(UP_DIR, f)); removed++; } catch {}
    });
    res.json({ ok: true, removed });
  } catch (e) { res.status(500).json({ error: 'cleanup-failed' }); }
});
app.post('/api/admin/upload-video', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  upVideo(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'upload-failed', detail: err.message });
    if (!req.file || !req.file.size) return res.status(400).json({ error: 'no-video' });
    res.json({ ok: true, url: `/uploads/${req.file.filename}` });
  });
});

// إضافة / تعديل منتج حقيقي برابط عمولتك ونسبة ربحك
app.post('/api/admin/product', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id, title, price, oldPrice, image, url, commission } = req.body || {};
    if (!String(title || '').trim() || !(Number(price) > 0) || !urlOk(url)) {
      return res.status(400).json({ error: 'invalid-product' });
    }
    // صور متعددة: روابط أو ملفات مرفوعة (/uploads/...) — سطر لكل رابط (بحد أقصى 8)
    let images = [];
    if (Array.isArray(req.body?.images)) images = req.body.images;
    else if (typeof req.body?.images === 'string') images = req.body.images.split('\n');
    images = images.map((s) => String(s).trim()).filter(urlOk).slice(0, 20);
    let main = String(image || '').trim();
    if (main && !images.includes(main)) images.unshift(main);
    if (!main && images.length) main = images[0];
    const cleanUrl = String(url).trim().replace(/[\r\n\t]+/g, '');
    // فيديو: رابط mp4 مباشر أو يوتيوب أو ملف مرفوع
    const video = String(req.body?.video || '').trim().slice(0, 500);
    if (video && !urlOk(video) && !/(?:youtube\.com\/watch\?v=|youtu\.be\/)/.test(video)) {
      return res.status(400).json({ error: 'invalid-video' });
    }
    const all = readProducts();
    // عملة سعر المنتج: تُدخل بأي عملة ونخزن الأساس بالدولار (لتوحيد الأرباح والتحويل)
    const pcur = curCode(req.body?.priceCur);
    const rate = CURR[pcur].rate;
    const priceUSD = Number(price) / rate;
    const oldUSD = Number(oldPrice) / rate || 0;
    if (!(priceUSD > 0)) return res.status(400).json({ error: 'invalid-product' });
    const item = {
      id: String(id || `my-${Date.now()}`),
      title: String(title).slice(0, 200), price: Math.round(priceUSD * 100) / 100,
      oldPrice: Math.round(oldUSD * 100) / 100, priceCur: pcur,
      image: main, images, video, url: cleanUrl,
      commission: Math.min(100, Math.max(0, Number(commission ?? process.env.ALI_DEFAULT_COMMISSION ?? 8))),
      source: 'manual',
    };
    const i = all.findIndex((x) => String(x.id) === item.id);
    if (i >= 0) all[i] = { ...all[i], ...item }; else all.unshift(item);
    const saved = all.slice(0, 200);
    writeJson(P_FILE, saved); backupProducts(saved);
    res.json({ ok: true, id: item.id });
  } catch (e) { res.status(500).json({ error: 'save-failed' }); }
});

app.post('/api/admin/product/delete', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const cur = readGuarded(P_FILE); if (cur === null) return res.status(500).json({ error: 'no-data' });
    const kept = cur.filter((x) => String(x.id) !== String(req.body?.id));
    writeJson(P_FILE, kept); backupProducts(kept);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message === 'data-unavailable' ? 'data-unavailable' : 'delete-failed' }); }
});

app.post('/api/admin/clear-demo', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const cur = readGuarded(P_FILE); if (cur === null) return res.status(500).json({ error: 'no-data' });
    const kept = cur.filter((x) => x.source === 'manual');
    writeJson(P_FILE, kept); backupProducts(kept);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message === 'data-unavailable' ? 'data-unavailable' : 'clear-failed' }); }
});

// تسجيل عملية بيع مؤكدة (تراها في تقارير AliExpress) لحساب الربح الحقيقي
app.post('/api/admin/sale', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const p = readProducts().find((x) => String(x.id) === String(req.body?.id));
    if (!p) return res.status(404).json({ error: 'no-product' });
    const amount = Number(req.body?.amount ?? p.price);
    if (!(amount > 0)) return res.status(400).json({ error: 'invalid-amount' });
    const all = readJson(SA_FILE, []);
    const entry = { id: String(p.id), amount, commission: commOf(p), at: new Date().toISOString() };
    all.push(entry); writeJson(SA_FILE, all.slice(-5000));
    res.json({ ok: true, profit: Math.round(amount * entry.commission) / 100 });
  } catch (e) { res.status(500).json({ error: 'sale-failed' }); }
});

// النشرة الأسبوعية التلقائية: أحدث المنتجات للمشتركين كل يوم محدد
const META_FILE = path.join(DATA, 'meta.json');
function readMeta() { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } }
function writeMeta(m) { try { writeJson(META_FILE, m); } catch {} }
async function sendDigest(reason) {
  const subs = readJson(S_FILE, []);
  if (!subs.length) return { sent: 0, reason: 'no-subscribers' };
  const items = withMeta(readProducts()).slice(0, Number(process.env.DIGEST_COUNT || 6));
  if (!items.length) return { sent: 0, reason: 'no-products' };
  const mailed = await sendCampaign({
    toList: subs,
    subject: 'تشكيلة الأسبوع الفاخرة من متجرك الذكي',
    html: newProductsHtml(items, storeUrl()),
  });
  const meta = readMeta(); meta.lastDigest = new Date().toISOString().slice(0, 10); writeMeta(meta);
  console.log(`[digest:${reason}] sent=${mailed.sent}`);
  return mailed;
}
app.post('/api/admin/digest', async (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ ok: true, ...(await sendDigest('manual')) });
  } catch (e) { res.status(500).json({ error: 'digest-failed', detail: e.message }); }
});

// المزامنة: تجلب المنتجات وتنشرها وتسوق لها (ايميل + تيليجرام) تلقائياً
async function doSync() {
  const kw = process.env.ALI_KEYWORDS || 'watch';
  const size = Number(process.env.ALI_PAGE_SIZE || 20);
  const { items, mode } = await searchProducts({ keywords: kw, pageSize: size });
  const old = readProducts();
  const oldIds = new Set(old.map((p) => p.id));
  const fresh = items.filter((p) => !oldIds.has(p.id));
  const merged = [...fresh, ...old].slice(0, 200);
  writeJson(P_FILE, merged); backupProducts(merged);
  let mailed = { sent: 0, reason: 'no-new' };
  let telegram = { ok: false, reason: 'no-new' };
  if (fresh.length) {
    const subs = readJson(S_FILE, []);
    mailed = await sendCampaign({
      toList: subs,
      subject: `وصل حديثاً: ${fresh.length} منتجات جديدة`,
      html: newProductsHtml(fresh, storeUrl()),
    });
    telegram = await postToTelegram(fresh, storeUrl());
  }
  return { mode, new: fresh.length, total: merged.length, mailed, telegram };
}

// مزامنة يدوية
app.post('/api/sync', async (req, res) => {
  try {
    res.json({ ok: true, ...(await doSync()) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'sync-failed', detail: e.message }); }
});

app.get('/sitemap.xml', (req, res) => {
  try {
    res.type('text/xml').send(buildSitemap(storeUrl(), readProducts(), readJson(AR_FILE, [])));
  } catch { res.status(500).end(); }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${storeUrl()}/sitemap.xml\n`);
});

// صفحة منتج حقيقية لكل منتج: SEO + structured data تظهر في Google (السعر والتقييم)
app.get('/p/:id', (req, res) => {
  try {
    const id = req.params.id;
    const found = withMeta(readProducts()).find((p) => String(p.id) === String(id));
    if (!found) return res.status(404).type('text/html').send('<h1>المنتج غير موجود</h1><a href="/">عودة للمتجر</a>');
    const p = found;
    const L = getSettings().store;
    const lang = L.lang, dir = lang === 'en' ? 'ltr' : 'rtl';
    const T = lang === 'en'
      ? { back: '← Back to store', buy: 'Buy Now — Exclusive Offer', video: 'Watch the product video', rev: 'Elite reviews', first: 'Be the first to review this masterpiece', name: 'Name', opinion: 'Your elegant opinion...', rate: 'Rate', related: 'You may also like' }
      : { back: '← عودة للمتجر', buy: 'اشترِ الآن — عرض حصري', video: 'شاهد المنتج بالفيديو', rev: 'آراء النخبة', first: 'كن أول من يقيّم هذه التحفة', name: 'اسمك', opinion: 'رأيك الراقي...', rate: 'قيّم', related: 'قد يعجبك أيضاً' };
    const pd = conv(p.price, L.currency), symb = sym(L.currency);
    const all = withMeta(readProducts());
    const related = all.filter((x) => x.id !== p.id && x.category === p.category).slice(0, 4);
    const url = `${storeUrl()}/p/${encodeURIComponent(p.id)}`;
    const reviews = readJson(R_FILE, []).filter((r) => String(r.id) === String(p.id)).slice(-20).reverse();
    const stars = (avg) => '★'.repeat(Math.round(avg)) + '☆'.repeat(Math.max(0, 5 - Math.round(avg)));
    const jsonld = {
      '@context': 'https://schema.org', '@type': 'Product',
      name: p.title, image: [p.image], description: p.title, sku: String(p.id),
      offers: {
        '@type': 'Offer', url: p.url, priceCurrency: 'USD', price: p.price,
        availability: 'https://schema.org/InStock',
      },
    };
    if (p.rating.count > 0) {
      jsonld.aggregateRating = { '@type': 'AggregateRating', ratingValue: p.rating.avg, reviewCount: p.rating.count };
    }
    const share = encodeURIComponent(`${p.title} — $${p.price}`);
    const shareUrl = encodeURIComponent(url);
    // معرض الصور + الفيديو
    const gallery = (Array.isArray(p.images) && p.images.length ? p.images : [p.image]).filter(Boolean).slice(0, 8);
    let videoHtml = '';
    const vid = String(p.video || '');
    const yt = vid.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
    if (yt) videoHtml = `<div class="mt-4"><div class="font-black mb-2">${T.video}</div><iframe class="w-full h-64 rounded-2xl" src="https://www.youtube.com/embed/${yt[1]}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
    else if (urlOk(vid)) videoHtml = `<div class="mt-4"><div class="font-black mb-2">${T.video}</div><video class="w-full rounded-2xl bg-black" controls preload="none" src="${escHtml(vid)}"></video></div>`;
    res.type('text/html').send(`<!doctype html><html lang="${lang}" dir="${dir}" style="background:#0A0A0F"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(p.title)} — ${escHtml(symb)}${escHtml(pd)} | متجري الذكي</title>
<meta name="description" content="${escHtml(p.title)} بسعر ${escHtml(symb)}${escHtml(pd)} — ${escHtml(p.category)}"/>
<link rel="canonical" href="${escHtml(url)}"/>
<meta property="og:title" content="${escHtml(p.title)}"/><meta property="og:image" content="${escHtml(p.image)}"/>
<meta property="og:url" content="${escHtml(url)}"/><meta property="og:type" content="product"/>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Cairo:wght@400;700;900&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com"></script>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>body{font-family:'Cairo',system-ui;background:radial-gradient(900px 400px at 80% 0%,#2a2113,transparent),#0A0A0F;color:#F5F1E6;overflow-x:hidden}img{max-width:100%}.font-amiri{font-family:'Amiri',serif}.gold-text{background:linear-gradient(120deg,#8a6a1c,#D4AF37 35%,#F7E7B0 50%,#D4AF37 65%,#8a6a1c);-webkit-background-clip:text;background-clip:text;color:transparent}.glass{background:rgba(255,255,255,.045);border:1px solid rgba(212,175,55,.22);backdrop-filter:blur(14px)}.gold-btn{background:linear-gradient(135deg,#b8912b,#f3dfa0 50%,#b8912b);color:#241a05;font-weight:900}:focus-visible{outline:2px solid #D4AF37;outline-offset:2px}</style></head>
<body><main class="max-w-3xl mx-auto p-4">
<a href="/" class="text-yellow-200/80">${T.back}</a>
<div class="glass rounded-3xl p-6 mt-3">
<div class="mb-4"><img id="gmain" src="${escHtml(gallery[0] || '')}" class="h-64 w-full object-contain mx-auto rounded-2xl bg-white/95 p-3"/>
${gallery.length > 1 ? `<div class="flex gap-2 mt-2 justify-center flex-wrap">` + gallery.map((g, i) => `<img src="${escHtml(g)}" onclick="document.getElementById('gmain').src=this.src" onmouseover="document.getElementById('gmain').src=this.src" class="h-16 w-16 object-contain rounded-xl bg-white/95 p-1 cursor-pointer border ${i === 0 ? 'border-yellow-500' : 'border-white/20'}"/>`).join('') + `</div>` : ''}</div>
${videoHtml}
<div class="font-amiri text-2xl mb-1">${escHtml(p.title)}</div>
<div class="text-sm opacity-60 mb-2">${escHtml(p.category)} · <span class="text-amber-400">${stars(p.rating.avg)}</span> ${p.rating.avg || ''} (${p.rating.count})</div>
<div class="gold-text font-black text-3xl mb-4">${escHtml(symb)}${escHtml(pd)}</div>
<a href="/go/${encodeURIComponent(p.id)}" target="_blank" rel="nofollow sponsored" class="gold-btn block text-center rounded-full py-3 text-lg">${T.buy}</a>
<div class="flex gap-2 mt-4 text-sm flex-wrap">
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://wa.me/?text=${share}%20${shareUrl}">واتساب</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://t.me/share/url?url=${shareUrl}&text=${share}">تيليجرام</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://twitter.com/intent/tweet?text=${share}&url=${shareUrl}">X</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}">فيسبوك</a>
</div></div>
${related.length ? `<h2 class="font-black mt-6 mb-2 text-lg">${T.related}</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">` + related.map((r) => `<a href="/p/${encodeURIComponent(r.id)}" class="glass rounded-2xl p-2"><img src="${escHtml(r.image)}" class="h-24 w-full object-contain mx-auto rounded-xl bg-white/95 p-1"/><div class="text-xs font-bold h-8 overflow-hidden mt-1">${escHtml(r.title)}</div><div class="gold-text font-black text-sm">${escHtml(sym(L.currency))}${escHtml(conv(r.price, L.currency))}</div></a>`).join('') + `</div>` : ''}
<div class="glass rounded-3xl p-6 mt-6"><h2 class="font-black mb-3">${T.rev} (${p.rating.count})</h2>
<div id="rev">${reviews.map((r) => `<div class="border-b border-white/10 py-2"><b>${escHtml(r.name)}</b> <span class="text-amber-400">${stars(r.rating)}</span><div class="text-sm opacity-80">${escHtml(r.text)}</div></div>`).join('') || `<p class="text-sm opacity-50">${T.first}</p>`}</div>
<div class="flex gap-2 mt-3 flex-wrap"><input id="rn" placeholder="${T.name}" class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl text-sm"/>
<select id="rr" class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl text-sm"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select>
<input id="rt" placeholder="${T.opinion}" class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl flex-1 text-sm"/>
<button onclick="sendRev()" class="gold-btn px-4 py-1.5 rounded-xl text-sm">${T.rate}</button></div></div>
</main>
<div class="md:hidden fixed bottom-0 right-0 left-0 z-50 p-3" style="background:rgba(10,10,15,.92);border-top:1px solid rgba(212,175,55,.35)">
<div class="flex gap-2 items-center max-w-3xl mx-auto">
<div class="gold-text font-black text-xl whitespace-nowrap">${escHtml(symb)}${escHtml(pd)}</div>
<a href="/go/${encodeURIComponent(p.id)}" target="_blank" rel="nofollow sponsored" class="gold-btn flex-1 text-center rounded-full py-2.5 font-black">${T.buy}</a>
</div></div>
<div class="h-20 md:hidden"></div>
<script>async function sendRev(){const r=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(p.id)},name:document.getElementById('rn').value,rating:document.getElementById('rr').value,text:document.getElementById('rt').value})});if(r.ok)location.reload();else alert('اكتب تقييماً صحيحاً');}</script>
</body></html>`);
  } catch (e) { res.status(500).type('text/html').send('خطأ داخلي'); }
});

// المدونة: مقالات SEO تجلب زواراً مجانيين من Google
const blogPage = (lang, dir, title, desc, body, jsonld) => `<!doctype html><html lang="${lang}" dir="${dir}" style="background:#0A0A0F"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} | متجري الذكي</title>
<meta name="description" content="${desc}"/>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Cairo:wght@400;700;900&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com"></script>
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
<style>body{font-family:'Cairo',system-ui;background:#0A0A0F;color:#F5F1E6}.font-amiri{font-family:'Amiri',serif}.gold-text{background:linear-gradient(120deg,#8a6a1c,#D4AF37 35%,#F7E7B0 50%,#D4AF37 65%,#8a6a1c);-webkit-background-clip:text;background-clip:text;color:transparent}.glass{background:rgba(255,255,255,.045);border:1px solid rgba(212,175,55,.22)}.gold-btn{background:linear-gradient(135deg,#b8912b,#f3dfa0 50%,#b8912b);color:#241a05;font-weight:900}.article-body p{margin:.8em 0;line-height:2}.article-body h2{font-weight:900;margin:1.2em 0 .5em;font-size:1.25rem}.article-body a{color:#F3DFA0;text-decoration:underline}</style></head>
<body><main class="max-w-3xl mx-auto p-4"><a href="/" class="text-yellow-200/80">← متجري الذكي</a>${body}</main></body></html>`;

app.get('/blog', (req, res) => {
  try {
    const L = getSettings().store;
    const arts = readJson(AR_FILE, []).slice().reverse();
    const body = `<h1 class="font-amiri text-4xl mt-4 mb-1">مدونة <span class="gold-text">النخبة</span></h1>
    <p class="opacity-60 text-sm mb-6">أدلة ونصائح التسوق الذكي — تُحدَّث باستمرار</p>` +
    (arts.map((a) => `<a href="/blog/${encodeURIComponent(a.slug)}" class="glass rounded-2xl p-5 mb-3 block">
      <div class="font-black text-lg">${escHtml(a.title)}</div>
      <div class="text-sm opacity-60 mt-1">${escHtml(a.excerpt || '')}</div></a>`).join('') || '<p class="opacity-60">قريباً: أول المقالات</p>');
    res.type('text/html').send(blogPage(L.lang, L.lang === 'en' ? 'ltr' : 'rtl', 'المدونة', 'مقالات وأدلة التسوق الذكي', body));
  } catch (e) { res.status(500).type('text/html').send('خطأ داخلي'); }
});

app.get('/blog/:slug', (req, res) => {
  try {
    const L = getSettings().store;
    const a = readJson(AR_FILE, []).find((x) => String(x.slug) === String(req.params.slug));
    if (!a) return res.status(404).type('text/html').send('<h1>المقال غير موجود</h1><a href="/blog">المدونة</a>');
    const url = `${storeUrl()}/blog/${encodeURIComponent(a.slug)}`;
    const rel = withMeta(readProducts()).slice(0, 4);
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.excerpt || '', datePublished: a.at, mainEntityOfPage: url });
    const body = `<article class="glass rounded-3xl p-6 mt-4"><h1 class="font-amiri text-3xl mb-2">${escHtml(a.title)}</h1>
    <div class="text-xs opacity-50 mb-4">${escHtml((a.at || '').slice(0, 10))}</div>
    <div class="article-body">${a.body || ''}</div></article>
    ${rel.length ? `<h2 class="font-black mt-6 mb-2">تسوق منتجاتنا</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">` + rel.map((r) => `<a href="/p/${encodeURIComponent(r.id)}" class="glass rounded-2xl p-2"><img src="${escHtml(r.image)}" class="h-24 w-full object-contain mx-auto rounded-xl bg-white/95 p-1"/><div class="text-xs font-bold h-8 overflow-hidden mt-1">${escHtml(r.title)}</div></a>`).join('') + `</div>` : ''}`;
    res.type('text/html').send(blogPage(L.lang, L.lang === 'en' ? 'ltr' : 'rtl', a.title, a.excerpt || a.title, body, jsonld));
  } catch (e) { res.status(500).type('text/html').send('خطأ داخلي'); }
});

// إدارة المقالات
app.get('/api/admin/articles', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, items: readJson(AR_FILE, []) });
});
app.post('/api/admin/article', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id, slug, title, excerpt, body } = req.body || {};
    if (!String(title || '').trim() || !String(body || '').trim()) return res.status(400).json({ error: 'invalid-article' });
    const all = readJson(AR_FILE, []);
    const item = {
      id: String(id || `ar-${Date.now()}`),
      slug: String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `a-${Date.now()}`,
      title: String(title).slice(0, 200), excerpt: String(excerpt || '').slice(0, 300),
      body: String(body).slice(0, 20000), at: new Date().toISOString(),
    };
    if (all.some((x) => x.slug === item.slug && x.id !== item.id)) return res.status(400).json({ error: 'slug-taken' });
    const i = all.findIndex((x) => String(x.id) === item.id);
    if (i >= 0) { item.at = all[i].at; all[i] = item; } else all.push(item);
    writeJson(AR_FILE, all.slice(-200));
    res.json({ ok: true, id: item.id });
  } catch (e) { res.status(500).json({ error: 'save-failed' }); }
});
app.post('/api/admin/article/delete', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    writeJson(AR_FILE, readJson(AR_FILE, []).filter((x) => String(x.id) !== String(req.body?.id)));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete-failed' }); }
});

app.get('/api/health', (req, res) => res.json({
  ok: true, boot: BOOT, code: CODEV, mode: (process.env.ALI_APP_KEY ? 'aliexpress' : 'demo'),
  products: readProducts().length, subscribers: readJson(S_FILE, []).length,
  mail: process.env.BREVO_API_KEY ? 'brevo' : (process.env.SMTP_USER ? 'smtp' : 'off'),
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
}));

const PORT = Number(process.env.PORT || 3000);
const BOOT = new Date().toISOString().slice(0, 16).replace('T', ' ');
// نسخة الكود من git — تتغير مع كل تحديث تلقائياً ليعمل شريط التحديث
const CODEV = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim() || 'dev'; } catch { return 'dev'; } })();
if (require.main === module) {
  app.listen(PORT, () => console.log(`Smart-Store on http://localhost:${PORT}`));
  const everyH = Number(process.env.SYNC_EVERY_HOURS || 6);
  const autoOff = String(process.env.AUTO_SYNC || 'on').toLowerCase() === 'off';
  if (!autoOff) setInterval(async () => {
    try {
      const r = await doSync();
      if (r.new) console.log(`[auto-sync] +${r.new} mail=${r.mailed.sent} tg=${r.telegram.ok}`);
    } catch (e) { console.error('[auto-sync-fail]', e.message); }
  }, everyH * 3600 * 1000);
  // فحص النشرة الأسبوعية كل ساعة (اليوم الافتراضي: الجمعة)
  const digestDay = Number(process.env.DIGEST_DAY ?? 5);
  setInterval(async () => {
    try {
      const now = new Date();
      const meta = readMeta();
      const today = now.toISOString().slice(0, 10);
      if (now.getDay() === digestDay && meta.lastDigest !== today) await sendDigest('weekly');
    } catch (e) { console.error('[digest-fail]', e.message); }
  }, 3600 * 1000);
}
module.exports = app;
