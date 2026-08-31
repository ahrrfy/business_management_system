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
 * الخلط الذي أنتج البلاغ: قيدان مختلفان يظهران للمستعمل كعطلٍ واحد — الكفاية (هل المخزون
 * يكفي؟) والقابلية للقسمة (هل الاستهلاك عددٌ صحيح؟). الثاني **غير تصاعديّ**، فيرى المستعمل
 * دفعةً تعمل عند 100 وتُرفض عند 50 والمواد وافرة، فيستنتج حدّاً وهمياً.
 */
describe("عقد سقف الإنتاج وقابلية قسمة الدفعة", () => {
  const productionNew = readPage("ProductionNew.tsx");
  const recipes = readPage("ProductionRecipes.tsx");
  const capacity = readRepoFile("server/services/production/capacity.ts");
  const router = readRepoFile("server/routers/productionRouter.ts");
  const preview = readRepoFile("server/services/production/preview.ts");

  it("مصدر الحساب واحد — لا شاشة تعيد تعريف القاعدة محلّياً", () => {
    for (const src of [recipes, capacity, preview]) {
      expect(src).toMatch(/batchDivisibility/);
    }
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

  it("رسالة رفض المعاينة صارت تسمّي الدفعة الصالحة لا مجرّد الخطأ", () => {
    expect(preview).toMatch(/const multipleNote = batchMultipleNote\(batchMultiple\)/);
    expect(preview).toMatch(/ليس عدداً صحيحاً — عدّل الدفعة أو الوصفة\.\$\{multipleNote/);
  });

  it("⭐ الحساب المركّب على أرقام الشاشة الحقيقية", () => {
    // مكوّن متاحٌ منه 195,680 ومعامِله 80 لكل ناتج ⇒ الكفاية تسمح بـ2446.
    const maxByStock = Math.floor(195680 / 80);
    expect(maxByStock).toBe(2446);
    // ومعامِلٌ كسريّ ثانٍ (0.01) يفرض مضاعفات 100 ⇒ الأقصى القابل للإنتاج 2400 لا 2446.
    const multiple = requiredBatchMultiple(["80", "0.01"]);
    expect(multiple).toBe(100);
    expect(largestValidBatchAtMost(maxByStock, multiple)).toBe(2400);
    // وبمعامِلات صحيحة فقط، السقف هو الكفاية نفسها بلا قصّ.
    expect(largestValidBatchAtMost(maxByStock, requiredBatchMultiple(["80"]))).toBe(2446);
  });
});
