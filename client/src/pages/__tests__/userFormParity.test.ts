import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const newSource = readFileSync(new URL("../UserNew.tsx", import.meta.url), "utf8");
const editSource = readFileSync(new URL("../UserEdit.tsx", import.meta.url), "utf8");
const accountFieldsSource = readFileSync(
  new URL("../../components/form/AccountFields.tsx", import.meta.url),
  "utf8",
);
const userRouterSource = readFileSync(
  new URL("../../../../server/routers/userRouter.ts", import.meta.url),
  "utf8",
);
// الخدمةُ مقروءةٌ هنا عمداً: التحذير في الشاشة يقتبس **رسالة الخادم التي سيراها المستخدم**،
// فأيُّ تعديلٍ لنصّها في الخدمة يجب أن يُحمِّر هذا الملفّ لا أن يترك الشاشة تقتبس نصّاً ميتاً.
const userServiceSource = readFileSync(
  new URL("../../../../server/services/userService.ts", import.meta.url),
  "utf8",
);
const passwordResetSource = readFileSync(
  new URL("../../../../server/services/passwordResetService.ts", import.meta.url),
  "utf8",
);

/**
 * شاشتا المستخدم انحرفتا حتى صار فارقُهما ٤.٢× سطراً. هذه الحزمة تثبّت ما وُحّد، وتثبّت كذلك ما
 * **يجب أن يبقى مختلفاً** — فالفارق الباقي مقصودٌ ومُعلَّل، ومَن يوحّده لاحقاً «إتماماً للتماثل»
 * يفتح ثغرةً أمنية أو ينسخ نصّاً كاذباً. لذلك تُقاس هنا بنصّها لا بالنيّة.
 *
 * الفخّ الحاكم: حقلٌ يُضاف للشاشة ويُرسَل في الحمولة بينما عقد الراوتر لا يقبله ⇒ zod يُسقطه
 * صامتاً فيبدو الإصلاح واقعاً وهو وهم. لذلك تُقاس الحمولةُ مقابل عقد `userRouter` نفسه أدناه.
 */
