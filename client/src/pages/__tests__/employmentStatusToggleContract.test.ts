import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPLOYMENT_STATUSES, employmentStatusLabel } from "@shared/hr";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRepoFile = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

/**
 * العقد الحاكم لمبدّل حالة التوظيف في بطاقة الموظف:
 *
 *   **لكل حالةٍ يمكن الدخول إليها طريقُ خروجٍ في الشاشة نفسها.**
 *
 * كان زرّ «إعادة للعمل» مشروطاً بـ`isTerminated` وحده، فالموظف الموضوع على «في إجازة»
 * (وتطبيق أندرويد يضعه بضغطة — `HrAdminScreen.kt` فيه الزرّان معاً) يعلق فيها بلا مخرج:
 * الخيار الوحيد المعروض له في الويب كان «إنهاء الخدمة».
 *
 * والعلوق ليس تجميلياً — `employmentStatus='active'` شرطُ ظهورٍ في:
 *   · منتقي التسجيل اليدوي للحضور  (`attendanceService`)
 *   · تسجيل العهدة على الموظف       (`assets/lifecycle`)
 *   · قائمة المدراء المرشّحين        (`employeeService`)
 * ⇒ موظفٌ على رأس عمله يختفي من ثلاثة مسارات تشغيلية بسبب وسمٍ لا أحد يستطيع رفعه.
 *
 * الاختبارات نصّية عمداً (مرآة `invoiceEditorPaymentTermsContract.test.ts`): تحرس
 * **الوصلة** التي انكسرت فعلاً — شرطَ إظهار الزرّ — لا حساباً منطقياً.
 */
describe("عقد مبدّل حالة التوظيف في بطاقة الموظف", () => {
  const page = readPage("EmployeeDetail.tsx");

  it("«إعادة للعمل» يظهر لكل حالةٍ غير active — لا للمنتهي وحده", () => {
    // الشرط الحاكم: التفرّع على active لا على terminated.
    expect(page).toMatch(/e\.employmentStatus === "active" \? \(/);
    // خطّ الرجعة: لم يعد أيّ زرٍّ في الصفّ مشروطاً بـ`isTerminated ? (` حصراً.
    expect(page).not.toMatch(/\{isTerminated \? \(/);
  });

  it("الزرّان يغطّيان الاتجاهين: وضعٌ بإجازة وإعادةٌ للعمل", () => {
    expect(page).toMatch(/setStatus\.mutate\(\{ id, status: "leave" \}\)/);
    expect(page).toMatch(/setStatus\.mutate\(\{ id, status: "active" \}\)/);
  });

  it("كلا الاتجاهين خلف تأكيدٍ صريح — لا تغييرَ حالةٍ بضغطةٍ واحدة", () => {
    const leaveIdx = page.indexOf('status: "leave"');
    const activeIdx = page.indexOf('status: "active"');
    expect(leaveIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeGreaterThan(-1);
    // نافذة الشيفرة قبل كل استدعاء تحوي confirm() من مكتبة النظام (لا window.confirm).
    expect(page.slice(Math.max(0, leaveIdx - 600), leaveIdx)).toMatch(/await confirm\(\{/);
    expect(page.slice(Math.max(0, activeIdx - 600), activeIdx)).toMatch(/await confirm\(\{/);
  });

  it("«إنهاء الخدمة» يبقى خارج المبدّل — الراوتر يرفض terminated من هذا المسار", () => {
    const router = readRepoFile("server/routers/employeeRouter.ts");
    expect(router).toMatch(/input\.status === "terminated"/);
    // ولذلك لا يجوز أن يصير «terminated» أحد طرفَي المبدّل في الشاشة.
    expect(page).not.toMatch(/setStatus\.mutate\(\{ id, status: "terminated" \}\)/);
  });

  it("الحالات الثلاث وحدها معرّفة، و«leave» منها — فلا وسمَ بلا مخرج", () => {
    expect(EMPLOYMENT_STATUSES.map((s) => s.key)).toEqual(["active", "leave", "terminated"]);
    expect(employmentStatusLabel("leave")).toBe("في إجازة");
    expect(employmentStatusLabel("active")).toBe("على رأس العمل");
  });

  it("وحدة الإجازات لا تكتب employmentStatus — الوسم يدويّ فلا يرفعه أحدٌ تلقائياً", () => {
    // هذا هو سبب وجوب وجود زرٍّ يدويّ للرجوع: انتهاء طلب الإجازة لا يُعيده إلى active.
    expect(readRepoFile("server/services/leaveService.ts")).not.toMatch(/employmentStatus/);
  });
});
