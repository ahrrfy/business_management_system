import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { UsagePanel } from "@/components/UsagePanel";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { isStrongPassword, PASSWORD_POLICY_MSG, USERNAME_POLICY_MSG, USERNAME_REGEX } from "@shared/const";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Check, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { ROLE_OPTIONS, ROLE_LABEL } from "./Users";
import {
  ROLES,
  ROLE_TEMPLATES,
  PERMISSION_MODULES,
  diffFromTemplate,
  resolvePermissions,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** يحوّل تاريخاً قادماً من الخادم (Date عبر superjson أو سلسلة) إلى yyyy-mm-dd لحقل type=date. */
function toDateInput(d: unknown): string {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  try {
    return new Date(d as Date).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/** فروق الصلاحيات عن قالب الدور — تُعرض فوق المصفوفة (مطابق لشاشة الإضافة). */
function PermDiffSummary({ role, override }: { role: RoleKey; override: PermissionMap }) {
  const entries = Object.entries(override);
  if (!entries.length) return null;
  const base = ROLE_TEMPLATES[role];
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {entries.map(([k, v]) => {
        const mod = PERMISSION_MODULES.find((m) => m.key === k);
        const prev = base[k] ?? "NONE";
        const label = v === "FULL" ? "كامل" : v === "READ" ? "قراءة" : "لا وصول";
        const prevLabel = prev === "FULL" ? "كامل" : prev === "READ" ? "قراءة" : "لا وصول";
        return (
          <span key={k} className="text-[10px] rounded bg-primary/10 text-primary px-1.5 py-0.5">
            {mod?.label ?? k}: {prevLabel} ← {label}
          </span>
        );
      })}
    </div>
  );
}

export default function UserEdit() {
  const [, params] = useRoute<{ id: string }>("/users/:id/edit");
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const userId = Number(params?.id ?? 0);

  const detail = trpc.users.get.useQuery({ userId }, { enabled: userId > 0 });
  const usage = trpc.users.usage.useQuery({ userId }, { enabled: userId > 0 });
  const branches = trpc.branches.list.useQuery();
  const rolesQ = trpc.roles.list.useQuery();
  const customRoles = rolesQ.data?.custom ?? [];

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [usernameChecked, setUsernameChecked] = useState(false);
  const [role, setRole] = useState<RoleKey>("cashier");
  const [customRoleId, setCustomRoleId] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [hiredAt, setHiredAt] = useState("");
  const [permsOverride, setPermsOverride] = useState<PermissionMap>({});
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [mustChangeOnReset, setMustChangeOnReset] = useState(true);
  const [resetShare, setResetShare] = useState<{ password: string; email: string; username?: string; name: string; phone?: string } | null>(null);

  useEffect(() => {
    if (detail.data && !loaded) {
      const u = detail.data;
      setName(u.name ?? "");
      setEmail(u.email ?? "");
      setUsername((u as { username?: string | null }).username ?? "");
      setRole((u.role as RoleKey) ?? "cashier");
      setCustomRoleId((u as { customRoleId?: number | null }).customRoleId ?? null);
      setBranchId(u.branchId ? String(u.branchId) : "");
      setPhone((u as { phone?: string | null }).phone ?? "");
      setJobTitle((u as { jobTitle?: string | null }).jobTitle ?? "");
      setHiredAt(toDateInput((u as { hiredAt?: unknown }).hiredAt));
      setPermsOverride(((u as { permissionsOverride?: PermissionMap | null }).permissionsOverride as PermissionMap) ?? {});
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  function invalidate() {
    return Promise.all([utils.users.list.invalidate(), utils.users.get.invalidate({ userId })]);
  }

  const update = trpc.users.update.useMutation({
    onSuccess: async () => { setDone("تمّ حفظ التعديلات بنجاح."); await invalidate(); },
    onError: (e) => setError(e.message),
  });
  const setActive = trpc.users.setActive.useMutation({
    onSuccess: async () => { await invalidate(); },
    onError: (e) => setError(e.message),
  });
  const del = trpc.users.delete.useMutation({
    onSuccess: async () => { await utils.users.list.invalidate(); navigate("/users"); },
    onError: (e) => setError(e.message),
  });
  const resetPassword = trpc.users.resetPassword.useMutation({
    onSuccess: (_, vars) => {
      setPwMsg("تمّت إعادة تعيين كلمة المرور؛ أُبطِلت جلسات المستخدم.");
      setResetShare({
        password: vars.newPassword,
        email: detail.data?.email ?? "",
        username: (detail.data as { username?: string | null })?.username ?? undefined,
        name: detail.data?.name ?? "",
        phone: (detail.data as any)?.phone ?? undefined,
      });
      setNewPassword("");
    },
    onError: (e) => setPwMsg(e.message),
  });
  const resolvedPerms = useMemo(
    () => resolvePermissions(role, Object.keys(permsOverride).length ? permsOverride : null),
    [role, permsOverride]
  );

  function handleRoleChange(val: string) {
    if (val.startsWith("custom:")) {
      setCustomRoleId(Number(val.slice(7))); // دور مخصّص — صلاحياته محفوظة فيه
    } else {
      setCustomRoleId(null);
      setRole(val as RoleKey);
      setPermsOverride({}); // اختيار دور مبني يعيد الصلاحيات لقالبه
    }
  }

  function handlePermChange(moduleKey: string, level: AccessLevel) {
    const newResolved = { ...resolvedPerms, [moduleKey]: level };
    setPermsOverride(diffFromTemplate(role, newResolved) ?? {});
  }

  async function handleGeneratePassword() {
    try {
      const res = await utils.users.generatePassword.fetch();
      setNewPassword(res.password);
    } catch {
      const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$%!";
      setNewPassword(Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
    }
  }

  async function checkUsernameFn() {
    const v = username.trim().toLowerCase();
    if (!v) { setUsernameError(""); setUsernameChecked(false); return; }
    if (!USERNAME_REGEX.test(v)) {
      setUsernameError(USERNAME_POLICY_MSG);
      setUsernameChecked(false);
      return;
    }
    try {
      const ok = await utils.users.checkUsername.fetch({ username: v, excludeUserId: userId });
      setUsernameError(ok ? "" : "اسم المستخدم مستخدم مسبقاً.");
      setUsernameChecked(true);
    } catch { setUsernameChecked(false); }
  }

  function submit() {
    setError(""); setDone("");
    if (!name.trim()) return setError("الاسم مطلوب.");
    if (usernameError) return setError(usernameError);
    const emailV = email.trim().toLowerCase();
    const usernameV = username.trim().toLowerCase();
    if (!emailV && !usernameV) return setError("يجب إبقاء بريد إلكتروني أو اسم مستخدم واحد على الأقل.");
    if (emailV && !/^\S+@\S+\.\S+$/.test(emailV)) return setError("بريد إلكتروني غير صالح.");
    if (usernameV && !USERNAME_REGEX.test(usernameV)) return setError(USERNAME_POLICY_MSG);
    if (hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAt)) return setError("تاريخ التوظيف غير صالح.");
    const override = customRoleId ? null : diffFromTemplate(role, resolvedPerms);
    // نرسل القيمتين دائماً: "" ⇒ مسح المعرّف صراحةً (الخادم يضمن بقاء معرّف واحد على الأقل).
    update.mutate({
      userId,
      name: name.trim(),
      email: emailV,
      username: usernameV,
      role,
      customRoleId,
      branchId: branchId ? Number(branchId) : null,
      phone: phone.trim() || null,
      jobTitle: jobTitle.trim() || null,
      hiredAt: hiredAt || null,
      permissionsOverride: override,
    });
  }

  async function doReset() {
    setPwMsg(""); setResetShare(null);
    if (!isStrongPassword(newPassword)) return setPwMsg(PASSWORD_POLICY_MSG);
    if (!(await confirm({
      variant: "warning",
      title: "إعادة تعيين كلمة المرور",
      description: `سيتم تعيين كلمة مرور جديدة لـ«${name || u?.email || `#${userId}`}» وإبطال كل جلساته الحالية فوراً. هل تتابع؟`,
      confirmText: "إعادة التعيين",
    }))) return;
    resetPassword.mutate({ userId, newPassword, mustChangePassword: mustChangeOnReset });
  }

  async function handleDelete() {
    setError("");
    if (!usage.data?.clean) return;
    const label = name || u?.email || `#${userId}`;
    if (!(await confirm({
      variant: "danger",
      title: "حذف المستخدم نهائياً",
      description: `سيُحذف «${label}» نهائياً من القاعدة ولا يمكن التراجع. (متاح لأنّ الحساب نظيف بلا أي نشاط.) هل تتابع؟`,
      confirmText: "حذف نهائياً",
    }))) return;
    del.mutate({ userId });
  }

  const roleInfo = ROLES.find((r) => r.key === role);
  const customCount = Object.keys(permsOverride).length;

  if (!userId) return <div className="p-6 text-center text-muted-foreground">معرّف مستخدم غير صالح.</div>;
  if (detail.isLoading) return <LoadingState message="جارٍ تحميل بيانات المستخدم…" />;
  if (!detail.data) return <div className="p-6 text-center text-muted-foreground">المستخدم غير موجود. <Link className="text-primary underline" href="/users">رجوع للقائمة</Link></div>;

  const u = detail.data;
  const isActive = !!u.isActive;

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader
        title="تعديل مستخدم"
        actions={<Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">بطاقة المستخدم</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المعرّف</div><div className="font-mono" dir="ltr">#{Number(u.id)}</div></div>
          <div><div className="text-muted-foreground text-xs">اسم المستخدم</div><div className="font-mono" dir="ltr">{(u as { username?: string | null }).username || "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">الدور الحالي</div><div>{ROLE_LABEL[u.role] ?? u.role}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}>
              {isActive ? "مفعّل" : "معطّل"}
            </span>
          </div>
          {(u as any).mustChangePassword && (
            <div>
              <div className="text-muted-foreground text-xs">كلمة المرور</div>
              <span className="text-xs text-[var(--stock-low)] font-medium inline-flex items-center gap-1"><AlertTriangle aria-hidden className="size-3.5" />تغيير إلزامي</span>
            </div>
          )}
          <div className="col-span-2 md:col-span-1 md:row-span-2 flex justify-center md:justify-end">
            <BarcodeDisplay
              barcodeSet={{ barcode128: `USER-${Number(u.id)}`, qrPayload: `USER-${Number(u.id)}`, displayLabel: `${u.name ?? ""}\nUSER-${Number(u.id)}` }}
              size="sm"
              showCode128={false}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">الاسم *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="username">اسم المستخدم (للدخول)</Label>
            <Input
              id="username" dir="ltr" value={username}
              onChange={(e) => { setUsername(e.target.value); setUsernameChecked(false); setUsernameError(""); }}
              onBlur={() => void checkUsernameFn()}
              placeholder="مثال: marwa.ibrahim"
              className={usernameError ? "border-destructive" : usernameChecked && !usernameError ? "border-[var(--status-active)]" : ""}
            />
            {usernameError && <p className="text-[11px] text-destructive">{usernameError}</p>}
            {usernameChecked && !usernameError && username.trim() && <p className="text-[11px] text-money-positive inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" />اسم المستخدم متاح</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني <span className="text-muted-foreground font-normal">(اختياري)</span></Label>
            <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@alroya.local" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role">الدور</Label>
            <select
              id="role" className={selectCls}
              value={customRoleId ? `custom:${customRoleId}` : role}
              onChange={(e) => handleRoleChange(e.target.value)}
            >
              <optgroup label="أدوار النظام">
                {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </optgroup>
              {customRoles.length > 0 && (
                <optgroup label="أدوار مخصّصة">
                  {customRoles.map((r: any) => <option key={r.id} value={`custom:${r.id}`}>{r.label}</option>)}
                </optgroup>
              )}
            </select>
            {customRoleId ? (
              <p className="text-[11px] text-muted-foreground">دور مخصّص — صلاحياته تُدار من شاشة «الأدوار والصلاحيات».</p>
            ) : roleInfo ? <p className="text-[11px] text-muted-foreground">{roleInfo.description}</p> : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="branch">الفرع</Label>
            <select id="branch" className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">— بلا فرع —</option>
              {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* البيانات الوظيفية */}
      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الوظيفية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="phone">رقم هاتف الاتصال</Label>
            <IntlPhoneInput id="phone" value={phone} onChange={setPhone} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="job">المسمى الوظيفي</Label>
            <Input id="job" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: كاشير / محاسب" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hired">تاريخ التوظيف</Label>
            <Input id="hired" type="date" dir="ltr" value={hiredAt} onChange={(e) => setHiredAt(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {/* الصلاحيات */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            الصلاحيات
            {!customRoleId && customCount > 0 && (
              <span className="text-[10px] font-medium text-primary mr-2 align-middle">
                {customCount} مخصّص
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {customRoleId ? (
            <p className="text-sm text-muted-foreground">صلاحيات الدور المخصّص محفوظة في تعريفه — عدّلها من شاشة «الأدوار والصلاحيات».</p>
          ) : (
            <>
              <PermDiffSummary role={role} override={permsOverride} />
              <PermissionMatrix
                role={role}
                permissions={resolvedPerms}
                onChange={handlePermChange}
                onReset={() => setPermsOverride({})}
              />
            </>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-money-positive">{done}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={update.isPending}>
          {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}
        </Button>
        {isActive ? (
          <Button
            variant="outline"
            onClick={() => void (async () => {
              if (!(await confirm({ variant: "danger", title: "تعطيل المستخدم", description: `لن يستطيع «${name || u.email}» الدخول وتُبطَل جلساته فوراً. هل تتابع؟`, confirmText: "تعطيل" }))) return;
              setActive.mutate({ userId, isActive: false });
            })()}
            disabled={setActive.isPending}
          >
            {setActive.isPending ? "…" : "تعطيل المستخدم"}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setActive.mutate({ userId, isActive: true })} disabled={setActive.isPending}>
            {setActive.isPending ? "…" : "إعادة تفعيل"}
          </Button>
        )}
        <Link href="/users"><Button variant="ghost">رجوع</Button></Link>
      </div>

      {/* إعادة تعيين كلمة المرور */}
      <Card>
        <CardHeader><CardTitle className="text-base">إعادة تعيين كلمة المرور</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            يضبط كلمة مرور جديدة ويُبطل كل جلسات المستخدم الحالية.
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="space-y-1 flex-1 min-w-[200px]">
              <div className="flex items-center justify-between">
                <Label htmlFor="newpw">كلمة المرور الجديدة</Label>
                <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2 inline-flex items-center gap-1" onClick={handleGeneratePassword}>
                  <Zap aria-hidden className="size-3.5" />توليد
                </Button>
              </div>
              <Input id="newpw" type="text" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="12 خانة على الأقل" className="font-mono" />
            </div>
            <Button variant="outline" onClick={doReset} disabled={resetPassword.isPending}>
              {resetPassword.isPending ? "…" : "إعادة التعيين"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="mustChangeReset" className="size-4" checked={mustChangeOnReset} onChange={(e) => setMustChangeOnReset(e.target.checked)} />
            <Label htmlFor="mustChangeReset" className="font-normal cursor-pointer text-sm">إلزام تغيير الكلمة عند أول دخول (72 ساعة)</Label>
          </div>
          {pwMsg && <p className={`text-sm ${resetPassword.isSuccess ? "text-money-positive" : "text-destructive"}`}>{pwMsg}</p>}
          {resetShare && (
            <CredentialsShare
              name={resetShare.name}
              email={resetShare.email}
              username={resetShare.username}
              password={resetShare.password}
              phone={resetShare.phone}
              onClose={() => setResetShare(null)}
            />
          )}
        </CardContent>
      </Card>

      {/* الحذف النهائي — للنظيف فقط */}
      <Card className="border-destructive/40">
        <CardHeader><CardTitle className="text-base text-destructive">الحذف النهائي</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            يُحذف الحساب نهائياً من القاعدة ولا يمكن التراجع. متاح فقط للحساب «النظيف» (بلا أيّ نشاط أو ارتباط).
            البديل الآمن القابل للتراجع: «تعطيل المستخدم» أعلاه.
          </p>
          <UsagePanel usage={usage.data} />
          <Button
            variant="outline"
            className="text-destructive border-destructive/50 hover:bg-destructive/10"
            disabled={usage.isLoading || !usage.data?.clean || del.isPending}
            onClick={() => void handleDelete()}
          >
            {del.isPending ? "جارٍ الحذف…" : "حذف نهائياً"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
