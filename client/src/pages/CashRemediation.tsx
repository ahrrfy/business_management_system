import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileDown, FlaskConical, Printer, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { exportRows } from "@/lib/export";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc, type ReportDocInput } from "@/lib/printing/reportDoc";
import { trpc } from "@/lib/trpc";
import type {
  CashRemediationFilters,
  CashRemediationOutRow,
  CashRemediationReport,
  RemediationClassification,
} from "../../../server/services/cashRemediation/types";

const CLASSIFICATION_LABEL: Record<string, string> = {
  TREASURY_PAID: "دفع فعلي من الخزينة",
  EMPLOYEE_PERSONAL_PAID: "دفع شخصي للموظف",
  MISSING_INTERNAL_TRANSFER: "تحويل داخلي مفقود",
  DUPLICATE_OR_ERROR: "تكرار أو خطأ يحتاج عكساً",
  VERIFIED_INTERNAL_TRANSFER: "تحويل داخلي مثبت",
  UNVERIFIED_INTERNAL_TRANSFER: "تحويل داخلي غير مكتمل الإثبات",
  VERIFIED_REVERSAL: "عكس نظامي متصافر",
  UNVERIFIED_REVERSAL: "عكس غير مكتمل الإثبات",
  UNRESOLVED: "غير محسوم",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  HIGH: "عالٍ",
  MEDIUM: "متوسط",
  LOW: "منخفض",
};

const EVIDENCE_LABEL: Record<string, string> = {
  SOURCE_DOCUMENT: "المستند المصدر",
  COUNTERPARTY: "الطرف",
  PAYMENT_PROOF: "إثبات الدفع/المرفق",
  LEDGER_ENTRY: "القيد المرتبط",
  EMPLOYEE_DECLARATION: "إقرار الموظف",
  TREASURY_HANDOVER_OR_FUNDING_PROOF: "سند خزينة/تحويل",
  PHYSICAL_CASH_COUNT: "محضر عد النقد",
  CONFIRM_SINGLE_PHYSICAL_PAYMENT: "تأكيد دفعة فعلية واحدة",
  MANAGER_DECISION: "اعتماد المدير",
};

const SIMULATION_OPTIONS: RemediationClassification[] = [
  "TREASURY_PAID",
  "EMPLOYEE_PERSONAL_PAID",
  "MISSING_INTERNAL_TRANSFER",
  "DUPLICATE_OR_ERROR",
];

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type DryRunClient = {
  cashRemediation: {
    dryRun: { query(input: CashRemediationFilters): Promise<CashRemediationReport> };
  };
};

export type CashRemediationExportRow = {
  shift: string;
  employee: string;
  receipt: string;
  occurredAt: string;
  source: string;
  amount: string;
  runningBefore: string;
  runningAfter: string;
  suggestion: string;
  confidence: string;
  evidenceMissing: string;
  rationale: string;
  simulation: string;
  drawerDelta: string;
  treasuryDelta: string;
  employeePayableDelta: string;
  expenseDelta: string;
  draftStatus: string;
};

export function buildCashRemediationExportRows(
  report: CashRemediationReport,
): CashRemediationExportRow[] {
  return report.shifts.flatMap((shift) =>
    shift.outflows.map((row) => ({
      shift: `#${shift.shift.id}`,
      employee: shift.shift.userName,
      receipt: `#${row.receiptId}`,
      occurredAt: row.createdAt,
      source:
        row.source.documentType === "EXPENSE" && row.source.expenseIds.length > 1
          ? `EXPENSE ${row.source.expenseIds.join("، ")}`
          : `${row.source.documentType} ${row.source.documentId}`,
      amount: row.amount,
      runningBefore: row.runningBalanceBefore,
      runningAfter: row.runningBalanceAfter,
      suggestion: CLASSIFICATION_LABEL[row.suggestedClassification] ?? row.suggestedClassification,
      confidence: CONFIDENCE_LABEL[row.confidence] ?? row.confidence,
      evidenceMissing: row.evidenceMissing.map((item) => EVIDENCE_LABEL[item] ?? item).join("، "),
      rationale: row.rationale,
      simulation: row.simulation.selectedClassification
        ? CLASSIFICATION_LABEL[row.simulation.selectedClassification]
        : "لم تُحدد",
      drawerDelta: row.simulation.drawerDelta,
      treasuryDelta: row.simulation.treasuryDelta,
      employeePayableDelta: row.simulation.employeePayableDelta,
      expenseDelta: row.simulation.expenseDelta,
      draftStatus: "مسودة تشخيصية — بلا ترحيل أو اعتماد",
    })),
  );
}

