// تسويق ذاتي مجاني وحقيقي: Brevo (300 ايميل/يوم مجاناً بدون بطاقة) + SMTP + تيليجرام + Sitemap
const nodemailer = require('nodemailer');

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function smtpMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// إرسال عبر Brevo REST API — مجاني 300/يوم وبدون بطاقة بنكية
async function sendViaBrevo({ toList, subject, html }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return null;
  const sender = process.env.BREVO_SENDER || process.env.SMTP_USER || 'store@localhost';
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify({
      sender: { email: sender, name: 'متجري الذكي' },
      to: toList.map((email) => ({ email })),
      subject, htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`brevo-http-${res.status}`);
  return true;
}

async function sendCampaign({ toList, subject, html }) {
  if (!Array.isArray(toList) || !toList.length) return { sent: 0, reason: 'no-subscribers' };
  try {
    if (process.env.BREVO_API_KEY) {
      // Brevo يقبل حتى 1000 مستلم في الطلب الواحد
      for (let i = 0; i < toList.length; i += 1000) {
        await sendViaBrevo({ toList: toList.slice(i, i + 1000), subject, html });
      }
      return { sent: toList.length, via: 'brevo' };
    }
    const t = smtpMailer();
    if (!t) {
      console.log(`[PREVIEW-EMAIL] to=${toList.length} subject=${subject}`);
      return { sent: 0, reason: 'no-mail-provider-preview-only' };
    }
    let sent = 0;
    for (const to of toList) {
      try { await t.sendMail({ from: process.env.SMTP_USER, to, subject, html }); sent++; }
      catch (e) { console.error('mail-fail', to, e.message); }
    }
    return { sent, via: 'smtp' };
  } catch (e) {
    console.error('campaign-fail', e.message);
    return { sent: 0, reason: e.message };
  }
}

function productLink(storeUrl, p) {
  return `${storeUrl}/p/${encodeURIComponent(p.id)}`;
}

function newProductsHtml(items, storeUrl) {
  const cards = items.slice(0, 6).map((p) => `
    <div style="border:1px solid #eee;border-radius:12px;padding:12px;margin:8px 0">
      <img src="${escHtml(p.image)}" width="120" style="border-radius:8px"/><br/>
      <b>${escHtml(p.title)}</b><br/>$${escHtml(p.price)}
      <br/><a href="${escHtml(productLink(storeUrl, p))}">شاهد التفاصيل</a> |
      <a href="${escHtml(p.url)}" target="_blank">اشترِ الآن</a>
    </div>`).join('');
  return `<div dir="rtl"><h2>وصل حديثاً في متجرك الذكي</h2>${cards}<br/><a href="${escHtml(storeUrl)}">تسوق كل المنتجات</a></div>`;
}

function welcomeHtml(storeUrl) {
  return `<div dir="rtl"><h2>أهلاً بك في متجرك الذكي</h2>`
    + `<p>ستصلك أحدث المنتجات والعروض تلقائياً — بدون إزعاج، ويمكنك إلغاء الاشتراك في أي وقت.</p>`
    + `<p><a href="${escHtml(storeUrl)}">ابدأ التسوق الآن</a></p></div>`;
}

// نشر تلقائي مجاني في قناة تيليجرام (اختياري: BOT_TOKEN + CHAT_ID)
async function postToTelegram(items, storeUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !items.length) return { ok: false, reason: 'telegram-not-configured' };
  try {
    const lines = items.slice(0, 5).map((p) => `• <a href="${productLink(storeUrl, p)}">${escHtml(p.title)}</a> — $${escHtml(p.price)}`).join('\n');
    const text = `🛍️ <b>وصل حديثاً في متجرنا</b>\n\n${lines}\n\n<a href="${storeUrl}">تسوق الآن</a>`;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    });
    if (!res.ok) throw new Error(`telegram-http-${res.status}`);
    return { ok: true };
  } catch (e) {
    console.error('telegram-fail', e.message);
    return { ok: false, reason: e.message };
  }
}

function buildSitemap(storeUrl, items) {
  const urls = ['', '/sitemap.xml', '/robots.txt', ...items.map((p) => `/p/${encodeURIComponent(p.id)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    urls.map((u) => `<url><loc>${escHtml(storeUrl)}${u}</loc></url>`).join('') + `</urlset>`;
}

module.exports = { sendCampaign, newProductsHtml, welcomeHtml, postToTelegram, buildSitemap, escHtml };
