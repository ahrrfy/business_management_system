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
import { and, eq } from "drizzle-orm";
import { productImages, products, storeBanners } from "../drizzle/schema";
import { getSessionContext } from "./auth/session";
import { getDb } from "./db";
import { logger } from "./logger";
import { resolveKioskDevice } from "./services/kioskDeviceService";
import type { Request, Response } from "express";

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

/**
 * يبني رابط صورة منتج — مفتاحه **`productImages.id`** لا `productId`.
 * السبب: `isPrimary` عمودٌ منطقيّ **بلا قيد فرادة** ⇒ يجوز وجود صفَّين رئيسيَّين لمنتجٍ واحد،
 * فرابطٌ مُفتَّح بـproductId يصير غامضاً (الاستعلام يختار صفّاً والنقطة قد تختار غيره) فتُخدَم
 * بايتاتٌ لا تطابق بصمة `v=` ⇒ ينكسر عهد `immutable` بصمت. المعرّف يشير لصفٍّ بعينه ⇒ لا غموض.
 */
export function productImageUrl(imageId: number, dataUrl: string): string {
  return `/api/img/product/${imageId}?v=${imageHash(dataUrl)}`;
}

/**
 * رابط صورة منتجٍ **لكشك المعرض** — مسارٌ منفصل عن العلنيّ عمداً، لا ترفاً:
 *
 * بنر الكشك يعرض `isActive && !isService` **بلا** `showInStore` (قرار المالك ٨/٧: الكشك يعرض
 * الكتالوج كاملاً) ⇒ لو خُدِمت صوره من النقطة العلنية للزم **تليين بوّابتها** حتى تشمل ما أخفاه
 * المالك عن المتجر، فيكفي تخمين عددٍ صحيح لسحبه. الفصل يُبقي العلنيّ **علنياً بحقّ** ويجعل
 * **الرابط نفسه يُعلن جمهوره** ⇒ لا لبس في قابلية تخبئته: هذا `private` وذاك `public`.
 */
export function kioskProductImageUrl(imageId: number, dataUrl: string): string {
  return `/api/img/kiosk-product/${imageId}?v=${imageHash(dataUrl)}`;
}

/**
 * دلالة الكاش المشتركة لكل الصور — **موضعٌ واحد عمداً**: البنر والمنتج (وأيّ صورة لاحقة) يجب
 * أن يتشاركوا `immutable`+`ETag`+`nosniff` بالضبط. تكرارها لكل نقطة يجعل انحراف إحداها مسألة وقت.
 *
 * **`visibility` ليس تفصيلاً تجميلياً:** ردٌّ يعتمد على **المصادقة** لا يجوز أن يحمل `public`
 * (تخزّنه ذاكرةٌ وسيطة مشتركة — proxy/CDN — فتقدّمه لمجهولٍ لاحقاً). `private` تُبقي كاش
 * المتصفّح — وهو كلّ ما نحتاجه — وتمنع المشتركة. لذلك تُمرَّر صراحةً لا افتراضاً.
 *
 * **ولا تكفي `private` وحدها (مراجعة Codex، P1):** كاش المتصفّح مُفتَّحٌ بالـ**رابط** لا بالجلسة،
 * و`immutable` تعني «لا تُعِد التحقّق **سنةً**» ⇒ بعد خروج الجهاز أو إبطال كوكيه، طلبٌ لاحقٌ
 * لنفس الرابط من نفس المتصفّح يُخدَم **من الكاش بلا مرورٍ بـ`kioskViewerAllowed`** — فتُعمَّر
 * صلاحيةُ الرؤية بعد انتهاء الجلسة. `Vary: Cookie` يجعل مفتاح الكاش = (الرابط + الكوكي) ⇒
 * تغيّر/زوال الكوكي = مفتاحٌ آخر = **إخفاقُ كاشٍ ⇒ شبكة ⇒ ٤٠١**. والفائدة تبقى: كوكي الجهاز
 * ثابتٌ طوال عمله فتُصاب الصور من الكاش كما هو مقصود.
 *
 * ⚠️ **للعلنيّ فقط `public` بلا `Vary`:** إضافتها هناك تُجزّئ الكاش المشترك بلا مقابل (الردّ لا
 * يعتمد على الكوكي أصلاً) فتُضعف مكسب #212/#213.
 */
function sendImage(req: Request, res: Response, dataUrl: string | null, visibility: "public" | "private"): Response {
  const img = decodeDataUrl(dataUrl);
  if (!img) return res.status(404).end();

  const etag = `"${imageHash(dataUrl!)}"`;

  // ترويسات التخبئة **قبل** فحص 304: الردّ ٣٠٤ يجب أن يحمل ما يحمله ٢٠٠ منها (خصوصاً `Vary`)
  // وإلّا حدّث الكاش مُدخَله من ردٍّ لا يصف تجزئته. (RFC 7232 §4.1)
  res.setHeader("Cache-Control", `${visibility}, max-age=${ONE_YEAR}, immutable`);
  if (visibility === "private") res.setHeader("Vary", "Cookie");
  res.setHeader("ETag", etag);

  // إعادة تحقّق رخيصة للمتصفّحات التي تتجاهل immutable (أو بعد انتهاء السنة).
  if (req.headers["if-none-match"] === etag) return res.status(304).end();

  res.setHeader("Content-Type", img.mime);
  // الصورة ليست مستنداً: نمنع أيّ محاولة تفسيرٍ كـHTML مهما كان المحتوى.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(img.bytes.length));
  return res.end(img.bytes);
}

