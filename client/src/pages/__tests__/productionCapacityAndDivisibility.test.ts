import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { largestValidBatchAtMost, requiredBatchMultiple } from "@shared/batchDivisibility";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRepoFile = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

/**
 * العقد الحاكم لشريحة «كم أستطيع أن أُنتج؟»:
 *
 *   **السقف والمضاعف يُعلَنان قبل المحاولة، من مصدرٍ واحد يشترك فيه الخادم والشاشتان.**
 *
 * عدد الناتج يبقى صحيحاً، واستهلاك المواد يقبل أربع منازل عشرية دون فرض مضاعفات وهمية.
 */
describe("عقد سقف الإنتاج وقابلية قسمة الدفعة", () => {
  const productionNew = readPage("ProductionNew.tsx");
  const recipes = readPage("ProductionRecipes.tsx");
  const capacity = readRepoFile("server/services/production/capacity.ts");
  const router = readRepoFile("server/routers/productionRouter.ts");
  const preview = readRepoFile("server/services/production/preview.ts");

  it("مصدر الحساب واحد — لا شاشة تعيد تعريف القاعدة محلّياً", () => {
    for (const src of [recipes, capacity]) {
      expect(src).toMatch(/batchDivisibility/);
    }
    expect(preview).toMatch(/exactRecipeMaterialQuantity/);
    // ⛔ لا اشتقاق مقامٍ يدويّ في الشاشات (نمط الانحراف الذي تمنعه §٥).
    expect(recipes).not.toMatch(/10\s*\*\*\s*4/);
    expect(productionNew).not.toMatch(/requiredBatchMultiple\(/); // الشاشة تعرض ما يحسبه الخادم
  });

  it("مسار السقف موجود ومحميّ بنفس بوّابة الإنتاج، وله مستدعٍ في الواجهة", () => {
    expect(router).toMatch(/recipeCapacity: inventoryManagerProcedure/);
    expect(productionNew).toMatch(/trpc\.production\.recipeCapacity\.useQuery/);
  });

  it("السقف لا يأخذ دفعةً ⇒ يبقى مُجيباً حين يرمي runPreview", () => {
    // لو أخذ batchQty لعاد يرمي على الدفعة غير الصالحة، وضاع الجواب وقت الحاجة إليه.
    expect(router).not.toMatch(/recipeCapacity[\s\S]{0,300}batchQty/);
    expect(capacity).toMatch(/args:\s*\{\s*\n?\s*recipeId: number;\s*\n?\s*branchId: number;/);
  });

  it("القيدان مفصولان في العقد: maxByStock مقابل maxBatch", () => {
    expect(capacity).toMatch(/maxByStock:/);
    expect(capacity).toMatch(/maxBatch: largestValidBatchAtMost\(stockCap, multiple\)/);
    expect(capacity).toMatch(/limitingComponent/);
  });

  it("شاشة التشغيل تعرض السقف وتزرعه بضغطة — والحقل يبقى حرّاً", () => {
    expect(productionNew).toMatch(/الأقصى الممكن إنتاجه الآن/);
    expect(productionNew).toMatch(/onClick=\{\(\) => setBatch\(String\(cap\.maxBatch\)\)\}/);
    // ⭐ الحقل لم يصر مقيَّداً بالسقف: يبقى مدخلاً حرّاً كما طلب المالك.
    expect(productionNew).toMatch(/value=\{batch\} onChange=\{\(e\) => setBatch\(e\.target\.value\)\}/);
    expect(productionNew).not.toMatch(/<Input[^>]*value=\{batch\}[^>]*(max=|readOnly|disabled)/);
  });

  it("محرّر الوصفات يحذّر قبل الحفظ ويسمّي المكوّن الكسريّ — ولا يحجب", () => {
    expect(recipes).toMatch(/recipeBatchMultiple > 1 &&/);
    expect(recipes).toMatch(/ستقبل دفعاتٍ مضاعفةً لـ/);
    expect(recipes).toMatch(/fractionalComps\.map/);
    // تحذيرٌ لا حجب: التحقّق المانع للحفظ لم يكتسب شرطاً جديداً.
    expect(recipes).not.toMatch(/return `?هذه الوصفة ستقبل/);
  });

  it("معاينة الاستهلاك تستخدم التحقق الدقيق الذي يسمّي المادة عند رفض الكمية", () => {
    expect(preview).toContain("exactRecipeMaterialQuantity(");
    expect(preview).toContain("استهلاك «${l.productName ?? l.inputVariantId}»");
  });

  /* ===== ملاحظات مراجعة Codex على #911 — كلٌّ منها مثبَّتة هنا ===== */

  it("P1: الفرع يُشتقّ من الفاعل لا من الحمولة — في السقف وفي المعاينة معاً", () => {
    // مدير فرعٍ كان يقرأ أرصدة فرعٍ آخر بتبديل الرقم في طلبٍ مباشر (عزل الفرع، قرار المالك ١٢/٨).
    for (const handler of ["recipeCapacity", "runPreview"]) {
      const idx = router.indexOf(handler + ":");
      expect(idx).toBeGreaterThan(-1);
      const body = router.slice(idx, idx + 1400);
      expect(body).toContain('const elevated = ctx.user.role === "admin"');
      expect(body).toContain("Number(ctx.user.branchId ?? 0)");
    }
    // ولا يُمرَّر input خامّاً بعد اليوم.
    expect(router).not.toContain(".query(({ input }) => runPreview(input))");
  });

  it("P2: السقف يجمع أسطر المتغيّر الواحد قبل القسمة", () => {
    expect(capacity).toContain("const byVariant = new Map<");
    expect(capacity).toContain("prev.coefSum = prev.coefSum.plus(coef)");
    expect(capacity).toContain(".div(agg.coefSum)");
  });

  it("يتحقق من دقة كل مادة ويقبل نصف وحدة لكل سطر", () => {
    expect(requiredBatchMultiple(["0.5", "0.5"])).toBe(1);
    expect(requiredBatchMultiple(["1"])).toBe(1);
    expect(requiredBatchMultiple(["0.00001", "0.99999"])).toBe(0);
    expect(capacity).toContain("const multiple = requiredBatchMultiple(coefficients)");
    expect(capacity).toContain("coefficients = recLines.map");
  });

  it("P2: لا يُعلَن سقفٌ لوصفةٍ معطّلة — الترحيل يرفضها", () => {
    expect(productionNew).toContain("capacity.data?.isActive ? capacity.data : null");
  });

  it("P2: كاش السقف يُبطَل بعد ترحيلٍ يغيّر المخزون", () => {
    expect(productionNew).toContain("utils.production.recipeCapacity.invalidate()");
  });

  it("⭐ الحساب المركّب على أرقام الشاشة الحقيقية", () => {
    // مكوّن متاحٌ منه 195,680 ومعامِله 80 لكل ناتج ⇒ الكفاية تسمح بـ2446.
    const maxByStock = Math.floor(195680 / 80);
    expect(maxByStock).toBe(2446);
    // استهلاك المادة0.01 يُحفظ كما هو، فتظل كل دفعة ناتج صحيحة ضمن سقف المواد ممكنة.
    const multiple = requiredBatchMultiple(["80", "0.01"]);
    expect(multiple).toBe(1);
    expect(largestValidBatchAtMost(maxByStock, multiple)).toBe(2446);
    // وبمعامِلات صحيحة فقط، السقف هو الكفاية نفسها بلا قصّ.
    expect(largestValidBatchAtMost(maxByStock, requiredBatchMultiple(["80"]))).toBe(2446);
  });
});
