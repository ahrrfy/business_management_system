import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Label } from "@/components/ui/label";
import { WagePackageFields, defaultWageSchedule, wageValueFromEmployee, type WageDayValue } from "@/components/form/WagePackageFields";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { PageHeader } from "@/components/PageHeader";
import {
  AccountFields, accountPermsPayload, emptyAccountValue, validateAccount, type AccountFieldsValue,
} from "@/components/form/AccountFields";
import { SmartUserInput, type SmartUserValue } from "@/components/form/SmartUserInput";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import {
  DAY_RATES_DEFAULT, DEGREES, GENDERS, HR_DEPARTMENTS, MARITAL_STATUSES, PAY_TYPES,
  type EmployeeEducation,
} from "@shared/hr";
import { AlertCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ROLE_OPTIONS } from "@/lib/roles";
import { selectClsFull } from "@/lib/ui/formStyles";

type AccountMode = "none" | "new" | "link";
const roleLabelOf = (r: string) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r;

const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#0891b2", "#ea580c", "#16a34a", "#ca8a04", "#9333ea", "#0d9488", "#dc2626"];

type EduRow = EmployeeEducation & { key: number };

/** نموذج إضافة/تعديل موظف. يعمل كإضافة افتراضياً، وكتعديل إن مرّر مسارٌ id. */
export default function EmployeeNew() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const isEdit = Number.isFinite(editId);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const opts = trpc.employees.formOptions.useQuery();
  const existing = trpc.employees.get.useQuery({ id: editId! }, { enabled: isEdit });
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [form, setForm] = useState({
    firstName: "", fatherName: "", grandfatherName: "", lastName: "",
    gender: "ذكر", birthDate: "", maritalStatus: "", nationality: "عراقي", nationalId: "",
    phone: "", email: "", governorate: "بغداد", district: "", addressLandmark: "",
    emergencyContactName: "", emergencyContactPhone: "",
    department: HR_DEPARTMENTS[0] as string, position: "", branchId: "", managerId: "", hireDate: "",
    payType: "monthly" as "monthly" | "hourly", salary: "", allowances: "0",
    colorTag: COLORS[0], annualLeaveBalance: "0", sickLeaveBalance: "0",
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const [dayRates, setDayRates] = useState<Record<string, number>>({ ...DAY_RATES_DEFAULT });
  /** جدول الدوام الأسبوعيّ: ساعات كل يوم وسعر ساعته (0139). صفر ساعة = راحة. */
  /**
   * جدول الدوام الأسبوعيّ لهذا الموظف — **كل قيمة صريحة بيد المالك** (قرار ٣١/٧):
   * ساعات كل يوم وسعر ساعة كل يوم. لا اشتقاق صامت؛ زرّ «احسب من الراتب» يملأ الأسعار
   * دفعةً واحدة كنقطة بداية ثم تُعدَّل كما يشاء.
   */
  /** إعفاءٌ من الحضور — راتبٌ ثابت (للمُلّاك ولمن لا جهاز له). الافتراضي: خاضع (قرار المالك). */
  const [exempt, setExempt] = useState(false);
  const [sched, setSched] = useState<Record<string, WageDayValue>>(defaultWageSchedule);
  const [photo, setPhoto] = useState<ImageItem[]>([]);
  const [edu, setEdu] = useState<EduRow[]>([]);

  // —— حساب النظام (admin فقط) ——
  const me = trpc.auth.me?.useQuery?.();
  const isAdmin = me?.data?.role === "admin";
  /**
   * حزمة الأجر مقفلةٌ في التعديل لغير الأدمن — مرآةُ حارس `updateEmployee` الخادميّ
   * (البصمة الأجرية كلّها لا الراتب وحده). الإضافة مفتوحة: شروط التعيين الأولى هي
   * قرار التوظيف نفسه، وتغييرُها بعده يمرّ بالترقيات (اعتماد مديرٍ ثانٍ).
   */
  const payLocked = isEdit && !isAdmin;
  // تسمية الدور المخصّص الحقيقية لبطاقة بيانات الدخول (كانت «دور مخصّص» عامّة تُخفي الهوية).
  const rolesQ = trpc.roles.list.useQuery(undefined, { enabled: isAdmin });
  const [accountMode, setAccountMode] = useState<AccountMode>("none"); // وضع الإضافة
  const [editAccountMode, setEditAccountMode] = useState<"new" | "link">("link"); // وضع التعديل (لا حساب بعد)
  const [account, setAccount] = useState<AccountFieldsValue>(emptyAccountValue);
  const patchAccount = (p: Partial<AccountFieldsValue>) => setAccount((a) => ({ ...a, ...p }));
  const [linkUser, setLinkUser] = useState<SmartUserValue>({ userId: null, label: "" });
  const [autoSuggestSignal, setAutoSuggestSignal] = useState(0);
  const [createdInfo, setCreatedInfo] = useState<{
    name: string; email: string; username?: string; password: string; phone?: string;
    roleLabel?: string; roleKey?: string | null; branchName?: string | null; jobTitle?: string | null; mustChangePassword?: boolean; employeeId: number | null;
  } | null>(null);
  const employeeFullName = [form.firstName, form.fatherName, form.lastName].map((s) => s.trim()).filter(Boolean).join(" ");

  function pickMode(m: AccountMode) {
    if (m === "new" && accountMode !== "new") {
      setAccount((a) => ({
        ...a,
        branchId: a.branchId !== "" ? a.branchId : form.branchId ? Number(form.branchId) : (me?.data?.branchId as number) ?? "",
      }));
      setAutoSuggestSignal((n) => n + 1);
    }
    setAccountMode(m);
  }

  // تعبئة نموذج التعديل عند وصول البيانات (مرّة واحدة).
  if (isEdit && existing.data && !loaded) {
    const e = existing.data;
    setForm((f) => ({
      ...f,
      firstName: e.firstName ?? "", fatherName: e.fatherName ?? "", grandfatherName: e.grandfatherName ?? "", lastName: e.lastName ?? "",
      gender: e.gender ?? "ذكر", birthDate: e.birthDate ?? "", maritalStatus: e.maritalStatus ?? "", nationality: e.nationality ?? "عراقي", nationalId: e.nationalId ?? "",
      phone: e.phone ?? "", email: e.email ?? "", governorate: e.governorate ?? "", district: e.district ?? "", addressLandmark: e.addressLandmark ?? "",
      emergencyContactName: e.emergencyContactName ?? "", emergencyContactPhone: e.emergencyContactPhone ?? "",
      department: e.department ?? HR_DEPARTMENTS[0], position: e.position ?? "", branchId: e.branchId ? String(e.branchId) : "", managerId: e.managerId ? String(e.managerId) : "", hireDate: e.hireDate ?? "",
      payType: (e.payType as "monthly" | "hourly") ?? "monthly", salary: e.salary != null ? String(e.salary) : "", allowances: e.allowances != null ? String(e.allowances) : "0",
      colorTag: e.colorTag ?? COLORS[0], annualLeaveBalance: String(e.annualLeaveBalance ?? 0), sickLeaveBalance: String(e.sickLeaveBalance ?? 0),
    }));
    // نفس المُطبِّع الذي تستعمله شاشة الترقيات: يقبل الشكل القديم (رقمٌ = ساعات) ويُكمل
    // الأيام الناقصة راحةً — وإلا عُرض جدولٌ قديمٌ أصفاراً وأُرسل بشكلٍ يرفضه التحقّق.
    const w = wageValueFromEmployee(e);
    setDayRates(w.dayRates);
    setExempt(w.attendanceExempt);
    setSched(w.schedule);
    if (Array.isArray(e.education)) setEdu((e.education as EmployeeEducation[]).map((x, i) => ({ ...x, key: i + 1 })));
    if (e.photoUrl) setPhoto([{ dataUrl: e.photoUrl, isPrimary: true } as ImageItem]);
    setLoaded(true);
  }

  const photoUrl = useMemo(() => photo[0]?.dataUrl || photo[0]?.url || null, [photo]);

  const addEdu = () => setEdu((r) => [...r, { key: (r.at(-1)?.key ?? 0) + 1, degree: "بكالوريوس" }]);
  const patchEdu = (key: number, p: Partial<EduRow>) => setEdu((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const removeEdu = (key: number) => setEdu((r) => r.filter((x) => x.key !== key));

  const mutationOpts = {
    onSuccess: (e: { id: number; fullName?: string } | null | undefined) => {
      notify.ok(isEdit ? "تم حفظ التعديلات" : `أُضيف الموظف ${e?.fullName ?? ""}`);
      utils.employees.list.invalidate();
      navigate(e?.id ? `/hr/employees/${e.id}` : "/hr/employees");
    },
    onError: (err: { message: string }) => { setError(err.message); notify.err(err); },
  };
  const create = trpc.employees.create.useMutation(mutationOpts);
  const update = trpc.employees.update.useMutation(mutationOpts);

  // يحلّ بيانات الدخول المولّدة إلى بطاقة المشاركة (CredentialsShare).
  function showCredentials(cred: { email: string | null; username: string | null; password: string; role: string; customRoleId: number | null; mustChangePassword: boolean }, employeeId: number | null) {
    const accBranchId = account.branchId !== "" ? Number(account.branchId) : form.branchId ? Number(form.branchId) : null;
    setCreatedInfo({
      name: employeeFullName,
      email: cred.email ?? "",
      username: cred.username ?? undefined,
      password: cred.password,
      phone: form.phone.trim() || undefined,
      roleLabel: cred.customRoleId
        ? (rolesQ.data?.custom?.find((r: { id: number | string; label: string }) => Number(r.id) === cred.customRoleId)?.label ?? "دور مخصّص")
        : roleLabelOf(cred.role),
      // مفتاح الدور يحدّد دومين رابط الدعوة (المندوب ⇒ تطبيق الدومين العام).
      roleKey: cred.customRoleId ? null : cred.role,
      branchName: accBranchId ? opts.data?.branches.find((b) => b.id === accBranchId)?.name ?? null : null,
      jobTitle: form.position.trim() || null,
      mustChangePassword: cred.mustChangePassword,
      employeeId,
    });
  }

  const createWithAccount = trpc.employees.createWithAccount.useMutation({
    onSuccess: (res) => {
      utils.employees.list.invalidate();
      notify.ok(`أُضيف الموظف ${res.employee?.fullName ?? ""}`);
      if (res.credentials) showCredentials(res.credentials, res.employee?.id ?? null);
      else navigate(res.employee?.id ? `/hr/employees/${res.employee.id}` : "/hr/employees");
    },
    onError: (err: { message: string }) => { setError(err.message); notify.err(err); },
  });

  const linkAccountM = trpc.employees.linkAccount.useMutation({
    onSuccess: () => { notify.ok("تم ربط الحساب بالموظف"); setLinkUser({ userId: null, label: "" }); void existing.refetch(); },
    onError: (err: { message: string }) => { setError(err.message); notify.err(err); },
  });
  const unlinkAccountM = trpc.employees.unlinkAccount.useMutation({
    onSuccess: () => { notify.ok("تم فكّ ربط الحساب"); void existing.refetch(); },
    onError: (err: { message: string }) => { setError(err.message); notify.err(err); },
  });
  const createAccountForM = trpc.employees.createAccountFor.useMutation({
    onSuccess: (res) => { notify.ok("تم إنشاء الحساب وربطه بالموظف"); void existing.refetch(); if (res.credentials) showCredentials(res.credentials, editId); },
    onError: (err: { message: string }) => { setError(err.message); notify.err(err); },
  });

  const pending = create.isPending || update.isPending || createWithAccount.isPending;

  function submit() {
    setError("");
    if (!form.firstName.trim()) { setError("الاسم الأول مطلوب."); return; }
    if (!form.lastName.trim()) { setError("اللقب مطلوب."); return; }
    if (form.payType === "monthly" && !form.salary.trim()) { setError("الراتب الأساس مطلوب لذوي الراتب الشهري."); return; }
    const payload = {
      firstName: form.firstName.trim(), fatherName: form.fatherName.trim() || undefined, grandfatherName: form.grandfatherName.trim() || undefined, lastName: form.lastName.trim(),
      gender: form.gender || undefined, birthDate: form.birthDate || undefined, maritalStatus: form.maritalStatus || undefined, nationality: form.nationality.trim() || undefined, nationalId: form.nationalId.trim() || undefined,
      phone: form.phone.trim() || undefined, email: form.email.trim() || undefined, governorate: form.governorate.trim() || undefined, district: form.district.trim() || undefined, addressLandmark: form.addressLandmark.trim() || undefined,
      emergencyContactName: form.emergencyContactName.trim() || undefined, emergencyContactPhone: form.emergencyContactPhone.trim() || undefined,
      department: form.department || undefined, position: form.position.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined, managerId: form.managerId ? Number(form.managerId) : undefined, hireDate: form.hireDate || undefined,
      payType: form.payType,
      salary: form.payType === "monthly" ? (form.salary.trim() || undefined) : undefined,
      allowances: form.payType === "monthly" ? (form.allowances.trim() || "0") : "0",
      // حقول الحزمة **تُحذَف** حين تكون مقفلة: الخادم يفسّر الغياب «لا تُمسّ» ⇒ لا يُرسل
      // النموذج قيمةً افتراضيةً تُقارَن بجدولٍ فارغٍ في القاعدة فتُقرأ تغييراً وهمياً.
      dayRates: payLocked ? undefined : form.payType === "hourly" ? dayRates : undefined,
      // جدولٌ خاصّ يتقدّم على الافتراضي العامّ؛ إطفاؤه ⇒ null فيرث العامّ.
      workSchedule: payLocked ? undefined : sched,
      // الإعفاء مفهومٌ شهريٌّ بحت: الساعيّ أجرُه ساعاتُ حضوره أصلاً فلا «راتب ثابت» يُعفى منه.
      attendanceExempt: payLocked ? undefined : form.payType === "monthly" && exempt,
      colorTag: form.colorTag || undefined, photoUrl: photoUrl || undefined,
      education: edu.length ? edu.map(({ key, ...e }) => ({ ...e, degree: e.degree, year: e.year ? Number(e.year) : undefined })) : undefined,
      annualLeaveBalance: Number(form.annualLeaveBalance || 0), sickLeaveBalance: Number(form.sickLeaveBalance || 0),
    };
    if (isEdit) { update.mutate({ id: editId!, ...payload }); return; }

    // الإضافة — تفرّع حسب وضع الحساب (غير admin أو «بلا حساب» ⇒ المسار الحالي).
    if (!isAdmin || accountMode === "none") { create.mutate(payload); return; }
    if (accountMode === "link") {
      if (!linkUser.userId) { setError("اختر حساباً موجوداً للربط، أو اختر «بلا حساب»."); return; }
      createWithAccount.mutate({ ...payload, account: { mode: "link", userId: linkUser.userId } });
      return;
    }
    // accountMode === "new"
    const accErr = validateAccount(account);
    if (accErr) { setError(accErr); return; }
    createWithAccount.mutate({ ...payload, account: { mode: "new", ...accountNewPayload() } });
  }

  /**
   * حارس فقد البيانات — النموذج طويل (٤٠+ حقلاً) وخطأ إغلاق تبويب بالخطأ مكلف.
   * الإضافة: أيّ حقلٍ غير فارغ يعني تغييراً حقيقياً (النموذج يبدأ فارغاً).
   * التعديل: النموذج يبدأ **معبَّأً** من بيانات الموظف ⇒ «غير فارغ» دائماً؛ لا بدّ من
   * لقطةٍ للحالة الأولى بعد التحميل (`loaded`) ومقارنة الحالة الحالية بها فعلياً.
   */
  const dirtySnapshot = () => JSON.stringify({ form, dayRates, exempt, sched, photoUrl, edu: edu.map(({ key, ...e }) => e) });
  const initialSnapshotRef = useRef<string>("");
  useEffect(() => {
    if (isEdit && !loaded) return; // بيانات التعديل لم تصل بعد — لا لقطة سابقة لأوانها
    if (initialSnapshotRef.current) return; // لقطة واحدة فقط عند أول استقرار
    initialSnapshotRef.current = dirtySnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, loaded]);
  const isDirty = !!initialSnapshotRef.current && dirtySnapshot() !== initialSnapshotRef.current;
  useUnsavedGuard(isDirty && !createdInfo);

  // اختصار: Ctrl+S حفظ — بلا Esc (النموذج مكتظّ بـ<select> أصليّة، راجع تحذير الهوك).
  useSaveShortcuts({ onSave: submit, enabled: !pending });

  /** يبني حقول الحساب الجديد للإرسال (الاسم من الموظف؛ الفرع/الهاتف/المسمّى تُؤخذ من الموظف خادمياً). */
  function accountNewPayload() {
    return {
      name: employeeFullName,
      email: account.email.trim().toLowerCase() || undefined,
      username: account.username.trim().toLowerCase() || undefined,
      password: account.password,
      role: account.role,
      customRoleId: account.customRoleId ?? undefined,
      branchId: account.branchId === "" ? undefined : Number(account.branchId),
      permissionsOverride: accountPermsPayload(account),
      mustChangePassword: account.mustChangePassword,
    };
  }

  /** التعديل: إنشاء حساب جديد لموظف قائم وربطه. */
  function createAccountForEdit() {
    setError("");
    const accErr = validateAccount(account);
    if (accErr) { setError(accErr); return; }
    createAccountForM.mutate({ employeeId: editId!, ...accountNewPayload() });
  }

  /** التعديل: ربط حساب قائم. */
  function linkAccountForEdit() {
    setError("");
    if (!linkUser.userId) { setError("اختر حساباً موجوداً للربط."); return; }
    linkAccountM.mutate({ employeeId: editId!, userId: linkUser.userId });
  }

  // بعد إنشاء حساب جديد للموظف: بطاقة مشاركة بيانات الدخول.
  if (createdInfo) {
    const dest = createdInfo.employeeId ? `/hr/employees/${createdInfo.employeeId}` : "/hr/employees";
    return (
      <div className="space-y-4 max-w-2xl">
        <PageHeader
          title={isEdit ? "تعديل موظف" : "إضافة موظف"}
          backHref="/hr/employees"
          backLabel="رجوع للموظفين"
        />
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
          onClose={() => navigate(dest)}
        />
        <div className="flex gap-2">
          <Button onClick={() => navigate(dest)}>عرض الموظف</Button>
          <Link href="/hr/employees"><Button variant="outline">العودة للموظفين</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* شريط أدوات ثابت أعلى النموذج — نموذجٌ طويل (٤٠+ حقلاً)، والتمرير كان يُغيّب زرّ الحفظ
          عن النظر تماماً حتى العودة للأعلى. مطابقٌ لشريط الأسفل (نفس الأزرار) لا يفرض قراراً جديداً. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <h1 className="text-2xl font-bold">{isEdit ? "تعديل موظف" : "إضافة موظف"}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={submit} disabled={pending} title="Ctrl+S">{pending ? "جارٍ الحفظ…" : isEdit ? "حفظ التعديلات" : "حفظ الموظف"}</Button>
          <Link href="/hr/employees"><Button variant="outline">إلغاء</Button></Link>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">الاسم والصورة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:col-span-2">
            <div className="space-y-1"><Label htmlFor="fn">الاسم الأول *</Label><Input id="fn" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} placeholder="علي" /></div>
            <div className="space-y-1"><Label htmlFor="fa">اسم الأب</Label><Input id="fa" value={form.fatherName} onChange={(e) => set({ fatherName: e.target.value })} placeholder="حسين" /></div>
            <div className="space-y-1"><Label htmlFor="gf">اسم الجد</Label><Input id="gf" value={form.grandfatherName} onChange={(e) => set({ grandfatherName: e.target.value })} placeholder="كاظم" /></div>
            <div className="space-y-1"><Label htmlFor="ln">اللقب *</Label><Input id="ln" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} placeholder="العبيدي" /></div>
          </div>
          <div className="md:col-span-2">
            <Label className="mb-1 block">الصورة الشخصية</Label>
            <ImageUploader value={photo} onChange={setPhoto} maxItems={1} hint="صورة واحدة (تُضغط تلقائياً)." />
          </div>
          <div className="space-y-1">
            <Label htmlFor="color">لون البطاقة</Label>
            <div className="flex items-center gap-2">
              <input id="color" type="color" value={form.colorTag} onChange={(e) => set({ colorTag: e.target.value })} className="h-9 w-14 rounded-md border border-input" />
              <div className="flex flex-wrap gap-1">
                {COLORS.map((c) => <button key={c} type="button" onClick={() => set({ colorTag: c })} className="size-5 rounded-full border" style={{ background: c }} aria-label={c} />)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المعلومات الشخصية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1"><Label htmlFor="gender">الجنس</Label>
            <select id="gender" className={selectClsFull} value={form.gender} onChange={(e) => set({ gender: e.target.value })}>{GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}</select>
          </div>
          <div className="space-y-1"><Label htmlFor="birth">تاريخ الميلاد</Label><Input id="birth" type="date" dir="ltr" value={form.birthDate} onChange={(e) => set({ birthDate: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="marital">الحالة الاجتماعية</Label>
            <select id="marital" className={selectClsFull} value={form.maritalStatus} onChange={(e) => set({ maritalStatus: e.target.value })}><option value="">—</option>{MARITAL_STATUSES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          </div>
          <div className="space-y-1"><Label htmlFor="nat">الجنسية</Label><Input id="nat" value={form.nationality} onChange={(e) => set({ nationality: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="nid">رقم الهوية الوطنية</Label><Input id="nid" dir="ltr" value={form.nationalId} onChange={(e) => set({ nationalId: e.target.value })} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">التواصل والعنوان</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1"><Label htmlFor="phone">الهاتف</Label><IntlPhoneInput id="phone" value={form.phone} onChange={(phone) => set({ phone })} /></div>
          <div className="space-y-1"><Label htmlFor="email">البريد الإلكتروني</Label><Input id="email" dir="ltr" value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="gov">المحافظة</Label><Input id="gov" value={form.governorate} onChange={(e) => set({ governorate: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="dist">المنطقة</Label><Input id="dist" value={form.district} onChange={(e) => set({ district: e.target.value })} /></div>
          <div className="space-y-1 md:col-span-2"><Label htmlFor="land">أقرب نقطة دالة</Label><Input id="land" value={form.addressLandmark} onChange={(e) => set({ addressLandmark: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="ecn">اسم جهة الطوارئ</Label><Input id="ecn" value={form.emergencyContactName} onChange={(e) => set({ emergencyContactName: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="ecp">هاتف الطوارئ</Label><IntlPhoneInput id="ecp" value={form.emergencyContactPhone} onChange={(emergencyContactPhone) => set({ emergencyContactPhone })} /></div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">الوظيفة والأجر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1"><Label htmlFor="dept">القسم</Label>
            <select id="dept" className={selectClsFull} value={form.department} onChange={(e) => set({ department: e.target.value })}>{HR_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</select>
          </div>
          <div className="space-y-1"><Label htmlFor="pos">المسمى الوظيفي</Label><Input id="pos" value={form.position} onChange={(e) => set({ position: e.target.value })} placeholder="مدير المبيعات" /></div>
          <div className="space-y-1"><Label htmlFor="br">الفرع</Label>
            <select id="br" className={selectClsFull} value={form.branchId} onChange={(e) => set({ branchId: e.target.value })}><option value="">—</option>{(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}</select>
          </div>
          <div className="space-y-1"><Label htmlFor="mgr">المدير المباشر</Label>
            <select id="mgr" className={selectClsFull} value={form.managerId} onChange={(e) => set({ managerId: e.target.value })}><option value="">—</option>{(opts.data?.managers ?? []).filter((m) => m.id !== editId).map((m) => <option key={m.id} value={String(m.id)}>{m.name}{m.position ? ` — ${m.position}` : ""}</option>)}</select>
          </div>
          <div className="space-y-1"><Label htmlFor="hire">تاريخ المباشرة</Label><Input id="hire" type="date" dir="ltr" value={form.hireDate} onChange={(e) => set({ hireDate: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pt">طريقة الأجر</Label>
            {/* جزءٌ من البصمة الأجرية (يبدّل نموذج الاحتساب كلَّه) ⇒ يتبع قفل الحزمة. */}
            <select id="pt" className={selectClsFull} disabled={payLocked} value={form.payType} onChange={(e) => set({ payType: e.target.value as "monthly" | "hourly" })}>{PAY_TYPES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
          </div>

          {/*
            حزمة الأجر — محرّرٌ مشترك مع شاشة الترقيات (مصدرُ قيمٍ افتراضيةٍ واحد يطابق
            تطبيع الخادم). وهي **مقفلةٌ في التعديل لغير الأدمن**: الخادم يرفض أيّ تغيّرٍ
            في البصمة الأجرية (راتب/بدلات/جدول/أسعار أيام/إعفاء) ويحيل إلى الترقيات ذات
            الاعتماد المزدوج، فعرضُها قابلةً للكتابة كان يَعِد بحفظٍ يُرفض بعد تعبئة النموذج.
            الإضافة تبقى مفتوحةً: شروط التعيين الأولى قرارُ التوظيف نفسه.
          */}
          {payLocked && (
            <div className="md:col-span-3 rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
              <span className="font-medium">حزمة الأجر للعرض فقط.</span>{" "}
              تغييرُ الراتب أو البدلات أو جدول الدوام أو أسعار الساعات أو الإعفاء من الحضور يمرّ بـ
              <Link href="/hr/promotions" className="mx-1 underline">الترقيات</Link>
              — باعتماد مديرٍ آخر وتاريخ سريان وسجلّ تاريخيّ.
            </div>
          )}
          <WagePackageFields
            value={{ payType: form.payType, salary: form.salary, allowances: form.allowances, attendanceExempt: exempt, dayRates, schedule: sched }}
            disabled={payLocked}
            onChange={(patch) => {
              if (patch.salary !== undefined) set({ salary: patch.salary });
              if (patch.allowances !== undefined) set({ allowances: patch.allowances });
              if (patch.attendanceExempt !== undefined) setExempt(patch.attendanceExempt);
              if (patch.dayRates !== undefined) setDayRates(patch.dayRates);
              if (patch.schedule !== undefined) setSched(patch.schedule);
            }}
          />
        </CardContent>
      </Card>

      {/* حساب النظام — admin فقط. وضع الإضافة: ٣ خيارات. */}
      {isAdmin && !isEdit && (
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">حساب النظام</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">يستخدم بعض الموظفين النظام والبعض لا — اختر ما يناسب هذا الموظف.</p>
            <div className="inline-flex flex-wrap rounded-md border p-0.5 gap-0.5">
              {([["none", "بلا حساب — موظف فقط"], ["new", "إنشاء حساب جديد"], ["link", "ربط بحساب موجود"]] as const).map(([k, lbl]) => (
                <button key={k} type="button" onClick={() => pickMode(k)} className={`px-3 h-8 rounded text-sm ${accountMode === k ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{lbl}</button>
              ))}
            </div>
            {accountMode === "new" && (
              <AccountFields value={account} onChange={patchAccount} nameForSuggest={employeeFullName} autoSuggestSignal={autoSuggestSignal} />
            )}
            {accountMode === "link" && (
              <div className="space-y-1 max-w-md">
                <Label>ربط بحساب موجود</Label>
                <SmartUserInput value={linkUser} onChange={setLinkUser} placeholder="ابحث باسم المستخدم أو البريد — يعرض الحسابات غير المرتبطة" />
                <p className="text-[11px] text-muted-foreground">تُعرض فقط الحسابات غير المرتبطة بموظف آخر.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* حساب النظام — admin فقط. وضع التعديل: عرض/فكّ الربط أو ربط/إنشاء. */}
      {isAdmin && isEdit && (
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">حساب النظام</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {existing.data?.linkedUser ? (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground">الحساب المرتبط:</span>
                  <span dir="ltr" className="truncate">{existing.data.linkedUser.username || existing.data.linkedUser.email || existing.data.linkedUser.name || `#${existing.data.linkedUser.id}`}</span>
                  <Badge variant="outline" className="text-[10px]" title={existing.data.linkedUser.customRoleLabel ? `دور مخصّص — الفئة الأساس: ${roleLabelOf(existing.data.linkedUser.role)}` : undefined}>
                    {existing.data.linkedUser.customRoleLabel ?? roleLabelOf(existing.data.linkedUser.role)}
                  </Badge>
                </span>
                <Button
                  variant="ghost" size="sm" className="text-destructive shrink-0"
                  disabled={unlinkAccountM.isPending}
                  onClick={() => { if (window.confirm("هل تريد إلغاء ربط هذا الحساب بالموظف؟ سيبقى الحساب فعّالاً لكن غير مرتبط.")) unlinkAccountM.mutate({ employeeId: editId! }); }}
                >إلغاء الربط</Button>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">لا حساب مرتبط بهذا الموظف.</p>
                <div className="inline-flex rounded-md border p-0.5 gap-0.5">
                  {([["new", "إنشاء حساب جديد"], ["link", "ربط بحساب موجود"]] as const).map(([k, lbl]) => (
                    <button key={k} type="button" onClick={() => { setEditAccountMode(k); if (k === "new") setAutoSuggestSignal((n) => n + 1); }} className={`px-3 h-8 rounded text-sm ${editAccountMode === k ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{lbl}</button>
                  ))}
                </div>
                {editAccountMode === "new" ? (
                  <>
                    <AccountFields value={account} onChange={patchAccount} nameForSuggest={employeeFullName} autoSuggestSignal={autoSuggestSignal} />
                    <Button onClick={createAccountForEdit} disabled={createAccountForM.isPending}>{createAccountForM.isPending ? "جارٍ…" : "إنشاء الحساب وربطه"}</Button>
                  </>
                ) : (
                  <div className="space-y-2 max-w-md">
                    <SmartUserInput value={linkUser} onChange={setLinkUser} employeeId={editId ?? undefined} placeholder="ابحث باسم المستخدم أو البريد — يعرض الحسابات غير المرتبطة" />
                    <p className="text-[11px] text-muted-foreground">تُعرض فقط الحسابات غير المرتبطة بموظف آخر.</p>
                    <Button onClick={linkAccountForEdit} disabled={linkAccountM.isPending}>{linkAccountM.isPending ? "جارٍ…" : "ربط الحساب"}</Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">المؤهلات الدراسية</CardTitle>
          <Button variant="outline" size="sm" onClick={addEdu}>+ إضافة مؤهل</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {edu.length === 0 && <p className="text-sm text-muted-foreground">لا مؤهلات مضافة.</p>}
          {edu.map((e) => (
            <div key={e.key} className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end border-t pt-3">
              <div className="space-y-1"><Label className="text-xs">الشهادة</Label>
                <select className={selectClsFull} value={e.degree} onChange={(ev) => patchEdu(e.key, { degree: ev.target.value })}>{DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}</select>
              </div>
              <div className="space-y-1"><Label className="text-xs">التخصص</Label><Input value={e.major ?? ""} onChange={(ev) => patchEdu(e.key, { major: ev.target.value })} /></div>
              <div className="space-y-1 md:col-span-2"><Label className="text-xs">الجهة</Label><Input value={e.school ?? ""} onChange={(ev) => patchEdu(e.key, { school: ev.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">السنة</Label><Input dir="ltr" inputMode="numeric" value={e.year ? String(e.year) : ""} onChange={(ev) => patchEdu(e.key, { year: Number(ev.target.value.replace(/\D/g, "")) || undefined })} /></div>
              <div className="flex items-end gap-1">
                <div className="space-y-1 flex-1"><Label className="text-xs">التقدير</Label><Input value={e.gpa ?? ""} onChange={(ev) => patchEdu(e.key, { gpa: ev.target.value })} /></div>
                <Button variant="ghost" size="sm" onClick={() => removeEdu(e.key)} aria-label="حذف"><X aria-hidden className="size-4" /></Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">أرصدة الإجازات (أيام)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1"><Label htmlFor="alb">رصيد الإجازة السنوية</Label><Input id="alb" dir="ltr" inputMode="numeric" value={form.annualLeaveBalance} onChange={(e) => set({ annualLeaveBalance: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="space-y-1"><Label htmlFor="slb">رصيد الإجازة المرضية</Label><Input id="slb" dir="ltr" inputMode="numeric" value={form.sickLeaveBalance} onChange={(e) => set({ sickLeaveBalance: e.target.value.replace(/\D/g, "") })} /></div>
        </CardContent>
      </Card>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button onClick={submit} disabled={pending} title="Ctrl+S">{pending ? "جارٍ الحفظ…" : isEdit ? "حفظ التعديلات" : "حفظ الموظف"}</Button>
        <Link href="/hr/employees"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
