/**
 * **حارسُ خادم التطوير** — النقطةُ العمياء التي جعلت `pnpm dev` معطوباً على `main` وCI أخضر.
 *
 * العطب (٣١/٨): `vite.config.ts` يُصدّر **دالّةً** (`defineConfig(({ mode }) => …)` منذ احتاج
 * `loadEnv`)، وكان [`setupVite`](../vite.ts) ينشرها بـ`...viteConfig`. ونشرُ دالّةٍ يُنتج
 * **كائناً فارغاً** — الدوالّ بلا خصائصَ قابلةٍ للتعداد — فيسقط الإعدادُ كلُّه: `root: client/`
 * ومُعرِّفا `@`/`@shared`. فيصير `/src/main.tsx` مسارَ ملفٍّ لا وجود له، وتُخدَم `index.html`
 * مكانَ الوحدة (MIME: text/html)، ويبقى `#root` فارغاً ⇒ **لا واجهةَ إطلاقاً**.
 *
 * **ولمَ لم يمسكه شيء؟** `pnpm check` يمرّ (النشرُ سليمٌ نوعياً — النتيجة `{}` وهي `UserConfig`
 * صالحة)، و`pnpm build` يمرّ (vite يقرأ الملفّ بنفسه فيستدعي الدالّة صحيحةً)، ولا اختبارَ يمسّ
 * مسارَ الخادم التطويريّ. ثلاثُ بوّاباتٍ خضراء وخادمٌ لا يعمل.
 *
 * ⚠️ **ويستورد هذا الاختبار `buildDevServerConfig` — الحمولةَ الكاملة التي تُمرَّر فعلاً إلى
 * `createViteServer` — لا مساعداً بجانبها.** جُرِّب أوّلاً على `resolveViteConfig` وحدَها فبقي
 * **أخضرَ بعد إعادة العطب حرفياً** إلى `setupVite`: كان يفحص المساعدَ لا ما يُمرَّر. حارسٌ
 * يقرأ من مصدرٍ غير الذي يُنفَّذ ليس حارساً — والفرقُ هنا ليس نظرياً، فقد أثبتَته التجربة.
 *
 * بلا قاعدة بيانات: خادمُ vite في وضع الوسيط لا يمسّ MySQL.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDevServerConfig } from "../vite";

describe("إعدادُ خادم التطوير (vite) — لا يُفقَد بالنشر", () => {
  it("يُحلّ إلى إعدادٍ حقيقيّ لا كائنٍ فارغ", async () => {
    const cfg = await buildDevServerConfig();
    // الشرطُ الحاسم: النشرُ العاري كان يُنتج `{}` — أيّ مفتاحٍ هنا يُثبت أنّ الدالّة استُدعيت.
    expect(Object.keys(cfg).length).toBeGreaterThan(0);
  });

  it("يحتفظ بـ`root` مشيراً إلى مجلّد العميل — وهو ما سقط فعلياً", async () => {
    const cfg = await buildDevServerConfig();
    expect(cfg.root, "root غائب ⇒ /src/main.tsx يُحلّ على مجلّد التشغيل فلا يوجد").toBeTruthy();
    expect(String(cfg.root).replace(/\\/g, "/")).toMatch(/\/client$/);
  });

  it("يحتفظ بمُعرِّفَي `@` و`@shared` (تسقطان مع الإعداد نفسه)", async () => {
    const cfg = await buildDevServerConfig();
    const alias = cfg.resolve?.alias as Record<string, string> | undefined;
    expect(alias?.["@"]).toBeTruthy();
    expect(alias?.["@shared"]).toBeTruthy();
  });

  /**
   * ⭐ الثابتُ الفعليّ: `client/index.html` يطلب `/src/main.tsx`، وvite يحلّها **نسبةً إلى
   * `root`**. فمتى كان `root` صحيحاً ووُجدت نقطةُ الدخول تحته، تُخدَم الوحدةُ لا الصفحة.
   *
   * ⛔ **ولا نُشغّل خادم vite هنا عمداً**: جُرِّب فكان `server.close()` يتعلّق (مراقب/تهيئة
   * الاعتماديات) فيُحمَّر ملفٌّ كلُّ اختباراته خضراء — وحارسٌ يُنذر كذباً يُتجاوَز فيصير
   * مسرحياً. هذا الفحصُ حتميٌّ وفوريّ، ويسقط قبل الإصلاح تماماً (`root` غائب).
   */
  it("⭐ نقطةُ الدخول `/src/main.tsx` موجودةٌ تحت `root` — فتُخدَم وحدةً لا صفحة", async () => {
    const cfg = await buildDevServerConfig();
    const entry = path.join(String(cfg.root), "src", "main.tsx");
    expect(existsSync(entry), `نقطةُ الدخول غير موجودة تحت root (${cfg.root}) ⇒ تُخدَم index.html مكانَ الوحدة و#root يبقى فارغاً`).toBe(true);
  });
});