/**
 * هل للطالب حقّ رؤية كتالوج الكشك؟ **نفس شرط `kioskRead` في kioskRouter حرفياً**: مستخدم نظام
 * مسجَّل **أو** كوكي جهاز كشك. كلا الدالّتين تقرأ `req.headers.cookie` بنفسها ⇒ تُستعمَلان هنا
 * بلا وسيط إضافي، ولا نُعيد تنفيذ منطق المصادقة (تكراره = انحرافه لاحقاً).
 *
 * الكوكي تُرسَل تلقائياً مع طلب `<img>` لأنه **نفس الأصل** ⇒ لا يلزم تعديل الواجهة.
 */
async function kioskViewerAllowed(req: Request): Promise<boolean> {
  try {
    const { user } = await getSessionContext(req);
    if (user) return true;
  } catch {
    // جلسة تالفة/منتهية ⇒ جرّب مسار الجهاز
  }
  return (await resolveKioskDevice(req)) != null;
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

      return sendImage(req, res, pickSlot(row, String(req.params.slot)), "public");
    } catch (e) {
      logger.error({ err: e, bannerId: id }, "img: banner fetch failed");
      return res.status(500).end();
    }
  });

  /**
   * صورة منتج — النقطة **علنية ومجهولة الهوية**، لذا الشرط أدناه ليس تجميلاً:
   *
   * **البوّابة = رؤية المتجر على مستوى المنتج بالضبط** (`isActive && !isService && showInStore`)
   * ⇒ صفر توسيعٍ لسطح الكشف: لا تُخدَم إلا صورةُ منتجٍ يعرضه `storefront` أصلاً لكل زائر.
   * `showInStore=false` قرارُ إخفاءٍ صريحٌ من المالك (لوحة hPanel) ⇒ تخطّيه هنا يجعل تخمين
   * عددٍ صحيحٍ كافياً لسحب صور ما أخفاه عمداً.
   *
   * **ولماذا لا نشترط أكثر؟** لا المخزون ولا السعر:
   *  • المخزون — صفحة المنتج تعرض «غير متوفّر» **بصورته** (بخلاف الشبكة التي تشترط `> 0`)
   *    ⇒ اشتراطه هنا يُخفي صورة صفحةٍ تُرسَم فعلاً.
   *  • السعر/الوحدة — شروط **قابلية البيع** (أيّ وحدةٍ تُباع) لا **علنية المنتج**؛ وهي أضيق ⇒
   *    اشتراطها يخاطر بصورةٍ تختفي بلا مقابلٍ أمنيّ (المنتج علنيّ بقرار المالك على أيّ حال).
   *
   * ⚠️ **الكشك (`kioskService`) خارج هذه النقطة عمداً:** بنره يعرض `isActive && !isService`
   * **بلا** `showInStore` ⇒ تغطيتُه هنا تعني تليين البوّابة حتى تشمل ما أخفاه المالك عن المتجر.
   * وهو خلف مصادقة (مستخدم أو كوكي جهاز) بينما هذه النقطة مجهولة ⇒ جمهورٌ مختلف يستحقّ
   * نقطةً واعيةً بمصادقته، لا بوّابةً مُوسَّعة. يبقى الكشك على data URL حتى تُبنى تلك (راجع تقرير الجلسة).
   */
  r.get("/product/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const db = getDb();
    if (!db) return res.status(503).end();

    try {
      const row = (
        await db
          .select({ url: productImages.url })
          .from(productImages)
          .innerJoin(products, eq(products.id, productImages.productId))
          .where(
            and(
              eq(productImages.id, id),
              eq(products.isActive, true),
              eq(products.isService, false),
              eq(products.showInStore, true)
            )
          )
          .limit(1)
      )[0];
      if (!row) return res.status(404).end();

      return sendImage(req, res, row.url, "public");
    } catch (e) {
      logger.error({ err: e, productImageId: id }, "img: product image fetch failed");
      return res.status(500).end();
    }
  });

  /**
   * صورة منتجٍ لكشك المعرض — **خلف مصادقة** (مستخدم نظام أو كوكي جهاز)، بخلاف النقطة العلنية.
   *
   * البوّابة هنا = رؤية **الكشك** (`isActive && !isService`، بلا `showInStore`) لأن بنره يعرض
   * الكتالوج كاملاً بقرار المالك. وهذا بالضبط سبب فصل المسار: توسيعُ العلنيّ ليشمله كان
   * سيكشف صور ما أُخفي عن المتجر لأيّ مجهولٍ يخمّن عدداً.
   *
   * والردّ `private` لا `public`: يعتمد على المصادقة ⇒ لا تخزّنه ذاكرةٌ وسيطة مشتركة.
   */
  r.get("/kiosk-product/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
    const db = getDb();
    if (!db) return res.status(503).end();

    try {
      if (!(await kioskViewerAllowed(req))) return res.status(401).end();

      const row = (
        await db
          .select({ url: productImages.url })
          .from(productImages)
          .innerJoin(products, eq(products.id, productImages.productId))
          .where(and(eq(productImages.id, id), eq(products.isActive, true), eq(products.isService, false)))
          .limit(1)
      )[0];
      if (!row) return res.status(404).end();

      return sendImage(req, res, row.url, "private");
    } catch (e) {
      logger.error({ err: e, productImageId: id }, "img: kiosk product image fetch failed");
      return res.status(500).end();
    }
  });

  return r;
}
