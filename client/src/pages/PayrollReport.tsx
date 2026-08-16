// تقرير الرواتب الاستحقاقي — مسيّرات، مكونات قانونية، التزامات مفتوحة، وبصمات المراجعة.
import { useMemo, useState } from "react";
import { type ColumnDef, type SortingFn } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { DataTable } from "@/components/data-table/DataTable";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { D, fmtAr, fmtInt, round2 } from "@/lib/money";
import { exportSheets } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { Printer } from "lucide-react";
import {
  OBLIGATION_KIND_LABEL,
  payrollStatusLabel,
  settledObligationAmount,
  shortHash,
  summarizeObligations,
  toExcelMoney,
} from "@/lib/payrollAccrual";

type Row = RouterOutputs["payroll"]["list"][number];
type LedgerRow = RouterOutputs["payroll"]["financialLedger"][number];

const STATUS_CLS: Record<string, string> = {
  draft: "badge-status-cancelled",
  approved: "badge-status-pending",
  paid: "badge-status-active",
  cancelled: "badge-status-cancelled",
};

const inputCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function sum(rows: Row[], pick: (row: Row) => string): string {
  return round2(rows.reduce((total, row) => total.plus(D(pick(row))), D(0))).toFixed(2);
}

const MOVEMENT_LABEL: Record<LedgerRow["movementType"], string> = {
  SALARY_PAYMENT: "صرف صافي راتب",
  SALARY_PAYMENT_RETURN: "إعادة دفعة راتب",
  TAX_REMITTANCE: "تحويل ضريبة الدخل",
  SOCIAL_SECURITY_REMITTANCE: "تحويل الضمان الاجتماعي",
  REMITTANCE_RETURN: "إعادة تحويل قانوني",
};

function ledgerDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 10);
}

function ledgerParty(row: LedgerRow): string {
  return row.employeeName ?? row.authorityName ?? "جهة قانونية";
}

function ledgerDirection(row: LedgerRow): "صرف" | "قبض/إعادة" {
  return row.movementType === "SALARY_PAYMENT_RETURN" || row.movementType === "REMITTANCE_RETURN"
    ? "قبض/إعادة"
    : "صرف";
}

const decimalSort: SortingFn<Row> = (rowA, rowB, columnId) =>
  D(rowA.getValue<string>(columnId) ?? 0).comparedTo(D(rowB.getValue<string>(columnId) ?? 0));

