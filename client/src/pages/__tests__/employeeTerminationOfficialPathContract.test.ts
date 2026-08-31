import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRouter = (name: string) =>
  readFileSync(new URL(`../../../../server/routers/${name}`, import.meta.url), "utf8");

/**
 * العقد الحاكم: **إنهاء الخدمة له مسارٌ واحد** — إجراء `promotions` بـMaker-Checker
 * وتسوية المستحقات النهائية (`/hr?tab=promotions`).
 *
 * بطاقة الموظف كانت تحمل نافذةَ إنهاءٍ كاملة (تاريخ + سبب + تأكيدٌ باسم الموظف) تنتهي
 * بـ`setStatus.mutate({ status: "terminated" })` — و`employeeRouter.setStatus` يرفض هذه
 * الحالة **صراحةً** ويحيل للمسار الرسميّ. أي: واجهةٌ مضمونةُ الفشل عند كل ضغطة، تُوهم
 * المستعمل أنّ للفصل طريقاً ثانياً بلا تسويةٍ ولا اعتمادٍ ثانٍ.
 *
 * والاختبار نصّيّ عمداً (مرآة `invoiceEditorPaymentTermsContract.test.ts`): يحرس **الوصلة**
 * بين شاشةٍ وعقدِ خادمٍ يرفضها — وهي وصلةٌ لا يمسّها اختبارُ سلوكٍ لأن الشاشة تُصيَّر بنجاح
 * والفشل لا يقع إلا على الشبكة.
 */
describe("عقد مسار إنهاء الخدمة الرسميّ", () => {
  it("الخادم يرفض `terminated` من `employees.setStatus` ويحيل للمسار الرسميّ", () => {
    // سببُ وجود هذا الملف كلّه. إن رُفع الرفض يوماً فهذه الاختبارات تُراجَع لا تُحذف.
    const router = readRouter("employeeRouter.ts");
    expect(router).toMatch(/input\.status === "terminated"/);
    expect(router).toMatch(/استخدم مسار إنهاء الخدمة الرسمي/);
  });

  it("بطاقة الموظف لا تستدعي `setStatus` بحالة `terminated`", () => {
    const page = readPage("EmployeeDetail.tsx");
    expect(page).not.toMatch(/status:\s*"terminated"/);
    expect(page).not.toMatch(/terminationDate:/);
    expect(page).not.toMatch(/terminationReason:\s*t/);
  });

  it("زرّ «إنهاء الخدمة» في بطاقة الموظف يُحيل إلى المسار الرسميّ", () => {
    const page = readPage("EmployeeDetail.tsx");
    expect(page).toMatch(/<Link href="\/hr\?tab=promotions">/);
    // الزرّ نفسه داخل الرابط — لا `onClick` يفتح نافذةً محلّية.
    expect(page).not.toMatch(/setOpenTerminate/);
    expect(page).not.toMatch(/openTerminate/);
  });

  it("لم تبقَ في البطاقة حالةُ نافذةِ الإنهاء ولا مكوّناتها المهجورة", () => {
    const page = readPage("EmployeeDetail.tsx");
    for (const dead of ["setTDate", "setTReason", "const today =", "<Dialog", "<Textarea", "<Input", "<Label"]) {
      expect(page, `«${dead}» ما زال في الصفحة`).not.toContain(dead);
    }
    // والاستيرادُ يتبع الاستعمال: بقاؤه يُبقي حزمةً أثقل وتحريراً مُغرياً لإعادة النافذة.
    for (const dead of ["ui/dialog", "ui/input", "ui/label", "ui/textarea"]) {
      expect(page, `استيراد «${dead}» بلا مستهلك`).not.toContain(dead);
    }
  });

  it("المسار الرسميّ يقع في تبويب الترقيات فعلاً", () => {
    // رابطٌ يقود إلى تبويبٍ غير موجود يُبدّل بابَين مسدودَين لا يُصلح واحداً.
    expect(readPage("HrHub.tsx")).toMatch(/value:\s*"promotions"/);
  });
});

/**
 * التحذير القَبْليّ كان يعيش في النافذة الميتة وحدها. الأثران اللذان يصفهما يقعان فعلاً
 * في `completeTermination` — تعطيلُ حساب الدخول، وحدُّ ربط جهاز الحضور بيوم العمل الأخير
 * (0207: **حدٌّ لا قطع**، وإلّا ضاعت نسبةُ بصمات ذلك اليوم = يومُ أجرٍ كامل). إسقاطُ النافذة
 * بلا نقلِ التحذير يُخفي فعلَين أمنيَّين عن مُنفِّذ الإجراء.
 */
describe("التحذير القَبْليّ لأثري الإكمال في المسار الرسميّ", () => {
  const page = readPage("Promotions.tsx");

  it("نافذة إنهاء الخدمة تعرض تحذيراً قَبْلياً مشروطاً بحقائق الموظف المُختار", () => {
    expect(page).toMatch(/data-testid="termination-preflight"/);
    expect(page).toMatch(/selectedTermEmp/);
    expect(page).toMatch(/selectedTermEmp\.userId != null/);
    expect(page).toMatch(/selectedTermEmp\.deviceLinked/);
  });

  it("التحذير يسمّي الأثرين: تعطيل الحساب، وحدّ ربط جهاز الحضور", () => {
    expect(page).toMatch(/تعطيل حساب دخوله للنظام/);
    expect(page).toMatch(/حدُّ ربطه بجهاز الحضور بيوم العمل الأخير/);
    // «تحرير الربط» وصفٌ صار كاذباً بعد 0207 — لا يعود إلى الشاشة.
    expect(page).not.toMatch(/تحرير ربطه بجهاز الحضور/);
  });

  it("التحذير يقول إنّ الأثرين يقعان عند الإكمال لا عند التسجيل", () => {
    // الإجراء ذو خطوتين (تسجيل ثم إكمال باعتماد ثانٍ)؛ نسبةُ الأثر للخطوة الخطأ
    // تجعل المُنفِّذ يظنّ الحساب معطَّلاً بينما الموظف ما زال يدخل ويبيع.
    expect(page).toMatch(/عند إكمال الإجراء \(لا عند تسجيله\)/);
  });

  it("الأثران يُصرَّح بهما بعد الإكمال أيضاً — الخدمة تُرجعهما", () => {
    expect(page).toMatch(/data\?\.userDisabled/);
    expect(page).toMatch(/data\?\.deviceLinksReleased/);
  });
});
