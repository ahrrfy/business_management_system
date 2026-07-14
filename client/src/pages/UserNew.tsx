import { Button } from "@/components/ui/button";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import {
  AccountFields,
  accountPermsPayload,
  emptyAccountValue,
  validateAccount,
  type AccountFieldsValue,
} from "@/components/form/AccountFields";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ROLE_OPTIONS } from "./Users";

export default function UserNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [account, setAccount] = useState<AccountFieldsValue>(emptyAccountValue);
  const patch = (p: Partial<AccountFieldsValue>) => setAccount((a) => ({ ...a, ...p }));
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.data]);

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

  // عرض بطاقة المشاركة بعد الإنشاء
  if (createdInfo) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">إضافة مستخدم</h1>
          <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
        </div>
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة مستخدم</h1>
        <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <AccountFields value={account} onChange={patch} showName showJobData />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => buildAndSubmit()} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ المستخدم"}
        </Button>
        <Link href="/users"><Button variant="ghost">إلغاء</Button></Link>
      </div>
      <p className="text-xs text-muted-foreground">
        بعد الحفظ تظهر بطاقة لمشاركة بيانات الدخول عبر واتساب أو نسخها — ومنها يمكنك إضافة مستخدم آخر.
      </p>
    </div>
  );
}
