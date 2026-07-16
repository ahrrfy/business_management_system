/**
 * نافذة تحميل صور كاروسيل الكشك (`isNearActive`) — الحارس الوحيد بين «٣ صور» و«٥٠٠ صورة».
 *
 * النافذة موجودة لأن الشرائح كلّها مرسومة ومكدّسة وتُخفى بـ`opacity:0` **لا** `display:none`
 * ⇒ كلّها «داخل الشاشة» عند مراقب التقاطع، فـ`loading="lazy"` لا يؤجّل شيئاً. حذف الـ`<img>`
 * للشرائح البعيدة هو الوحيد الذي يمنع الطلب ⇒ أيّ خللٍ هنا = انفجار طلباتٍ صامت على شاشة المعرض.
 */
import { describe, expect, it } from "vitest";
import { isNearActive } from "./KioskView";

/** عدد الشرائح التي ستُرسَم لها `<img>` فعلاً عند مؤشّرٍ نشط معيّن. */
function windowSize(idx: number, n: number): number {
  let count = 0;
  for (let i = 0; i < n; i++) if (isNearActive(i, idx, n)) count++;
  return count;
}

describe("isNearActive — النافذة الطبيعية", () => {
  it("الحالية + المجاورتان فقط (٣ من ٥٠٠)", () => {
    expect(windowSize(0, 500)).toBe(3);
    expect(windowSize(250, 500)).toBe(3);
    expect(windowSize(499, 500)).toBe(3);
  });

  it("تلتفّ عند الطرفين (الأخيرة مجاورةٌ للأولى — الكاروسيل دائريّ)", () => {
    expect(isNearActive(499, 0, 500)).toBe(true); // السابقة للأولى
    expect(isNearActive(1, 0, 500)).toBe(true); // التالية
    expect(isNearActive(2, 0, 500)).toBe(false); // خارج النافذة
    expect(isNearActive(250, 0, 500)).toBe(false);
  });

  it("التالية داخل النافذة دائماً ⇒ تُحمَّل قبل ظهورها فلا تومض الشاشة فارغةً", () => {
    for (const idx of [0, 1, 77, 498, 499]) expect(isNearActive((idx + 1) % 500, idx, 500)).toBe(true);
  });

  it("قوائم صغيرة (≤٣) ⇒ الكلّ (لا معنى لنافذةٍ أكبر من القائمة)", () => {
    expect(windowSize(0, 1)).toBe(1);
    expect(windowSize(0, 3)).toBe(3);
    expect(windowSize(0, 4)).toBe(3);
  });
});

/**
 * 🛡️ انحدار مراجعة Codex (P2) — **مقيسٌ فعلاً قبل الإصلاح: ١٠٠/١٠٠ شريحة بدل ٣.**
 *
 * `useEffect(() => { if (idx >= n) setIdx(0) })` يعمل **بعد** الرسم ⇒ في رسمةٍ واحدة بعد تقلّص
 * القائمة (إعادة جلب البنر كل ٥ د، أو تبديل الفرع) يكون `idx >= n`. وباقي القسمة في جافاسكربت
 * يحمل **إشارة المقسوم**: `(0 - 499 + 100) % 100 === -99` ⇒ `Math.min(-99, …) <= 1` صحيحٌ لكل
 * الشرائح تقريباً ⇒ تُرسَم كلّها وتنطلق مئات الطلبات — انفجارٌ في اللحظة نفسها التي وُجدت
 * النافذة لتمنعه. العلاج: تطبيع `idx` قبل الحساب.
 */
describe("isNearActive — مؤشّر بائت بعد تقلّص القائمة (انحدار P2)", () => {
  it("⭐ idx=499 وقد صارت القائمة ١٠٠ ⇒ ٣ لا ١٠٠ (كان ينفجر بالباقي السالب)", () => {
    expect(windowSize(499, 100)).toBe(3);
  });

  it("المؤشّر البائت يُطبَّع لا يُهمَل: idx=499 مع n=100 ≡ idx=99", () => {
    for (let i = 0; i < 100; i++) expect(isNearActive(i, 499, 100)).toBe(isNearActive(i, 99, 100));
  });

  it("يصمد لمؤشّراتٍ شاذّة أخرى (مضاعفات تامّة وقيمٍ ضخمة)", () => {
    expect(windowSize(100, 100)).toBe(3); // idx === n بالضبط ⇒ ≡ 0
    expect(windowSize(1000, 100)).toBe(3);
    expect(windowSize(12345, 500)).toBe(3);
  });
});
