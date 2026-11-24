import type { Express, Request, Response } from "express";

/**
 * Digital Asset Links لـTWA (Trusted Web Activity) — تغليف تطبيق الويب (PWA) على أندرويد.
 *
 * يربط تطبيق الويب المغلَّف (بحزمته + بصمة توقيعه) بأصل الموقع ⇒ يتحقّق كروم من الرابط
 * فيُزيل شريط العنوان ويصير التطبيق ملء الشاشة. **شرطٌ إلزاميّ** لاعتماد TWA.
 * يجب أن يُخدَم من: `https://<النطاق>/.well-known/assetlinks.json` بنوع application/json.
 *
 * القيم من البيئة (سرّية لكلّ نشر، لا تُلتزم في git):
 *   TWA_ANDROID_PACKAGE            — اسم حزمة التطبيق (مثل online.alarabiya.store).
 *   TWA_SHA256_CERT_FINGERPRINTS   — بصمات SHA-256 مفصولة بفاصلة.
 * غير مضبوطة ⇒ 404 صريح بدل خدمة ملفٍّ ناقص يكسر التحقّق.
 */
export function registerWellKnown(app: Express): void {
  app.get("/.well-known/assetlinks.json", (_req: Request, res: Response) => {
    const pkg = process.env.TWA_ANDROID_PACKAGE?.trim();
    const fingerprints = (process.env.TWA_SHA256_CERT_FINGERPRINTS ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!pkg || fingerprints.length === 0) {
      res
        .status(404)
        .type("application/json")
        .send(JSON.stringify({ error: "assetlinks غير مُعدّ — اضبط مفاتيح TWA وبصمات SHA-256" }));
      return;
    }

    const body = [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: pkg,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
    // تخبئة قصيرة: أداة التحقّق من Google تعيد الجلب، والتحديث النادر (تغيّر بصمة) يجب أن يصل بسرعة.
    res.status(200).type("application/json").set("Cache-Control", "public, max-age=300").send(JSON.stringify(body));
  });
}
