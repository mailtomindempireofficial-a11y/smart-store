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
  return items.map((p) => ({ ...p, category: categoryOf(p), rating: ratingOf(p.id, reviews) }));
}

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
      count: items.length, total: all.length, items,
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
    res.type('text/html').send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(p.title)} — $${escHtml(p.price)} | متجري الذكي</title>
<meta name="description" content="${escHtml(p.title)} بسعر $${escHtml(p.price)} — ${escHtml(p.category)}"/>
<link rel="canonical" href="${escHtml(url)}"/>
<meta property="og:title" content="${escHtml(p.title)}"/><meta property="og:image" content="${escHtml(p.image)}"/>
<meta property="og:url" content="${escHtml(url)}"/><meta property="og:type" content="product"/>
<script src="https://cdn.tailwindcss.com"></script>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script></head>
<body class="bg-slate-50"><main class="max-w-3xl mx-auto p-4">
<a href="/" class="text-blue-600">← عودة للمتجر</a>
<div class="bg-white rounded-xl shadow p-6 mt-3">
<img src="${escHtml(p.image)}" class="h-64 object-contain mx-auto mb-4"/>
<h1 class="font-bold text-xl mb-1">${escHtml(p.title)}</h1>
<div class="text-sm text-slate-500 mb-2">${escHtml(p.category)} · <span class="text-amber-500">${stars(p.rating.avg)}</span> ${p.rating.avg || ''} (${p.rating.count})</div>
<div class="text-emerald-600 font-bold text-2xl mb-4">$${escHtml(p.price)}</div>
<a href="${escHtml(p.url)}" target="_blank" rel="nofollow sponsored" class="block text-center bg-orange-500 text-white rounded py-2 font-bold">اشترِ الآن</a>
<div class="flex gap-2 mt-3 text-sm">
<a class="bg-green-500 text-white px-3 py-1 rounded" target="_blank" href="https://wa.me/?text=${share}%20${shareUrl}">واتساب</a>
<a class="bg-sky-500 text-white px-3 py-1 rounded" target="_blank" href="https://t.me/share/url?url=${shareUrl}&text=${share}">تيليجرام</a>
<a class="bg-slate-800 text-white px-3 py-1 rounded" target="_blank" href="https://twitter.com/intent/tweet?text=${share}&url=${shareUrl}">X</a>
<a class="bg-blue-600 text-white px-3 py-1 rounded" target="_blank" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}">فيسبوك</a>
</div></div>
${related.length ? `<h2 class="font-bold mt-6 mb-2">منتجات مشابهة</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-3">` + related.map((r) => `<a href="/p/${encodeURIComponent(r.id)}" class="bg-white rounded shadow p-2"><img src="${escHtml(r.image)}" class="h-24 object-contain mx-auto"/><div class="text-xs font-bold h-8 overflow-hidden">${escHtml(r.title)}</div><div class="text-emerald-600 font-bold text-sm">$${escHtml(r.price)}</div></a>`).join('') + `</div>` : ''}
<div class="bg-white rounded-xl shadow p-6 mt-6"><h2 class="font-bold mb-3">التقييمات (${p.rating.count})</h2>
<div id="rev">${reviews.map((r) => `<div class="border-b py-2"><b>${escHtml(r.name)}</b> <span class="text-amber-500">${stars(r.rating)}</span><div class="text-sm">${escHtml(r.text)}</div></div>`).join('') || '<p class="text-sm text-slate-500">كن أول من يقيّم هذا المنتج</p>'}</div>
<div class="flex gap-2 mt-3 flex-wrap"><input id="rn" placeholder="اسمك" class="border px-2 py-1 rounded"/>
<select id="rr" class="border px-2 py-1 rounded"><option value="5">5 ★</option><option value="4">4 ★</option><option value="3">3 ★</option><option value="2">2 ★</option><option value="1">1 ★</option></select>
<input id="rt" placeholder="رأيك..." class="border px-2 py-1 rounded flex-1"/>
<button onclick="sendRev()" class="bg-blue-600 text-white px-3 py-1 rounded">قيّم</button></div></div>
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
