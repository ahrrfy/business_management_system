import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const newSource = readFileSync(new URL("../AssetNew.tsx", import.meta.url), "utf8");
const editSource = readFileSync(new URL("../AssetEdit.tsx", import.meta.url), "utf8");

/**
 * شاشتا الأصل انحرفتا حقلاً بحقل رغم أنّهما تحرّران المستند نفسه. هذه الحزمة تثبّت ما وُحّد،
 * وتثبّت كذلك ما يجب أن يبقى مختلفاً — فالفروق الباقية مقصودة، ومَن يوحّدها لاحقاً «إتماماً
 * للتماثل» يفتح ثغرةً مالية. لذلك تُقاس هنا بنصّها لا بالنيّة.
 */
describe("تماثل نموذجَي الأصل (إضافة/تعديل)", () => {
  it("يحرس النموذجين معاً من فقد البيانات غير المحفوظة", () => {
    for (const source of [newSource, editSource]) {
      expect(source).toContain('import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";');
      expect(source).toContain("useUnsavedGuard(isDirty)");
    }
  });

  it("يقيس انحراف شاشة التعديل عن لقطة الخادم لا عن حالةٍ فارغة", () => {
    // التعبئة الأولى من الخادم ليست تغييراً من المستخدم؛ مقارنتها بحالةٍ فارغة تُطلق التحذير
    // على كل فتحٍ للشاشة حتى بلا لمس حقل، والتحذير الكاذب يُدرّب المستخدم على تجاهله.
    expect(editSource).toContain("setBaseline(JSON.stringify(loadedForm))");
    expect(editSource).toContain(
      "const isDirty = useMemo(() => baseline != null && JSON.stringify(form) !== baseline, [form, baseline]);",
    );
  });

  it("يعرض العهدة في شاشة التعديل للقراءة مع سببٍ مكتوب بدل إخفائها", () => {
    // الحقل الذي يحظر النظام تغييره يُعرَض ولا يختفي — وإخفاؤه يجعل الشاشة تُخفي واقع الأصل.
    expect(editSource).toContain('<Label htmlFor="cust">العهدة (الموظف المسؤول)</Label>');
    expect(editSource).toMatch(/id="cust"[\s\S]*?readOnly aria-describedby="asset-custody-lock"/);
    expect(editSource).toContain('id="asset-custody-lock"');
    expect(editSource).toContain("تُنقل من صفحة الأصل");
  });

  it("لا ترسل شاشة التعديل عهدةً في حمولة التحديث", () => {
    // `assets.update` لا يقبل custodianId أصلاً (zod يُسقط الزائد صامتاً)، ونقلُ العهدة
    // يمرّ بـ`assets.handover` وحده لأنّه يفتح قيداً في سجلّ العهدة باسم المُستلم وتاريخه.
    const updatePayload = editSource.slice(
      editSource.indexOf("update.mutate({"),
      editSource.indexOf("update.mutate({") + 900,
    );
    expect(updatePayload).not.toContain("custodianId");
  });

  it("لا تُعيد شاشة التعديل احتساب العمر الإنتاجي عند تبديل الفئة", () => {
    // في الإضافة `categoryDefaultLife` تسهيلٌ بلا أثر (لا شيء رُحّل بعد). أمّا في التعديل فتغيّر
    // العمر الإنتاجي على أصلٍ له إهلاكٌ متراكم يُرحّل قيد ADJUST (DEPR_ADJ) داخل updateAsset،
    // فيصير تصحيحُ تصنيفٍ خاطئ إعادةَ تقييمٍ ماليّةً لم يطلبها أحد.
    expect(newSource).toContain("categoryDefaultLife");
    expect(editSource).not.toContain("categoryDefaultLife");
    expect(editSource).toContain('onValueChange={(next) => set({ category: next })}');
  });

  it("لا تختلق شاشة التعديل حالةً فنّية للأصل", () => {
    // الافتراض "ممتاز" في الإضافة قيمةٌ يقرّها المُدخِل. نسخُه إلى التعديل يَسِم كل أصلٍ
    // حالتُه الفنّية فارغةٌ في القاعدة بـ"ممتاز" عند أوّل حفظ — اختلاقُ بيانٍ لم يُرصد.
    expect(newSource).toContain('condition: "ممتاز"');
    expect(editSource).toContain('condition: ""');
    expect(editSource).toContain('condition: a.condition ?? ""');
  });
});
