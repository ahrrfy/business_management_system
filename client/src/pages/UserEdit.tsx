import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { UsagePanel } from "@/components/UsagePanel";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { USERNAME_POLICY_MSG, USERNAME_REGEX } from "@shared/const";
import { ACTION_LABELS } from "@shared/actionLabels";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { fmtDateTime } from "@/lib/date";
import { describeUserAgent } from "@/lib/userAgent";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { AlertTriangle, Check, Copy, Monitor } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { ROLE_LABEL, ROLE_OPTIONS } from "@/lib/roles";
import { EffectiveAccessForAssignment } from "@/components/form/EffectiveAccessPreview";
import { EffectivePermissionsPanel } from "@/components/form/EffectivePermissionsPanel";
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

  const me = trpc.auth.me.useQuery();
  const meIsOwner = !!(me.data as any)?.isOwner;
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
  const [isOwner, setIsOwner] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [resetToken, setResetToken] = useState("");
  const [resetExpiresAt, setResetExpiresAt] = useState<Date | string | null>(null);
  const [resetMsg, setResetMsg] = useState("");
  const [resetCopied, setResetCopied] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState("");

  // لقطة القيم عند التحميل (وبعد كل حفظ ناجح) — أساس مقارنة حارس فقد البيانات (useUnsavedGuard).
  // مبنيّة من سجلّ الخادم مباشرةً (لا من الحالة) لتفادي سباق التحديثات المُجمَّعة عند setLoaded.
  const baselineRef = useRef<string>("");

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
      setIsOwner(!!(u as { isOwner?: boolean }).isOwner);
      baselineRef.current = JSON.stringify({
        name: u.name ?? "", email: u.email ?? "", username: (u as { username?: string | null }).username ?? "",
        role: (u.role as RoleKey) ?? "cashier", customRoleId: (u as { customRoleId?: number | null }).customRoleId ?? null,
        branchId: u.branchId ? String(u.branchId) : "", phone: (u as { phone?: string | null }).phone ?? "",
        jobTitle: (u as { jobTitle?: string | null }).jobTitle ?? "", hiredAt: toDateInput((u as { hiredAt?: unknown }).hiredAt),
        permsOverride: ((u as { permissionsOverride?: PermissionMap | null }).permissionsOverride as PermissionMap) ?? {},
        isOwner: !!(u as { isOwner?: boolean }).isOwner,
      });
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  const isDirty = loaded && JSON.stringify({
    name, email, username, role, customRoleId, branchId, phone, jobTitle, hiredAt, permsOverride, isOwner,
  }) !== baselineRef.current;
  useUnsavedGuard(isDirty);

  function invalidate() {
    return Promise.all([utils.users.list.invalidate(), utils.users.get.invalidate({ userId })]);
  }

  const update = trpc.users.update.useMutation({
    onSuccess: async () => {
      setDone("تمّ حفظ التعديلات بنجاح.");
      // الحفظ نجح ⇒ الحالة الحالية هي الأساس الجديد (وإلا يبقى الحارس يُنذر بفقد بيانات محفوظة فعلاً).
      baselineRef.current = JSON.stringify({
        name, email, username, role, customRoleId, branchId, phone, jobTitle, hiredAt, permsOverride, isOwner,
      });
      await invalidate();
    },
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
  const issueResetToken = trpc.users.issuePasswordResetToken.useMutation({
    onSuccess: (data) => {
      setResetToken(data.token);
      setResetExpiresAt(data.expiresAt);
      setResetCopied(false);
      setResetMsg("صدر الرمز. انسخه الآن؛ لن يعرضه النظام مرة أخرى.");
    },
    onError: (e) => setResetMsg(e.message),
  });
  const revokeSessions = trpc.users.revokeSessions.useMutation({
    onSuccess: () => setRevokeMsg("أُبطِلت كل جلسات المستخدم — سيُطلَب منه الدخول من جديد."),
    onError: (e) => setRevokeMsg(e.message),
  });
  const reset2fa = trpc.users.resetTwoFactor.useMutation({
    onSuccess: () => setRevokeMsg("صُفِّرت المصادقة الثنائية وأُبطِلت جلسات المستخدم — يدخل الآن بكلمة المرور وحدها."),
    onError: (e) => setRevokeMsg(e.message),
  });
  const userSessions = trpc.users.sessions.useQuery({ userId }, { enabled: userId > 0 });
  const revokeOneSession = trpc.users.revokeSession.useMutation({
    onSuccess: async () => { await utils.users.sessions.invalidate({ userId }); },
  });
  const resolvedPerms = useMemo(
    () => resolvePermissions(role, Object.keys(permsOverride).length ? permsOverride : null),
    [role, permsOverride]
  );

  // Ctrl/⌘+S ⇒ حفظ. بلا onCancel/Esc عمداً — الشاشة مكتظّة بقوائم منسدلة (الدور/الفرع) وEsc
  // يتعارض مع إغلاقها (تحذير الهوك نفسه).
  useSaveShortcuts({ onSave: () => submit(), enabled: !update.isPending });

  async function handleRoleChange(val: string) {
    if (val.startsWith("custom:")) {
      setCustomRoleId(Number(val.slice(7))); // دور مخصّص — صلاحياته محفوظة فيه
    } else {
      // اختيار دور مبني يعيد الصلاحيات لقالبه ويمسح أي تخصيص يدوي حالي — تأكيدٌ صريح إن كان
      // ثمّة تخصيصٌ فعلي ليخسره (كان يُمسَح صامتاً بلا تحذير).
      if (Object.keys(permsOverride).length > 0 && !(await confirm({
        variant: "warning",
        title: "تغيير الدور الأساسي",
        description: "سيُعاد ضبط الصلاحيات المخصَّصة الحالية لهذا الحساب إلى قالب الدور الجديد ويُفقَد أي تخصيص يدوي. هل تتابع؟",
        confirmText: "تغيير الدور",
      }))) return;
      setCustomRoleId(null);
      setRole(val as RoleKey);
      setPermsOverride({});
    }
  }

  function handlePermChange(moduleKey: string, level: AccessLevel) {
    const newResolved = { ...resolvedPerms, [moduleKey]: level };
    setPermsOverride(diffFromTemplate(role, newResolved) ?? {});
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
      // isOwner: يُرسَل فقط إن كان المستخدم الحالي مالكاً (وإلا يتجاهله الخادم بحارس FORBIDDEN).
      ...(meIsOwner ? { isOwner } : {}),
      permissionsOverride: override,
    });
  }

  async function doIssueResetToken() {
    setResetMsg("");
    if (!(await confirm({
      variant: "warning",
      title: "إصدار رمز استعادة",
      description: `سيُلغى أي رمز استعادة سابق لـ«${name || u?.email || `#${userId}`}». الرمز الجديد صالح ١٥ دقيقة ويُعرض مرة واحدة. هل تتابع؟`,
      confirmText: "إصدار الرمز",
    }))) return;
    setResetToken("");
    setResetExpiresAt(null);
    issueResetToken.mutate({ userId });
  }

  async function doRevokeSessions() {
    setRevokeMsg("");
    if (!(await confirm({
      variant: "warning",
      title: "إبطال الجلسات النشطة",
      description: `سيُطرَد «${name || u?.email || `#${userId}`}» من كل جلساته الحالية فوراً بلا تغيير كلمة مروره — يحتاج دخولاً جديداً. هل تتابع؟`,
      confirmText: "إبطال الجلسات",
    }))) return;
    revokeSessions.mutate({ userId });
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
    <div className="space-y-4">
      <PageHeader
        title="تعديل مستخدم"
        backHref="/users"
        backLabel="رجوع للمستخدمين"
      />

      <Card>
        <CardHeader><CardTitle className="text-base">بطاقة المستخدم</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المعرّف</div><div className="font-mono" dir="ltr">#{Number(u.id)}</div></div>
          <div><div className="text-muted-foreground text-xs">اسم المستخدم</div><div className="font-mono" dir="ltr">{(u as { username?: string | null }).username || "—"}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الدور الحالي</div>
            {/* دور مخصّص ⇒ تسميته الحقيقية + فئته الأساس (صدق العرض — لا «كاشير» مجرّدة). */}
            <div>
              {u.customRoleLabel ?? ROLE_LABEL[u.role] ?? u.role}
              {u.customRoleLabel ? (
                <span className="text-muted-foreground text-xs"> (الفئة: {ROLE_LABEL[u.role] ?? u.role})</span>
              ) : null}
            </div>
          </div>
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

      {/* الأثر الفعليّ الحاليّ (طبقة الشفافية ش١): «لماذا يرى هذا الحساب هذا؟» — مصدر كل صلاحية + القسم الفعليّ. */}
      <Card>
        <CardHeader><CardTitle className="text-base">الأثر الفعليّ لهذا الحساب</CardTitle></CardHeader>
        <CardContent>
          <EffectivePermissionsPanel userId={userId} />
        </CardContent>
      </Card>

      {/* عنصر نموذج حقيقي يلفّ حقول الحفظ الفعلية (كان غائباً — يمنع حفظ متصفح/تعبئة تلقائية ويكسر
          دلالة Enter-to-submit). لا يلفّ بطاقات الإجراءات المستقلة أسفله (إعادة تعيين كلمة المرور/
          إبطال الجلسات/2FA/الحذف) — لكلٍّ منها مطفَره الخاص. */}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="grid gap-4 lg:grid-cols-2 items-start">
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
            <AppSelect
              id="role"
              value={customRoleId ? `custom:${customRoleId}` : role}
              onValueChange={(value) => void handleRoleChange(value)}
            >
              <optgroup label="أدوار النظام">
                {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </optgroup>
              {customRoles.length > 0 && (
                <optgroup label="أدوار مخصّصة">
                  {customRoles.map((r: any) => <option key={r.id} value={`custom:${r.id}`}>{r.label}</option>)}
                </optgroup>
              )}
            </AppSelect>
            {customRoleId ? (
              <p className="text-[11px] text-muted-foreground">دور مخصّص — صلاحياته تُدار من شاشة «الأدوار والصلاحيات».</p>
            ) : roleInfo ? <p className="text-[11px] text-muted-foreground">{roleInfo.description}</p> : null}
            {/* معاينة حيّة للأثر الفعليّ (ش١ RBAC): «سيرى: تجزئة فقط» — تلتقط خطأ اختيار الدور قبل الحفظ. */}
            <div className="pt-1">
              <EffectiveAccessForAssignment
                role={role}
                permsOverride={permsOverride}
                customRoleId={customRoleId}
                customRoles={customRoles}
                title="بعد الحفظ سيرى هذا الحساب:"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="branch">الفرع</Label>
            <AppSelect id="branch" value={branchId} onValueChange={(next) => setBranchId(next)}>
              <option value="">— بلا فرع —</option>
              {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>)}
            </AppSelect>
          </div>
          {/* مالك النظام (isOwner): يظهر فقط للمالك الحالي (حارس تصعيد الصلاحيات). المالك يتجاوز
              كل اعتماد ثنائي على السندات ويحتفظ بدور admin. */}
          {meIsOwner && (
            <div className="space-y-1 md:col-span-2">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={isOwner}
                  onChange={(e) => setIsOwner(e.target.checked)}
                  disabled={userId === (me.data?.id as number | undefined) && isOwner}
                />
                <span>مالك النظام <span className="text-[11px] text-[var(--sem-warn)] bg-[var(--sem-warn-bg)] rounded px-1.5 py-0.5 mr-1">صلاحيات خاصة</span></span>
              </Label>
              <p className="text-[11px] text-muted-foreground">
                يتجاوز كل اعتماد ثنائي على السندات (Maker-Checker + العتبات). لا يمكنك سحب الصفة عن نفسك.
              </p>
            </div>
          )}
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
      </div>

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
        {/* type="submit" وبلا onClick مباشر — يعتمد على onSubmit في <form> وحده كمصدرٍ واحد
            (تفادياً لاستدعاء submit() مرّتين لو حمل الزرّ onClick أيضاً). */}
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? ACTION_LABELS.saving : "حفظ التعديلات"}
        </Button>
        {isActive ? (
          <Button
            type="button"
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
          <Button type="button" variant="outline" onClick={() => setActive.mutate({ userId, isActive: true })} disabled={setActive.isPending}>
            {setActive.isPending ? "…" : "إعادة تفعيل"}
          </Button>
        )}
        <Link href="/users"><Button type="button" variant="ghost">رجوع</Button></Link>
      </div>
      </form>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      {/* إصدار رمز استعادة — المدير لا يرى كلمة المرور التي يختارها المستخدم. */}
      <Card>
        <CardHeader><CardTitle className="text-base">استعادة كلمة المرور</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            أصدر رمزاً أحادي الاستخدام وأرسله للمستخدم عبر قناة موثوقة. يختار المستخدم كلمته
            الجديدة بنفسه من شاشة الدخول؛ لا يعرفها المدير. صلاحية الرمز ١٥ دقيقة.
          </p>
          <Button type="button" variant="outline" onClick={() => void doIssueResetToken()} disabled={issueResetToken.isPending}>
            {issueResetToken.isPending ? "جارٍ الإصدار…" : resetToken ? "إصدار رمز بديل" : "إصدار رمز استعادة"}
          </Button>
          {resetMsg && (
            <p role="status" className={`text-sm ${issueResetToken.isError ? "text-destructive" : "text-money-positive"}`}>
              {resetMsg}
            </p>
          )}
          {resetToken && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <Label htmlFor="passwordResetToken">الرمز — يظهر في هذه الجلسة فقط</Label>
              <div className="flex gap-2">
                <Input id="passwordResetToken" readOnly dir="ltr" value={resetToken} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(resetToken);
                      setResetCopied(true);
                    } catch {
                      setResetMsg("تعذّر النسخ التلقائي؛ حدّد الرمز وانسخه يدوياً.");
                    }
                  }}
                >
                  <Copy aria-hidden className="size-4" />
                  {resetCopied ? "نُسخ" : "نسخ"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                ينتهي {resetExpiresAt ? fmtDateTime(resetExpiresAt) : "خلال ١٥ دقيقة"}. إصدار رمز آخر يُبطل هذا الرمز فوراً.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* إبطال الجلسات النشطة */}
      <Card>
        <CardHeader><CardTitle className="text-base">إبطال الجلسات النشطة</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            يَطرد المستخدم من كل جلساته الحالية فوراً (جهاز مفقود/موظف مطرود) بلا تغيير كلمة مروره —
            بديل أخفّ من «إعادة تعيين كلمة المرور» عندما لا داعي لكلمة مرور جديدة.
          </p>
          <Button variant="outline" onClick={() => void doRevokeSessions()} disabled={revokeSessions.isPending}>
            {revokeSessions.isPending ? "…" : "تسجيل الخروج من كل الأجهزة"}
          </Button>
          {revokeMsg && <p className={`text-sm ${revokeSessions.isSuccess ? "text-money-positive" : "text-destructive"}`}>{revokeMsg}</p>}
          {/* إنقاذ 2FA: المستخدم فقد هاتفه ورموز استرداده معاً ⇒ الأدمن يصفّرها ليدخل بكلمة المرور. */}
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              فقد المستخدم هاتفه ورموز الاسترداد معاً؟ صفّر مصادقته الثنائية ليدخل بكلمة المرور
              وحدها (تُبطَل جلساته كلها احتياطاً). يستطيع إعادة تفعيلها من «حسابي».
            </p>
            <Button
              variant="outline"
              onClick={async () => {
                if (!(await confirm({
                  variant: "danger",
                  title: "تصفير المصادقة الثنائية",
                  description: `سيُعطَّل رمز التحقق لـ«${name || u?.email || `#${userId}`}» وتُحذف رموز استرداده وتُبطل جلساته. هل تتابع؟`,
                  confirmText: "تصفير",
                }))) return;
                reset2fa.mutate({ userId });
              }}
              disabled={reset2fa.isPending}
            >
              {reset2fa.isPending ? "…" : "تصفير المصادقة الثنائية (2FA)"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* الجلسات النشطة (فردياً) */}
      <Card>
        <CardHeader><CardTitle className="text-base">الجلسات النشطة</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            أجهزة هذا المستخدم المسجَّل دخولها حالياً — يمكن إنهاء جهازٍ واحدٍ بعينه بدل كل الأجهزة.
          </p>
          {userSessions.isLoading && <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>}
          {!userSessions.isLoading && (userSessions.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">لا جلسات مسجَّلة (ربما دخل قبل تفعيل هذه الميزة).</p>
          )}
          <div className="space-y-2">
            {userSessions.data?.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div className="flex items-start gap-3 min-w-0">
                  <Monitor aria-hidden className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="font-medium">{describeUserAgent(s.userAgent)}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">
                      {s.ipAddress ?? "—"} · آخر نشاط: {fmtDateTime(s.lastSeenAt)} · دخول: {fmtDateTime(s.createdAt)}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={revokeOneSession.isPending}
                  onClick={async () => {
                    if (!(await confirm({
                      variant: "danger",
                      title: "إنهاء هذه الجلسة",
                      description: `سيُطرَد «${name || u?.email || `#${userId}`}» من هذا الجهاز تحديداً فوراً. هل تتابع؟`,
                      confirmText: "إنهاء الجلسة",
                    }))) return;
                    revokeOneSession.mutate({ userId, sessionId: s.id });
                  }}
                >
                  إنهاء
                </Button>
              </div>
            ))}
          </div>
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
            {del.isPending ? ACTION_LABELS.deleting : "حذف نهائياً"}
          </Button>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
