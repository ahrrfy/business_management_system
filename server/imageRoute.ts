/**
 * نقطة خدمة الصور (خارج tRPC) — `GET /api/img/...`
 *
 * **لماذا وُجدت (قياسٌ حيّ ١٦/٧):** الصور تُخزَّن data-URL بـbase64 داخل أعمدة MEDIUMTEXT
 * وتُشحَن **داخل ردّ JSON**. فكان ردّ `storefront.banners` العلنيّ **١٫٣٢ م.ب مضغوطاً** في
 * **كل** تحميلٍ للمتجر (٨× حجم حزمة جافاسكربت كلّها = ١٦٩ ك.ب)، وبلا أيّ ترويسة كاش،
 * والـservice worker يضع `/api/*` على NetworkOnly عمداً ⇒ صفر إعادة استعمال.
 *
 * الصورة داخل JSON تُبطل **كل** آليات المتصفّح دفعةً واحدة: لا كاش HTTP (ليست مورداً مستقلاً)،
 * ولا تحميل كسول (الكاروسيل يجلب الخمسة ليعرض واحدة)، ولا تحميل متوازٍ، و+٣٣٪ من base64.
 *
 * **الحل هنا:** المورد يصير رابطاً حقيقياً. الصور **تبقى في القاعدة** (صفر هجرة بيانات، وصفر
 * أثر على النسخ الليلية المشفّرة) لكنها تُخدَم كبايتات مع `immutable` + `ETag`.
 *
 * **مفتاح الإبطال:** الرابط يحمل `v=<hash>` من محتوى الصورة نفسها ⇒ `immutable` آمنة تماماً:
 * تعديل الصورة يُغيّر الرابط فيُجلَب الجديد فوراً، ولا تعديل ⇒ صفر بايت للأبد.
 *
 * **علنيّ بلا مصادقة عمداً:** هذه صور المتجر التي تُعرض لكل زائر (البنرات علنية أصلاً عبر
 * `storefront.banners` بلا كوكي). لا csrfGuard (قراءة GET محضة لا تُغيّر حالة).
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { storeBanners } from "../drizzle/schema";
import { getDb } from "./db";
import { logger } from "./logger";

/** سنة كاملة — آمنة لأن الرابط يحمل بصمة المحتوى (تغيّر المحتوى ⇒ تغيّر الرابط). */
const ONE_YEAR = 60 * 60 * 24 * 365;

/** أنواع الصور المسموح خدمتها — قائمة بيضاء صريحة (لا نثق ببادئة data URL القادمة من DB). */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export interface DecodedImage {
  mime: string;
  bytes: Buffer;
}

/**
 * يفكّ data URL إلى (نوع + بايتات). يُعيد null لأيّ شكلٍ غير متوقّع أو نوعٍ خارج القائمة البيضاء
 * — الحماية هنا مقصودة: العمود نصٌّ حرّ في DB، وخدمة `Content-Type` مأخوذاً منه بلا تحقّق تفتح
 * باب XSS (مثلاً `data:text/html`). أيّ شذوذ ⇒ ٤٠٤ لا تخمين.
 */
export function decodeDataUrl(value: string | null | undefined): DecodedImage | null {
  if (!value || typeof value !== "string") return null;
  // [\s\S] بدل العَلَم `s` (dotAll): هدف tsc هنا أقدم من es2018 فيرفضه — والنمط مكافئ تماماً.
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(value.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return null;
  try {
    const bytes = Buffer.from(m[2], "base64");
    return bytes.length ? { mime, bytes } : null;
  } catch {
    return null;
  }
}

/** بصمة قصيرة من محتوى الصورة — تُبنى منها `v=` في الرابط و`ETag`. */
export function imageHash(dataUrl: string): string {
  return createHash("sha256").update(dataUrl).digest("hex").slice(0, 16);
}

/** يبني رابط صورة بنر — المصدر الوحيد لشكل الرابط (يستعمله bannerService). */
export function bannerImageUrl(bannerId: number, slot: string, dataUrl: string): string {
  return `/api/img/banner/${bannerId}/${slot}?v=${imageHash(dataUrl)}`;
}

/** يختار الـdata URL المطلوب من صفّ البنر حسب الفتحة (main-<i> أو mobile). */
function pickSlot(row: { imageUrl: string | null; images: unknown; mobileImageUrl: string | null }, slot: string): string | null {
  if (slot === "mobile") return row.mobileImageUrl;
  const m = /^main-(\d+)$/.exec(slot);
  if (!m) return null;
  const idx = Number(m[1]);
  const list = Array.isArray(row.images) ? row.images : [];
  // الصور المتعددة (#203) أوّلاً بترتيب sortOrder — نفس ترتيب listActiveBanners؛ فإن لم تكن
  // مُهيّأة فالصورة الأحادية القديمة (imageUrl) عند الفهرس 0 حصراً.
  if (list.length) {
    const sorted = [...list]
      .filter((x): x is { url: string; sortOrder?: number } => !!x && typeof (x as any).url === "string")
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return sorted[idx]?.url ?? null;
  }
  return idx === 0 ? row.imageUrl : null;
}

export function imageRouter(): Router {
  const r = Router();

  r.get("/banner/:id/:slot", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const db = getDb();
    if (!db) return res.status(503).end();

    try {
      const row = (
        await db
          .select({ imageUrl: storeBanners.imageUrl, images: storeBanners.images, mobileImageUrl: storeBanners.mobileImageUrl })
          .from(storeBanners)
          .where(eq(storeBanners.id, id))
          .limit(1)
      )[0];
      if (!row) return res.status(404).end();

      const dataUrl = pickSlot(row, String(req.params.slot));
      const img = decodeDataUrl(dataUrl);
      if (!img) return res.status(404).end();

      const etag = `"${imageHash(dataUrl!)}"`;
      // إعادة تحقّق رخيصة للمتصفّحات التي تتجاهل immutable (أو بعد انتهاء السنة).
      if (req.headers["if-none-match"] === etag) return res.status(304).end();

      res.setHeader("Content-Type", img.mime);
      res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR}, immutable`);
      res.setHeader("ETag", etag);
      // الصورة ليست مستنداً: نمنع أيّ محاولة تفسيرٍ كـHTML مهما كان المحتوى.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Length", String(img.bytes.length));
      return res.end(img.bytes);
    } catch (e) {
      logger.error({ err: e, bannerId: id }, "img: banner fetch failed");
      return res.status(500).end();
    }
  });

  return r;
}
