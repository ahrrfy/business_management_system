import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/form/PasswordInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
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
import { ROLE_OPTIONS } from "@/pages/Users";
import { AlertTriangle, Check, Zap } from "lucide-react";

/**
 * قسم «حساب النظام» المشترك — بيانات الدخول + الدور والفرع + الصلاحيات.
 * يستعمله نموذج «إضافة مستخدم» (UserNew، بكامل الحقول) و«إضافة موظف» (EmployeeNew، وضع «إنشاء حساب
 * جديد» بلا حقول الاسم/الوظيفة لأنها تُؤخذ من بيانات الموظف). إبقاء الحقول والسياسات في مكوّن واحد
 * يمنع انحراف الشاشتين. التحقّق المشترك عبر validateAccount + بناء الـoverride عبر accountPermsPayload.
 */

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** أدوار تشغيلية تستوجب تحديد فرع (تحذير عند «كل الفروع»). */
const BRANCH_WARN_ROLES: RoleKey[] = ["cashier", "warehouse", "print_operator", "purchasing", "sales_rep"];

export interface AccountFieldsValue {
  name: string;
  email: string;
  username: string;
  password: string;
  passwordConfirm: string;
  phone: string;
  jobTitle: string;
  hiredAt: string;
  role: RoleKey;
  customRoleId: number | null;
  branchId: number | "";
  permsOverride: PermissionMap;
  mustChangePassword: boolean;
}

/** قيمة ابتدائية فارغة لحساب جديد. */
export const emptyAccountValue: AccountFieldsValue = {
  name: "", email: "", username: "", password: "", passwordConfirm: "",
  phone: "", jobTitle: "", hiredAt: "",
  role: "cashier", customRoleId: null, branchId: "", permsOverride: {}, mustChangePassword: true,
};

/** تحويل الاسم العربي إلى بريد مقترح @alroya.local. */
export function suggestEmail(name: string): string {
  if (!name.trim()) return "";
  const map: Record<string, string> = {
    ا:"a",أ:"a",إ:"a",آ:"a",ب:"b",ت:"t",ث:"th",ج:"j",ح:"h",خ:"kh",
    د:"d",ذ:"z",ر:"r",ز:"z",س:"s",ش:"sh",ص:"s",ض:"d",ط:"t",ظ:"z",
    ع:"a",غ:"g",ف:"f",ق:"q",ك:"k",ل:"l",م:"m",ن:"n",ه:"h",و:"w",
    ي:"y",ى:"a",ة:"a",ء:"",ئ:"y",ؤ:"w",لا:"la",
  };
  const words = name.trim().split(/\s+/).slice(0, 2);
  const slug = words
    .map((w) => w.split("").map((c) => map[c] ?? (c.match(/[a-z0-9]/i) ? c.toLowerCase() : "")).join(""))
    .filter(Boolean)
    .join(".");
  return slug ? `${slug}@alroya.local` : "";
}

/** تحقّق مشترك لقيمة الحساب (يُستعمل في الشاشتين) — يعيد رسالة الخطأ أو null. */
export function validateAccount(v: AccountFieldsValue): string | null {
  const emailV = v.email.trim().toLowerCase();
  const usernameV = v.username.trim().toLowerCase();
  if (!emailV && !usernameV) return "أدخل بريداً إلكترونياً أو اسم مستخدم على الأقل.";
  if (emailV && !/^\S+@\S+\.\S+$/.test(emailV)) return "بريد إلكتروني غير صالح.";
  if (usernameV && !USERNAME_REGEX.test(usernameV)) return USERNAME_POLICY_MSG;
  if (!isStrongPassword(v.password)) return "كلمة المرور ضعيفة — استخدم زر التوليد أو أدخل 12 خانة تحتوي حرفاً كبيراً وصغيراً ورقماً ورمزاً.";
  if (v.password !== v.passwordConfirm) return "تأكيد كلمة المرور لا يطابق.";
  if (v.hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(v.hiredAt)) return "تاريخ التوظيف غير صالح.";
  return null;
}

