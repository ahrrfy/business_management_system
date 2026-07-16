/**
 * حارسُ الافتراض الذي يجعل ترميز WebP آمناً بلا نسخةٍ احتياطية JPEG.
 *
 * **الملاحظة (مراجعة Codex على #216) وجيهةٌ منطقياً:** فحصُ دعم WebP يجري عند **الرافع**
 * (موظّف على متصفّحه) لا عند **المشاهد** (زبون المتجر) ⇒ نظرياً قد يُخزَّن WebP فلا يفكّه زبون،
 * فتظهر بطاقة المنتج **بلا صورة** — وهو أسوأ أصناف الأعطال (اختفاءٌ صامت، درس #203).
 *
 * **ولماذا هي منتفيةٌ هنا:** المتجر تطبيق React/Vite بلا أيّ مسارٍ بلا جافاسكربت — لا صفحة
 * أصلاً دون تشغيل الحزمة. و`build.target` يفرض **سفاري ١٦** كحدٍّ أدنى، وWebP دخلت سفاري في
 * **١٤** (٢٠٢٠) — أي إصدارين **أقدم**. وكذلك chrome107 ≫ chrome9، وfirefox104 ≫ firefox65،
 * وedge107 ≫ edge18. ⇒ **مجموعة «من يرى المتجر ولا يفكّ WebP» فارغةٌ بنيوياً**؛ المتصفّح الذي
 * يعجز عن WebP يعجز عن تحليل الحزمة نفسها فلا يصل للصور.
 *
 * **ولماذا اختبارٌ لا تعليق:** الحجّة كلّها تتّكئ على `build.target`. لو خفّضه أحدهم يوماً
 * (دعمُ جهازٍ قديم، أو ضبطٌ صريح) لسقط الافتراض **بصمت** وظهرت متاجرُ بلا صور. هنا يحمرّ CI
 * بدل الزبون. (وهذا نقيض «اختبارٍ يحرس بالصدفة» — الثابت مُسمّى صراحةً.)
 *
 * إن لزم يوماً دعمُ متصفّحٍ أقدم من سفاري ١٤: أعِد `<picture>` بنسخة JPEG (تخزينٌ مزدوج) أو
 * تفاوضاً بالمحتوى عبر `Accept` (يتطلّب مُحوِّلاً خادمياً)، قبل خفض الهدف.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

/** أوّل إصدارٍ يدعم فكّ WebP لكل محرّك (caniuse). */
const WEBP_MIN = { safari: 14, chrome: 9, firefox: 65, edge: 18 } as const;

describe("build.target — الافتراض الذي يُغني عن نسخة JPEG احتياطية", () => {
  it("⭐ كل متصفّحٍ يُشغّل المتجر يفكّ WebP (وإلّا لزمت نسخةٌ احتياطية)", async () => {
    const { resolveConfig } = await import("vite");
    const root = path.resolve(__dirname, "../../../../..");
    // الملفّ الحقيقيّ لا الافتراضي: لو ضُبط target صراحةً يوماً، يجب أن يُفحَص هو.
    const cfg = await resolveConfig({ configFile: path.join(root, "vite.config.ts"), root }, "build");

    const targets = ([] as string[]).concat(cfg.build.target as string[]);
    expect(targets.length).toBeGreaterThan(0);

    let checked = 0;
    for (const t of targets) {
      const m = /^([a-z]+)([0-9.]+)$/.exec(t);
      if (!m) continue;
      const engine = m[1] as keyof typeof WEBP_MIN;
      const min = WEBP_MIN[engine];
      if (min === undefined) continue; // محرّكٌ لا نعرف حدّه ⇒ لا نحكم
      expect.soft(parseFloat(m[2]), `هدف البناء ${t} أقدم من أوّل إصدارٍ يدعم WebP (${engine}${min})`).toBeGreaterThanOrEqual(min);
      checked++;
    }
    // لو لم نتعرّف على أيّ محرّك، فالحارس لا يحرس شيئاً ⇒ أفشِل بدل أن تمرّ حراسةٌ وهمية.
    expect(checked, `لم يُتعرَّف على أيّ محرّك في ${JSON.stringify(targets)}`).toBeGreaterThan(0);
  }, 60_000);
});
