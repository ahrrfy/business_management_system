import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { DeviceLinkCard } from "@/components/hr/DeviceLinkCard";
import { EmployeeStatementCard } from "@/components/hr/EmployeeStatementCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsagePanel } from "@/components/UsagePanel";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { EmpAvatar, EmploymentStatusBadge, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { type EmployeeEducation, payTypeLabel, WEEK_DAYS } from "@shared/hr";
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { PageHeader } from "@/components/PageHeader";

/** أعمدة المؤهلات الدراسية — قائمةُ صفوفٍ متجانسة داخل تبويب البطاقة. */
const educationColumns: ColumnDef<EmployeeEducation, unknown>[] = [
  { id: "degree", header: "الشهادة", accessorFn: (r) => r.degree, cell: ({ row }) => row.original.degree },
  { id: "major", header: "التخصص", accessorFn: (r) => r.major ?? "—", cell: ({ row }) => row.original.major ?? "—" },
  { id: "school", header: "الجهة", accessorFn: (r) => r.school ?? "—", meta: { width: "wide" }, cell: ({ row }) => row.original.school ?? "—" },
  // سَنَة: رقمٌ يُعزَل اتّجاهه بـkind، ومحاذاته تبقى بدايةً كما كانت في الجدول الخامّ.
  { id: "year", header: "السنة", accessorFn: (r) => r.year ?? "—", meta: { kind: "number", align: "start" }, cell: ({ row }) => row.original.year ?? "—" },
  { id: "gpa", header: "التقدير", accessorFn: (r) => r.gpa ?? "—", cell: ({ row }) => row.original.gpa ?? "—" },
];

function Field({ label, value, dir }: { label: string; value: React.ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div dir={dir}>{value ?? "—"}</div>
    </div>
  );
}

