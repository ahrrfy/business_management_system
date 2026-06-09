import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/form/PasswordInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
import { PASSWORD_MIN_LEN, isStrongPassword } from "@shared/const";
import {
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  diffFromTemplate,
  resolvePermissions,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ROLE_OPTIONS } from "./Users";

/**
 * إضافة مستخدم — v3 add-screens.
 *
 * تصميم:
 *  - بيانات الدخول (بريد + كلمة مرور بإظهار/إخفاء + تأكيد).
 *  - بيانات HR: اسم + هاتف اتّصال + مسمى وظيفي + تاريخ توظيف.
 *  - الدور والفرع.
 *  - **محرّر صلاحيات تفاعلي**: يبدأ من قالب الدور، أيّ تخصيص يدوي يُوسم بـ«مخصّص».
 *
 * ملاحظة: مصادقة الدخول لا تزال بالبريد + كلمة مرور (لا تغيير في الـauth في هذه الشريحة).
 * الهاتف هنا اتّصال HR، ليس معرّف دخول.
 */

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STRONG_HINT = "٨ خانات على الأقل، يحتوي حرفاً ورقماً ورمزاً.";

export default function UserNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [hiredAt, setHiredAt] = useState("");
  const [role, setRole] = useState<RoleKey>("cashier");
  const [branchId, setBranchId] = useState<number | "">("");
  const [permsOverride, setPermsOverride] = useState<PermissionMap>({});
  const [error, setError] = useState("");

  const branches = trpc.branches.list.useQuery();

  // الصلاحيات الفعلية = قالب الدور + الـoverride الحالي.
  const resolvedPerms = useMemo(
    () => resolvePermissions(role, Object.keys(permsOverride).length ? permsOverride : null),
    [role, permsOverride]
  );

  const create = trpc.users.create.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      navigate("/users");
    },
    onError: (e) => setError(e.message),
  });

  function handlePermChange(moduleKey: string, level: AccessLevel) {
    // الحالة المخزّنة هي الـoverride (الانحراف عن القالب). نُحدّثها بحيث تعكس الفعليّ.
    const newResolved = { ...resolvedPerms, [moduleKey]: level };
    const newOverride = diffFromTemplate(role, newResolved) ?? {};
    setPermsOverride(newOverride);
  }

  function handlePermReset() {
    setPermsOverride({});
  }

  function handleRoleChange(next: RoleKey) {
    setRole(next);
    // مسح الـoverride عند تغيير الدور — حتى لا يحمل قيوداً غير قاصدة من قالب سابق.
    setPermsOverride({});
  }

  function submit() {
    setError("");
    if (!email.trim()) { setError("البريد الإلكتروني مطلوب."); return; }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("بريد إلكتروني غير صالح."); return; }
    if (!name.trim()) { setError("الاسم مطلوب."); return; }
    if (!isStrongPassword(password)) { setError(`كلمة المرور ضعيفة. ${STRONG_HINT}`); return; }
    if (password !== passwordConfirm) { setError("تأكيد كلمة المرور لا يطابق."); return; }
    if (hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAt)) { setError("تاريخ التوظيف غير صالح."); return; }

    const override = diffFromTemplate(role, resolvedPerms);

    create.mutate({
      email: email.trim().toLowerCase(),
      password,
      name: name.trim(),
      role,
      branchId: branchId === "" ? null : Number(branchId),
      phone: phone.trim() || null,
      jobTitle: jobTitle.trim() || null,
      hiredAt: hiredAt || null,
      permissionsOverride: override,
    });
  }

  const pwMismatch = passwordConfirm.length > 0 && password !== passwordConfirm;
  const customCount = Object.keys(permsOverride).length;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة مستخدم</h1>
        <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">بيانات الدخول</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني *</Label>
            <Input id="email" type="email" dir="ltr" autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@alroya.local" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pw">كلمة المرور *</Label>
            <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="new-password" />
            <p className="text-[11px] text-muted-foreground">{STRONG_HINT}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pw2">تأكيد كلمة المرور *</Label>
            <PasswordInput id="pw2" value={passwordConfirm} onChange={setPasswordConfirm} invalid={pwMismatch} autoComplete="new-password" />
            {pwMismatch && <p className="text-[11px] text-destructive">لا يطابق كلمة المرور.</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">البيانات الشخصية والوظيفية</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">الاسم الكامل *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: علي محمد حسين" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="phone">رقم هاتف الاتصال</Label>
            <IntlPhoneInput id="phone" value={phone} onChange={setPhone} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="job">المسمى الوظيفي</Label>
            <Input id="job" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مسؤول نقطة بيع" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hired">تاريخ التوظيف</Label>
            <Input id="hired" type="date" dir="ltr" value={hiredAt} onChange={(e) => setHiredAt(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">الدور والفرع</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="role">الدور</Label>
            <select id="role" className={selectCls} value={role} onChange={(e) => handleRoleChange(e.target.value as RoleKey)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              قالب الدور يحدّد الصلاحيات الافتراضية أدناه — يمكنك تخصيص أيّ وحدة.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="branch">الفرع</Label>
            <select id="branch" className={selectCls} value={String(branchId)} onChange={(e) => setBranchId(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            الصلاحيات
            {customCount > 0 && (
              <span className="text-[10px] font-medium text-primary mr-2 align-middle">
                {customCount} مخصّص
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PermissionMatrix
            role={role}
            permissions={resolvedPerms}
            onChange={handlePermChange}
            onReset={handlePermReset}
          />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ المستخدم"}
        </Button>
        <Link href="/users"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}

// تنبيه: المتغيرات المُستوردة (PERMISSION_MODULES, ROLE_TEMPLATES, PASSWORD_MIN_LEN)
// متروكة للتوافق ولاستخدامات لاحقة في حال أضفنا «معاينة» تظهر الفروق بين القالب والمخصّص.
void PERMISSION_MODULES; void ROLE_TEMPLATES; void PASSWORD_MIN_LEN;