describe("تماثل نموذجَي المستخدم (إضافة/تعديل)", () => {
  it("يحرس النموذجين معاً من فقد البيانات غير المحفوظة بلقطةٍ مرجعية لا بحالةٍ فارغة", () => {
    for (const source of [newSource, editSource]) {
      expect(source).toContain('import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";');
      expect(source).toContain("baselineRef");
      expect(source).toMatch(/useUnsavedGuard\(isDirty/);
    }
    // التعبئة الأولى من الخادم ليست تغييراً من المستخدم؛ مقارنتها بحالةٍ فارغة تُطلق التحذير على
    // كل فتحٍ للشاشة حتى بلا لمس حقل، والتحذير الكاذب يُدرّب المستخدم على تجاهله.
    expect(editSource).toContain("!== baselineRef.current");
  });

  it("يفحص الشاشتان توفّر البريد واسم المستخدم قبل الحفظ لا بعده", () => {
    // كان الفحص في الإضافة وحدها ⇒ تعديل البريد إلى بريدٍ مأخوذ لا يُكتشف إلا برسالة خادمٍ
    // بعد كتابة النموذج كلّه.
    expect(accountFieldsSource).toContain("utils.users.checkEmail.fetch");
    expect(editSource).toContain("utils.users.checkEmail.fetch({ email: v, excludeUserId: userId })");
    expect(editSource).toContain("utils.users.checkUsername.fetch");
    // excludeUserId إلزاميّ في التعديل وإلا بُلِّغ بريدُ الحساب نفسه «مأخوذاً» على كل فتح.
    expect(editSource).toContain("excludeUserId: userId");
  });

  it("تملك الشاشتان زرّ توليد اسم المستخدم (التفرّد خادميّ لا عميلّي)", () => {
    for (const source of [accountFieldsSource, editSource]) {
      expect(source).toContain("utils.users.suggestUsername.fetch");
    }
    expect(editSource).toContain("توليد تلقائي");
  });

  it("تُنذر شاشة التعديل من «بلا فرع» بقاعدة الخادم لا بقائمة الأدوار الناقصة", () => {
    // ⚠️ فارقٌ مقصود عن `BRANCH_WARN_ROLES` الخماسية في AccountFields: تفوت مدير الفرع
    // والمحاسب والمدقّق والمندوب والمستخدم العام، ونصُّها يقول عكس ما ينفّذه الخادم.
    //
    // ⭐ **والمرجع قاعدةُ الحفظ لا قاعدةُ التشغيل** — وهذا ما أخطأته النسخةُ الأولى: كتبت
    // `&& !isOwner` قياساً على `canCrossBranches` (وقتَ التشغيل)، بينما الذي يقع أوّلاً هو
    // `assertUserBranchAssignmentTx` فيرفض **الحفظ** على `role !== "admin"` وحدها. فكان
    // مديرٌ مُنِح صفةَ المالك ثمّ مُسِح فرعُه يرى صفر تحذيرٍ ثمّ يصطدم برفضٍ غير مُفسَّر.
    expect(editSource).toContain('return role !== "admin";');
    expect(editSource).not.toContain('role !== "admin" && !isOwner');
    // والنصُّ يقتبس رسالة الخادم التي سيراها فعلاً، لا رسالةَ حارسٍ آخر لا يبلغه.
    expect(editSource).toContain("الحساب غير الإداري يجب أن يرتبط بفرع");
    expect(userServiceSource).toContain("الحساب غير الإداري يجب أن يرتبط بفرع");
    // القياس على نسخِ القائمة لا على ذكرها — تعليقُ UserEdit يسمّيها عمداً ليشرح سببَ الاختلاف.
    expect(accountFieldsSource).toContain("const BRANCH_WARN_ROLES: RoleKey[]");
    expect(editSource).not.toContain("const BRANCH_WARN_ROLES");
    expect(editSource).not.toContain('"print_operator", "purchasing", "sales_rep"');
    expect(editSource).not.toContain("لتجنّب الوصول لكل الفروع");
  });

  it("لا ترسل شاشة الإنشاء صفةَ المالك — العقد لا يقبلها", () => {
    // `users.create` بلا isOwner (المنحُ حكرٌ على مالكٍ قائم من شاشة التعديل، وحارساه في
    // userService). إرسالها هنا يُسقطه zod صامتاً فيبدو الحقل عاملاً وهو وهم.
    const createInput = userRouterSource.slice(
      userRouterSource.indexOf("create: adminProcedure"),
      userRouterSource.indexOf("update: adminProcedure"),
    );
    expect(createInput).not.toContain("isOwner");
    expect(newSource).not.toContain("isOwner");
    // ويُسمّى غيابُه للمُنشئ بدل أن يصمت.
    expect(newSource).toContain("صفة «مالك النظام»");
  });

  it("لا ترسل شاشة التعديل mustChangePassword — العقد لا يقبله، فيُعرض للقراءة بسببه", () => {
    const updateInput = userRouterSource.slice(
      userRouterSource.indexOf("update: adminProcedure"),
      userRouterSource.indexOf("usage: adminProcedure"),
    );
    expect(updateInput).not.toContain("mustChangePassword");
    const updatePayload = editSource.slice(
      editSource.indexOf("update.mutate({"),
      editSource.indexOf("update.mutate({") + 900,
    );
    expect(updatePayload).not.toContain("mustChangePassword");
    // يُعرض للقراءة مع سببٍ مكتوب — لا يختفي.
    expect(editSource).toContain('aria-describedby="user-mustchange-lock"');
    expect(editSource).toContain('id="user-mustchange-lock"');
    // ⭐ والنصُّ يجب أن يصف ما يفعله الكود لا ما يبدو معقولاً: `issuePasswordResetToken`
    // **لا يمسّ العمود إطلاقاً** — كاتباه الوحيدان `createUserTx` (رفعاً) و
    // `consumePasswordResetToken`/`recoverLastAdminAccess` (خفضاً). كانت النسخةُ الأولى تَعِد
    // بأنّ «كل رمز استعادةٍ يُصدَر يُعيد ضبطه»، فيُصدر المديرُ رمزاً وينتظر إلزاماً لا يقع.
    expect(editSource).toMatch(/id="user-mustchange-lock"[\s\S]{0,400}يُرفَع عند إنشاء الحساب وحده/);
    expect(editSource).not.toContain("ويُعاد ضبطه مع كل رمز استعادة");
    const issueFn = passwordResetSource.slice(
      passwordResetSource.indexOf("export async function issuePasswordResetToken"),
      passwordResetSource.indexOf("export async function consumePasswordResetToken"),
    );
    expect(issueFn.length).toBeGreaterThan(0);
    expect(issueFn).not.toContain("mustChangePassword");
  });

  it("تشرح شاشة التعديل غياب حقل كلمة المرور بدل أن تُسقطه صامتاً", () => {
    // الحجب أمنيّ ويبقى: المدير لا يختار كلمة مستخدمٍ آخر ولا يراها.
    expect(editSource).toContain("ولا حقلَ لكلمة المرور في هذه الشاشة");
    expect(editSource).toContain("رمزاً أحادي الاستخدام");
    expect(editSource).not.toContain("users.resetPassword");
  });

  it("تسمّي شاشة الإنشاء ما لا معنى له قبل وجود الحساب بدل إخفائه", () => {
    for (const mention of [
      "إصدار رمز استعادة كلمة المرور",
      "إبطال الجلسات وتصفير المصادقة الثنائية",
      "تعطيل الحساب أو حذفه نهائياً",
    ]) {
      expect(newSource).toContain(mention);
    }
  });

  it("يعرض اختفاءُ مصفوفة الصلاحيات على الدور المخصّص مخرجاً لا فراغاً", () => {
    // الاختفاء مقصود (الصلاحيات في تعريف الدور لا فرقاً فوقه)، لكنّ تسمية الشاشة بلا رابطٍ
    // إليها بابُ خروجٍ مسدود.
    expect(editSource).toContain("href={`/roles/${customRoleId}/edit`}");
    expect(accountFieldsSource).toContain("صلاحيات هذا الدور محفوظة فيه");
  });

  it("يُبقي كلتا الشاشتين على نموذجٍ حقيقيّ واختصار الحفظ", () => {
    for (const source of [newSource, editSource]) {
      expect(source).toContain("<form");
      expect(source).toContain("onSubmit={(e) => { e.preventDefault();");
      expect(source).toContain('import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";');
    }
  });
});
