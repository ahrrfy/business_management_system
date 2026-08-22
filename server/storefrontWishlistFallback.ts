import type { Express, Request, Response } from "express";

import { resolveStorefrontWishlistShare } from "./services/storefrontWishlistShareService";

const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,32}$/;
const GOOGLE_PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=online.alarabiya.customerstore";
const configuredDownloadUrl = (() => {
  const value = process.env.STOREFRONT_ANDROID_DOWNLOAD_URL?.trim();
  try {
    return value && new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
})();

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[char] ?? char);
}

function formatIqd(value: string | null) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${new Intl.NumberFormat("en-US").format(amount)} د.ع` : "السعر في التطبيق";
}

function fallbackDocument(input: {
  token: string;
  expiresAt: Date;
  items: Array<{ productId: number; productName: string; category: string | null; imageUrl: string | null; price: string | null; salePrice: string | null; inStock: boolean }>;
}) {
  const deepLink = `maktabaalarabiya:///shared-wishlist/${encodeURIComponent(input.token)}`;
  const expiry = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Baghdad" }).format(input.expiresAt);
  const downloadUrl = configuredDownloadUrl ?? GOOGLE_PLAY_STORE_URL;
  const downloadAction = `<a class="button install" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer"><span class="button-icon" aria-hidden="true">▶</span><span><strong>نزّل التطبيق من Google Play</strong><small>القناة الرسمية لمكتبة العربية</small></span></a>`;
  const cards = input.items.map((item) => {
    const activePrice = item.salePrice ?? item.price;
    const image = item.imageUrl
      ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.productName)}" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="placeholder" aria-hidden="true">مكتبة<br>العربية</div>`;
    const oldPrice = item.salePrice && item.price ? `<span class="old-price">${escapeHtml(formatIqd(item.price))}</span>` : "";
    const status = item.inStock ? "متوفر الآن" : "تحقق من التوفر في التطبيق";
    const stockClass = item.inStock ? "available" : "check-stock";
    return `<article class="card">${image}<div class="copy"><p class="category">${escapeHtml(item.category ?? "منتجات المكتبة")}</p><h2>${escapeHtml(item.productName)}</h2><p class="price">${escapeHtml(formatIqd(activePrice))}${oldPrice}</p><p class="status ${stockClass}"><span aria-hidden="true"></span>${status}</p><a class="product-link" href="maktabaalarabiya:///product/${item.productId}">عرض التفاصيل في التطبيق <b aria-hidden="true">←</b></a></div></article>`;
  }).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#fff8f2"><title>قائمة رغبات مشتركة | مكتبة العربية</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 95% 0,#ffecce 0,transparent 30%),#fff8f2;color:#183d36;font-family:Arial,"Cairo",sans-serif}.page{max-width:720px;margin:auto;padding:26px 18px 56px}.brand{display:flex;align-items:center;gap:9px;color:#0e806a;font-weight:800;font-size:14px;margin:0 4px 14px}.brand-mark{width:28px;height:28px;border-radius:10px;background:#0e806a;color:#fff;display:grid;place-items:center;font-size:15px;box-shadow:0 7px 15px #0e806a30}.hero{position:relative;overflow:hidden;background:#fff;border:1px solid #eee3d7;border-radius:28px;padding:27px;box-shadow:0 14px 34px #173a3312}.hero:after{content:"";position:absolute;width:160px;height:160px;left:-84px;top:-88px;border:26px solid #fff3e8;border-radius:50%;pointer-events:none}.eyebrow{position:relative;z-index:1;margin:0;color:#0e806a;font-weight:800;font-size:13px}.hero h1{position:relative;z-index:1;font-size:28px;line-height:1.35;margin:8px 0}.sub{position:relative;z-index:1;color:#5b7169;line-height:1.8;margin:0}.launch-state{position:relative;z-index:1;display:flex;align-items:center;gap:8px;color:#315e53;font-size:12px;font-weight:700;margin:17px 0 0}.pulse{width:9px;height:9px;flex:none;border-radius:50%;background:#0e806a;box-shadow:0 0 0 0 #0e806a66}.meta{position:relative;z-index:1;font-size:12px;color:#708078;line-height:1.7;margin:12px 0 0}.actions{position:relative;z-index:1;display:grid;gap:10px;margin-top:20px}.button{display:flex;align-items:center;justify-content:center;gap:10px;border-radius:16px;min-height:54px;padding:12px 17px;text-align:center;text-decoration:none;font-weight:700;transition:transform .16s ease,box-shadow .16s ease}.button:hover{transform:translateY(-1px)}.button:focus-visible,.product-link:focus-visible{outline:3px solid #f3b85a;outline-offset:3px}.open{background:#0e806a;color:#fff;box-shadow:0 10px 22px #0e806a35}.open small,.install small{display:block;font-size:11px;font-weight:400;margin-top:2px}.button-loader{width:0;opacity:0;overflow:hidden;transition:opacity .14s ease,width .14s ease}.button-loader i{display:block;width:14px;height:14px;border:2px solid #fff8;border-top-color:#fff;border-radius:50%}.open:active .button-loader,.open:focus-visible .button-loader{width:14px;opacity:1}.install{justify-content:flex-start;background:#fff3e8;color:#0e806a;border:1px solid #f5ddc3}.button-icon{width:26px;height:26px;display:grid;place-items:center;flex:none;border-radius:9px;background:#0e806a;color:#fff;font-size:11px;direction:ltr}.grid{display:grid;gap:14px;margin-top:20px}.card{background:#fff;border:1px solid #eee3d7;border-radius:22px;display:flex;gap:14px;overflow:hidden;box-shadow:0 5px 18px #173a3308}.card img,.placeholder{height:118px;width:118px;object-fit:cover;background:#e8f5ef;display:flex;align-items:center;justify-content:center;text-align:center;color:#0e806a;font-size:12px;font-weight:800;line-height:1.4;flex:none}.copy{min-width:0;padding:14px 14px 14px 6px;flex:1}.category,.status{color:#708078;font-size:12px;margin:0}.copy h2{font-size:16px;margin:4px 0;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.price{color:#0e806a;font-weight:800;margin:5px 0}.old-price{color:#95a29d;text-decoration:line-through;font-size:11px;margin-right:8px}.status{display:flex;align-items:center;gap:5px}.status span{width:7px;height:7px;border-radius:50%}.available span{background:#18a36f}.check-stock span{background:#f3b85a}.product-link{color:#0e806a;font-size:12px;font-weight:800;text-decoration:none;display:inline-block;margin-top:8px}.product-link b{display:inline-block;transition:transform .16s ease}.product-link:hover b{transform:translateX(-3px)}.empty{text-align:center;background:#fff;border:1px solid #eee3d7;border-radius:22px;padding:28px;color:#708078}.empty strong{color:#183d36}@media (prefers-reduced-motion:no-preference){.pulse{animation:pulse 1.7s infinite}.open:active .button-loader i,.open:focus-visible .button-loader i{animation:spin .7s linear infinite}@keyframes pulse{70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}@keyframes spin{to{transform:rotate(360deg)}}}@media (max-width:390px){.page{padding-inline:13px}.hero{padding:22px}.hero h1{font-size:25px}.card img,.placeholder{width:96px;height:112px}.copy h2{white-space:normal}}</style></head><body><main class="page"><p class="brand"><span class="brand-mark" aria-hidden="true">ع</span>مكتبة العربية</p><section class="hero"><p class="eyebrow">قائمة وصلت إليك من صديق</p><h1>اختيارات تستحق أن تراها</h1><p class="sub">تعرض هذه القائمة الأسعار والتوفر الحاليين. افتح التطبيق لإضافة المنتجات إلى سلتك واستعراض التفاصيل الكاملة.</p><p class="launch-state" aria-live="polite"><span class="pulse" aria-hidden="true"></span>جاهز لفتح التطبيق والعودة إلى هذه القائمة بأمان.</p><p class="meta">ينتهي هذا الرابط في ${escapeHtml(expiry)} بتوقيت بغداد.</p><div class="actions"><a class="button open" href="${escapeHtml(deepLink)}"><span><strong>فتح في تطبيق مكتبة العربية</strong><small>سيُفتح التطبيق المثبت لديك</small></span><span class="button-loader" aria-hidden="true"><i></i></span></a>${downloadAction}</div></section>${cards ? `<section class="grid" aria-label="منتجات القائمة">${cards}</section>` : `<section class="empty"><strong>لم تعد منتجات هذه القائمة متاحة حالياً.</strong><p>نزّل التطبيق لاستكشاف أحدث منتجات المكتبة.</p></section>`}</main></body></html>`;
}

/** صفحة عامة قصيرة العمر، مسجلة قبل catch-all لوحة الإدارة ولا تحتاج جلسة أو بيانات عميل. */
export function registerStorefrontWishlistFallback(app: Express): void {
  app.get("/s/w/:token", async (req: Request, res: Response, next) => {
    const token = String(req.params.token ?? "").trim();
    if (!SHARE_TOKEN.test(token)) return res.status(404).type("text/plain").send("رابط قائمة الرغبات غير صالح أو انتهت صلاحيته.");
    try {
      const share = await resolveStorefrontWishlistShare(token);
      res.status(200)
        .set("Cache-Control", "private, no-store")
        .set("Content-Security-Policy", "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .type("html")
        .send(fallbackDocument({ token, ...share }));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "NOT_FOUND") return res.status(404).type("text/plain").send("رابط قائمة الرغبات غير صالح أو انتهت صلاحيته.");
      next(error);
    }
  });
}
