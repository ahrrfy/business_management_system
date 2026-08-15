// ميزان مراجعة رسمي من journalEntries/journalLines — افتتاح، حركة، وختام لكل حساب قابل للترحيل.
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  DEFAULT_PERIOD,
  PeriodFilter,
  type PeriodValue,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState } from "@/components/PageState";
import { D, fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { cn } from "@/lib/utils";
import { clampDoubleEntryReportPeriod } from "@/lib/doubleEntryReportPeriod";

type Report = RouterOutputs["reports"]["trialBalance"];
type Row = Report["rows"][number];

const TYPE_LABEL: Record<string, string> = {
  ASSET: "أصل",
  LIABILITY: "التزام",
  EQUITY: "حقوق ملكية",
  REVENUE: "إيراد",
  EXPENSE: "مصروف",
};
const selectCls =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function moneyCell(value: string) {
  return D(value).isZero() ? "—" : fmtAr(value);
}

function LedgerModeNotice({ report }: { report: Report }) {
  if (report.mode === "SHADOW") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-sm text-[var(--sem-warn)]">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-semibold">
            للمطابقة فقط — الدفتر المُعتمَد ما زال المبسّط.
          </p>
          <p className="text-xs opacity-80">
            القيود المزدوجة تُكتب في وضع الظل منذ{" "}
            {report.shadowStartedAt ?? "تاريخ غير مسجّل"}، ولا تصبح مصدراً
            معتمداً قبل اجتياز بوابة ACTIVE.
          </p>
        </div>
      </div>
    );
  }
  if (report.mode === "OFF") {
    return (
      <div className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-foreground">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-semibold">الدفتر المزدوج متوقف.</p>
          <p className="text-xs opacity-80">
            لن تظهر عمليات جديدة هنا ما دام الوضع OFF؛ لا تعتمد هذا التقرير
            كميزانٍ حي.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] px-3 py-2 text-sm text-[var(--sem-pos)]">
      <CheckCircle2 aria-hidden className="size-4 shrink-0" />
      الدفتر المزدوج في وضع ACTIVE.
    </div>
  );
}

