// Smart Store — خادم ذاتي: API + مزامنة تلقائية + تسويق مجاني
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { searchProducts } = require('./lib/aliexpress');
const { sendCampaign, newProductsHtml, welcomeHtml, postToTelegram, buildSitemap, escHtml } = require('./lib/marketing');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA = path.join(__dirname, 'data');
const P_FILE = path.join(DATA, 'products.json');
const S_FILE = path.join(DATA, 'subscribers.json');
const R_FILE = path.join(DATA, 'reviews.json');
const C_FILE = path.join(DATA, 'clicks.json');
const SA_FILE = path.join(DATA, 'sales.json');
try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }
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
  return { id: p.id, title: p.title, price: p.price, oldPrice: p.oldPrice, image: p.image, category: p.category, rating: p.rating, source: p.source };
}
const adminOk = (req) => String(req.query.key || req.body?.key || '') === String(process.env.ADMIN_PASS || 'admin123');
const commOf = (p) => Number(p.commission ?? process.env.ALI_DEFAULT_COMMISSION ?? 8);

// عرض المنتجات مع بحث + تصنيف + ترتيب (تفاعلي حقيقي)
app.get('/api/products', (req, res) => {
  try {
    let items = withMeta(readJson(P_FILE, []));
    const q = String(req.query.q || '').toLowerCase().trim();
    const cat = String(req.query.cat || '').trim();
    const sort = String(req.query.sort || 'new');
    if (q) items = items.filter((p) => `${p.title} ${p.category}`.toLowerCase().includes(q));
    if (cat) items = items.filter((p) => p.category === cat);
    if (sort === 'price_asc') items = [...items].sort((a, b) => a.price - b.price);
    else if (sort === 'price_desc') items = [...items].sort((a, b) => b.price - a.price);
    else if (sort === 'rating') items = [...items].sort((a, b) => b.rating.avg - a.rating.avg);
    const all = withMeta(readJson(P_FILE, []));
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
    const p = readJson(P_FILE, []).find((x) => String(x.id) === String(req.params.id));
    const clicks = readJson(C_FILE, {});
    clicks[String(req.params.id)] = (clicks[String(req.params.id)] || 0) + 1;
    writeJson(C_FILE, clicks);
    let dest = p?.url || '/';
    if (!/^https?:\/\//i.test(dest)) dest = '/';
    res.redirect(dest);
  } catch { res.redirect('/'); }
});

// لوحة الإدارة (بكلمة سر): منتجات حقيقية + أرباح
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

function stats() {
  const products = withMeta(readJson(P_FILE, []));
  const clicks = readJson(C_FILE, {});
  const sales = readJson(SA_FILE, []);
  let tClicks = 0, tSales = 0, tRevenue = 0, tProfit = 0;
  const rows = products.map((p) => {
    const c = clicks[String(p.id)] || 0;
    const s = sales.filter((x) => String(x.id) === String(p.id));
    const revenue = s.reduce((a, x) => a + Number(x.amount || 0), 0);
    const profit = s.reduce((a, x) => a + Number(x.amount || 0) * Number(x.commission ?? commOf(p)) / 100, 0);
    tClicks += c; tSales += s.length; tRevenue += revenue; tProfit += profit;
    return { id: p.id, title: p.title, price: p.price, commission: commOf(p), clicks: c, sales: s.length, revenue: Math.round(revenue * 100) / 100, profit: Math.round(profit * 100) / 100 };
  });
  return { rows, totals: { clicks: tClicks, sales: tSales, revenue: Math.round(tRevenue * 100) / 100, profit: Math.round(tProfit * 100) / 100 } };
}

app.get('/api/admin/stats', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, ...stats() });
});

// إضافة / تعديل منتج حقيقي برابط عمولتك ونسبة ربحك
app.post('/api/admin/product', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id, title, price, oldPrice, image, url, commission } = req.body || {};
    if (!String(title || '').trim() || !(Number(price) > 0) || !/^https?:\/\//i.test(String(url || ''))) {
      return res.status(400).json({ error: 'invalid-product' });
    }
    const all = readJson(P_FILE, []);
    const item = {
      id: String(id || `my-${Date.now()}`),
      title: String(title).slice(0, 200), price: Number(price),
      oldPrice: Number(oldPrice) || 0, image: String(image || ''), url: String(url),
      commission: Math.min(100, Math.max(0, Number(commission ?? process.env.ALI_DEFAULT_COMMISSION ?? 8))),
      source: 'manual',
    };
    const i = all.findIndex((x) => String(x.id) === item.id);
    if (i >= 0) all[i] = { ...all[i], ...item }; else all.unshift(item);
    writeJson(P_FILE, all.slice(0, 200));
    res.json({ ok: true, id: item.id });
  } catch (e) { res.status(500).json({ error: 'save-failed' }); }
});

