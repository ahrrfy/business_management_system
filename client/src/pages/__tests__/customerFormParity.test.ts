import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const newSource = readFileSync(new URL("../CustomerNew.tsx", import.meta.url), "utf8");
const editSource = readFileSync(new URL("../CustomerEdit.tsx", import.meta.url), "utf8");

/** مجموعة معرّفات الحقول المرتبطة بتسميتها (`htmlFor`) في ملفٍ — بصمة «ما يراه المستخدم». */
function labeledFieldIds(source: string): string[] {
  return [...new Set([...source.matchAll(/htmlFor="([^"]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * شاشتا العميل (إضافة/تعديل) تُحرّران السجلّ نفسه، فانحرافُهما يجعل الموظّف يرى بياناً في إحداهما
 * ولا يراه في الأخرى. هذه الحزمة تثبّت ما وُحّد، وتثبّت كذلك ما **يجب** أن يبقى مختلفاً — فالفرق
 * الباقي مقصود، ومَن يوحّده لاحقاً «إتماماً للتماثل» يفتح باباً لم يُدرَس. تُقاس بنصّها لا بالنيّة.
 */
describe("تماثل نموذجَي العميل (إضافة/تعديل)", () => {
  it("يعرض الشاشتان المال بصيغةٍ واحدة", () => {
    // كانت الإضافة على `fmt` (en-US بمنزلتَين محشوّتَين: 500,000.00) والتعديل على `fmtAr`
    // (500,000) ⇒ المبلغ الواحد يبدو مختلفاً باختلاف الشاشة، فيُشكِّك القارئ في الرقم نفسه.
    // الموحَّد هو `fmtAr` لأنّه صيغة شاشة العملاء وبطاقة التعديل معاً، وأرقامه لاتينية
    // (`ar-IQ-u-nu-latn`) وفق قاعدة المالك.
    for (const source of [newSource, editSource]) {
      // ⚠️ يُقاس **المعنى** لا نصُّ سطر الاستيراد: تثبيتُه حرفياً (`toEqual([...])`) كان
      // يُحمِّر على إضافة مساعدٍ مشروع، وحارسٌ ينكسر على تغييرٍ سليم يُعدَّل ليمرّ فيفقد معناه.
      const moneyImports = [...source.matchAll(/import \{([^}]*)\} from "@\/lib\/money";/g)].map((m) => m[1].trim());
      expect(moneyImports).toHaveLength(1);
      const names = moneyImports[0].split(",").map((n) => n.trim());
      // الصيغة الموحَّدة حاضرة…
      expect(names).toContain("fmtAr as fmt");
      // …و`fmt` الخامّة (en-US بمنزلتين محشوّتين) لا تتسلّل بأيّ اسم.
      expect(names).not.toContain("fmt");
      expect(names.some((n) => /^fmt\s+as\s+/.test(n))).toBe(false);
    }
  });

  it("لا تُحلّل أيّ من الشاشتين مبلغاً بـNumber()", () => {
    // §٥: المال عبر decimal.js وحده. كانت المعاينة تقارن `Number(openingAmount) > 0`
    // والتحميل يقرأ `Number(c.creditLimit) === 0` — قراءتان ماليّتان بحساب عائم.
    for (const source of [newSource, editSource]) {
      expect(source).not.toMatch(/Number\((?:openingAmount|signedOpen|c\.creditLimit|creditLimit|c\.currentBalance)/);
    }
  });

  it("تعرض الشاشتان نفس مجموعة الحقول المُسمّاة", () => {
    // حقل الواتساب كان في التعديل وحده، بينما الإضافة تُرسله ضمنياً = الهاتف الرئيسي ⇒ رقمٌ
    // يظهر عند أوّل تعديل ولم يره مُدخِله قطّ.
    expect(labeledFieldIds(newSource)).toEqual(labeledFieldIds(editSource));
    for (const source of [newSource, editSource]) {
      expect(source).toContain('<Label htmlFor="whatsapp">واتساب</Label>');
    }
  });

  it("يتبع واتساب الإضافة الهاتفَ الرئيسي حتى يُلمَس الحقل", () => {
    // شرط عدم الانحدار: مَن لم يلمس الحقل ترحل حمولته كما كانت (whatsapp = الهاتف الرئيسي).
    expect(newSource).toContain("if (!whatsappTouched) setWhatsapp(v);");
    expect(newSource).toContain("whatsapp: whatsapp.trim() || null,");
  });

  it("تقيس الشاشتان الانحراف بلقطةٍ مرجعية وتحرسان فقد البيانات بها", () => {
    // الإضافة كانت تقيس الانحراف بقائمة حقولٍ ناقصة (بلا سقف الائتمان ولا الواتساب)،
    // والتعديل بلقطةٍ من الخادم. اللقطة الواحدة تجعل الحارسَين يقيسان الشيء نفسه.
    for (const source of [newSource, editSource]) {
      expect(source).toContain("function dirtySnapshot(): string {");
      expect(source).toContain(
        "city, district, address, creditMode, creditLimit, notes, openingAmount, openingDir,",
      );
      expect(source).toContain("useUnsavedGuard(isDirty)");
    }
  });

  it("تمرّ كل مغادرة في الشاشتين بتأكيدٍ حين يحمل النموذج بيانات", () => {
    // تنقّل SPA لا يُطلق `beforeunload`، فرابط «إلغاء» في الإضافة كان يُفرّط بنموذجٍ معبَّأ
    // بضغطة Esc واحدة بلا سؤال. الزرّ (لا الرابط) يمرّ بـhandleCancel، ولذلك لا `backHref`.
    for (const source of [newSource, editSource]) {
      expect(source).toContain("async function handleCancel()");
      expect(source).toContain("onCancel: () => void handleCancel()");
      expect(source).toContain('variant: "warning"');
      expect(source).not.toMatch(/backHref=/);
    }
  });

  it("تحفظ الشاشتان دلالة سقف الائتمان الثلاثية بلا انقلاب صامت", () => {
    // قرار المالك: null=بلا حدّ، "0"=نقدي فقط **وهو الافتراضي**، رقم=سقف. الأوضاع نصّاً واحدة
    // في الشاشتين، والافتراضُ في الإضافة «نقدي فقط» لا «بلا حدّ».
    for (const source of [newSource, editSource]) {
      expect(source).toContain('type CreditMode = "none" | "limit" | "unlimited";');
      expect(source).toContain('creditLimitPayload = null;');
      expect(source).toContain('creditLimitPayload = "0"; // نقدي فقط.');
      // غير المدير لا يُرسل الحقل أصلاً ⇒ لا تُطمَس القيمة المخزّنة بقيمةٍ محجوبة.
      expect(source).toContain("creditLimitPayload = undefined;");
    }
    expect(newSource).toContain('useState<CreditMode>("none")');
    expect(editSource).toContain('if (c.creditLimit == null) { setCreditMode("unlimited"); setCreditLimit(""); }');
  });

  it("لا تُعلن بطاقة التعديل «بلا حدّ» على قيمةٍ محجوبة", () => {
    // `maskCustomerSensitive` يُرجع creditLimit=null لغير المدير — وقراءتُه «بلا حدّ» تُعلن
    // ائتماناً مفتوحاً لعميلٍ سقفُه «نقدي فقط». نفس حارس شاشة العملاء (`isElevated &&`).
    expect(editSource).toContain('{isElevated && c.creditLimit == null ? "بلا حدّ" : isElevated ? fmt(c.creditLimit) : "—"}');
    expect(editSource).toContain('{isElevated ? fmt(c.currentBalance) : "—"}');
  });

  it("يُبقي التماثلُ الفوارقَ المقصودة بحكم طبيعة الشاشة", () => {
    // الإضافة وحدها: مفتاح idempotency + تحذير التكرار الحيّ (`customers.findSimilar` بلا معامل
    // استثناءٍ للسجلّ نفسه ⇒ نقلُه للتعديل يجعل العميل تكراراً لنفسه).
    expect(newSource).toContain("clientRequestId");
    expect(newSource).toContain("trpc.customers.findSimilar.useQuery");
    expect(editSource).not.toContain("findSimilar");
    // التعديل وحده: بطاقة QR ودورة التعطيل/التفعيل — كلاهما يلزمه سجلٌّ قائم بمعرّف.
    expect(editSource).toContain("qrPayload");
    expect(editSource).toContain("trpc.customers.deactivate.useMutation");
    expect(newSource).not.toContain("deactivate");
  });
});