export default function PayrollReport() {
  const [period, setPeriod] = useState("");
  const me = trpc.auth.me.useQuery();
  const ownerAccess = me.data?.isOwner === true;
  const runsQ = trpc.payroll.list.useQuery(undefined, { enabled: ownerAccess });
  const obligationsQ = trpc.payroll.obligations.useQuery(undefined, { enabled: ownerAccess });
  const ledgerQ = trpc.payroll.financialLedger.useQuery(period ? { period } : undefined, { enabled: ownerAccess });
  const rows = useMemo(
    () => (runsQ.data ?? []).filter((run) => !period || run.period === period),
    [period, runsQ.data],
  );
  const ledger = ledgerQ.data ?? [];
  const currentRevision = useMemo(() => new Map(rows.map((run) => [Number(run.id), Number(run.revisionNo)])), [rows]);
  const obligations = useMemo(
    () => (obligationsQ.data ?? []).filter((row) => {
      if (row.runId == null) {
        if (!period) return true;
        return ledgerDate(row.dueDate ?? row.createdAt).slice(0, 7) === period;
      }
      const revision = currentRevision.get(Number(row.runId));
      return revision != null && revision === Number(row.revisionNo);
    }),
    [currentRevision, obligationsQ.data, period],
  );
  const outstanding = summarizeObligations(obligations.filter((row) => row.status === "OPEN" || row.status === "PARTIAL"));
  const accruedRows = rows.filter((row) => row.status === "approved" || row.status === "paid");
  const netPaidByRun = useMemo(() => new Map(rows.map((run) => [
    Number(run.id),
    settledObligationAmount(
      obligations.filter((obligation) => Number(obligation.runId) === Number(run.id)),
      "SALARY_NET",
      Number(run.revisionNo),
    ),
  ])), [obligations, rows]);
  const netPaid = round2(rows.reduce(
    (total, row) => total.plus(D(netPaidByRun.get(Number(row.id)) ?? 0)),
    D(0),
  )).toFixed(2);
  const runsWithPayment = rows.filter((row) => D(netPaidByRun.get(Number(row.id)) ?? 0).gt(0)).length;
  const totals = {
    runs: rows.length,
    accruedRuns: accruedRows.length,
    employees: accruedRows.reduce((total, row) => total + Number(row.employeeCount), 0),
    gross: sum(accruedRows, (row) => row.totalGross),
    net: sum(accruedRows, (row) => row.totalNet),
    netPaid,
    tax: sum(accruedRows, (row) => row.totalIncomeTax),
    ssEmployee: sum(accruedRows, (row) => row.totalSocialSecurityEmployee),
    ssEmployer: sum(accruedRows, (row) => row.totalSocialSecurityEmployer),
    eos: sum(accruedRows, (row) => row.totalEndOfServiceAccrual),
  };
  const legalOutstanding = outstanding
    .filter((row) => row.kind !== "SALARY_NET")
    .reduce((total, row) => total.plus(D(row.remaining)), D(0));

  const kpis: KpiItem[] = [
    { label: "المسيّرات", value: totals.runs, hint: `${totals.accruedRuns} معتمد/مدفوع` },
    { label: "الأساسي والمخصصات", value: fmtAr(totals.gross), tone: "info" },
    { label: "صافي مدفوع فعلاً", value: fmtAr(totals.netPaid), tone: "positive", hint: `${runsWithPayment} مسيّر` },
    { label: "التزامات قانونية مفتوحة", value: fmtAr(legalOutstanding.toFixed(2)), tone: legalOutstanding.gt(0) ? "warning" : "default" },
  ];

  const cols = useMemo<ColumnDef<Row>[]>(() => [
    { header: "الشهر", accessorKey: "period", cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.period}</span> },
    { header: "الحالة", accessorKey: "status", cell: ({ row }) => <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.status] ?? "bg-muted"}`}>{payrollStatusLabel(row.original.status)}</span> },
    { id: "revision", header: "المراجعة", accessorFn: (row) => Number(row.revisionNo), cell: ({ row }) => <span dir="ltr">R{row.original.revisionNo}</span> },
    { id: "employees", header: "الموظفون", accessorFn: (row) => Number(row.employeeCount), cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtInt(row.original.employeeCount)}</span> },
    { id: "gross", header: "الأساسي والمخصصات", accessorFn: (row) => row.totalGross, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.totalGross)}</span> },
    { id: "deductions", header: "الاستقطاعات", accessorFn: (row) => row.totalDeductions, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums text-money-negative">{fmtAr(row.original.totalDeductions)}</span> },
    { id: "net", header: "صافي الموظفين", accessorFn: (row) => row.totalNet, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums font-medium">{fmtAr(row.original.totalNet)}</span> },
    { id: "netPaid", header: "المدفوع فعلاً", accessorFn: (row) => netPaidByRun.get(Number(row.id)) ?? "0", sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums text-money-positive">{fmtAr(netPaidByRun.get(Number(row.original.id)) ?? "0")}</span> },
    { id: "tax", header: "ضريبة", accessorFn: (row) => row.totalIncomeTax, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.totalIncomeTax)}</span> },
    { id: "ss", header: "ضمان الشركة", accessorFn: (row) => row.totalSocialSecurityEmployer, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.totalSocialSecurityEmployer)}</span> },
    { id: "eos", header: "نهاية الخدمة", accessorFn: (row) => row.totalEndOfServiceAccrual, sortingFn: decimalSort, cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.totalEndOfServiceAccrual)}</span> },
    { header: "تاريخ الاستحقاق", accessorKey: "accrualDate", cell: ({ row }) => <span dir="ltr" className="tabular-nums">{row.original.accrualDate ?? "—"}</span> },
  ], [netPaidByRun]);

  const ledgerCols = useMemo<ColumnDef<LedgerRow>[]>(() => [
    { header: "الحركة", accessorKey: "movementType", cell: ({ row }) => <span>{MOVEMENT_LABEL[row.original.movementType]}</span> },
    { id: "party", header: "الموظف/الجهة", accessorFn: ledgerParty },
    { id: "direction", header: "الاتجاه", accessorFn: ledgerDirection },
    { id: "amount", header: "المبلغ", accessorFn: (row) => row.amount, sortingFn: (a, b, id) => D(a.getValue<string>(id)).comparedTo(D(b.getValue<string>(id))), cell: ({ row }) => <span dir="ltr" className="tabular-nums font-medium">{fmtAr(row.original.amount)}</span> },
    { id: "date", header: "التاريخ الفعلي", accessorFn: (row) => ledgerDate(row.paymentDate), cell: ({ row }) => <span dir="ltr" className="tabular-nums">{ledgerDate(row.original.paymentDate)}</span> },
    { id: "document", header: "المستند/الحدث", accessorFn: (row) => `REC-${row.receiptId} / EV-${row.eventId}`, cell: ({ row }) => <div className="font-mono text-[11px]" dir="ltr"><div>REC-{row.original.receiptId}</div><div>EV-{row.original.eventId}{row.original.reversalOfId ? ` ← EV-${row.original.reversalOfId}` : ""}</div></div> },
    { id: "method", header: "الطريقة/المرجع", accessorFn: (row) => `${row.method} ${row.referenceNumber ?? ""}`, cell: ({ row }) => <div><div>{row.original.method}</div><div className="text-muted-foreground" dir="ltr">{row.original.referenceNumber || "—"}</div></div> },
    { id: "actor", header: "المنفذ", accessorFn: (row) => row.createdByName ?? `USER-${row.createdBy}`, cell: ({ row }) => <div><div>{row.original.createdByName ?? "مستخدم"}</div><div className="text-muted-foreground" dir="ltr">USER-{row.original.createdBy}</div></div> },
    { id: "state", header: "الأثر", accessorFn: (row) => row.active ? "نافذ" : "معكوس", cell: ({ row }) => <span className={`rounded-full px-2 py-0.5 text-[11px] ${row.original.active ? "badge-status-active" : "badge-status-cancelled"}`}>{row.original.active ? "نافذ" : "معكوس بإعادة لاحقة"}</span> },
  ], []);

  function onExport() {
    const runRows = rows.map((row) => ({
      period: row.period,
      status: payrollStatusLabel(row.status),
      revisionNo: Number(row.revisionNo),
      accrualDate: row.accrualDate ?? "",
      employeeCount: Number(row.employeeCount),
      gross: toExcelMoney(row.totalGross),
      overtime: toExcelMoney(row.totalOvertime),
      commission: toExcelMoney(row.totalCommission),
      deductions: toExcelMoney(row.totalDeductions),
      net: toExcelMoney(row.totalNet),
      netPaid: toExcelMoney(netPaidByRun.get(Number(row.id))),
      tax: toExcelMoney(row.totalIncomeTax),
      ssEmployee: toExcelMoney(row.totalSocialSecurityEmployee),
      ssEmployer: toExcelMoney(row.totalSocialSecurityEmployer),
      eos: toExcelMoney(row.totalEndOfServiceAccrual),
      legalPolicyHash: row.legalPolicyHash ?? "",
      approvalSnapshotHash: row.approvalSnapshotHash ?? "",
    }));
    const ledgerRows = ledger.map((row) => ({
      movement: MOVEMENT_LABEL[row.movementType],
      party: ledgerParty(row),
      direction: ledgerDirection(row),
      amount: toExcelMoney(row.amount),
      paymentDate: ledgerDate(row.paymentDate),
      receiptId: `REC-${row.receiptId}`,
      eventId: `EV-${row.eventId}`,
      reversalOf: row.reversalOfId ? `EV-${row.reversalOfId}` : "",
      method: row.method,
      referenceNumber: row.referenceNumber ?? "",
      actor: row.createdByName ?? `USER-${row.createdBy}`,
      actorId: `USER-${row.createdBy}`,
      active: row.active ? "نافذ" : "معكوس بإعادة لاحقة",
    }));
    exportSheets(`تقرير-الرواتب-الاستحقاقي${period ? `-${period}` : ""}`, [
      {
        sheetName: "ملخص الاستحقاق",
        title: `تقرير الرواتب الاستحقاقي — ${period || "كل الأشهر"}`,
        rows: runRows,
        columns: [
          { key: "period", header: "الشهر" }, { key: "status", header: "الحالة" },
          { key: "revisionNo", header: "المراجعة" }, { key: "accrualDate", header: "تاريخ الاستحقاق" },
          { key: "employeeCount", header: "عدد الموظفين" }, { key: "gross", header: "الأساسي والمخصصات", money: true },
          { key: "overtime", header: "العمل الإضافي", money: true }, { key: "commission", header: "العمولة", money: true },
          { key: "deductions", header: "الاستقطاعات", money: true }, { key: "net", header: "صافي الموظفين", money: true },
          { key: "netPaid", header: "المدفوع فعلاً", money: true }, { key: "tax", header: "ضريبة الدخل", money: true },
          { key: "ssEmployee", header: "ضمان الموظف", money: true }, { key: "ssEmployer", header: "ضمان رب العمل", money: true },
          { key: "eos", header: "استحقاق نهاية الخدمة", money: true }, { key: "legalPolicyHash", header: "بصمة السياسة" },
          { key: "approvalSnapshotHash", header: "بصمة الاعتماد" },
        ],
      },
      {
        sheetName: "سجل حركة الأموال",
        title: `سجل دفعات ومرتجعات الرواتب والتحويلات — ${period || "كل الأشهر"}`,
        rows: ledgerRows,
        columns: [
          { key: "movement", header: "الحركة" }, { key: "party", header: "الموظف/الجهة" },
          { key: "direction", header: "الاتجاه" }, { key: "amount", header: "المبلغ", money: true },
          { key: "paymentDate", header: "التاريخ الفعلي" }, { key: "receiptId", header: "رقم الإيصال" },
          { key: "eventId", header: "رقم الحدث" }, { key: "reversalOf", header: "يعكس الحدث" },
          { key: "method", header: "طريقة الدفع" }, { key: "referenceNumber", header: "المرجع" },
          { key: "actor", header: "المنفذ" }, { key: "actorId", header: "معرف المنفذ" },
          { key: "active", header: "الأثر الحالي" },
        ],
      },
    ]);
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الرواتب الاستحقاقي",
      headerExtra: [{ label: "الشهر", value: period || "كل الأشهر" }],
      columns: [
        { key: "period", label: "الشهر" }, { key: "status", label: "الحالة" },
        { key: "revision", label: "المراجعة" }, { key: "employees", label: "الموظفون", align: "left" },
        { key: "gross", label: "الأساسي والمخصصات", align: "left" }, { key: "net", label: "الصافي", align: "left" },
        { key: "netPaid", label: "المدفوع فعلاً", align: "left" },
        { key: "tax", label: "الضريبة", align: "left" }, { key: "ss", label: "ضمان الشركة", align: "left" },
        { key: "eos", label: "نهاية الخدمة", align: "left" }, { key: "accrual", label: "الاستحقاق" },
      ],
      rows: rows.map((row) => ({
        period: row.period, status: payrollStatusLabel(row.status), revision: `R${row.revisionNo}`,
        employees: String(row.employeeCount), gross: fmtAr(row.totalGross), net: fmtAr(row.totalNet),
        netPaid: fmtAr(netPaidByRun.get(Number(row.id)) ?? "0"),
        tax: fmtAr(row.totalIncomeTax), ss: fmtAr(row.totalSocialSecurityEmployer), eos: fmtAr(row.totalEndOfServiceAccrual), accrual: row.accrualDate ?? "—",
      })),
      summary: [
        { label: "عدد المسيّرات", value: String(totals.runs) },
        { label: "إجمالي صافي الموظفين", value: fmtAr(totals.net) },
        { label: "صافي مدفوع فعلاً", value: fmtAr(totals.netPaid), large: true, bold: true },
        { label: "التزامات قانونية مفتوحة", value: fmtAr(legalOutstanding.toFixed(2)) },
      ],
    });
  }

  function printFinancialLedger() {
    const outgoing = ledger
      .filter((row) => ledgerDirection(row) === "صرف")
      .reduce((total, row) => total.plus(D(row.amount).abs()), D(0));
    const returned = ledger
      .filter((row) => ledgerDirection(row) === "قبض/إعادة")
      .reduce((total, row) => total.plus(D(row.amount).abs()), D(0));
    printReportDoc({
      title: "سجل حركة أموال الرواتب والتحويلات",
      orientation: "landscape",
      headerExtra: [{ label: "شهر الحركة الفعلية", value: period || "كل الأشهر" }],
      note: "كل صف مربوط بإيصال وحدث محاسبي ومنفذ. الحركات المعكوسة تبقى ظاهرة ولا تُحذف من أثر المراجعة.",
      columns: [
        { key: "movement", label: "الحركة" }, { key: "party", label: "الموظف/الجهة" },
        { key: "direction", label: "الاتجاه" }, { key: "amount", label: "المبلغ", align: "left" },
        { key: "date", label: "التاريخ" }, { key: "document", label: "الإيصال/الحدث" },
        { key: "method", label: "الطريقة/المرجع" }, { key: "actor", label: "المنفذ" },
        { key: "state", label: "الأثر" },
      ],
      rows: ledger.map((row) => ({
        movement: MOVEMENT_LABEL[row.movementType],
        party: ledgerParty(row),
        direction: ledgerDirection(row),
        amount: `${fmtAr(D(row.amount).abs().toFixed(2))} د.ع`,
        date: ledgerDate(row.paymentDate),
        document: `REC-${row.receiptId} / EV-${row.eventId}${row.reversalOfId ? ` ← EV-${row.reversalOfId}` : ""}`,
        method: `${row.method}${row.referenceNumber ? ` / ${row.referenceNumber}` : ""}`,
        actor: `${row.createdByName ?? "مستخدم"} / USER-${row.createdBy}`,
        state: row.active ? "نافذ" : "معكوس بإعادة لاحقة",
      })),
      summary: [
        { label: "إجمالي حركات الصرف", value: fmtAr(outgoing.toFixed(2)) },
        { label: "إجمالي المقبوض/المعاد", value: fmtAr(returned.toFixed(2)) },
        { label: "عدد الحركات", value: String(ledger.length), large: true, bold: true },
      ],
      emptyText: "لا دفعات أو مرتجعات في شهر الحركة المختار.",
    });
  }

  if (!me.isLoading && !ownerAccess) {
    return <ErrorState message="تقرير الرواتب محصور بجلسة المالك لحماية سرية رواتب جميع الفروع." />;
  }

  return <ReportShell
    title="تقرير الرواتب الاستحقاقي"
    description="يفصل تكلفة فترة العمل عن صرف الصافي والتحويلات القانونية، ويعرض المراجعة والبصمات والالتزامات المفتوحة."
    backHref="/reports" kpis={kpis} onExport={onExport} onPrint={onPrint}
    actions={<Button variant="outline" size="sm" onClick={printFinancialLedger} disabled={!ledger.length}><Printer className="size-4" aria-hidden /> طباعة سجل الأموال</Button>}
    exportDisabled={!rows.length && !ledger.length} printDisabled={!rows.length}
    filters={<div className="flex flex-wrap items-end gap-3"><div className="flex flex-col gap-1"><label className="text-[11px] text-muted-foreground">الشهر</label><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} className={inputCls} /></div>{period && <button type="button" onClick={() => setPeriod("")} className="h-9 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent">عرض الكل</button>}</div>}
  >
    {(runsQ.isError || obligationsQ.isError || ledgerQ.isError) ? <ErrorState message="تعذّر تحميل تقرير الرواتب." onRetry={() => { void runsQ.refetch(); void obligationsQ.refetch(); void ledgerQ.refetch(); }} /> : <div className="space-y-4">
      <DataTable columns={cols} data={rows} loading={runsQ.isLoading} emptyText="لا مسيّرات رواتب في هذا النطاق." pageSize={Infinity} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {outstanding.map((row) => <div key={row.kind} className="rounded-md border p-3 text-xs"><div className="text-muted-foreground">{OBLIGATION_KIND_LABEL[row.kind]} — متبقٍ</div><div className="mt-1 text-base font-bold tabular-nums" dir="ltr">{fmtAr(row.remaining)} د.ع</div><div className="mt-1 text-muted-foreground">{row.openCount} التزام مفتوح</div></div>)}
      </div>
      {rows.some((row) => row.approvalSnapshotHash) && <div className="rounded-md border bg-muted/20 p-3 text-xs"><div className="font-medium">أثر التدقيق</div>{rows.map((row) => <div key={row.id} className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono" dir="ltr"><span>{row.period} / R{row.revisionNo}</span><span title={row.legalPolicyHash ?? undefined}>POLICY {shortHash(row.legalPolicyHash)}</span><span title={row.approvalSnapshotHash ?? undefined}>APPROVAL {shortHash(row.approvalSnapshotHash)}</span></div>)}</div>}
      <Card>
        <CardHeader><CardTitle>سجل حركة الأموال والمستندات</CardTitle><p className="text-xs text-muted-foreground">دفعات ومرتجعات صافي الرواتب وتحويلات الضريبة والضمان؛ مع الإيصال والحدث والمرجع والمنفذ.</p></CardHeader>
        <CardContent className="p-0"><DataTable columns={ledgerCols} data={ledger} loading={ledgerQ.isLoading} emptyText="لا دفعات أو مرتجعات في شهر الحركة المختار." pageSize={Infinity} /></CardContent>
      </Card>
    </div>}
  </ReportShell>;
}