/** خريطة الصلاحيات للإرسال (null للأدوار المخصّصة — صلاحياتها محفوظة في تعريفها). */
export function accountPermsPayload(v: AccountFieldsValue): Record<string, AccessLevel> | null {
  if (v.customRoleId) return null;
  return diffFromTemplate(v.role, resolvePermissions(v.role, Object.keys(v.permsOverride).length ? v.permsOverride : null));
}

/** فروق الصلاحيات عن القالب — يُعرض في رأس المصفوفة. */
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

export interface AccountFieldsProps {
  value: AccountFieldsValue;
  onChange: (patch: Partial<AccountFieldsValue>) => void;
  /** يعرض حقل الاسم الكامل داخل بطاقة الدخول (شاشة المستخدم). */
  showName?: boolean;
  /** يعرض بطاقة البيانات الوظيفية (هاتف/مسمّى/تاريخ توظيف) — تُخفى في شاشة الموظف (تُؤخذ منه). */
  showJobData?: boolean;
  /** مصدر اقتراح اسم المستخدم/البريد (افتراضياً value.name). */
  nameForSuggest?: string;
  /** عند تغيّر هذا الرقم: يُجرى اقتراح تلقائي لاسم المستخدم/البريد (لشاشة الموظف عند فتح وضع «جديد»). */
  autoSuggestSignal?: number;
  /** يُمرَّر إلى فحوص توفّر البريد/الاسم في التعديل (تجنّب التعارض مع الذات). */
  excludeUserId?: number;
}

