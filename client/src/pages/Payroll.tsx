/* ============================================================================
 * شاشة الرواتب — وحدة الموارد البشرية (client/src/pages/Payroll.tsx)
 * مسيّر شهري بثلاث حالات (مسوّدة → معتمد → مدفوع). مُركَّب على trpc.payroll.
 *
 * المكوّنات: مؤشّرات (الإجمالي/الإضافي/الاستقطاع/الصافي) + اختيار المسيّر (أو الأحدث) +
 * جدول البنود (الموظف/نوع الأجر/الأساسي أو الساعات/البدلات/الإضافي/الاستقطاع/الصافي/الحالة +
 * زر القسيمة + تحرير الإضافي/الاستقطاع أثناء المسوّدة + بحث/فلترة محلية + تصدير Excel) +
 * أزرار توليد/اعتماد/دفع/إلغاء حسب الحالة.
 * كل المبالغ تُعرَض عبر iqd() (الخادم هو المرجع الحسابي).
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { PayrollAccrualOperations, PayrollRemittanceRequestPanel } from "@/components/hr/PayrollAccrualOperations";
import { PayrollPaymentDialog } from "@/components/hr/PayrollPaymentDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm, confirmDelete } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { D, round2 } from "@/lib/money";
import { PAY_TYPES, payTypeLabel, payrollItemNeedsAttention } from "@shared/hr";
import { printPayslip } from "@/lib/printing/printPayslip";
import { payrollStatusLabel as accrualStatusLabel, toExcelMoney } from "@/lib/payrollAccrual";
import { AlarmClock, Banknote, Check, FileSpreadsheet, FileText, Minus, Plus, Printer, TriangleAlert, Wallet, X } from "lucide-react";
import { useMemo, useState } from "react";
import { selectClsSm } from "@/lib/ui/formStyles";
import { ACTION_LABELS } from "@shared/actionLabels";


const STATUS_CLS: Record<string, string> = {
  draft: "badge-stock-low",
  approved: "badge-status-pending",
  paid: "badge-status-active",
  cancelled: "badge-status-cancelled",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {accrualStatusLabel(status)}
    </span>
  );
}

function StatCard({ label, value, sub, accent, icon }: { label: string; value: string; sub?: string; accent?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-xs">{label}</div>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums" dir="ltr" style={{ color: accent }}>{value}</div>
        {sub && <div className="text-muted-foreground text-xs mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** الشهر الحالي بصيغة YYYY-MM (افتراضي حقل توليد مسيّر جديد). */
const thisMonth = () => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Baghdad", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year}-${month}`;
};

const PAYMENT_METHOD_AR: Record<string, string> = {
  CASH: "نقداً", CARD: "بطاقة/حساب مصرفي", TRANSFER: "تحويل مصرفي", WALLET: "محفظة دفع",
};

function paymentYmd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

type RunItem = NonNullable<ReturnType<typeof useRunQuery>["data"]>["items"][number];

function useRunQuery(id: number | null, enabled: boolean) {
  return trpc.payroll.get.useQuery({ id: id ?? 0 }, { enabled: enabled && id != null && Number.isFinite(id) });
}