export default function TrialBalance() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery(undefined, {
    enabled: me.data?.role === "admin",
  });
  const canChooseBranch = me.data?.role === "admin";
  const availability = trpc.reports.doubleEntryReportAvailability.useQuery();
  const availableFrom = availability.data?.availableFrom ?? null;
  useEffect(() => {
    setPeriod((current) =>
      clampDoubleEntryReportPeriod(current, availableFrom),
    );
  }, [availableFrom]);
  const input = {
    from: period.from,
    to: period.to,
    branchId: canChooseBranch && branchId ? Number(branchId) : undefined,
  };
  const q = trpc.reports.trialBalance.useQuery(input, {
    enabled: Boolean(
      period.from &&
      period.to &&
      period.from <= period.to &&
      (!availableFrom || period.from >= availableFrom),
    ),
  });
  const report = q.data;

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      { accessorKey: "code", header: "الرمز" },
      {
        accessorKey: "name",
        header: "الحساب",
        cell: ({ row }) => (
          <div>
            <p
              className={cn(
                "font-medium",
                row.original.isUnmappedAccount && "text-destructive",
              )}
            >
              {row.original.name}
            </p>
            <p className="text-[10px] text-muted-foreground" dir="ltr">
              {row.original.systemRole}
            </p>
          </div>
        ),
      },
      {
        id: "type",
        header: "النوع",
        accessorFn: (row) =>
          row.type ? (TYPE_LABEL[row.type] ?? row.type) : "غير مربوط",
      },
      {
        accessorKey: "openingDebit",
        header: "افتتاح مدين",
        cell: ({ row }) => <Money value={row.original.openingDebit} />,
      },
      {
        accessorKey: "openingCredit",
        header: "افتتاح دائن",
        cell: ({ row }) => <Money value={row.original.openingCredit} />,
      },
      {
        accessorKey: "periodDebit",
        header: "حركة مدين",
        cell: ({ row }) => <Money value={row.original.periodDebit} />,
      },
      {
        accessorKey: "periodCredit",
        header: "حركة دائن",
        cell: ({ row }) => <Money value={row.original.periodCredit} />,
      },
      {
        accessorKey: "closingDebit",
        header: "ختام مدين",
        cell: ({ row }) => <Money value={row.original.closingDebit} />,
      },
      {
        accessorKey: "closingCredit",
        header: "ختام دائن",
        cell: ({ row }) => <Money value={row.original.closingCredit} />,
      },
    ],
    [],
  );

  const kpis: KpiItem[] = report
    ? [
        {
          label: "مدين حركة الفترة",
          value: fmtAr(report.totals.periodDebit),
          tone: "info",
        },
        {
          label: "دائن حركة الفترة",
          value: fmtAr(report.totals.periodCredit),
          tone: "info",
        },
        {
          label: "تحقق الميزان",
          value: report.totals.isBalanced ? "متوازن" : "غير متوازن",
          tone: report.totals.isBalanced ? "positive" : "negative",
          hint: `فرق الختام ${fmtAr(report.totals.closingDifference)} د.ع`,
        },
        {
          label: "فجوات حتى الختام",
          value: report.unmappedCount,
          tone: report.unmappedCount === 0 ? "positive" : "negative",
          hint: `افتتاح ${report.openingUnmappedCount} · فترة ${report.periodUnmappedCount}`,
        },
      ]
    : [];

  const branchLabel =
    canChooseBranch && branchId
      ? (branches.data?.find((branch) => branch.id === Number(branchId))
          ?.name ?? String(branchId))
      : canChooseBranch
        ? "كل الشركة"
        : "الفرع المعيّن";

  function onExport() {
    if (!report) return;
    exportRows(report.rows, {
      filename: `ميزان-المراجعة-${period.from}-${period.to}`,
      title: "ميزان المراجعة — الدفتر المزدوج",
      meta: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "وضع الدفتر", value: report.mode },
        { label: "دورة الدفتر", value: report.cycleId ?? "غير مفعلة" },
        {
          label: "بداية تغطية الدورة",
          value: report.availableFrom ?? "لا توجد دورة مفعلة",
        },
        {
          label: "فجوات قبل الفترة",
          value: String(report.openingUnmappedCount),
        },
        {
          label: "فجوات داخل الفترة",
          value: String(report.periodUnmappedCount),
        },
      ],
      columns: [
        { key: "code", header: "رمز الحساب" },
        { key: "name", header: "اسم الحساب" },
        {
          key: "type",
          header: "النوع",
          map: (row) =>
            row.type ? (TYPE_LABEL[row.type] ?? row.type) : "غير مربوط",
        },
        {
          key: "openingDebit",
          header: "افتتاح مدين",
          money: true,
          map: (row) => D(row.openingDebit).toNumber(),
        },
        {
          key: "openingCredit",
          header: "افتتاح دائن",
          money: true,
          map: (row) => D(row.openingCredit).toNumber(),
        },
        {
          key: "periodDebit",
          header: "حركة مدين",
          money: true,
          map: (row) => D(row.periodDebit).toNumber(),
        },
        {
          key: "periodCredit",
          header: "حركة دائن",
          money: true,
          map: (row) => D(row.periodCredit).toNumber(),
        },
        {
          key: "closingDebit",
          header: "ختام مدين",
          money: true,
          map: (row) => D(row.closingDebit).toNumber(),
        },
        {
          key: "closingCredit",
          header: "ختام دائن",
          money: true,
          map: (row) => D(row.closingCredit).toNumber(),
        },
      ],
      totalsRow: {
        code: "الإجمالي",
        openingDebit: D(report.totals.openingDebit).toNumber(),
        openingCredit: D(report.totals.openingCredit).toNumber(),
        periodDebit: D(report.totals.periodDebit).toNumber(),
        periodCredit: D(report.totals.periodCredit).toNumber(),
        closingDebit: D(report.totals.closingDebit).toNumber(),
        closingCredit: D(report.totals.closingCredit).toNumber(),
      },
    });
  }

  return (
    <ReportShell
      title="ميزان المراجعة"
      description="أرصدة افتتاحية وحركة وختام مستخرجة مباشرةً من القيود المزدوجة، بلا حقوق ملكية مشتقّة."
      kpis={kpis}
      onExport={onExport}
      exportDisabled={!report}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter
            value={period}
            onChange={(next) =>
              setPeriod(clampDoubleEntryReportPeriod(next, availableFrom))
            }
          />
          {canChooseBranch && (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              الفرع
              <select
                className={selectCls}
                value={branchId}
                onChange={(event) =>
                  setBranchId(
                    event.target.value ? Number(event.target.value) : "",
                  )
                }
              >
                <option value="">كل الشركة</option>
                {branches.data?.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      }
    >
      {q.isError ? (
        <ErrorState
          message="تعذّر تحميل ميزان المراجعة."
          onRetry={() => void q.refetch()}
        />
      ) : (
        <div className="space-y-3">
          {report && <LedgerModeNotice report={report} />}

          {availableFrom && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">
                  بداية تغطية دورة الدفتر: {availableFrom}
                </p>
                <p className="text-xs text-muted-foreground">
                  لا يتضمن هذا الميزان أرباحاً أو خسائر سبقت لقطة القطع؛ ضُبطت
                  بداية الفترة تلقائياً لحماية دقة التقرير.
                </p>
              </div>
            </div>
          )}
          {report &&
            (report.unmappedCount > 0 ||
              report.unmappedAccountRoles.length > 0) && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] px-3 py-2 text-sm text-[var(--sem-neg)]">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <p>
                  التقرير غير مكتمل للاعتماد: {report.openingUnmappedCount} فجوة
                  قبل الفترة تؤثر في موثوقية الافتتاح، و
                  {report.periodUnmappedCount} فجوة داخل الفترة
                  {report.unmappedAccountRoles.length > 0 &&
                    `، و${report.unmappedAccountRoles.length} دور محاسبي بلا حساب مربوط`}
                  .
                </p>
              </div>
            )}
          <Card>
            <CardContent className="p-3">
              <DataTable
                columns={columns}
                data={report?.rows ?? []}
                loading={q.isLoading}
                searchable
                searchPlaceholder="بحث برمز الحساب أو اسمه…"
                emptyText="لا توجد قيود مزدوجة ضمن هذه الفترة."
                pageSize={Infinity}
                viewKey="double-entry-trial-balance"
                getRowClassName={(row) =>
                  row.isUnmappedAccount ? "bg-[var(--sem-neg-bg)]" : undefined
                }
              />
            </CardContent>
          </Card>
          {report && <TotalsStrip report={report} />}
        </div>
      )}
    </ReportShell>
  );
}

function Money({ value }: { value: string }) {
  return (
    <span className="block text-left tabular-nums" dir="ltr">
      {moneyCell(value)}
    </span>
  );
}

function TotalsStrip({ report }: { report: Report }) {
  const cells = [
    ["افتتاح مدين", report.totals.openingDebit],
    ["افتتاح دائن", report.totals.openingCredit],
    ["حركة مدين", report.totals.periodDebit],
    ["حركة دائن", report.totals.periodCredit],
    ["ختام مدين", report.totals.closingDebit],
    ["ختام دائن", report.totals.closingCredit],
  ] as const;
  return (
    <div
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-md border text-sm sm:grid-cols-3 lg:grid-cols-6",
        report.totals.isBalanced
          ? "border-[var(--sem-pos)]"
          : "border-[var(--sem-neg)]",
      )}
    >
      {cells.map(([label, value]) => (
        <div
          key={label}
          className="border-b border-s last:border-0 p-3 sm:border-b-0"
        >
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-bold tabular-nums" dir="ltr">
            {fmtAr(value)}
          </p>
        </div>
      ))}
    </div>
  );
}