export function AccountFields({ value, onChange, showName, showJobData, nameForSuggest, autoSuggestSignal, excludeUserId }: AccountFieldsProps) {
  const utils = trpc.useUtils();
  const [emailError, setEmailError] = useState("");
  const [emailChecked, setEmailChecked] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  const [usernameChecked, setUsernameChecked] = useState(false);

  const branches = trpc.branches.list.useQuery();
  const rolesQ = trpc.roles.list.useQuery();
  const customRoles = rolesQ.data?.custom ?? [];

  const resolvedPerms = useMemo(
    () => resolvePermissions(value.role, Object.keys(value.permsOverride).length ? value.permsOverride : null),
    [value.role, value.permsOverride],
  );
  const roleInfo = ROLES.find((r) => r.key === value.role);
  const branchWarn = BRANCH_WARN_ROLES.includes(value.role) && value.branchId === "";
  const customCount = Object.keys(value.permsOverride).length;
  const pwMismatch = value.passwordConfirm.length > 0 && value.password !== value.passwordConfirm;
  const suggestName = (nameForSuggest ?? value.name).trim();

  const checkEmailFn = useCallback(async () => {
    const v = value.email.trim().toLowerCase();
    if (!v || !/^\S+@\S+\.\S+$/.test(v)) return;
    try {
      const ok = await utils.users.checkEmail.fetch({ email: v, excludeUserId });
      setEmailError(ok ? "" : "هذا البريد مستخدم مسبقاً.");
      setEmailChecked(true);
    } catch {
      setEmailChecked(false);
    }
  }, [value.email, excludeUserId, utils.users.checkEmail]);

  const checkUsernameFn = useCallback(async () => {
    const v = value.username.trim().toLowerCase();
    if (!v) { setUsernameError(""); setUsernameChecked(false); return; }
    if (!USERNAME_REGEX.test(v)) { setUsernameError(USERNAME_POLICY_MSG); setUsernameChecked(false); return; }
    try {
      const ok = await utils.users.checkUsername.fetch({ username: v, excludeUserId });
      setUsernameError(ok ? "" : "اسم المستخدم مستخدم مسبقاً.");
      setUsernameChecked(true);
    } catch {
      setUsernameChecked(false);
    }
  }, [value.username, excludeUserId, utils.users.checkUsername]);

  const fillSuggestedUsername = useCallback(async () => {
    if (!suggestName) return;
    try {
      const res = await utils.users.suggestUsername.fetch({ name: suggestName });
      if (res.username) {
        onChange({ username: res.username });
        setUsernameError("");
        setUsernameChecked(true);
      } else {
        setUsernameError("تعذّر اقتراح اسم مستخدم تلقائياً — أدخله يدوياً أو استخدم البريد الإلكتروني.");
      }
    } catch {
      setUsernameError("تعذّر الاتصال لاقتراح اسم المستخدم — أدخله يدوياً.");
    }
  }, [suggestName, onChange, utils.users.suggestUsername]);

  // اقتراح تلقائي لاسم المستخدم/البريد إن كانا فارغين (يُستدعى عند مغادرة حقل الاسم أو عبر إشارة).
  const maybeAutoSuggest = useCallback(async () => {
    if (!suggestName) return;
    if (!value.username.trim()) await fillSuggestedUsername();
    if (!value.email.trim()) {
      const s = suggestEmail(suggestName);
      if (s) onChange({ email: s });
    }
  }, [suggestName, value.username, value.email, fillSuggestedUsername, onChange]);

  // إشارة الاقتراح التلقائي (شاشة الموظف عند فتح وضع «إنشاء حساب جديد»).
  const lastSignal = useRef<number | undefined>(autoSuggestSignal);
  useEffect(() => {
    if (autoSuggestSignal === undefined || autoSuggestSignal === lastSignal.current) return;
    lastSignal.current = autoSuggestSignal;
    void maybeAutoSuggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSuggestSignal]);

  function handleRoleChange(val: string) {
    if (val.startsWith("custom:")) {
      onChange({ customRoleId: Number(val.slice(7)) });
    } else {
      onChange({ customRoleId: null, role: val as RoleKey, permsOverride: {} });
    }
  }

  function handlePermChange(moduleKey: string, level: AccessLevel) {
    const newResolved = { ...resolvedPerms, [moduleKey]: level };
    onChange({ permsOverride: diffFromTemplate(value.role, newResolved) ?? {} });
  }

  async function handleGeneratePassword() {
    try {
      const res = await utils.users.generatePassword.fetch();
      onChange({ password: res.password, passwordConfirm: res.password });
    } catch {
      const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$%!";
      const pw = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      onChange({ password: pw, passwordConfirm: pw });
    }
  }

  return (
    <div className="space-y-4">
      {/* بيانات الدخول */}
      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الدخول</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {showName && (
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="acc-name">الاسم الكامل *</Label>
              <Input
                id="acc-name" value={value.name}
                onChange={(e) => onChange({ name: e.target.value })}
                onBlur={() => void maybeAutoSuggest()}
                placeholder="مثال: علي محمد حسين"
              />
              <p className="text-[11px] text-muted-foreground">يكفي معرّف دخول واحد: اسم المستخدم أو البريد الإلكتروني.</p>
            </div>
          )}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="acc-username">اسم المستخدم (للدخول)</Label>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2 gap-1" onClick={() => void fillSuggestedUsername()}>
                <Zap aria-hidden className="size-3.5" /> توليد تلقائي
              </Button>
            </div>
            <Input
              id="acc-username" type="text" dir="ltr" autoComplete="off"
              value={value.username}
              onChange={(e) => { onChange({ username: e.target.value }); setUsernameChecked(false); setUsernameError(""); }}
              onBlur={() => void checkUsernameFn()}
              placeholder="مثال: marwa.ibrahim"
              className={usernameError ? "border-destructive" : usernameChecked && !usernameError ? "border-emerald-500" : ""}
            />
            {usernameError && <p className="text-[11px] text-destructive">{usernameError}</p>}
            {usernameChecked && !usernameError && value.username.trim() && <p className="text-[11px] text-emerald-600 inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" /> اسم المستخدم متاح</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="acc-email">البريد الإلكتروني <span className="text-muted-foreground font-normal">(اختياري)</span></Label>
            <Input
              id="acc-email" type="email" dir="ltr" autoComplete="off"
              value={value.email}
              onChange={(e) => { onChange({ email: e.target.value }); setEmailChecked(false); setEmailError(""); }}
              onBlur={() => void checkEmailFn()}
              placeholder="user@alroya.local"
              className={emailError ? "border-destructive" : emailChecked && !emailError ? "border-emerald-500" : ""}
            />
            {emailError && <p className="text-[11px] text-destructive">{emailError}</p>}
            {emailChecked && !emailError && <p className="text-[11px] text-emerald-600 inline-flex items-center gap-1"><Check aria-hidden className="size-3.5" /> البريد متاح</p>}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="acc-pw">كلمة المرور *</Label>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2 gap-1" onClick={handleGeneratePassword}>
                <Zap aria-hidden className="size-3.5" /> توليد تلقائي
              </Button>
            </div>
            <PasswordInput id="acc-pw" value={value.password} onChange={(v) => onChange({ password: v })} autoComplete="new-password" />
            <p className="text-[11px] text-muted-foreground">{PASSWORD_POLICY_MSG}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="acc-pw2">تأكيد كلمة المرور *</Label>
            <PasswordInput id="acc-pw2" value={value.passwordConfirm} onChange={(v) => onChange({ passwordConfirm: v })} invalid={pwMismatch} autoComplete="new-password" />
            {pwMismatch && <p className="text-[11px] text-destructive">لا يطابق كلمة المرور.</p>}
          </div>
          <div className="flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox" id="acc-mustChange" className="size-4"
              checked={value.mustChangePassword}
              onChange={(e) => onChange({ mustChangePassword: e.target.checked })}
            />
            <Label htmlFor="acc-mustChange" className="font-normal cursor-pointer">
              إلزام تغيير كلمة المرور عند أول دخول (صالحة 72 ساعة)
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* البيانات الوظيفية (شاشة المستخدم فقط) */}
      {showJobData && (
        <Card>
          <CardHeader><CardTitle className="text-base">البيانات الوظيفية</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="acc-phone">رقم هاتف الاتصال</Label>
              <IntlPhoneInput id="acc-phone" value={value.phone} onChange={(v) => onChange({ phone: v })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-job">المسمى الوظيفي</Label>
              <Input id="acc-job" value={value.jobTitle} onChange={(e) => onChange({ jobTitle: e.target.value })} placeholder="مثال: كاشير / محاسب" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-hired">تاريخ التوظيف</Label>
              <Input id="acc-hired" type="date" dir="ltr" value={value.hiredAt} onChange={(e) => onChange({ hiredAt: e.target.value })} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* الدور والفرع */}
      <Card>
        <CardHeader><CardTitle className="text-base">الدور والفرع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="acc-role">الدور</Label>
            <select id="acc-role" className={selectCls} value={value.customRoleId ? `custom:${value.customRoleId}` : value.role} onChange={(e) => handleRoleChange(e.target.value)}>
              <optgroup label="أدوار النظام">
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </optgroup>
              {customRoles.length > 0 && (
                <optgroup label="أدوار مخصّصة">
                  {customRoles.map((r: any) => (
                    <option key={r.id} value={`custom:${r.id}`}>{r.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {value.customRoleId ? (
              <p className="text-[11px] text-muted-foreground">صلاحيات هذا الدور محفوظة فيه — تُدار من شاشة «الأدوار والصلاحيات».</p>
            ) : roleInfo ? (
              <p className="text-[11px] text-muted-foreground">{roleInfo.description}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="acc-branch">الفرع</Label>
            <select
              id="acc-branch" className={`${selectCls} ${branchWarn ? "border-amber-400" : ""}`}
              value={String(value.branchId)}
              onChange={(e) => onChange({ branchId: e.target.value === "" ? "" : Number(e.target.value) })}
            >
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {branchWarn && (
              <p className="text-[11px] text-amber-600 inline-flex items-center gap-1"><AlertTriangle aria-hidden className="size-3.5" /> هذا الدور يُنصح بتحديد فرع محدد لتجنّب الوصول لكل الفروع.</p>
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
              <span className="text-[10px] font-medium text-primary mr-2 align-middle">{customCount} مخصّص</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {value.customRoleId ? (
            <p className="text-sm text-muted-foreground">صلاحيات الدور المخصّص محفوظة في تعريفه — عدّلها من شاشة «الأدوار والصلاحيات».</p>
          ) : (
            <>
              <PermDiffSummary role={value.role} override={value.permsOverride} />
              <PermissionMatrix
                role={value.role}
                permissions={resolvedPerms}
                onChange={handlePermChange}
                onReset={() => onChange({ permsOverride: {} })}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
