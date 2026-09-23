// ربط AliExpress Affiliate API + وضع تجريبي مجاني بدون مفاتيح
const crypto = require('crypto');

const GATEWAY = 'https://api.taobao.com/router/rest';

function utcTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// توقيع HMAC-MD5 حسب توثيق AliExpress: رتب أبجدياً ثم key+value ثم HMAC بالـ Secret
function signParams(params, appSecret) {
  const sorted = Object.keys(params).sort();
  const concat = sorted.map((k) => `${k}${params[k]}`).join('');
  return crypto.createHmac('md5', appSecret).update(concat, 'utf8').digest('hex').toUpperCase();
}

async function callAli(method, bizParams) {
  const appKey = process.env.ALI_APP_KEY;
  const appSecret = process.env.ALI_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('missing-keys');
  const sys = {
    app_key: appKey,
    method,
    sign_method: 'hmac',
    timestamp: utcTimestamp(),
    format: 'json',
    v: '2.0',
    ...bizParams,
  };
  sys.sign = signParams(sys, appSecret);
  const body = new URLSearchParams(sys);
  const res = await fetch(GATEWAY, { method: 'POST', body });
  if (!res.ok) throw new Error(`ali-http-${res.status}`);
  return res.json();
}

function normalizeAliItems(apiRes) {
  try {
    const r = apiRes?.aliexpress_affiliate_product_query_response?.resp_result?.result;
    const list = r?.products?.product || r?.products || [];
    return list.map((p) => ({
      id: String(p.product_id || p.productId),
      title: p.product_title || p.productTitle,
      price: Number(p.sale_price ?? p.salePrice ?? 0),
      oldPrice: Number(p.original_price ?? p.originalPrice ?? 0),
      image: p.product_main_image_url || p.productMainImageUrl,
      url: p.promotion_link || p.product_detail_url || p.productDetailUrl,
      commission: p.commission_rate || p.commissionRate || null,
      source: 'aliexpress',
    })).filter((x) => x.id && x.title);
  } catch { return []; }
}

// وضع تجريبي مجاني (DummyJSON) يعمل فوراً بدون مفاتيح
async function fetchDemoProducts(limit = 20) {
  const res = await fetch(`https://dummyjson.com/products?limit=${limit}`);
  if (!res.ok) throw new Error(`demo-http-${res.status}`);
  const j = await res.json();
  const tag = process.env.ALI_TRACKING_ID || '';
  return (j.products || []).map((p) => ({
    id: `dz-${p.id}`,
    title: p.title,
    price: p.price,
    oldPrice: Math.round(p.price / (1 - Math.min(p.discountPercentage || 10, 50) / 100)),
    image: p.thumbnail,
    url: tag ? `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(p.title)}&aff=${encodeURIComponent(tag)}` : `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(p.title)}`,
    commission: null,
    source: 'demo',
  }));
}

async function searchProducts({ keywords, pageNo = 1, pageSize = 20 }) {
  try {
    if (!process.env.ALI_APP_KEY || !process.env.ALI_APP_SECRET) {
      return { items: await fetchDemoProducts(pageSize), mode: 'demo' };
    }
    const first = String(keywords || 'watch').split(',')[0].trim() || 'watch';
    const j = await callAli('aliexpress.affiliate.product.query', {
      keywords: first, page_no: String(pageNo), page_size: String(pageSize),
      sort: 'LAST_VOLUME_DESC', target_currency: 'USD', target_language: 'EN',
    });
    const items = normalizeAliItems(j);
    if (!items.length) return { items: await fetchDemoProducts(pageSize), mode: 'demo-fallback' };
    return { items, mode: 'aliexpress' };
  } catch (e) {
    if (String(e.message).includes('missing-keys')) {
      return { items: await fetchDemoProducts(pageSize), mode: 'demo' };
    }
    throw e;
  }
}

module.exports = { searchProducts, signParams };
