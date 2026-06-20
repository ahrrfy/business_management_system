import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/form/PasswordInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import { isStrongPassword, PASSWORD_POLICY_MSG, USERNAME_POLICY_MSG, USERNAME_REGEX } from "@shared/const";
import {
  ROLES,
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  diffFromTemplate,
  resolvePermissions,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { trpc } from "@/lib/trpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { ROLE_OPTIONS } from "./Users";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** أدوار تشغيلية تستوجب تحديد فرع (تحذير عند «كل الفروع»). */
const BRANCH_WARN_ROLES: RoleKey[] = ["cashier", "warehouse", "print_operator", "purchasing", "sales_rep"];

/** تحويل الاسم العربي إلى بريد مقترح @alroya.local */
function suggestEmail(name: string): string {
  if (!name.trim()) return "";
  // تبسيط: أخذ أول كلمتين، تحويل إلى ASCII بسيط
  const map: Record<string, string> = {
    ا:"a",أ:"a",إ:"a",آ:"a",ب:"b",ت:"t",ث:"th",ج:"j",ح:"h",خ:"kh",
    د:"d",ذ:"z",ر:"r",ز:"z",س:"s",ش:"sh",ص:"s",ض:"d",ط:"t",ظ:"z",
    ع:"a",غ:"g",ف:"f",ق:"q",ك:"k",ل:"l",م:"m",ن:"n",ه:"h",و:"w",
    ي:"y",ى:"a",ة:"a",ء:"",ئ:"y",ؤ:"w",لا:"la",
  };
  const words = name.trim().split(/\s+/).slice(0, 2);
  const slug = words
    .map((w) =>
      w.split("").map((c) => map[c] ?? (c.match(/[a-z0-9]/i) ? c.toLowerCase() : "")).join("")
    )
    .filter(Boolean)
    .join(".");
  return slug ? `${slug}@alroya.local` : "";
}

/** فروق الصلاحيات عن القالب — يُعرض في رأس المصفوفة */
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

export default function UserNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailChecked, setEmailChecked] = useState(false);
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [usernameChecked, setUsernameChecked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [hiredAt, setHiredAt] = useState("");
  const [role, setRole] = useState<RoleKey>("cashier");
  const [branchId, setBranchId] = useState<number | "">("");
  const [permsOverride, setPermsOverride] = useState<PermissionMap>({});
  const [mustChangePassword, setMustChangePassword] = useState(true);
  const [error, setError] = useState("");
  const [createdInfo, setCreatedInfo] = useState<{
    name: string; email: string; username?: string; password: string; phone?: string;
    roleLabel?: string; branchName?: string | null; jobTitle?: string | null; mustChangePassword?: boolean;
  } | null>(null);

  const branches = trpc.branches.list.useQuery();
  const generatePwQ = trpc.users.generatePassword.useQuery(undefined, { enabled: false });

  // افتراضي: فرع المستخدم الحالي (يُقرأ من السياق حين يتوفر)
  const me = trpc.auth.me?.useQuery?.();
  useEffect(() => {
    if (me?.data?.branchId && branchId === "") {
      setBranchId(me.data.branchId as number);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.data]);

  const resolvedPerms = useMemo(
    () => resolvePermissions(role, Object.keys(permsOverride).length ? permsOverride : null),
    [role, permsOverride]
  );

  const roleInfo = ROLES.find((r) => r.key === role);
  const branchWarn = BRANCH_WARN_ROLES.includes(role) && branchId === "";

  // فحص البريد onBlur
  const checkEmailFn = useCallback(async () => {
    const v = email.trim().toLowerCase();
    if (!v || !/^\S+@\S+\.\S+$/.test(v)) return;
    try {
      const ok = await utils.users.checkEmail.fetch({ email: v });
      setEmailError(ok ? "" : "هذا البريد مستخدم مسبقاً.");
      setEmailChecked(true);
    } catch {
      setEmailChecked(false);
    }
  }, [email, utils.users.checkEmail]);

  // فحص اسم المستخدم onBlur — صيغة سريعة محلياً ثم توفّر من الخادم.
  const checkUsernameFn = useCallback(async () => {
    const v = username.trim().toLowerCase();
    if (!v) { setUsernameError(""); setUsernameChecked(false); return; }
    if (!USERNAME_REGEX.test(v)) {
      setUsernameError(USERNAME_POLICY_MSG);
      setUsernameChecked(false);
      return;
    }
    try {
      const ok = await utils.users.checkUsername.fetch({ username: v });
      setUsernameError(ok ? "" : "اسم المستخدم مستخدم مسبقاً.");
      setUsernameChecked(true);
    } catch {
      setUsernameChecked(false);
    }
  }, [username, utils.users.checkUsername]);

  // اقتراح اسم مستخدم متاح من الخادم (يضمن التفرّد).
  async function fillSuggestedUsername() {
    if (!name.trim()) return;
    try {
      const res = await utils.users.suggestUsername.fetch({ name: name.trim() });
      if (res.username) {
        setUsername(res.username);
        setUsernameError("");
        setUsernameChecked(true);
      } else {
        // الاشتقاق فشل (اسم بلا أحرف لاتينية أو كل البدائل مأخوذة) — أبلغ بدل الصمت.
        setUsernameError("تعذّر اقتراح اسم مستخدم تلقائياً — أدخله يدوياً أو استخدم البريد الإلكتروني.");
      }
    } catch {
      setUsernameError("تعذّر الاتصال لاقتراح اسم المستخدم — أدخله يدوياً.");
    }
  }

  // عند مغادرة حقل الاسم: ولّد اسم المستخدم تلقائياً (المعرّف الأساسي) إن كان فارغاً، واقترح بريداً.
  async function handleNameBlur() {
    if (!username.trim() && name.trim()) {
      await fillSuggestedUsername();
    }
    if (!email && name.trim()) {
      const suggested = suggestEmail(name);
      if (suggested) setEmail(suggested);
    }
  }

  function handleRoleChange(next: RoleKey) {
    setRole(next);
    setPermsOverride({});
  }

  function handlePermChange(moduleKey: string, level: AccessLevel) {
    const newResolved = { ...resolvedPerms, [moduleKey]: level };
    const newOverride = diffFromTemplate(role, newResolved) ?? {};
    setPermsOverride(newOverride);
  }

  async function handleGeneratePassword() {
    try {
      const res = await utils.users.generatePassword.fetch();
      setPassword(res.password);
      setPasswordConfirm(res.password);
    } catch {
      // fallback client-side
      const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$%!";
      const pw = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      setPassword(pw);
      setPasswordConfirm(pw);
    }
  }

  const create = trpc.users.create.useMutation({
    onSuccess: (_, vars) => {
      utils.users.list.invalidate();
      setCreatedInfo({
        name: vars.name,
        email: vars.email ?? "",
        username: vars.username ?? undefined,
        password: vars.password,
        phone: vars.phone ?? undefined,
        roleLabel: ROLE_OPTIONS.find((r) => r.value === vars.role)?.label ?? vars.role,
        branchName: vars.branchId ? branches.data?.find((b: any) => b.id === vars.branchId)?.name ?? null : null,
        jobTitle: vars.jobTitle ?? null,
        mustChangePassword: vars.mustChangePassword,
      });
    },
    onError: (e) => setError(e.message),
  });

  /** تفريغ النموذج لإضافة مستخدم آخر (من بطاقة المشاركة بعد النجاح). */
  function resetForm() {
    setEmail(""); setEmailError(""); setEmailChecked(false);
    setUsername(""); setUsernameError(""); setUsernameChecked(false);
    setPassword(""); setPasswordConfirm("");
    setName(""); setPhone(""); setJobTitle(""); setHiredAt("");
    setRole("cashier"); setPermsOverride({});
    setBranchId((me?.data?.branchId as number) ?? "");
    setMustChangePassword(true);
    setError("");
  }

  function buildAndSubmit() {
    setError("");
    if (!name.trim()) { setError("الاسم مطلوب."); return; }
    if (emailError) { setError(emailError); return; }
    if (usernameError) { setError(usernameError); return; }
    const emailV = email.trim().toLowerCase();
    const usernameV = username.trim().toLowerCase();
    // معرّف دخول واحد على الأقل (طلب المالك: «اما بريد او اسم مستخدم»).
    if (!emailV && !usernameV) { setError("أدخل بريداً إلكترونياً أو اسم مستخدم على الأقل."); return; }
    if (emailV && !/^\S+@\S+\.\S+$/.test(emailV)) { setError("بريد إلكتروني غير صالح."); return; }
    if (usernameV && !USERNAME_REGEX.test(usernameV)) { setError(USERNAME_POLICY_MSG); return; }
    if (!isStrongPassword(password)) { setError("كلمة المرور ضعيفة — استخدم زر التوليد أو أدخل 12 خانة تحتوي حرفاً كبيراً وصغيراً ورقماً ورمزاً."); return; }
    if (password !== passwordConfirm) { setError("تأكيد كلمة المرور لا يطابق."); return; }
    if (hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAt)) { setError("تاريخ التوظيف غير صالح."); return; }
    const override = diffFromTemplate(role, resolvedPerms);
    // النجاح يعرض بطاقة المشاركة (CredentialsShare) عبر onSuccess على مستوى الطفرة. ⛔ لا تنقّل هنا:
    // navigate("/users") السابق كان يُنفَّذ مع onSuccess فيُخفي البطاقة قبل ظهورها (سبب «الميزة غير مطبّقة»).
    // التنقّل و«إضافة آخر» من أزرار البطاقة بعد المشاركة.
    create.mutate({
      email: emailV || undefined,
      username: usernameV || undefined,
      password,
      name: name.trim(),
      role,
      branchId: branchId === "" ? null : Number(branchId),
      phone: phone.trim() || null,
      jobTitle: jobTitle.trim() || null,
      hiredAt: hiredAt || null,
      permissionsOverride: override,
      mustChangePassword,
    });
  }

  const pwMismatch = passwordConfirm.length > 0 && password !== passwordConfirm;
  const customCount = Object.keys(permsOverride).length;

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
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة مستخدم</h1>
        <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      {/* بيانات الدخول */}
      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الدخول</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="name">الاسم الكامل *</Label>
            <Input
              id="name" value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void handleNameBlur()}
              placeholder="مثال: علي محمد حسين"
            />
            <p className="text-[11px] text-muted-foreground">يكفي معرّف دخول واحد: اسم المستخدم أو البريد الإلكتروني.</p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="username">اسم المستخدم (للدخول)</Label>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => void fillSuggestedUsername()}>
                ⚡ توليد تلقائي
              </Button>
            </div>
            <Input
              id="username" type="text" dir="ltr" autoComplete="off"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setUsernameChecked(false); setUsernameError(""); }}
              onBlur={() => void checkUsernameFn()}
              placeholder="مثال: marwa.ibrahim"
              className={usernameError ? "border-destructive" : usernameChecked && !usernameError ? "border-emerald-500" : ""}
            />
            {usernameError && <p className="text-[11px] text-destructive">{usernameError}</p>}
            {usernameChecked && !usernameError && username.trim() && <p className="text-[11px] text-emerald-600">✓ اسم المستخدم متاح</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني <span className="text-muted-foreground font-normal">(اختياري)</span></Label>
            <Input
              id="email" type="email" dir="ltr" autoComplete="off"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailChecked(false); setEmailError(""); }}
              onBlur={checkEmailFn}
              placeholder="user@alroya.local"
              className={emailError ? "border-destructive" : emailChecked && !emailError ? "border-emerald-500" : ""}
            />
            {emailError && <p className="text-[11px] text-destructive">{emailError}</p>}
            {emailChecked && !emailError && <p className="text-[11px] text-emerald-600">✓ البريد متاح</p>}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="pw">كلمة المرور *</Label>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleGeneratePassword}>
                ⚡ توليد تلقائي
              </Button>
            </div>
            <PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="new-password" />
            <p className="text-[11px] text-muted-foreground">{PASSWORD_POLICY_MSG}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pw2">تأكيد كلمة المرور *</Label>
            <PasswordInput id="pw2" value={passwordConfirm} onChange={setPasswordConfirm} invalid={pwMismatch} autoComplete="new-password" />
            {pwMismatch && <p className="text-[11px] text-destructive">لا يطابق كلمة المرور.</p>}
          </div>
          <div className="flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox" id="mustChange" className="size-4"
              checked={mustChangePassword}
              onChange={(e) => setMustChangePassword(e.target.checked)}
            />
            <Label htmlFor="mustChange" className="font-normal cursor-pointer">
              إلزام تغيير كلمة المرور عند أول دخول (صالحة 72 ساعة)
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* البيانات الشخصية */}
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

      {/* الدور والفرع */}
      <Card>
        <CardHeader><CardTitle className="text-base">الدور والفرع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="role">الدور</Label>
            <select id="role" className={selectCls} value={role} onChange={(e) => handleRoleChange(e.target.value as RoleKey)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {roleInfo && (
              <p className="text-[11px] text-muted-foreground">{roleInfo.description}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="branch">الفرع</Label>
            <select
              id="branch" className={`${selectCls} ${branchWarn ? "border-amber-400" : ""}`}
              value={String(branchId)}
              onChange={(e) => setBranchId(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {branchWarn && (
              <p className="text-[11px] text-amber-600">⚠️ هذا الدور يُنصح بتحديد فرع محدد لتجنّب الوصول لكل الفروع.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* الصلاحيات */}
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
          <PermDiffSummary role={role} override={permsOverride} />
          <PermissionMatrix
            role={role}
            permissions={resolvedPerms}
            onChange={handlePermChange}
            onReset={() => setPermsOverride({})}
          />
        </CardContent>
      </Card>

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

void PERMISSION_MODULES; void ROLE_TEMPLATES;
