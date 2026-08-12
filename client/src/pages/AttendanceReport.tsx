// تقرير الحضور والانصراف — صفوف الحضور في نطاق فترة + فلتر موظف اختياري (بحث خادميّ) وفرعٍ
// اختياري للمرتفعين، مع إجماليات (أيام/ساعات/أجر). عرض بترقيمٍ عميليّ + تصدير Excel + طباعة A4
// (ReportShell + printReportDoc). يكشف الأجور ⇒ صلاحية hr/READ خادمياً.
import { useEffect, useMemo, useRef, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { X } from "lucide-react";

type Row = RouterOutputs["attendance"]["report"]["rows"][number];

const STATUS_CLS: Record<string, string> = {
  PRESENT: "badge-status-active",
  ABSENT: "badge-stock-out",
  LATE: "badge-status-pending",
  LEAVE: "badge-status-pending",
};

export default function AttendanceReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [employeeId, setEmployeeId] = useState<number | "">("");
  // اسم الموظف المختار — يُلتقط لحظة الاختيار من نتيجة البحث، بلا استعلامٍ إضافي لجلبه.
  const [empName, setEmpName] = useState("");
  const [branchId, setBranchId] = useState<number | "">("");

  /*
   * منتقي الموظف كان `employees.list({limit:200})` عارياً — يقتطع صامتاً فوق ٢٠٠ موظف (لا
   * مؤشّر، ولا فوز فرصة الوصول لمن بعدهم). استُبدل ببحثٍ خادميّ حيّ (نفس الحقل q في
   * employees.list) على نمط منتقي العميل في الكاشير — يبدأ فارغاً ولا يجلب حتى يُكتب حرفٌ.
   */
  const [empQuery, setEmpQuery] = useState("");
  const [empOpen, setEmpOpen] = useState(false);
  const empWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (!empWrapRef.current?.contains(e.target as Node)) setEmpOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const dEmpQuery = useDebouncedValue(empQuery.trim(), 250);
  const empSearchEnabled = dEmpQuery.length >= 1 && employeeId === "";
  const empSearch = trpc.employees.list.useQuery(
    { q: dEmpQuery, limit: 20 },
    { enabled: empSearchEnabled },
  );
  const empSuggestions = empSearch.data?.rows ?? [];

  // فلتر الفرع — للمرتفعين العابرين للفروع فقط (نمط Invoices.tsx: hr/READ لا يحمل عزل فروعٍ
  // أصلاً لأي دور، فهذا مجرّد تضييقٍ اختياريّ لا صلاحيةٍ جديدة).
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isElevated });

  const q = trpc.attendance.report.useQuery({
    from: period.from,
    to: period.to,
    employeeId: employeeId ? Number(employeeId) : undefined,
    branchId: isElevated && branchId ? Number(branchId) : undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const periodLabel = `${period.from} — ${period.to}`;
  const empLabel = employeeId ? empName || `#${employeeId}` : "الكل";

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد الأيام", value: totals.days },
        { label: "حاضر", value: totals.present, tone: "positive" },
        { label: "غائب", value: totals.absent, tone: "negative" },
        { label: "إجمالي الساعات", value: fmtAr(totals.hours), tone: "info" },
        { label: "إجمالي الأجر", value: fmtAr(totals.amount), tone: "warning" },
      ]
    : [];

  // أعمدة DataTable — التاريخ نصّي LTR (يُفرز صحيحاً أبجدياً لصيغة YYYY-MM-DD)، الحالة شارةٌ
  // ملوّنة بتوكنز badge-status-*/badge-stock-out حسب statusKey، والساعات/الأجر بفرزٍ رقميّ.
  const cols = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        header: "التاريخ",
        accessorKey: "date",
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.date}</span>,
      },
      { header: "الموظف", accessorKey: "employeeName" },
      {
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.statusKey] ?? "bg-muted"}`}>
            {row.original.status}
          </span>
        ),
      },
      {
        id: "hours",
        header: "الساعات",
        accessorFn: (r) => Number(r.hours),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.hours)}</span>,
      },
      {
        id: "amount",
        header: "الأجر",
        accessorFn: (r) => Number(r.amount),
        cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.amount)}</span>,
      },
    ],
    [],
  );

  function onExport() {
    exportRows(rows, {
      filename: `تقرير-الحضور-${period.from}-${period.to}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "employeeName", header: "الموظف" },
        { key: "status", header: "الحالة" },
        { key: "hours", header: "الساعات", map: (r) => Number(r.hours) },
        { key: "amount", header: "الأجر", map: (r) => Number(r.amount) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الحضور والانصراف",
      headerExtra: [
        { label: "الفترة", value: periodLabel },
        { label: "الموظف", value: empLabel },
      ],
      columns: [
        { key: "date", label: "التاريخ" },
        { key: "employeeName", label: "الموظف" },
        { key: "status", label: "الحالة" },
        { key: "hours", label: "الساعات", align: "left" },
        { key: "amount", label: "الأجر", align: "left" },
      ],
      rows: rows.map((r) => ({
        date: r.date,
        employeeName: r.employeeName,
        status: r.status,
        hours: fmtAr(r.hours),
        amount: fmtAr(r.amount),
      })),
      summary: totals
        ? [
            { label: "عدد الأيام", value: String(totals.days) },
            { label: "إجمالي الساعات", value: fmtAr(totals.hours) },
            { label: "إجمالي الأجر", value: fmtAr(totals.amount), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تقرير الحضور والانصراف"
      description="سجلّ الحضور اليومي في فترة محدّدة مع إجماليات الساعات والأجر."
      backHref="/reports"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="relative flex flex-col gap-1" ref={empWrapRef}>
            <label className="text-[11px] text-muted-foreground">الموظف</label>
            {employeeId !== "" ? (
              <div className="flex h-9 w-56 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm">
                <span className="truncate">{empLabel}</span>
                <button
                  type="button"
                  onClick={() => { setEmployeeId(""); setEmpName(""); setEmpQuery(""); }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label="إلغاء اختيار الموظف (عرض الكلّ)"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            ) : (
              <Input
                className="h-9 w-56"
                value={empQuery}
                onChange={(e) => { setEmpQuery(e.target.value); setEmpOpen(true); }}
                onFocus={() => setEmpOpen(true)}
                placeholder="الكلّ — أو ابحث بالاسم"
                aria-autocomplete="list"
                aria-expanded={empOpen}
              />
            )}
            {empOpen && employeeId === "" && dEmpQuery.length >= 1 && (
              <div className="absolute z-20 top-full mt-1 w-56 rounded-md border bg-popover shadow-md max-h-64 overflow-auto">
                {empSearch.isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">جارٍ البحث…</div>}
                {!empSearch.isLoading && empSuggestions.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">لا نتائج — اكتب اسماً مختلفاً.</div>
                )}
                {!empSearch.isLoading && empSuggestions.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => { setEmployeeId(e.id); setEmpName(e.fullName); setEmpQuery(""); setEmpOpen(false); }}
                    className="block w-full truncate px-3 py-2 text-right text-sm hover:bg-accent"
                  >
                    {e.fullName}{e.position ? ` — ${e.position}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
          {isElevated && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground" id="att-report-branch-label">الفرع</label>
              <AppSelect
                aria-label="الفرع"
                className="h-9 w-40"
                value={branchId === "" ? "" : String(branchId)}
                onValueChange={(v) => setBranchId(v ? Number(v) : "")}
              >
                <option value="">كل الفروع</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            </div>
          )}
        </div>
      }
    >
      {q.isError ? (
        <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          loading={q.isLoading}
          emptyText="لا سجلّات حضور في هذا النطاق."
        />
      )}
    </ReportShell>
  );
}