app.post('/api/admin/product/delete', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    writeJson(P_FILE, readJson(P_FILE, []).filter((x) => String(x.id) !== String(req.body?.id)));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete-failed' }); }
});

app.post('/api/admin/clear-demo', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    writeJson(P_FILE, readJson(P_FILE, []).filter((x) => x.source === 'manual'));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'clear-failed' }); }
});

// تسجيل عملية بيع مؤكدة (تراها في تقارير AliExpress) لحساب الربح الحقيقي
app.post('/api/admin/sale', (req, res) => {
  try {
    if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const p = readJson(P_FILE, []).find((x) => String(x.id) === String(req.body?.id));
    if (!p) return res.status(404).json({ error: 'no-product' });
    const amount = Number(req.body?.amount ?? p.price);
    if (!(amount > 0)) return res.status(400).json({ error: 'invalid-amount' });
    const all = readJson(SA_FILE, []);
    const entry = { id: String(p.id), amount, commission: commOf(p), at: new Date().toISOString() };
    all.push(entry); writeJson(SA_FILE, all.slice(-5000));
    res.json({ ok: true, profit: Math.round(amount * entry.commission) / 100 });
  } catch (e) { res.status(500).json({ error: 'sale-failed' }); }
});

// المزامنة: تجلب المنتجات وتنشرها وتسوق لها (ايميل + تيليجرام) تلقائياً
async function doSync() {
  const kw = process.env.ALI_KEYWORDS || 'watch';
  const size = Number(process.env.ALI_PAGE_SIZE || 20);
  const { items, mode } = await searchProducts({ keywords: kw, pageSize: size });
  const old = readJson(P_FILE, []);
  const oldIds = new Set(old.map((p) => p.id));
  const fresh = items.filter((p) => !oldIds.has(p.id));
  const merged = [...fresh, ...old].slice(0, 200);
  writeJson(P_FILE, merged);
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
    res.type('text/xml').send(buildSitemap(storeUrl(), readJson(P_FILE, [])));
  } catch { res.status(500).end(); }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${storeUrl()}/sitemap.xml\n`);
});

// صفحة منتج حقيقية لكل منتج: SEO + structured data تظهر في Google (السعر والتقييم)
app.get('/p/:id', (req, res) => {
  try {
    const id = req.params.id;
    const found = withMeta(readJson(P_FILE, [])).find((p) => String(p.id) === String(id));
    if (!found) return res.status(404).type('text/html').send('<h1>المنتج غير موجود</h1><a href="/">عودة للمتجر</a>');
    const p = found;
    const all = withMeta(readJson(P_FILE, []));
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
    res.type('text/html').send(`<!doctype html><html lang="ar" dir="rtl" style="background:#0A0A0F"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(p.title)} — $${escHtml(p.price)} | متجري الذكي</title>
