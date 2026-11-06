import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { isBatchDivisible } from "@shared/batchDivisibility";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRepoFile = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

/**
 * العقد الحاكم لشاشة «الإنتاج / تحويل المخزون»:
 *
 *   **كل رفضٍ خادميٍّ للدفعة يُعرَض نصّاً — لا زرَّ معطَّلاً بلا سبب.**
 *
 * `runPreview` يرفض حالاتٍ مشروعةً برسائل عربية دقيقة تسمّي المكوّن والرقم. وكانت الشاشة
 * تُسقط `preview.error` كلّه، فيبقى `pv` undefined ⇒ بطاقة الإنتاجية تختفي وزرّ الترحيل
 * يبقى معطَّلاً أبداً بلا سطرٍ واحد يفسّر. النتيجة عند المستعمل: دفعةٌ تعمل عند رقمٍ
 * وتتجمّد عند غيره — وهو بلاغ المالك «لا تقبل إلا 100».
 *
 * المواد تقبل الكسور بدقة أربع منازل، وتظل أخطاء الدقة والمدى والمواد المعطلة واضحة للمستخدم.
 */
describe("عقد إظهار خطأ معاينة الإنتاج", () => {
  const page = readPage("ProductionNew.tsx");

  it("الشاشة تشتقّ نصّ الخطأ من preview.error بدل إسقاطه", () => {
    expect(page).toMatch(/const previewErrorMsg = preview\.error\?\.message \?\? null;/);
  });

  it("النصّ يظهر تحت حقل الدفعة (حيث السبب) وعند الزرّ (حيث يُكتشَف التعطُّل)", () => {
    const occurrences = page.match(/\{previewErrorMsg\}/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(page).toMatch(/تعذّر حساب هذه الدفعة — الترحيل موقوف/);
  });

  it("الزرّ المعطَّل يسمّي سببه بدل الصمت", () => {
    expect(page).toMatch(/previewErrorMsg \? "تعذّر حساب الدفعة"/);
  });

  it("مسار Ctrl+S لا يكذب برسالة انتظارٍ على خطأٍ قائم", () => {
    // الزرّ معطَّل، لكن useSaveShortcuts يستدعي submitRecipe مباشرةً ⇒ يلزمه السبب الحقيقيّ.
    expect(page).toMatch(/setError\(previewErrorMsg \?\? "انتظر اكتمال المعاينة\."\)/);
    expect(page).not.toMatch(/if \(!pv\) return setError\("انتظر اكتمال المعاينة\."\)/);
  });

  it("الخادم فعلاً يرفض بهذه الرسائل — فالعرض ليس زينة", () => {
    const preview = readRepoFile("server/services/production/preview.ts");
    expect(preview).toMatch(/exactRecipeMaterialQuantity/);
    expect(preview).toMatch(/الوصفة معطّلة/);
    expect(preview).toMatch(/الوصفة بلا مكوّنات/);
    // الرسالة تحمل اسم المكوّن والرقم الكسريّ ⇒ قابلة للتنفيذ حين تُعرَض.
    expect(preview).toContain("استهلاك «${l.productName ?? l.inputVariantId}»");
  });

  it("معامل0.01 يقبل دفعات ناتج50و150 باستهلاك0.5و1.5 بدقة", () => {
    const perOut = new Decimal("0.01");
    expect(perOut.times(100).isInteger()).toBe(true);   // 1     ⇒ يمرّ
    expect(perOut.times(200).isInteger()).toBe(true);   // 2     ⇒ يمرّ
    expect(perOut.times(50).toString()).toBe("0.5");
    expect(perOut.times(150).toString()).toBe("1.5");
    expect(isBatchDivisible(["0.01"], 50)).toBe(true);
    expect(isBatchDivisible(["0.01"], 150)).toBe(true);
    expect(isBatchDivisible(["0.01"], 1.5)).toBe(false);
    expect(isBatchDivisible(["0.00001"], 1)).toBe(false);
    // ومعامِلٌ صحيح لا يقيّد شيئاً — فالمشكلة في الوصفة لا في الشاشة.
    expect(new Decimal("80").times(50).isInteger()).toBe(true);
  });
});
