import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import {
  AccountFields,
  accountPermsPayload,
  emptyAccountValue,
  validateAccount,
  type AccountFieldsValue,
} from "@/components/form/AccountFields";
import { trpc } from "@/lib/trpc";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ROLE_OPTIONS } from "@/lib/roles";

export default function UserNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [account, setAccount] = useState<AccountFieldsValue>(emptyAccountValue);
  const patch = (p: Partial<AccountFieldsValue>) => setAccount((a) => ({ ...a, ...p }));
  // لقطة القيم «غير المعدَّلة يدوياً» (تتحرّك مع افتراضي الفرع التلقائي أدناه) — أساس حارس فقد
  // البيانات؛ لا تُقارَن الحالة الخام بـemptyAccountValue الثابتة كي لا يُنذر الحارس زوراً بمجرّد
  // امتلاء فرع المستخدم تلقائياً.
  const baselineRef = useRef<AccountFieldsValue>(emptyAccountValue);
  const [error, setError] = useState("");
  const [createdInfo, setCreatedInfo] = useState<{
    name: string; email: string; username?: string; password: string; phone?: string;
    roleLabel?: string; roleKey?: string | null; branchName?: string | null; jobTitle?: string | null; mustChangePassword?: boolean;
  } | null>(null);

  const branches = trpc.branches.list.useQuery();
  const rolesQ = trpc.roles.list.useQuery();
  const customRoles = rolesQ.data?.custom ?? [];

  // افتراضي: فرع المستخدم الحالي (يُقرأ من السياق حين يتوفر).
  const me = trpc.auth.me?.useQuery?.();
  useEffect(() => {
    if (me?.data?.branchId && account.branchId === "") {
      setAccount((a) => ({ ...a, branchId: me.data!.branchId as number }));
      // يُحدَّث الأساس بنفس التصحيح (لا حالة المستخدم الحيّة) — تلقائي لا تعديل يدوي.
      baselineRef.current = { ...baselineRef.current, branchId: me.data!.branchId as number };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.data]);

  const isDirty = JSON.stringify(account) !== JSON.stringify(baselineRef.current);
  // الحارس يُعطَّل بعد النجاح (شاشة مشاركة بيانات الدخول) — لا داعي للتحذير من فقد بياناتٍ حُفظت فعلاً.
  // createdInfo (لا مرجع) يكفي: الحقول نفسها لا تتغيّر بعد النجاح، والشاشة تعرض بطاقة المشاركة بدلاً
  // من النموذج (JSX مبكر أدناه) فلا يبقى الحارس مسجَّلاً على نموذجٍ غير معروض أصلاً.
  useUnsavedGuard(isDirty && !createdInfo);

  const create = trpc.users.create.useMutation({
    onSuccess: (_, vars) => {
      utils.users.list.invalidate();
      setCreatedInfo({
        name: vars.name,
        email: vars.email ?? "",
        username: vars.username ?? undefined,
        password: vars.password,
        phone: vars.phone ?? undefined,
        roleLabel: vars.customRoleId
          ? (customRoles.find((r: any) => Number(r.id) === vars.customRoleId)?.label ?? "دور مخصّص")
          : (ROLE_OPTIONS.find((r) => r.value === vars.role)?.label ?? vars.role),
        // مفتاح الدور يحدّد دومين رابط الدعوة (المندوب ⇒ تطبيق الدومين العام).
        roleKey: vars.customRoleId ? null : vars.role,
        branchName: vars.branchId ? branches.data?.find((b: any) => b.id === vars.branchId)?.name ?? null : null,
        jobTitle: vars.jobTitle ?? null,
        mustChangePassword: vars.mustChangePassword,
      });
    },
    onError: (e) => setError(e.message),
  });

  /** تفريغ النموذج لإضافة مستخدم آخر (من بطاقة المشاركة بعد النجاح). */
  function resetForm() {
    setAccount({ ...emptyAccountValue, branchId: (me?.data?.branchId as number) ?? "" });
    setError("");
  }

  function buildAndSubmit() {
    setError("");
    if (!account.name.trim()) { setError("الاسم مطلوب."); return; }
    const v = validateAccount(account);
    if (v) { setError(v); return; }
    // النجاح يعرض بطاقة المشاركة (CredentialsShare) عبر onSuccess — لا تنقّل هنا (يُخفي البطاقة).
    create.mutate({
      email: account.email.trim().toLowerCase() || undefined,
      username: account.username.trim().toLowerCase() || undefined,
      password: account.password,
      name: account.name.trim(),
      role: account.role,
      customRoleId: account.customRoleId ?? undefined,
      branchId: account.branchId === "" ? null : Number(account.branchId),
      phone: account.phone.trim() || null,
      jobTitle: account.jobTitle.trim() || null,
      hiredAt: account.hiredAt || null,
      permissionsOverride: accountPermsPayload(account),
      mustChangePassword: account.mustChangePassword,
    });
  }

  // Ctrl/⌘+S ⇒ حفظ. بلا onCancel/Esc عمداً — AccountFields مكتظّ بـ<select> أصلية (الدور/الفرع)
  // وEsc يتعارض مع إغلاقها (نفس تحذير الهوك). يبقى فعّالاً حتى بعد النجاح (createdInfo) — الحفظ
  // حينها لا معنى له فعلياً لأن الحقول مخفية خلف بطاقة المشاركة، فلا ضرر من تفعيله دائماً.
  useSaveShortcuts({ onSave: () => buildAndSubmit(), enabled: !create.isPending });

  // عرض بطاقة المشاركة بعد الإنشاء
  if (createdInfo) {
    return (
      <div className="space-y-4 max-w-2xl">
        <PageHeader title="إضافة مستخدم" backHref="/users" backLabel="رجوع للقائمة" />
        <CredentialsShare
          name={createdInfo.name}
          email={createdInfo.email}
          username={createdInfo.username}
          password={createdInfo.password}
          phone={createdInfo.phone}
          roleLabel={createdInfo.roleLabel}
          branchName={createdInfo.branchName}
          jobTitle={createdInfo.jobTitle}
          mustChangePassword={createdInfo.mustChangePassword}
          roleKey={createdInfo.roleKey}
          onClose={() => navigate("/users")}
        />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { setCreatedInfo(null); resetForm(); }}>إضافة مستخدم آخر</Button>
          <Link href="/users"><Button>العودة للقائمة</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="إضافة مستخدم" backHref="/users" backLabel="رجوع للقائمة" />

      {/* عنصر نموذج حقيقي يلفّ حقول الحفظ الفعلية (كان غائباً — يمنع حفظ متصفح/تعبئة تلقائية ويكسر
          دلالة Enter-to-submit، نمط UserEdit.tsx). AccountFields مكوّن مشترك خارج ملكيتي (يُستعمله
          أيضاً EmployeeNew) فيُلَفّ من هنا لا يُعدَّل هو نفسه. */}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); buildAndSubmit(); }}>
        <AccountFields value={account} onChange={patch} showName showJobData />

        {/* ما تملكه شاشة التعديل ولا تملكه هذه — يُسمّى بدل أن يغيب صامتاً.
            الغياب الصامت هو ما يجعل المُنشئ يظنّ الشاشة ناقصة، فيبحث عن الحقل حيث لا وجود له. */}
        <Card>
          <CardHeader><CardTitle className="text-base">ما يتاح بعد الإنشاء</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              الحقول أعلاه هي كل ما يقبله النظام عند الإنشاء. وما يلي لا مقابل له قبل وجود الحساب،
              فيُدار من «تعديل المستخدم» بعد الحفظ:
            </p>
            <ul className="list-disc ps-5 space-y-1">
              <li>
                <span className="text-foreground">صفة «مالك النظام»:</span> لا تُمنح عند الإنشاء —
                يمنحها مالكٌ قائم وحده من شاشة التعديل، فلا يستطيع مديرٌ أن يصنع مالكاً جديداً بنموذجٍ واحد.
              </li>
              <li>
                <span className="text-foreground">إصدار رمز استعادة كلمة المرور:</span> كلمة المرور هنا
                تُسلَّم مباشرةً في بطاقة المشاركة بعد الحفظ؛ الرمز لاحقاً لمن نسيها.
              </li>
              <li>
                <span className="text-foreground">إبطال الجلسات وتصفير المصادقة الثنائية:</span> لا جلسات
                ولا مصادقة ثنائية لحسابٍ لم يدخل بعد.
              </li>
              <li>
                <span className="text-foreground">تعطيل الحساب أو حذفه نهائياً:</span> يُنشأ الحساب مفعّلاً،
                والحذف مشروطٌ بخلوّه من أي نشاط.
              </li>
              <li>
                <span className="text-foreground">لوحة «الأثر الفعليّ» لهذا الحساب:</span> تُقرأ من الحساب
                المحفوظ. وقبل الحفظ تكفي معاينة «سيرى هذا الحساب» في بطاقة الدور أعلاه.
              </li>
            </ul>
          </CardContent>
        </Card>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap gap-2">
          {/* type="submit" وبلا onClick مباشر — onSubmit في <form> وحده مصدر الإرسال. */}
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "جارٍ الحفظ…" : "حفظ المستخدم"}
          </Button>
          <Link href="/users"><Button type="button" variant="ghost">إلغاء</Button></Link>
        </div>
        <p className="text-xs text-muted-foreground">
          بعد الحفظ تظهر بطاقة لمشاركة بيانات الدخول عبر واتساب أو نسخها — ومنها يمكنك إضافة مستخدم آخر.
        </p>
      </form>
    </div>
  );
}