<meta name="description" content="${escHtml(p.title)} بسعر $${escHtml(p.price)} — ${escHtml(p.category)}"/>
<link rel="canonical" href="${escHtml(url)}"/>
<meta property="og:title" content="${escHtml(p.title)}"/><meta property="og:image" content="${escHtml(p.image)}"/>
<meta property="og:url" content="${escHtml(url)}"/><meta property="og:type" content="product"/>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Cairo:wght@400;700;900&display=swap" rel="stylesheet"/>
<script src="https://cdn.tailwindcss.com"></script>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>body{font-family:'Cairo',system-ui;background:radial-gradient(900px 400px at 80% 0%,#2a2113,transparent),#0A0A0F;color:#F5F1E6}.font-amiri{font-family:'Amiri',serif}.gold-text{background:linear-gradient(120deg,#8a6a1c,#D4AF37 35%,#F7E7B0 50%,#D4AF37 65%,#8a6a1c);-webkit-background-clip:text;background-clip:text;color:transparent}.glass{background:rgba(255,255,255,.045);border:1px solid rgba(212,175,55,.22);backdrop-filter:blur(14px)}.gold-btn{background:linear-gradient(135deg,#b8912b,#f3dfa0 50%,#b8912b);color:#241a05;font-weight:900}:focus-visible{outline:2px solid #D4AF37;outline-offset:2px}</style></head>
<body><main class="max-w-3xl mx-auto p-4">
<a href="/" class="text-yellow-200/80">← عودة للمتجر</a>
<div class="glass rounded-3xl p-6 mt-3">
<img src="${escHtml(p.image)}" class="h-64 w-full object-contain mx-auto mb-4 rounded-2xl bg-white/95 p-3"/>
<div class="font-amiri text-2xl mb-1">${escHtml(p.title)}</div>
<div class="text-sm opacity-60 mb-2">${escHtml(p.category)} · <span class="text-amber-400">${stars(p.rating.avg)}</span> ${p.rating.avg || ''} (${p.rating.count})</div>
<div class="gold-text font-black text-3xl mb-4">$${escHtml(p.price)}</div>
<a href="/go/${encodeURIComponent(p.id)}" target="_blank" rel="nofollow sponsored" class="gold-btn block text-center rounded-full py-3 text-lg">اشترِ الآن — عرض حصري</a>
<div class="flex gap-2 mt-4 text-sm flex-wrap">
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://wa.me/?text=${share}%20${shareUrl}">واتساب</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://t.me/share/url?url=${shareUrl}&text=${share}">تيليجرام</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://twitter.com/intent/tweet?text=${share}&url=${shareUrl}">X</a>
<a class="border border-white/20 px-3 py-1.5 rounded-full" target="_blank" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}">فيسبوك</a>
</div></div>
${related.length ? `<h2 class="font-black mt-6 mb-2 text-lg">قد يعجبك أيضاً</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">` + related.map((r) => `<a href="/p/${encodeURIComponent(r.id)}" class="glass rounded-2xl p-2"><img src="${escHtml(r.image)}" class="h-24 w-full object-contain mx-auto rounded-xl bg-white/95 p-1"/><div class="text-xs font-bold h-8 overflow-hidden mt-1">${escHtml(r.title)}</div><div class="gold-text font-black text-sm">$${escHtml(r.price)}</div></a>`).join('') + `</div>` : ''}
<div class="glass rounded-3xl p-6 mt-6"><h2 class="font-black mb-3">آراء النخبة (${p.rating.count})</h2>
<div id="rev">${reviews.map((r) => `<div class="border-b border-white/10 py-2"><b>${escHtml(r.name)}</b> <span class="text-amber-400">${stars(r.rating)}</span><div class="text-sm opacity-80">${escHtml(r.text)}</div></div>`).join('') || '<p class="text-sm opacity-50">كن أول من يقيّم هذه التحفة</p>'}</div>
<div class="flex gap-2 mt-3 flex-wrap"><input id="rn" placeholder="اسمك" class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl text-sm"/>
<select id="rr" class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl text-sm"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select>
<input id="rt" placeholder="رأيك الراقي..." class="bg-white/10 border border-yellow-700/40 px-2 py-1.5 rounded-xl flex-1 text-sm"/>
<button onclick="sendRev()" class="gold-btn px-4 py-1.5 rounded-xl text-sm">قيّم</button></div></div>
</main><script>async function sendRev(){const r=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:${JSON.stringify(p.id)},name:document.getElementById('rn').value,rating:document.getElementById('rr').value,text:document.getElementById('rt').value})});if(r.ok)location.reload();else alert('اكتب تقييماً صحيحاً');}</script>
</body></html>`);
  } catch (e) { res.status(500).type('text/html').send('خطأ داخلي'); }
});

app.get('/api/health', (req, res) => res.json({
  ok: true, mode: (process.env.ALI_APP_KEY ? 'aliexpress' : 'demo'),
  products: readJson(P_FILE, []).length, subscribers: readJson(S_FILE, []).length,
  mail: process.env.BREVO_API_KEY ? 'brevo' : (process.env.SMTP_USER ? 'smtp' : 'off'),
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
}));

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`Smart-Store on http://localhost:${PORT}`));
  const everyH = Number(process.env.SYNC_EVERY_HOURS || 6);
  setInterval(async () => {
    try {
      const r = await doSync();
      if (r.new) console.log(`[auto-sync] +${r.new} mail=${r.mailed.sent} tg=${r.telegram.ok}`);
    } catch (e) { console.error('[auto-sync-fail]', e.message); }
  }, everyH * 3600 * 1000);
}
module.exports = app;