export function buildCashRemediationPrintInput(
  report: CashRemediationReport,
): ReportDocInput {
  const rows = buildCashRemediationExportRows(report);
  return {
    title: "مسودة تشخيص الأرصدة السالبة",
    docDate: fmtDateTime(report.generatedAt),
    headerExtra: [
      { label: "الفترة", value: `${report.filters.from} — ${report.filters.to}` },
      { label: "الوضع", value: "DRY-RUN للقراءة فقط" },
    ],
    note:
      "مسودة تشخيصية غير محاسبية: لا تثبت قبضاً أو صرفاً، ولا تنشئ إيصالاً أو قيداً أو حركة درج/خزينة، ولا تصلح سند اعتماد.",
    columns: [
      { key: "shift", label: "الوردية" },
      { key: "employee", label: "الموظف" },
      { key: "receipt", label: "الإيصال" },
      { key: "source", label: "المصدر" },
      { key: "amount", label: "المبلغ", align: "left" },
      { key: "runningAfter", label: "الرصيد بعده", align: "left" },
      { key: "suggestion", label: "الاقتراح" },
      { key: "confidence", label: "الثقة" },
      { key: "evidenceMissing", label: "النواقص" },
      { key: "rationale", label: "التعليل" },
      { key: "simulation", label: "اختيار المحاكاة" },
      { key: "simulationEffect", label: "أثر المحاكاة" },
    ],
    rows: rows.map((row) => ({
      shift: row.shift,
      employee: row.employee,
      receipt: row.receipt,
      source: row.source,
      amount: fmtAr(row.amount),
      runningAfter: fmtAr(row.runningAfter),
      suggestion: row.suggestion,
      confidence: row.confidence,
      evidenceMissing: row.evidenceMissing || "لا شيء",
      rationale: row.rationale,
      simulation: row.simulation,
      simulationEffect:
        `درج ${fmtAr(row.drawerDelta)}؛ خزينة ${fmtAr(row.treasuryDelta)}؛ ` +
        `ذمة موظف ${fmtAr(row.employeePayableDelta)}؛ مصروف ${fmtAr(row.expenseDelta)}`,
    })),
    summary: [
      { label: "الورديات", value: String(report.summary.shiftCount) },
      { label: "بلغت السالب", value: String(report.summary.negativeShiftCount) },
      { label: "حركات OUT", value: String(report.summary.outflowCount) },
      { label: "قبل المحاكاة", value: `${fmtAr(report.summary.beforeExpectedCash)} د.ع` },
      { label: "بعد المحاكاة", value: `${fmtAr(report.summary.afterExpectedCash)} د.ع`, bold: true },
    ],
    orientation: "landscape",
  };
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseIds(value: string): number[] | undefined {
  const ids = value
    .split(/[،,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));
  if (!ids.length) return undefined;
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("معرّفات الورديات/الموظفين يجب أن تكون أرقاماً صحيحة موجبة");
  }
  return Array.from(new Set(ids));
}

function sourceLabel(row: CashRemediationOutRow): string {
  const labels: Record<string, string> = {
    EXPENSE: "مصروف",
    INVOICE: "فاتورة",
    WORK_ORDER: "أمر شغل",
    RESERVATION: "حجز",
    VOUCHER: "سند",
    RECEIPT: "إيصال منفرد",
  };
  return `${labels[row.source.documentType] ?? row.source.documentType} ${row.source.documentId}`;
}

