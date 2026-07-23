import express, { type Express } from "express";

/**
 * مُحلِّلات جسم الطلب العامة (body parsers) — منقولة **حرفياً** من `server/index.ts` (كانت تُسجَّل
 * عاماً قبل تركيب `/api/webhooks`، فيَستهلك json العام تدفّق الطلب أولاً؛ `express.raw()` الخاص
 * بمسارات webhook في `channelWebhooks.ts` كان يستلم عندها كائناً محلولاً لا Buffer خاماً ⇒ تحقّق
 * HMAC كان مستحيل النجاح مع Meta الحقيقية أبداً — اختبارات الراوتر الحالية كانت تمرّ لأنها تركّبه
 * معزولاً بلا هذا الوسيط العام).
 *
 * التعديل الوحيد عن النسخة الأصلية في index.ts: json/urlencoded العامّان (آخر سطرين) يتخطّيان أيّ
 * مسار `/api/webhooks/*` — تلك المسارات تركّب `express.raw()` الخاص بها داخل channelWebhooks.ts
 * وتحتاج Buffer خاماً كاملاً لتوقيع HMAC، لا كائناً محلولاً مسبقاً.
 */
export function applyBodyParsers(app: Express): void {
  // حجم الجسم: ١mb افتراضياً لكل المسارات (سطح هجوم DoS أصغر على /auth.login وغيرها).
  // الاستثناء الوحيد: /api/print/raw يرفع لـ١٠mb لأن العميل يرسل raster ESC/POS كبير
  // (نقطية الإيصال العربي مُولَّدة على Canvas) — لا حدّ ١mb لأنه يقطع الطباعة الفعلية.
  app.use("/api/print/raw", express.json({ limit: "10mb" }));
  // attachment-upload (٥/٧): سند بمرفق صورة (data URL مضغوطة حتى ٧٠٠ك ⇒ ~٩٣٣ك نصاً) قد يُقارب/يتجاوز
  // ١mb مع بقية حمولة السند. استثناء مماثل لـ/api/print/raw أعلاه — لكن بفحص substring لا مسار ثابت
  // (batch tRPC قد يُجمِّع عدّة إجراءات في مسار واحد ك"vouchers.create,other").
  app.use("/api/trpc", (req, res, next) => {
    if (req.path.includes("vouchers.create")) {
      return express.json({ limit: "3mb" })(req, res, next);
    }
    // بنرات المتجر تحمل صورة data-URL مضغوطة (نمط vouchers.create) ⇒ استثناء ٣mb لإنشائها/تعديلها.
    if (req.path.includes("storeAdmin.banners")) {
      return express.json({ limit: "3mb" })(req, res, next);
    }
    // كتالوج المتجر: setImage يرفع صورة المنتج الرئيسية data-URL مضغوطة (نفس نمط البنرات) ⇒ ٣mb.
    if (req.path.includes("storeAdmin.catalog")) {
      return express.json({ limit: "3mb" })(req, res, next);
    }
    // مستندات الأصل: addDocument يرفع صورة مستند data-URL مضغوطة (نفس نمط البنرات) ⇒ ٣mb.
    if (req.path.includes("assets.addDocument")) {
      return express.json({ limit: "3mb" })(req, res, next);
    }
    // product-image-edit: إنشاء/تعديل منتج يحمل حتى ١٠ صور عامّة (data-URL مضغوطة ~٩٣٣ك لكلٍّ) +
    // صورة مستقلّة لكل لون ⇒ الحمولة تتجاوز ١mb بسهولة. رفعٌ لـ١٠mb (نمط /api/print/raw): محصورٌ
    // بـproductsManagerProcedure (مصادَق، سطح DoS ضيّق) وكلّ صورة محدودة خادمياً بـ٢m.ب و≤١٠ صور.
    // كان الغياب يجعل حفظ منتجٍ بصورة يفشل ٤١٣ صامتاً (شمل صور المتغيّرات القائمة أيضاً).
    if (req.path.includes("catalog.createProduct") || req.path.includes("catalog.updateProductVariants")) {
      return express.json({ limit: "10mb" })(req, res, next);
    }
    // استوديو صور المنتجات: proCutout يرسل صورة المنتج data-URL لقصّها عبر remove.bg (حتى ٢م.ب خام
    // ⇒ ~٢.٧م.ب نصاً). استثناء ٤mb (نمط vouchers.create أعلاه). راجع server/routers/imageStudioRouter.ts.
    // aiStudioTransform: يرسل صورة المنتج data-URL (وضع EDIT) لإعادة تصميمها عبر مزوّد الذكاء الاصطناعي — نفس الحجم.
    if (req.path.includes("imageStudio.proCutout") || req.path.includes("imageStudio.aiStudioTransform")) {
      return express.json({ limit: "4mb" })(req, res, next);
    }
    // #9 (تدقيق التثبيت): system.restoreUpload يستقبل ملف نسخة احتياطية base64. الخدمة تقبل حتى
    // ٢٠٠MB مفكوكاً (maintenanceService.MAX_UPLOAD_BYTES) لكن هذا الوسيط كان يحبس عند ١MB ⇒ النسخ
    // الحقيقية لا تُستعاد أبداً. adminProcedure + كلمة مرور + رمز تأكيد ⇒ سطح DoS محدود بحساب مدير
    // متحقَّق. الحدّ = 300mb (يسع ٢٠٠MB مفكوكاً بحاشية base64 ~٣٣٪) وقابل للتجاوز عبر ENV للنموّ.
    if (req.path.includes("system.restoreUpload")) {
      return express.json({ limit: process.env.RESTORE_UPLOAD_LIMIT ?? "300mb" })(req, res, next);
    }
    next();
  });
  // json/urlencoded العامّان: يتخطّيان /api/webhooks/* — تلك المسارات تحتاج Buffer خاماً كاملاً
  // (express.raw() الخاص بها في channelWebhooks.ts) لتوقيع HMAC، لا كائناً محلولاً مسبقاً هنا.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/webhooks")) return next();
    return express.json({ limit: "1mb" })(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/webhooks")) return next();
    return express.urlencoded({ limit: "1mb", extended: true })(req, res, next);
  });
}
