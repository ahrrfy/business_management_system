import type { Express, Request, Response } from "express";

const STOREFRONT_ANDROID_PACKAGE = "online.alarabiya.customerstore";
// بصمة توقيع EAS Development — تُستعمل **فقط** في development حين تخدم القاعدة تطبيق EAS Dev Client
// على الأجهزة الحيّة. في الإنتاج Google يُعيد التوقيع بمفتاح Play App Signing فبصمةُ الجهاز تُصبح
// مختلفة، ولذلك لا يجوز أن تظهر هذه البصمة على استجابة إنتاجيّة — راجع assertStorefrontFingerprintsInProduction.
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
/**
 * حارس إنتاجيّ لبصمة التطبيق الأصيل: يمنع أن تخدم القاعدة بصمةَ EAS-dev على nginx العلنيّ.
 * السبب — Google Play App Signing يُعيد توقيع AAB بمفتاح Play (لا مفتاح EAS)، فبصمةُ التطبيق
 * على أجهزة العملاء تختلف عن بصمة EAS-dev. تحقّق Android لـApp Links يقارن بصمة التطبيق بما
 * تُرجعه هذه الاستجابة ⇒ لو استجابت بـEAS-dev، كلّ عميلٍ نهائيّ يرى الرابط يفتح Chrome بدل التطبيق،
 * والفشل صامتٌ لأنّ الاستجابة 200+JSON صحيحان بحدّ ذاتهما. راجع
 * expo/customer-store-mobile/docs/erp-followups.md § ك-٢.
 */
function assertStorefrontFingerprintsInProduction(source: "env" | "fallback"): void {
  if (source === "fallback" && process.env.NODE_ENV === "production") {
    // سبب صريح للتحقيق (ليس رسالة مبهمة): يفشل النشر بلا مسٍّ لأيّ حزمة عميل.
    // إعادة الحياة: ضبط STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS في .env على القيمة من
    // Play Console → Setup → App integrity → App signing → SHA-256.
    throw new Error(
      "STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS is required in production — refusing to serve EAS-dev fingerprint",
    );
  }
}

export function registerWellKnown(app: Express): void {
  app.get("/.well-known/assetlinks.json", (_req: Request, res: Response) => {
    const pkg = process.env.TWA_ANDROID_PACKAGE?.trim();
    const fingerprints = (process.env.TWA_SHA256_CERT_FINGERPRINTS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const storefrontPkg = process.env.STOREFRONT_ANDROID_PACKAGE?.trim() || STOREFRONT_ANDROID_PACKAGE;
    const storefrontEnv = process.env.STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS?.trim();
    const storefrontFingerprintSource: "env" | "fallback" = storefrontEnv ? "env" : "fallback";
    try {
      assertStorefrontFingerprintsInProduction(storefrontFingerprintSource);
    } catch (error) {
      // يفشل مفتوحاً بـ500 على مسار storefront فقط (مسار TWA يبقى يعمل إن ضُبط). لا تكشف السبب للعامّة.
      const reason = error instanceof Error ? error.message : "storefront assetlinks misconfigured";
      // eslint-disable-next-line no-console -- تنبيه تشغيليّ محدود لسبب فشل النشر
      console.error("[wellKnown] refusing storefront assetlinks:", reason);
      res.status(500).type("application/json").send(JSON.stringify({ error: "storefront assetlinks configuration error" }));
      return;
    }
    const storefrontFingerprints = (storefrontEnv ?? STOREFRONT_EAS_DEVELOPMENT_SHA256)
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