export default function CashRemediation() {
  const today = useMemo(() => new Date(), []);
  const thirtyDaysAgo = useMemo(() => new Date(today.getTime() - 29 * 86_400_000), [today]);
  const [from, setFrom] = useState(ymd(thirtyDaysAgo));
  const [to, setTo] = useState(ymd(today));
  const [branchId, setBranchId] = useState("");
  const [shiftIds, setShiftIds] = useState("");
  const [userIds, setUserIds] = useState("");
  const [submitted, setSubmitted] = useState<CashRemediationFilters | null>(null);
  const [selections, setSelections] = useState<Record<number, RemediationClassification | "">>({});
  useEffect(() => {
    setSelections({});
    setSubmitted(null);
  }, [from, to, branchId, shiftIds, userIds]);
  const utils = trpc.useUtils();
  const dryRunClient = utils.client as unknown as DryRunClient;
  const reportQuery = useQuery({
    queryKey: ["cash-remediation-dry-run", submitted],
    queryFn: () => dryRunClient.cashRemediation.dryRun.query(submitted!),
    enabled: submitted != null,
  });

  const run = (includeSimulation: boolean) => {
    try {
      const parsedBranch = branchId.trim() ? Number(branchId) : undefined;
      if (parsedBranch != null && (!Number.isInteger(parsedBranch) || parsedBranch <= 0)) {
        throw new Error("معرّف الفرع يجب أن يكون رقماً صحيحاً موجباً");
      }
      const visibleReceiptIds = new Set(
        reportQuery.data?.shifts.flatMap((shift) => shift.outflows.map((row) => row.receiptId)) ?? [],
      );
      if (!includeSimulation) setSelections({});
      setSubmitted({
        from,
        to,
        branchId: parsedBranch,
        shiftIds: parseIds(shiftIds),
        userIds: parseIds(userIds),
        simulations: includeSimulation
          ? Object.entries(selections)
              .filter((entry): entry is [string, RemediationClassification] => Boolean(entry[1]))
              .filter(([receiptId]) => visibleReceiptIds.has(Number(receiptId)))
              .map(([receiptId, classification]) => ({ receiptId: Number(receiptId), classification }))
          : undefined,
      });
    } catch (error) {
      notify.err(error);
    }
  };

  const report = reportQuery.data;
  const exportDraft = () => {
    if (!report) return;
    const rows = buildCashRemediationExportRows(report);
    exportRows(rows, {
      filename: "مسودة-تشخيص-الأرصدة-السالبة",
      title: "مسودة تشخيص الأرصدة السالبة — بلا ترحيل",
      meta: [
        { label: "الفترة", value: `${report.filters.from} — ${report.filters.to}` },
        { label: "الوضع", value: "DRY_RUN_READ_ONLY" },
      ],
      columns: [
        { key: "shift", header: "الوردية" },
        { key: "employee", header: "الموظف" },
        { key: "receipt", header: "الإيصال" },
        { key: "occurredAt", header: "التاريخ" },
        { key: "source", header: "المصدر" },
        { key: "amount", header: "المبلغ" },
        { key: "runningBefore", header: "الرصيد قبله" },
        { key: "runningAfter", header: "الرصيد بعده" },
        { key: "suggestion", header: "التصنيف المقترح" },
        { key: "confidence", header: "الثقة" },
        { key: "evidenceMissing", header: "الأدلة الناقصة" },
        { key: "rationale", header: "التعليل" },
        { key: "simulation", header: "اختيار المحاكاة" },
        { key: "drawerDelta", header: "دلتا الدرج" },
        { key: "treasuryDelta", header: "دلتا الخزينة" },
        { key: "employeePayableDelta", header: "دلتا ذمة الموظف" },
        { key: "expenseDelta", header: "دلتا المصروف" },
        { key: "draftStatus", header: "حالة المستند" },
      ],
      format: "xlsx",
    });
  };

  return (
    <main className="space-y-4 p-4" dir="rtl">
      <section className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-4 text-[var(--sem-warn)]">
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div>
            <h1 className="text-lg font-bold">تشخيص تاريخي للأرصدة السالبة</h1>
            <p className="mt-1 text-sm">
              مسودة قراءة ومحاكاة فقط. لا تنشئ إيصالاً أو قيداً أو حركة درج/خزينة، ولا تعتمد أي تسوية.
            </p>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">نطاق التشخيص</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-5">
          <label className="space-y-1 text-sm">من<Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="space-y-1 text-sm">إلى<Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <label className="space-y-1 text-sm">معرّف الفرع<Input inputMode="numeric" value={branchId} onChange={(event) => setBranchId(event.target.value)} placeholder="اختياري" /></label>
          <label className="space-y-1 text-sm">معرّفات الورديات<Input value={shiftIds} onChange={(event) => setShiftIds(event.target.value)} placeholder="مثال: 12، 15" /></label>
          <label className="space-y-1 text-sm">معرّفات الموظفين<Input value={userIds} onChange={(event) => setUserIds(event.target.value)} placeholder="مثال: 3، 7" /></label>
          <div className="md:col-span-5 flex flex-wrap gap-2">
            <Button onClick={() => run(false)} disabled={!from || !to || reportQuery.isFetching}>
              <Search aria-hidden /> تشغيل التقرير
            </Button>
            <Button variant="outline" onClick={() => run(true)} disabled={!report || reportQuery.isFetching}>
              <FlaskConical aria-hidden /> محاكاة المحددات
            </Button>
            <Button variant="outline" onClick={exportDraft} disabled={!report}>
              <FileDown aria-hidden /> تصدير مسودة
            </Button>
            <Button
              variant="outline"
              onClick={() => report && !printReportDoc(buildCashRemediationPrintInput(report)) && notify.err("تعذّر فتح نافذة الطباعة")}
              disabled={!report}
            >
              <Printer aria-hidden /> طباعة مسودة
            </Button>
          </div>
        </CardContent>
      </Card>

      {reportQuery.isFetching && <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">جارٍ تحليل السجل التاريخي…</div>}
      {reportQuery.error && <div className="rounded-md border border-destructive p-4 text-sm text-destructive">{reportQuery.error.message}</div>}

      {report && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">الورديات</div><div className="text-2xl font-bold">{report.summary.shiftCount}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">بلغت السالب</div><div className="text-2xl font-bold text-destructive">{report.summary.negativeShiftCount}</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">قبل المحاكاة</div><div className="text-xl font-bold">{fmtAr(report.summary.beforeExpectedCash)} د.ع</div></CardContent></Card>
            <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">بعد المحاكاة</div><div className="text-xl font-bold">{fmtAr(report.summary.afterExpectedCash)} د.ع</div></CardContent></Card>
          </section>

          {report.shifts.map((shift) => (
            <Card key={shift.shift.id}>
              <CardHeader className="border-b">
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span>وردية #{shift.shift.id} — {shift.shift.userName} — {shift.shift.branchName}</span>
                  <span className="text-xs font-normal text-muted-foreground">{fmtDateTime(shift.shift.openedAt)}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <div><span className="text-muted-foreground">الافتتاح:</span> {fmtAr(shift.before.openingBalance)}</div>
                  <div><span className="text-muted-foreground">الجاري/المتوقع:</span> {fmtAr(shift.before.computedExpectedCash)}</div>
                  <div><span className="text-muted-foreground">المخزن:</span> {shift.before.storedExpectedCash == null ? "—" : fmtAr(shift.before.storedExpectedCash)}</div>
                  <div><span className="text-muted-foreground">بعد المحاكاة:</span> {fmtAr(shift.afterSimulation.expectedCash)}</div>
                  <div className={shift.firstNegative ? "text-destructive" : "text-muted-foreground"}>
                    {shift.firstNegative
                      ? `أول سالب: ${shift.firstNegative.point === "OPENING" ? "الرصيد الافتتاحي" : `إيصال #${shift.firstNegative.receiptId}`} (${fmtAr(shift.firstNegative.balance)})`
                      : "لم يبلغ الرصيد السالب"}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[1200px] text-sm">
                    <thead className="bg-muted/60 text-right">
                      <tr>
                        <th className="p-2">الإيصال/الوقت</th><th className="p-2">المصدر والطرف</th><th className="p-2">المبلغ</th>
                        <th className="p-2">الجاري قبله ← بعده</th><th className="p-2">الاقتراح</th><th className="p-2">الأدلة الناقصة</th><th className="p-2">محاكاة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shift.outflows.map((row) => (
                        <tr key={row.receiptId} className="border-t align-top">
                          <td className="p-2"><div className="font-mono">#{row.receiptId}</div><div className="text-xs text-muted-foreground">{fmtDateTime(row.createdAt)}</div></td>
                          <td className="p-2"><div>{sourceLabel(row)}</div><div className="text-xs text-muted-foreground">{row.counterpartyName ?? "طرف غير موثق"} · {row.actorName ?? "فاعل غير موثق"}</div></td>
                          <td className="p-2 font-semibold">{fmtAr(row.amount)} د.ع<div className="text-xs font-normal text-muted-foreground">{row.paymentMethod} / {row.cashBucket ?? "بلا دلو"}</div></td>
                          <td className="p-2" dir="ltr">{fmtAr(row.runningBalanceBefore)} ← <span className={row.runningBalanceAfter.startsWith("-") ? "text-destructive font-bold" : ""}>{fmtAr(row.runningBalanceAfter)}</span></td>
                          <td className="p-2"><div className="font-medium">{CLASSIFICATION_LABEL[row.suggestedClassification]}</div><div className="text-xs text-muted-foreground">الثقة: {CONFIDENCE_LABEL[row.confidence]}</div><div className="mt-1 max-w-80 text-xs">{row.rationale}</div></td>
                          <td className="p-2 text-xs">{row.evidenceMissing.length ? row.evidenceMissing.map((item) => EVIDENCE_LABEL[item]).join("، ") : "مكتملة بنيوياً"}</td>
                          <td className="p-2">
                            <select
                              className={selectClass}
                              aria-label={`تصنيف محاكاة الإيصال ${row.receiptId}`}
                              disabled={!row.affectsDrawer || row.pairedTreasuryReceiptId != null || row.status === "REVERSED" || row.source.expenseIds.length > 1}
                              value={selections[row.receiptId] ?? ""}
                              onChange={(event) => setSelections((current) => ({ ...current, [row.receiptId]: event.target.value as RemediationClassification | "" }))}
                            >
                              <option value="">بلا محاكاة</option>
                              {SIMULATION_OPTIONS.map((option) => <option key={option} value={option}>{CLASSIFICATION_LABEL[option]}</option>)}
                            </select>
                            {row.simulation.selectedClassification && <div className="mt-1 text-xs text-muted-foreground">أثر الدرج: {fmtAr(row.simulation.drawerDelta)}</div>}
                          </td>
                        </tr>
                      ))}
                      {!shift.outflows.length && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا توجد حركات OUT في الوردية.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </main>
  );
}
