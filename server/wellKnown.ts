import type { Express, Request, Response } from "express";

const STOREFRONT_ANDROID_PACKAGE = "online.alarabiya.customerstore";
const STOREFRONT_EAS_DEVELOPMENT_SHA256 = "24:6B:73:BE:E1:B5:B7:7F:22:E4:E2:9B:59:67:B6:2C:70:C1:60:CC:EB:69:49:68:84:E3:FF:F7:6F:A5:DA:23";

/**
 * Digital Asset Links لـTWA (Trusted Web Activity) — تغليف الـPWA كتطبيق أندرويد على Google Play.
 *
 * يربط تطبيق أندرويد (بحزمته + بصمة توقيعه) بأصل الموقع (alarabiya.online) ⇒ يتحقّق كروم من الرابط
 * فيُزيل شريط العنوان ويصير التطبيق ملء الشاشة (لا يبدو كمتصفّح). **شرطٌ إلزاميّ** لاعتماد TWA.
 * يجب أن يُخدَم من: `https://<النطاق>/.well-known/assetlinks.json` بنوع application/json.
 *
 * ⚠️ لماذا مسارٌ صريح لا ملفٌّ ثابت: `express.static` يتجاهل الملفات النقطية (`.well-known`)
 * افتراضياً، وcatch-all الـSPA يُعيد index.html لأي مسار ⇒ لولا هذا المسار لعاد HTML بدل JSON
 * ولفشل التحقّق صامتاً. لذا يُسجَّل **قبل** setupVite/serveStatic (قبل الـcatch-all).
 *
 * القيم من البيئة (سرّية لكلّ نشر، لا تُلتزم في git):
 *   TWA_ANDROID_PACKAGE            — اسم حزمة التطبيق (مثل online.alarabiya.store).
 *   TWA_SHA256_CERT_FINGERPRINTS   — بصمات SHA-256 مفصولة بفاصلة (مفتاح التوقيع المحلّي +
 *                                    مفتاح Play App Signing — أضِف كليهما إن استعملت توقيع Play).
 * غير مضبوطة ⇒ 404 صريح (لم يُعدّ التغليف بعد) بدل خدمة ملفٍّ ناقص يكسر التحقّق.
 */
export function registerWellKnown(app: Express): void {
  app.get("/.well-known/assetlinks.json", (_req: Request, res: Response) => {
    const pkg = process.env.TWA_ANDROID_PACKAGE?.trim();
    const fingerprints = (process.env.TWA_SHA256_CERT_FINGERPRINTS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const storefrontPkg = process.env.STOREFRONT_ANDROID_PACKAGE?.trim() || STOREFRONT_ANDROID_PACKAGE;
    const storefrontFingerprints = (process.env.STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS ?? STOREFRONT_EAS_DEVELOPMENT_SHA256)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if ((!pkg || fingerprints.length === 0) && (!storefrontPkg || storefrontFingerprints.length === 0)) {
      res
        .status(404)
        .type("application/json")
        .send(JSON.stringify({ error: "assetlinks غير مُعدّ — اضبط مفاتيح TWA أو STOREFRONT Android وبصمات SHA-256" }));
      return;
    }

    const body = [];
    if (pkg && fingerprints.length > 0) body.push({
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: pkg,
          sha256_cert_fingerprints: fingerprints,
        },
      });
    if (storefrontPkg && storefrontFingerprints.length > 0) body.push({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: storefrontPkg,
        sha256_cert_fingerprints: storefrontFingerprints,
      },
    });
    // تخبئة قصيرة: أداة التحقّق من Google تعيد الجلب، والتحديث النادر (تغيّر بصمة) يجب أن يصل بسرعة.
    res.status(200).type("application/json").set("Cache-Control", "public, max-age=300").send(JSON.stringify(body));
  });
}