export default function EmployeeDetail() {
  const params = useParams();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const q = trpc.employees.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const usage = trpc.employees.usage.useQuery({ id }, { enabled: Number.isFinite(id) });
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin"; // شاشة تعديل المستخدم admin-only ⇒ لا نربطها لغير الإدارة
  const [tab, setTab] = useState("overview");

  const refresh = async () => { await Promise.all([utils.employees.get.invalidate({ id }), utils.employees.list.invalidate()]); };
  const setStatus = trpc.employees.setStatus.useMutation({
    onSuccess: async (r) => {
      // الخادم يرفض `terminated` من هذا الإجراء ويحيل للمسار الرسميّ ⇒ أثرا الفصل
      // (تعطيلُ الحساب وحدُّ ربط الجهاز) لا يقعان هنا أبداً. الأثر الممكن الوحيد عكسيّ:
      // إعادةُ العمل ترفع `effectiveTo` عن ربط جهاز الحضور (0207) — يُصرَّح به بدل أن
      // يمرّ صامتاً، وإلّا ظنّ المستعمل أنّ بصمات العائد ما زالت مُهمَلة.
      const restored = r?.deviceLinksRestored ?? 0;
      notify.ok(`تم تحديث حالة التوظيف${restored ? ` — وأُعيد تفعيل ربطه بجهاز الحضور (${restored})` : ""}`);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.employees.delete.useMutation({
    onSuccess: async () => { notify.ok("تم حذف الموظف نهائياً"); await utils.employees.list.invalidate(); navigate("/hr/employees"); },
    onError: (e) => notify.err(e),
  });

  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (q.error) return <div className="p-10 text-center text-destructive">تعذّر تحميل الموظف: {q.error.message}</div>;
  const e = q.data;
  if (!e) return <div className="p-10 text-center text-muted-foreground">الموظف غير موجود. <Link href="/hr/employees" className="text-primary">رجوع للقائمة</Link></div>;

  const dayRates = (e.dayRates && typeof e.dayRates === "object" ? e.dayRates : {}) as Record<string, number>;
  const education = (Array.isArray(e.education) ? e.education : []) as EmployeeEducation[];
  const grossMonthly = Number(e.salary ?? 0) + Number(e.allowances ?? 0);
  const isTerminated = e.employmentStatus === "terminated";

  return (
    <div className="space-y-4 max-w-5xl">
      <PageHeader
        title="بطاقة الموظف"
        backHref="/hr/employees"
        backLabel="رجوع للموظفين"
      />

      {/* ترويسة الموظف */}
      <Card>
        <CardContent className="p-4 flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-start gap-3">
            <EmpAvatar name={e.fullName} color={e.colorTag} photoUrl={e.photoUrl} sizePx={56} />
            <div>
              <div className="text-lg font-bold leading-tight">{e.fullName}</div>
              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
                {e.position && <span>{e.position}</span>}
                {e.department && <><span>·</span><span>{e.department}</span></>}
                {e.branchName && <><span>·</span><span>{e.branchName}</span></>}
                <span>·</span>
                <EmploymentStatusBadge status={e.employmentStatus} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/hr/employees/${id}/edit`}><Button variant="outline" size="sm">تعديل</Button></Link>
            {/*
             * مبدّل الحالة **زوجٌ كامل** — لكل حالةٍ طريقُ رجوع. كان «إعادة للعمل» مشروطاً
             * بـ`isTerminated` وحده، فالموظف الموضوع على «في إجازة» يعلق فيها بلا أيّ مخرجٍ
             * في الويب: خيارُه الوحيد المعروض كان «إنهاء الخدمة». وتطبيق أندرويد يملك
             * الزرَّين معاً (`HrAdminScreen.kt`) ⇒ يُوضَع بإجازةٍ من هناك ولا يُعاد من هنا.
             *
             * والعلوقُ ليس تجميلياً: `employmentStatus='active'` شرطٌ في منتقي التسجيل
             * اليدوي للحضور (`attendanceService`) وفي تسجيل العهدة (`assets/lifecycle`)
             * وفي قائمة المدراء المرشّحين (`employeeService`) ⇒ الموظف يختفي من هذه
             * المسارات كلّها وهو على رأس عمله.
             *
             * ⛔ «إنهاء الخدمة» خارج هذا المبدّل عمداً — الراوتر يرفض الحالة
             * `terminated` صراحةً ويحيل إلى مسار التسوية الرسميّ (فصلُ مهامٍ واعتمادٌ ثانٍ).
             */}
            {e.employmentStatus === "active" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={setStatus.isPending}
                onClick={async () => {
                  if (!(await confirm({
                    variant: "warning",
                    title: "وضع الموظف في إجازة",
                    description: `سيُوسَم «${e.fullName}» «في إجازة»: يختفي من منتقي تسجيل الحضور اليدوي ومن قائمة المدراء المرشّحين، ويُمنع تسجيل عهدة جديدة عليه. أعِده من الزرّ نفسه متى رجع.`,
                    confirmText: "وضع بإجازة",
                  }))) return;
                  setStatus.mutate({ id, status: "leave" });
                }}
              >وضع بإجازة</Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={setStatus.isPending}
                onClick={async () => {
                  if (!(await confirm({
                    variant: "info",
                    title: "إعادة الموظف للعمل",
                    description: isTerminated
                      ? `إعادة «${e.fullName}» إلى الخدمة الفعّالة؟ يُرفَع حدُّ ربطه بجهاز الحضور فتعود بصماته تُسجَّل.`
                      : `إنهاء إجازة «${e.fullName}» وإعادته إلى رأس العمل؟ يعود إلى منتقي الحضور اليدوي وقائمة المدراء المرشّحين، ويُسمح بتسجيل العهدة عليه.`,
                    confirmText: "إعادة للعمل",
                  }))) return;
                  setStatus.mutate({ id, status: "active" });
                }}
              >إعادة للعمل</Button>
            )}
            {!isTerminated && (
              // إنهاء الخدمة لا يُنفَّذ من بطاقة الموظف: `employees.setStatus` يرفض
              // `terminated` صراحةً، والمسار الرسميّ وحده يحمل Maker-Checker وتسوية
              // المستحقات النهائية. الزرّ يُحيل إليه بدل نافذةٍ تفشل عند كل ضغطة.
              //
              // والرابط يحمل **النيّة والموظف** لا التبويب وحده (Codex P2، ٣١/٨): `tab`
              // للـhub، و`sub` لتبويب الإنهاءات داخل الشاشة، و`employee` لانتقائه سلفاً.
              // بدونها يهبط المستعمل على تبويب الترقيات — وزرّ «إنهاء خدمة» لا يُرسَم أصلاً
              // إلا على تبويب الإنهاءات — فيلزمه نقرتان وإعادةُ اختيارٍ من مئتَي اسم:
              // بابُ إنهاءِ خدمةٍ للموظف الخطأ، وهو فعلٌ ماليّ لا رجعة فيه.
              <Link href={`/hr?tab=promotions&sub=terminations&employee=${id}`}>
                <Button variant="outline" size="sm" className="text-destructive" title="يُنفَّذ من مسار إنهاء الخدمة الرسميّ — بتسوية مستحقات واعتماد ثانٍ">إنهاء الخدمة</Button>
              </Link>
            )}
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="overview">نظرة عامة</TabsTrigger>
          <TabsTrigger value="personal">شخصية</TabsTrigger>
          <TabsTrigger value="education">دراسية ({education.length})</TabsTrigger>
          <TabsTrigger value="salary">الراتب</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardContent className="p-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <Field label="القسم" value={e.department} />
                <Field label="المسمى الوظيفي" value={e.position} />
                <Field label="الفرع" value={e.branchName} />
                <Field label="المدير المباشر" value={e.managerName} />
                <Field label="تاريخ المباشرة" value={fmtDate(e.hireDate)} dir="ltr" />
                <Field label="طريقة الأجر" value={payTypeLabel(e.payType)} />
                <Field label="الهاتف" value={e.phone} dir="ltr" />
                <Field label="البريد الإلكتروني" value={e.email} dir="ltr" />
                <Field label="العنوان" value={[e.governorate, e.district, e.addressLandmark].filter(Boolean).join(" / ") || "—"} />
                <Field label="رصيد الإجازة السنوية" value={`${e.annualLeaveBalance ?? 0} يوم`} />
                <Field label="رصيد الإجازة المرضية" value={`${e.sickLeaveBalance ?? 0} يوم`} />
                {isTerminated && <Field label="تاريخ إنهاء الخدمة" value={fmtDate(e.terminationDate)} dir="ltr" />}
                {isTerminated && e.terminationReason && <Field label="سبب إنهاء الخدمة" value={e.terminationReason} />}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">بطاقة الموظف</CardTitle></CardHeader>
              <CardContent className="flex flex-col items-center gap-2 py-2">
                <BarcodeDisplay barcodeSet={{ barcode128: `EMP-${e.id}`, qrPayload: `EMP-${e.id}`, displayLabel: `${e.fullName}\nEMP-${e.id}` }} size="md" showCode128={false} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="personal">
          <Card><CardContent className="p-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="الجنس" value={e.gender} />
            <Field label="تاريخ الميلاد" value={fmtDate(e.birthDate)} dir="ltr" />
            <Field label="الحالة الاجتماعية" value={e.maritalStatus} />
            <Field label="الجنسية" value={e.nationality} />
            <Field label="رقم الهوية الوطنية" value={e.nationalId} dir="ltr" />
            <Field label="جهة الطوارئ" value={e.emergencyContactName} />
            <Field label="هاتف الطوارئ" value={e.emergencyContactPhone} dir="ltr" />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="education">
          <Card><CardContent className="p-0">
            {/* مُضمَّن: تبويبٌ داخل بطاقة الموظف يحمل عدَّه في رأس التبويب. */}
            <DataTable<EmployeeEducation>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              data={education}
              columns={educationColumns}
              emptyText="لا مؤهلات مسجّلة."
            />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="salary">
          <Card>
            <CardHeader><CardTitle className="text-base">الأجر — {payTypeLabel(e.payType)}</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {e.payType === "monthly" ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <Field label="الراتب الأساس" value={<span dir="ltr" className="tabular-nums">{iqd(e.salary)}</span>} />
                  <Field label="البدلات" value={<span dir="ltr" className="tabular-nums">{iqd(e.allowances)}</span>} />
                  <Field label="الإجمالي الشهري" value={<span dir="ltr" className="tabular-nums font-bold">{iqd(grossMonthly)}</span>} />
                </div>
              ) : (
                <div>
                  <p className="text-muted-foreground mb-2">سعر الساعة لكل يوم (أجر اليوم = ساعات × سعر ذلك اليوم):</p>
                  <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
                    {WEEK_DAYS.map((d) => (
                      <div key={d} className="rounded-md border p-2 text-center">
                        <div className="text-xs text-muted-foreground">{d}</div>
                        <div className="tabular-nums font-medium" dir="ltr">{iqd(dayRates[d] ?? 0)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* كشف الحضور اليوميّ — من ساعة إلى ساعة، سعر الساعة وأجر اليوم (قرار المالك ٣١/٧) */}
      <EmployeeStatementCard employeeId={id} phone={e.phone} />

      {/* ربط جهاز الحضور — يُدار من بطاقة الموظف لا من شاشة الأجهزة وحدها */}
      <DeviceLinkCard employeeId={id} employeeName={e.fullName} hireDate={e.hireDate} links={e.deviceLinks ?? []} isTerminated={isTerminated} onChanged={refresh} />

      {/* الوصول لحساب المستخدم المرتبط + الحذف النهائي */}
      <Card className="border-destructive/40">
        <CardHeader><CardTitle className="text-base text-destructive">أدوات الموظف — الحذف النهائي</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {e.userId ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">حساب المستخدم المرتبط:</span>
              {isAdmin ? (
                <Link href={`/users/${e.userId}/edit`} className="text-primary underline">فتح حساب المستخدم #{e.userId}</Link>
              ) : (
                <span className="font-mono" dir="ltr">USER-{e.userId} <span className="text-xs text-muted-foreground">(إدارته للإدارة فقط)</span></span>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">لا حساب مستخدم (دخول للنظام) مرتبط بهذا الموظف.</p>
          )}
          <p className="text-xs text-muted-foreground">
            يُحذف الموظف نهائياً من القاعدة ولا يمكن التراجع. متاح فقط للموظف «النظيف» (بلا حضور/عُهد/رواتب/إجازات/ترقيات).
            البديل الآمن القابل للتراجع: «إنهاء الخدمة» أعلاه.
          </p>
          <UsagePanel usage={usage.data} />
          <Button
            variant="outline"
            className="text-destructive border-destructive/50 hover:bg-destructive/10"
            disabled={usage.isLoading || !usage.data?.clean || del.isPending}
            onClick={() => void (async () => {
              if (!usage.data?.clean) return;
              if (!(await confirm({ variant: "danger", title: "حذف الموظف نهائياً", description: `سيُحذف «${e.fullName}» نهائياً من القاعدة ولا يمكن التراجع. (متاح لأنّه نظيف بلا نشاط.) هل تتابع؟`, confirmText: "حذف نهائياً" }))) return;
              del.mutate({ id });
            })()}
          >
            {del.isPending ? "جارٍ الحذف…" : "حذف نهائياً"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