export default function Payroll() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const ownerAccess = me.data?.isOwner === true;
  const runsQ = trpc.payroll.list.useQuery(undefined, { enabled: ownerAccess });
  const runs = runsQ.data ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // المسيّر المعروض: المُختار صراحةً، أو الأحدث (أول عنصر — مرتّب بالأحدث).
  const effectiveId = selectedId ?? (runs.length ? Number(runs[0].id) : null);
  const runQ = useRunQuery(effectiveId, ownerAccess);
  const run = runQ.data ?? null;

  const [slip, setSlip] = useState<RunItem | null>(null);
  const [editItem, setEditItem] = useState<RunItem | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genPeriod, setGenPeriod] = useState(thisMonth());
  const [payOpen, setPayOpen] = useState(false);

  const refresh = async () => {
    await Promise.all([utils.payroll.list.invalidate(), utils.payroll.get.invalidate()]);
  };

  const generate = trpc.payroll.generate.useMutation({
    onSuccess: async (r) => {
      /*
       * الموسومون بيومٍ مفتوح (دخولٌ بلا انصراف): لا يُستبعد أحد — بندُه يُنشأ بساعاته
       * المؤكَّدة وحدها — لكنّ الوسم يجب أن **يُرى** فوراً وإلّا اعتُمد نقصٌ صامت. التنبيه
       * هنا لحظيّ، ولوحةُ الانتباه أدناه أثرُه الدائم (تُشتقّ من ملاحظات البنود).
       */
      const openCount = r?.attendanceFlagged?.length ?? 0;
      if (openCount > 0) {
        notify.warn(
          `تم توليد المسيّر — ${openCount} موظف بأيام بلا انصراف`,
          "ساعات تلك الأيام غير محتسَبة. صحّحها قبل الاعتماد (التفصيل أعلى الجدول).",
        );
      } else {
        notify.ok("تم توليد المسيّر");
      }
      setGenOpen(false);
      if (r?.id) setSelectedId(Number(r.id));
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.payroll.approve.useMutation({
    onSuccess: async () => { notify.ok("تم اعتماد المسيّر"); await refresh(); },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.payroll.cancel.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.status === "deleted" ? "تم حذف المسوّدة" : r.status === "draft" ? "أُعيد المسيّر إلى مسوّدة" : "تم عكس الدفع وإعادة المسيّر إلى معتمد");
      if (r.status === "deleted") setSelectedId(null);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const updateItemM = trpc.payroll.updateItem.useMutation({
    onSuccess: async () => { notify.ok("تم تحديث البند"); setEditItem(null); await refresh(); },
    onError: (e) => notify.err(e),
  });

  const items = run?.items ?? [];
  const isDraft = run?.status === "draft";
  const isApproved = run?.status === "approved";
  const isPaid = run?.status === "paid";
  const busy = generate.isPending || approve.isPending || cancel.isPending;
  // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — مالكٌ نشط يعتمد استحقاقه بنفسه.
  const isOwner = me.data?.isOwner === true;
  const openSalaryObligations = (run?.obligations ?? []).filter((obligation) =>
    obligation.kind === "SALARY_NET" &&
    Number(obligation.revisionNo) === Number(run?.revisionNo ?? -1) &&
    (obligation.status === "OPEN" || obligation.status === "PARTIAL") &&
    D(obligation.remainingAmount).gt(0),
  );
  let openSalaryTotal = D(0);
  for (const obligation of openSalaryObligations) {
    openSalaryTotal = openSalaryTotal.plus(D(obligation.remainingAmount));
  }
  const openSalaryAmount = round2(openSalaryTotal).toFixed(2);
  const canPayOpenSalary = isApproved || (isPaid && D(openSalaryAmount).gt(0));

  // اسم فرع كل موظف — payroll.get لا يحمل الفرع، فنشتقّه من قائمة الموظفين (نفس بوّابة hr/READ)
  // لتمريره لقسيمة الراتب المطبوعة (كان يُطبع «—» دائماً بسبب branchName: null الثابتة).
  const employeesQ = trpc.employees.list.useQuery({ includeInactive: true, limit: 200 }, { enabled: ownerAccess });
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: ownerAccess });
  const empBranch = useMemo(
    () => new Map((employeesQ.data?.rows ?? []).map((e) => [Number(e.id), e.branchName ?? null])),
    [employeesQ.data],
  );
  const branchName = useMemo(
    () => new Map((branchesQ.data ?? []).map((branch) => [Number(branch.id), branch.name])),
    [branchesQ.data],
  );
  const activePaymentByEmployee = useMemo(() => {
    const result = new Map<number, NonNullable<typeof run>["employeePaymentSnapshots"][number]>();
    for (const payment of run?.employeePaymentSnapshots ?? []) {
      if (!payment.active || Number(payment.revisionNo) !== Number(run?.revisionNo) || payment.employeeId == null) continue;
      const employeeId = Number(payment.employeeId);
      const previous = result.get(employeeId);
      if (!previous || Number(payment.eventId) > Number(previous.eventId)) result.set(employeeId, payment);
    }
    return result;
  }, [run]);
  const slipPayment = slip ? activePaymentByEmployee.get(Number(slip.employeeId)) ?? null : null;
  const slipStatusLabel = !slip
    ? "مسوّدة"
    : slipPayment
      ? "مدفوع"
      : D(slip.net).isZero() && (run?.status === "approved" || run?.status === "paid")
        ? "مسدد بلا حركة نقدية"
        : run?.status === "draft" ? "مسوّدة" : "مستحق غير مدفوع";

  // بحث/فلترة محلية في جدول البنود (اسم الموظف / نوع الأجر) — البيانات كلها محمَّلة مع المسيّر.
  const [itemQ, setItemQ] = useState("");
  const [payTypeF, setPayTypeF] = useState("");
  const visibleItems = useMemo(() => {
    const q = itemQ.trim();
    return items.filter((p) => {
      if (q && !p.employeeName.includes(q)) return false;
      if (payTypeF && p.payType !== payTypeF) return false;
      return true;
    });
  }, [items, itemQ, payTypeF]);
  const itemsFiltered = Boolean(itemQ.trim() || payTypeF);

  /*
   * رسالةُ الفراغ — تسلسلٌ ثلاثيّ **بأولويةٍ لغياب المسيّرات نفسها**، ومصدرُه واحدٌ يُغذّي
   * كلا فرعَي DataTable (المفلتَر وغير المفلتَر) كي لا ينجرف أحدهما عن الآخر.
   * ما كان: بعد التحويل صار فحصُ `runs.length === 0` في فرع `emptyState` وحدَه، وحقلا
   * البحث ونوع الأجر معروضان دائماً في ترويسة البطاقة حتى بلا أيّ مسيّر. فمن يكتب حرفاً
   * في البحث وهو لا يملك مسيّراً واحداً كان يُنقَل إلى فرع `emptyFilteredState` فيقرأ
   * «لا بنود في هذا المسيّر» — جملةٌ تُثبت وجودَ مسيّرٍ لا وجودَ له، وتُسقط دعوةَ
   * «ولّد مسيّراً شهرياً للبدء» التي هي خطوتُه التالية الوحيدة. الجدولُ الخامّ كان يفحص
   * `runs.length` أوّلاً قبل أيّ اعتبارٍ للفلتر، وهذا يعيد ذلك السلوك حرفياً.
   */
  const itemsEmptyMessage =
    runs.length === 0
      ? "لا مسيّرات بعد. ولّد مسيّراً شهرياً للبدء."
      : items.length === 0
        ? "لا بنود في هذا المسيّر."
        : "لا بنود مطابقة للبحث/الفلتر.";

  /*
   * بنودٌ تحتاج انتباهاً قبل الاعتماد (اليوم المفتوح: دخولٌ بلا انصراف ⇒ ساعاتٌ غير محتسَبة).
   * تُشتقّ من **ملاحظة البند نفسها** لا من نتيجة التوليد: فتظهر أيضاً عند فتح المسوّدة لاحقاً
   * أو بعد إعادة تحميل الصفحة، لا في اللحظة التي وُلِّد فيها المسيّر وحدها.
   * وتتجاهل الفلترة المحلية عمداً — إخفاءُ نقصٍ ماليّ خلف بحثٍ باسمٍ هو بالضبط ما تمنعه هذه اللوحة.
   */
  const attentionItems = useMemo(() => items.filter((p) => payrollItemNeedsAttention(p.note)), [items]);

  /** تصدير بنود المسيّر المعروضة (بعد الفلترة المحلية) إلى Excel. */
  const onExportItems = () => {
    if (!run || visibleItems.length === 0) return;
    exportRows(visibleItems, {
      filename: `مسير-الرواتب-${run.period}`,
      title: `مسيّر رواتب ${run.period} — ${accrualStatusLabel(run.status)}`,
      columns: [
        { key: "employeeName", header: "الموظف" },
        { key: "branch", header: "لقطة الفرع", map: (p) => p.branchIdSnapshot ? (branchName.get(Number(p.branchIdSnapshot)) ?? `فرع #${p.branchIdSnapshot}`) : "عام للشركة" },
        { key: "revisionNo", header: "المراجعة", map: (p) => Number(p.revisionNo) },
        { key: "position", header: "المنصب", map: (p) => p.position ?? "" },
        { key: "department", header: "القسم", map: (p) => p.department ?? "" },
        { key: "payType", header: "نوع الأجر", map: (p) => payTypeLabel(p.payType) },
        {
          key: "base",
          header: "الأساسي / أجر الساعات",
          money: true,
          // الأساسي للشهري = الإجمالي − البدلات (gross = أساسي + بدلات)؛ للساعيّ = أجر الساعات كاملاً.
          map: (p) => (p.payType === "monthly" ? toExcelMoney(round2(D(p.gross).minus(D(p.allowances))).toFixed(2)) : toExcelMoney(p.gross)),
        },
        { key: "hours", header: "الساعات", map: (p) => (p.payType === "hourly" ? (p.hours ?? "0") : "") },
        { key: "allowances", header: "البدلات", money: true, map: (p) => (p.payType === "monthly" ? toExcelMoney(p.allowances) : null) },
        { key: "overtime", header: "الإضافي", money: true, map: (p) => toExcelMoney(p.overtime) },
        { key: "commission", header: "العمولة", money: true, map: (p) => toExcelMoney(p.commission) },
        { key: "wageReduction", header: "تخفيض الأجر المصنف", money: true, map: (p) => toExcelMoney(p.wageReduction) },
        { key: "deductions", header: "إجمالي الاستقطاع", money: true, map: (p) => toExcelMoney(p.deductions) },
        { key: "advanceDeduction", header: "منه سلفة", money: true, map: (p) => toExcelMoney(p.advanceDeduction) },
        { key: "incomeTax", header: "منه ضريبة دخل", money: true, map: (p) => toExcelMoney(p.incomeTax) },
        { key: "socialSecurityEmployee", header: "ضمان الموظف", money: true, map: (p) => toExcelMoney(p.socialSecurityEmployee) },
        { key: "socialSecurityEmployer", header: "ضمان رب العمل", money: true, map: (p) => toExcelMoney(p.socialSecurityEmployer) },
        { key: "endOfServiceAccrual", header: "استحقاق نهاية الخدمة", money: true, map: (p) => toExcelMoney(p.endOfServiceAccrual) },
        { key: "net", header: "الصافي المستحق", money: true, map: (p) => toExcelMoney(p.net) },
        { key: "snapshotHash", header: "بصمة البند", map: (p) => p.snapshotHash ?? "" },
        { key: "note", header: "ملاحظة", map: (p) => p.note ?? "" },
      ],
    });
  };

  // مؤشّرات من رأس المسيّر (الخادم هو المرجع).
  const totals = useMemo(
    () => ({
      gross: run?.totalGross ?? "0",
      overtime: run?.totalOvertime ?? "0",
      commission: run?.totalCommission ?? "0",
      deductions: run?.totalDeductions ?? "0",
      net: run?.totalNet ?? "0",
    }),
    [run],
  );

  /*
   * أعمدة بنود المسيّر. صفُّ الإجماليات في `<tfoot>` عبر `footer` على الأعمدة — ويُخفى أثناء
   * الفلترة (كما كان) كي لا يوحي بأنه مجموعُ الصفوف المعروضة وحدها: المجاميعُ من رأس المسيّر
   * (الخادم هو المرجع) لا من الصفحة. وبلا فرزٍ: ترتيبُ البنود من الخادم وصفُّ الإجماليات
   * يقابل كامل المسيّر لا الصفوفَ المفروزة.
   */
  const showItemTotals = !itemsFiltered;
  const itemColumns: ColumnDef<RunItem, unknown>[] = [
    {
      id: "employee",
      header: "الموظف",
      accessorFn: (p) => p.employeeName,
      enableSorting: false,
      meta: { width: "wide", wrap: true },
      footer: showItemTotals ? () => "الإجمالي" : undefined,
      cell: ({ row }) => {
        const p = row.original;
        // بندٌ ناقص الساعات (يوم بلا انصراف): يُوسَم في صفّه أيضاً لا في اللوحة وحدها،
        // كي لا يمرّ في تصفّحٍ سريع للجدول أو بعد فلترةٍ باسم الموظف.
        const needsAttention = payrollItemNeedsAttention(p.note);
        return (
          <div className="flex items-center gap-2.5">
            <EmpAvatar name={p.employeeName} color={p.colorTag} photoUrl={p.photoUrl} sizePx={32} />
            <div>
              <div className="font-medium text-[13px]">{p.employeeName}</div>
              {p.position && <div className="text-[11px] text-muted-foreground">{p.position}</div>}
              {needsAttention && (
                <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--sem-warn)]" title={p.note ?? undefined}>
                  <TriangleAlert aria-hidden className="size-3 shrink-0" />
                  <span>ساعات غير محتسَبة</span>
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "branchSnapshot",
      header: "لقطة الفرع",
      accessorFn: (p) =>
        p.branchIdSnapshot ? (branchName.get(Number(p.branchIdSnapshot)) ?? `فرع #${p.branchIdSnapshot}`) : "عام للشركة",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.branchIdSnapshot
            ? (branchName.get(Number(row.original.branchIdSnapshot)) ?? `فرع #${row.original.branchIdSnapshot}`)
            : "عام للشركة"}
          <span className="block text-[10px] text-muted-foreground" dir="ltr">R{row.original.revisionNo}</span>
        </span>
      ),
    },
    {
      id: "payType",
      header: "نوع الأجر",
      accessorFn: (p) => payTypeLabel(p.payType),
      enableSorting: false,
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${row.original.payType === "monthly" ? "bg-primary/10 text-primary" : "badge-stock-low"}`}
        >
          {payTypeLabel(row.original.payType)}
        </span>
      ),
    },
    {
      id: "base",
      header: "الأساسي / الساعات",
      // الأساسي للشهري = الإجمالي − البدلات (gross = أساسي + بدلات).
      accessorFn: (p) =>
        p.payType === "monthly"
          ? iqd(round2(D(p.gross).minus(D(p.allowances))).toFixed(2))
          : `${iqd(p.gross)} (${p.hours ?? "0"} س)`,
      enableSorting: false,
      meta: { kind: "money" },
      footer: showItemTotals ? () => iqd(totals.gross) : undefined,
      cell: ({ row }) => {
        const p = row.original;
        return p.payType === "monthly"
          ? iqd(round2(D(p.gross).minus(D(p.allowances))).toFixed(2))
          : `${iqd(p.gross)} (${p.hours ?? "0"} س)`;
      },
    },
    {
      id: "allowances",
      header: "البدلات",
      accessorFn: (p) => (p.payType === "monthly" ? iqd(p.allowances) : "—"),
      enableSorting: false,
      meta: { kind: "money" },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.payType === "monthly" ? iqd(row.original.allowances) : "—"}</span>
      ),
    },
    {
      id: "overtime",
      header: "إضافي",
      accessorFn: (p) => (D(p.overtime).gt(0) ? `+${iqd(p.overtime)}` : "—"),
      enableSorting: false,
      meta: { kind: "money" },
      footer: showItemTotals ? () => <span className="text-money-positive">+{iqd(totals.overtime)}</span> : undefined,
      cell: ({ row }) => (
        <span className="text-money-positive">{D(row.original.overtime).gt(0) ? `+${iqd(row.original.overtime)}` : "—"}</span>
      ),
    },
    {
      id: "commission",
      header: "عمولة",
      // عمولة المبيعات الملتقطة من تشغيلة العمولات المعتمدة — قراءة فقط (تُعدَّل بإعادة الاحتساب هناك).
      accessorFn: (p) => (D(p.commission).gt(0) ? `+${iqd(p.commission)}` : "—"),
      enableSorting: false,
      meta: { kind: "money" },
      footer: showItemTotals ? () => <span className="text-money-positive">+{iqd(totals.commission)}</span> : undefined,
      cell: ({ row }) => (
        <span className="text-money-positive">{D(row.original.commission).gt(0) ? `+${iqd(row.original.commission)}` : "—"}</span>
      ),
    },
    {
      id: "deductions",
      header: "استقطاع",
      accessorFn: (p) => (D(p.deductions).gt(0) ? `−${iqd(p.deductions)}` : "—"),
      enableSorting: false,
      meta: { kind: "money" },
      footer: showItemTotals ? () => <span className="text-money-negative">−{iqd(totals.deductions)}</span> : undefined,
      cell: ({ row }) => (
        <span className="text-money-negative">
          {D(row.original.deductions).gt(0) ? `−${iqd(row.original.deductions)}` : "—"}
          {/* advances (بند 12ج): جزء السلفة المخصوم تلقائياً ضمن الاستقطاع. */}
          {D(row.original.advanceDeduction || 0).gt(0) && (
            <span className="block text-[11px] text-muted-foreground">منه سلفة: {iqd(row.original.advanceDeduction)}</span>
          )}
        </span>
      ),
    },
    {
      id: "net",
      header: "الصافي",
      accessorFn: (p) => iqd(p.net),
      enableSorting: false,
      meta: { kind: "money" },
      footer: showItemTotals ? () => iqd(totals.net) : undefined,
      cell: ({ row }) => <span className="font-bold">{iqd(row.original.net)}</span>,
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: () => (run ? run.status : ""),
      enableSorting: false,
      meta: { kind: "status" },
      cell: () => <StatusBadge status={run!.status} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          <button onClick={() => setSlip(row.original)} className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1">
            <FileText className="size-3.5" /> القسيمة
          </button>
          {isDraft && (
            <button onClick={() => setEditItem(row.original)} className="text-xs text-muted-foreground font-medium hover:underline ms-3">
              تعديل
            </button>
          )}
        </span>
      ),
    },
  ];

  if (!me.isLoading && !ownerAccess) {
    return <div className="space-y-4">
      <PageHeader title="طلبات تحويل استقطاعات الرواتب" description="إنشاء طلب تحويل مقيد بفرعك دون الاطلاع على مسيرات الرواتب السرية." />
      <PayrollRemittanceRequestPanel />
      <Card><CardContent className="p-4 text-center text-xs text-muted-foreground">تفاصيل المسيرات ودفعات الموظفين محصورة بجلسة المالك.</CardContent></Card>
    </div>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="الرواتب"
        description="مسيّر استحقاقي شهري: الاعتماد يثبت تكلفة العمل والتزاماتها، ثم تُسوّى الرواتب والضريبة والضمان بمسارات دفع مستقلة."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <AppSelect
              className="h-9"
              value={effectiveId != null ? String(effectiveId) : ""}
              onValueChange={(next) => setSelectedId(next ? Number(next) : null)}
              aria-label="المسيّر"
            >
              {runs.length === 0 && <option value="">لا مسيّرات</option>}
              {runs.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  مسيّر {r.period} — {accrualStatusLabel(r.status)}
                </option>
              ))}
            </AppSelect>
            <Button onClick={() => setGenOpen(true)} disabled={busy}>
              <Plus className="size-4" /> توليد مسيّر
            </Button>
          </div>
        }
      />

      {/* المؤشّرات */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="الأجر الأساس والمخصصات" value={iqd(totals.gross)} sub="قبل الإضافي والعمولة" icon={<Banknote className="size-4" />} />
        <StatCard label="العمل الإضافي" value={iqd(totals.overtime)} sub="د.ع" accent="var(--status-done, #059669)" icon={<AlarmClock className="size-4" />} />
        <StatCard label="الاستقطاعات" value={iqd(totals.deductions)} sub="سلف وغياب" accent="var(--money-negative, #dc2626)" icon={<Minus className="size-4" />} />
        <StatCard label="الصافي المستحق" value={iqd(totals.net)} sub={run ? `د.ع — مسيّر ${run.period}` : "د.ع"} accent="var(--status-active, #2563eb)" icon={<Wallet className="size-4" />} />
      </div>

      {/* أزرار دورة الحياة */}
      {run && (
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={run.status} />
          <span className="text-sm text-muted-foreground">مسيّر {run.period} — {run.employeeCount} موظف</span>
          <div className="flex-1" />
          {isDraft && (
            <>
              <Button variant="outline" size="sm" title={!isOwner ? "الاعتماد محصور بحساب مالك نشط" : undefined} onClick={async () => { if (!(await confirm({ variant: "warning", title: `اعتماد استحقاق رواتب ${run.period}`, description: "سيُثبّت مصروف الفترة والتزامات الصافي والضريبة والضمان ونهاية الخدمة بتاريخ نهاية الشهر، بلا حركة نقدية. تُقفل البنود وتُحفظ بصمات السياسة واللقطة.", confirmText: "اعتماد الاستحقاق" }))) return; approve.mutate({ id: Number(run.id) }); }} disabled={busy || !isOwner}>
                <Check className="size-4" /> اعتماد الاستحقاق
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={async () => { if (!(await confirmDelete({ description: `حذف مسوّدة رواتب ${run.period} وكل بنودها (${run.employeeCount} موظف) نهائياً؟` }))) return; cancel.mutate({ id: Number(run.id) }); }} disabled={busy}>
                <X className="size-4" /> حذف المسوّدة
              </Button>
            </>
          )}
          {canPayOpenSalary && (
            <>
              <Button size="sm" onClick={() => setPayOpen(true)} disabled={busy}>
                <Wallet className="size-4" /> {isPaid ? "إعادة دفع الالتزامات المفتوحة" : "صرف صافي الرواتب"}
              </Button>
              {isApproved && <Button variant="outline" size="sm" onClick={async () => { if (!(await confirm({ variant: "warning", title: `إعادة مسيّر رواتب ${run.period} إلى مسوّدة`, description: "سيُنشئ النظام عكساً استحقاقياً كاملاً، يعكس تسويات السلف، ويرفع رقم المراجعة قبل السماح بالتعديل. لا توجد حركة نقدية في هذه الخطوة.", confirmText: "عكس الاستحقاق وإعادة" }))) return; cancel.mutate({ id: Number(run.id), reason: "إعادة للمسودة من شاشة الرواتب" }); }} disabled={busy}>
                إعادة لمسوّدة
              </Button>}
            </>
          )}
          {isPaid && <span className="text-xs text-muted-foreground">{D(openSalaryAmount).gt(0) ? `أُعيد جزء من الصرف: متبقٍ لإعادة الدفع ${iqd(openSalaryAmount)} د.ع على ${openSalaryObligations.length} موظف.` : "لإعادة المسيّر: أثبت أولاً إعادة كل دفعة راتب فعلياً من سجل الدفعات أدناه، ثم أعده إلى المسوّدة."}</span>}
        </div>
      )}

      {/* لوحة الانتباه — أيامٌ بلا انصراف: ساعاتٌ غير محتسَبة في بنودٍ قائمة (لا استبعاد) */}
      {attentionItems.length > 0 && (
        <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]">
          <CardContent className="p-3 space-y-2">
            <div className="flex items-start gap-2">
              <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
              <div className="text-xs leading-relaxed">
                <span className="font-medium text-[var(--sem-warn)]">
                  {attentionItems.length} موظف بأيام بلا بصمة انصراف
                </span>{" "}
                — ساعات تلك الأيام <b>غير محتسَبة</b> في أجورهم، وبقيّة أيامهم محتسَبة كاملةً.
                {isDraft
                  ? " الحسم قبل الاعتماد: صحّح البصمة من كشف الموظف، ثم احذف هذه المسوّدة وأعد التوليد."
                  : " المسيّر لم يعد مسوّدة — أعِده إلى مسوّدة أولاً إن أردت استرداد هذه الساعات."}
              </div>
            </div>
            <ul className="space-y-1 ps-6">
              {attentionItems.map((p) => (
                <li key={p.id} className="text-[11px]">
                  <span className="font-medium">{p.employeeName}</span>
                  <span className="text-muted-foreground"> — {p.note}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* جدول البنود */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>
            {run ? `مسيّر رواتب ${run.period} — ${items.length} موظف` : "مسيّر الرواتب"}
            {itemsFiltered && (
              <span className="ms-2 text-xs font-normal text-muted-foreground">
                (المعروض {visibleItems.length} من {items.length})
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={itemQ}
              onChange={(e) => setItemQ(e.target.value)}
              placeholder="بحث باسم الموظف…"
              aria-label="بحث باسم الموظف"
              className="h-8 w-44"
            />
            <AppSelect
              value={payTypeF}
              onValueChange={setPayTypeF}
              size="sm"
              className="w-32"
              aria-label="نوع الأجر"
            >
              <option value="">كل الأنواع</option>
              {PAY_TYPES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </AppSelect>
            <Button variant="outline" size="sm" disabled={!visibleItems.length} onClick={onExportItems}>
              <FileSpreadsheet className="size-4" /> تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* البحث وفلتر نوع الأجر في ترويسة البطاقة أعلاه (يغذّيان `visibleItems`) ⇒
              `searchable={false}` وإلّا ظهر حقلا بحثٍ متجاوران. و`externalFiltersActive`
              يحمل نفس معنى `itemsFiltered`. والبنود كلّها بلا ترقيم كما كان الجدول الخامّ. */}
          <DataTable<RunItem>
            columns={itemColumns}
            data={visibleItems}
            searchable={false}
            externalFiltersActive={itemsFiltered}
            pageSize={Infinity}
            loading={runQ.isLoading}
            errorState={{ isError: runQ.isError, message: runQ.error?.message, onRetry: () => void runQ.refetch() }}
            getRowClassName={(p) => (payrollItemNeedsAttention(p.note) ? "bg-[var(--sem-warn-bg)]/60" : undefined)}
            emptyState={itemsEmptyMessage}
            emptyFilteredState={itemsEmptyMessage}
          />
        </CardContent>
      </Card>

      {run && <PayrollAccrualOperations run={run} onChanged={refresh} />}

      <PayrollPaymentDialog
        open={payOpen}
        run={run ? {
          id: Number(run.id), period: run.period,
          totalNet: isPaid ? openSalaryAmount : run.totalNet,
          employeeCount: isPaid ? openSalaryObligations.length : run.employeeCount,
          createdBy: run.createdBy,
        } : null}
        onClose={() => setPayOpen(false)}
        onPaid={refresh}
      />

      {/* حوار توليد مسيّر */}
      <Dialog open={genOpen} onOpenChange={(o) => !o && setGenOpen(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>توليد مسيّر رواتب</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label htmlFor="gen-period">الشهر (YYYY-MM)</Label>
              <Input id="gen-period" type="month" value={genPeriod} onChange={(e) => setGenPeriod(e.target.value)} dir="ltr" className="tabular-nums" />
            </div>
            <p className="text-xs text-muted-foreground">
              يُولَّد مسيّر مسوّدة لكل الموظفين غير منتهي الخدمة: الراتب الأساسي + البدلات للشهريين، ومجموع أجر الساعات للساعيين.
              الإضافي والاستقطاع صفر ابتداءً ويُحرَّران من زر «تعديل» قبل الاعتماد.
              وإن وُجدت تشغيلة عمولات <b>معتمدة</b> لنفس الشهر (تبويب «تشغيلات العمولة») يُدرَج بند «عمولة» لكل موظف تلقائياً.
              وتُملأ استقطاعات <b>سلف الموظفين</b> النشطة تلقائياً ضمن الاستقطاع (تبويب «سلف الموظفين»).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)}>إلغاء</Button>
            <Button onClick={() => generate.mutate({ period: genPeriod })} disabled={generate.isPending || !genPeriod}>
              {generate.isPending ? "جارٍ التوليد…" : "توليد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تحرير بند (أثناء المسوّدة) */}
      <EditItemDialog
        item={editItem}
        onClose={() => setEditItem(null)}
        onSave={(overtime, deductions, note) => editItem && updateItemM.mutate({ itemId: Number(editItem.id), overtime, deductions, note })}
        saving={updateItemM.isPending}
      />

      {/* قسيمة راتب */}
      <Dialog open={!!slip} onOpenChange={(o) => !o && setSlip(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>قسيمة راتب — {run?.period}</DialogTitle></DialogHeader>
          {slip && (
            <div>
              <div className="flex items-center gap-3 pb-3 border-b">
                <EmpAvatar name={slip.employeeName} color={slip.colorTag} photoUrl={slip.photoUrl} sizePx={44} />
                <div className="flex-1">
                  <div className="font-bold">{slip.employeeName}</div>
                  <div className="text-xs text-muted-foreground">{[slip.position, slip.department].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                <div className="text-xs text-muted-foreground" dir="ltr">#{slip.employeeId}</div>
              </div>
              <div className="py-3 space-y-2 text-sm">
                {slip.payType === "hourly" && (
                  <div className="flex justify-between"><span className="text-muted-foreground">ساعات العمل</span><span className="tabular-nums">{slip.hours ?? "0"} ساعة</span></div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{slip.payType === "monthly" ? "الراتب الأساسي" : "أجر الساعات"}</span>
                  <span className="tabular-nums" dir="ltr">{iqd(slip.payType === "monthly" ? round2(D(slip.gross).minus(D(slip.allowances))).toFixed(2) : slip.gross)}</span>
                </div>
                {slip.payType === "monthly" && (
                  <div className="flex justify-between"><span className="text-muted-foreground">البدلات</span><span className="tabular-nums" dir="ltr">{iqd(slip.allowances)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">العمل الإضافي</span><span className="tabular-nums text-money-positive" dir="ltr">+{iqd(slip.overtime)}</span></div>
                {D(slip.commission).gt(0) && (
                  <div className="flex justify-between"><span className="text-muted-foreground">عمولة المبيعات (تشغيلة {run?.period})</span><span className="tabular-nums text-money-positive" dir="ltr">+{iqd(slip.commission)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">الاستقطاعات (سلف/غياب)</span><span className="tabular-nums text-money-negative" dir="ltr">−{iqd(slip.deductions)}</span></div>
                {D(slip.advanceDeduction || 0).gt(0) && (
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground ps-3">منها استقطاع سلفة</span><span className="tabular-nums text-money-negative" dir="ltr">−{iqd(slip.advanceDeduction)}</span></div>
                )}
                {/* المكوّنات القانونية (البند ④) — حصّتا الموظف (ضمان/ضريبة) ضمن الاستقطاع، تظهران عند التفعيل. */}
                {D(slip.socialSecurityEmployee || 0).gt(0) && (
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground ps-3">منها ضمان اجتماعي (حصّة الموظف)</span><span className="tabular-nums text-money-negative" dir="ltr">−{iqd(slip.socialSecurityEmployee)}</span></div>
                )}
                {D(slip.incomeTax || 0).gt(0) && (
                  <div className="flex justify-between text-xs"><span className="text-muted-foreground ps-3">منها ضريبة دخل مستقطعة</span><span className="tabular-nums text-money-negative" dir="ltr">−{iqd(slip.incomeTax)}</span></div>
                )}
                {slip.note && <div className="flex justify-between"><span className="text-muted-foreground">ملاحظة</span><span>{slip.note}</span></div>}
              </div>
              <div className="flex justify-between items-center py-3 border-t-2">
                <span className="font-bold">الصافي المستحق</span>
                <span className="text-xl font-bold text-money-positive tabular-nums" dir="ltr">{iqd(slip.net)}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-xs">
                <span className="text-muted-foreground">حالة الصرف الفردي</span>
                <span className="font-medium">{slipStatusLabel}{slipPayment ? ` · REC-${slipPayment.receiptId} · ${paymentYmd(slipPayment.paymentDate) ?? "—"}` : ""}</span>
              </div>
              {/* التزامات على الشركة (البند ④) — لا تُخصَم من الموظف ولا تؤثّر على الصافي؛ تظهر عند التفعيل فقط. */}
              {(D(slip.socialSecurityEmployer || 0).gt(0) || D(slip.endOfServiceAccrual || 0).gt(0)) && (
                <div className="pt-2 space-y-1.5 text-xs border-t">
                  <div className="font-medium text-muted-foreground">التزامات على الشركة (لا تُخصَم من الموظف)</div>
                  {D(slip.socialSecurityEmployer || 0).gt(0) && (
                    <div className="flex justify-between"><span className="text-muted-foreground">ضمان اجتماعي — حصّة رب العمل</span><span className="tabular-nums" dir="ltr">{iqd(slip.socialSecurityEmployer)}</span></div>
                  )}
                  {D(slip.endOfServiceAccrual || 0).gt(0) && (
                    <div className="flex justify-between"><span className="text-muted-foreground">استحقاق نهاية الخدمة (متراكم هذا الشهر)</span><span className="tabular-nums" dir="ltr">{iqd(slip.endOfServiceAccrual)}</span></div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSlip(null)}>إغلاق</Button>
            <Button onClick={() => slip && run && printPayslip({
              runId: run.id, period: run.period, statusLabel: slipStatusLabel,
              employeeName: slip.employeeName, employeeId: Number(slip.employeeId),
              // لقطة الفرع المثبتة في البند مقدَّمة على فرع الموظف الحالي؛ النقل اللاحق لا يعيد كتابة القسيمة.
              position: slip.position, department: slip.department,
              branchName: slip.branchIdSnapshot ? (branchName.get(Number(slip.branchIdSnapshot)) ?? `فرع #${slip.branchIdSnapshot}`) : (empBranch.get(Number(slip.employeeId)) ?? null),
              revisionNo: Number(slip.revisionNo), accrualDate: run.accrualDate,
              legalPolicyHash: run.legalPolicyHash, approvalSnapshotHash: run.approvalSnapshotHash,
              itemSnapshotHash: slip.snapshotHash,
              payTypeLabel: payTypeLabel(slip.payType),
              baseSalary: slip.payType === "monthly" ? round2(D(slip.gross).minus(D(slip.allowances))).toFixed(2) : null,
              hours: slip.hours, gross: slip.gross, overtime: slip.overtime, commission: slip.commission,
              deductions: slip.deductions, advanceDeduction: slip.advanceDeduction,
              socialSecurityEmployee: slip.socialSecurityEmployee, incomeTax: slip.incomeTax,
              socialSecurityEmployer: slip.socialSecurityEmployer, endOfServiceAccrual: slip.endOfServiceAccrual,
              net: slip.net, note: slip.note,
              paidAt: paymentYmd(slipPayment?.paymentDate),
              paidAmount: slipPayment?.amount ?? null,
              paymentMethod: slipPayment ? (PAYMENT_METHOD_AR[slipPayment.paymentMethod] ?? slipPayment.paymentMethod) : null,
              paymentReference: slipPayment?.referenceNumber ?? null,
              receiptId: slipPayment?.receiptId ?? null,
            })}><Printer className="size-4" /> طباعة كشف الراتب</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditItemDialog({
  item,
  onClose,
  onSave,
  saving,
}: {
  item: RunItem | null;
  onClose: () => void;
  onSave: (overtime: string, deductions: string, note: string) => void;
  saving: boolean;
}) {
  const [overtime, setOvertime] = useState("0");
  const [deductions, setDeductions] = useState("0");
  const [note, setNote] = useState("");

  // تهيئة القيم عند فتح بند جديد.
  const itemId = item?.id ?? null;
  const [lastId, setLastId] = useState<number | null>(null);
  if (item && itemId !== lastId) {
    setLastId(Number(itemId));
    setOvertime(round2(D(item.overtime)).toFixed(2));
    setDeductions(round2(D(item.deductions)).toFixed(2));
    setNote(item.note ?? "");
  }

  // الصافي يشمل العمولة الملتقطة (قراءة فقط هنا — تُعدَّل بإعادة احتساب التشغيلة قبل التوليد).
  const newNet = item ? round2(D(item.gross).plus(D(overtime || 0)).plus(D(item.commission || 0)).minus(D(deductions || 0))).toFixed(2) : "0";

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>تعديل بند — {item?.employeeName}</DialogTitle></DialogHeader>
        {item && (
          <div className="space-y-3 py-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">الإجمالي قبل الاستقطاع</span>
              <span className="tabular-nums font-medium" dir="ltr">{iqd(item.gross)}</span>
            </div>
            {D(item.commission || 0).gt(0) && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">عمولة المبيعات (قراءة فقط)</span>
                <span className="tabular-nums font-medium text-money-positive" dir="ltr">+{iqd(item.commission)}</span>
              </div>
            )}
            <div>
              <Label htmlFor="edit-ot">العمل الإضافي (د.ع)</Label>
              <Input id="edit-ot" inputMode="decimal" value={overtime} onChange={(e) => setOvertime(e.target.value)} dir="ltr" className="tabular-nums" />
            </div>
            <div>
              <Label htmlFor="edit-ded">الاستقطاع — سلف/غياب (د.ع)</Label>
              <Input id="edit-ded" inputMode="decimal" value={deductions} onChange={(e) => setDeductions(e.target.value)} dir="ltr" className="tabular-nums" />
              {/* advances (بند 12ج): جزء السلفة المولَّد ثابت — الاستقطاع الكلي لا يهبط دونه (الخادم يفرضها). */}
              {D(item.advanceDeduction || 0).gt(0) && (
                <p className="text-xs text-muted-foreground mt-1">
                  منه استقطاع سلفة مولَّد تلقائياً: {iqd(item.advanceDeduction)} د.ع — لا يقلّ الاستقطاع الكلي عنه.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="edit-note">ملاحظة (اختياري)</Label>
              <Input id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
            </div>
            <div className="flex justify-between items-center pt-2 border-t">
              <span className="font-bold text-sm">الصافي بعد التعديل</span>
              <span className="text-lg font-bold tabular-nums" dir="ltr">{iqd(newNet)}</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            onClick={() => onSave(round2(D(overtime || 0)).toFixed(2), round2(D(deductions || 0)).toFixed(2), note)}
            disabled={saving}
          >
            {saving ? ACTION_LABELS.saving : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
