// تسويق ذاتي مجاني: نشرة ايميل + Sitemap + حملة منتجات جديدة
const nodemailer = require('nodemailer');

function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null; // وضع معاينة بدون إرسال
  return nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendCampaign({ toList, subject, html }) {
  if (!Array.isArray(toList) || !toList.length) return { sent: 0, reason: 'no-subscribers' };
  const t = mailer();
  if (!t) {
    console.log(`[PREVIEW-EMAIL] to=${toList.length} subject=${subject}`);
    return { sent: 0, reason: 'smtp-not-configured-preview-only' };
  }
  let sent = 0;
  for (const to of toList) {
    try {
      await t.sendMail({ from: process.env.SMTP_USER, to, subject, html });
      sent++;
    } catch (e) { console.error('mail-fail', to, e.message); }
  }
  return { sent };
}

function newProductsHtml(items, storeUrl) {
  const cards = items.slice(0, 6).map((p) => `
    <div style="border:1px solid #eee;border-radius:12px;padding:12px;margin:8px 0">
      <img src="${p.image}" width="120" style="border-radius:8px"/><br/>
      <b>${p.title}</b><br/>$${p.price}
      <br/><a href="${p.url}" target="_blank">اشترِ الآن</a>
    </div>`).join('');
  return `<div dir="rtl"><h2>وصل حديثاً في متجرك الذكي</h2>${cards}<br/><a href="${storeUrl}">تسوق كل المنتجات</a></div>`;
}

function buildSitemap(storeUrl, items) {
  const urls = ['', '/sitemap.xml', ...items.map((p) => `/p/${encodeURIComponent(p.id)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    urls.map((u) => `<url><loc>${storeUrl}${u}</loc></url>`).join('') + `</urlset>`;
}

module.exports = { sendCampaign, newProductsHtml, buildSitemap };
