// التعرّض الائتماني للعملاء — من أعطيه آجلاً؟ من أوقف عنه؟ من يحتاج اتصال تحصيل؟
// رصيد/متأخّر/آخر دفعة/أيام تأخّر/أعلى فاتورة/حدّ ائتمان + تصنيف خطر (عالٍ/متوسّط/منخفض).
// أزرار الصفّ: كشف الحساب · تذكير واتساب (صفري التكلفة). عرض + تصدير Excel + طباعة A4 (ReportShell).
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { Link } from "wouter";
import { MessageCircle, FileText } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";


import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { openWhatsApp } from "@/lib/whatsapp";
import { RowActions } from "@/components/list";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { selectCls } from "@/lib/ui/formStyles";

type Row = RouterOutputs["reports"]["creditExposure"]["rows"][number];
type RiskFilter = "all" | "high" | "medium" | "low";

const RISK_LABEL: Record<string, string> = { high: "عالٍ", medium: "متوسّط", low: "منخفض" };
const RISK_CLS: Record<string, string> = {
  high: "badge-stock-out",
  medium: "badge-stock-low",
  low: "bg-muted text-muted-foreground",
};

const NOTE =
  "الرصيد الحالي والمتأخّر مشتقّان من الفواتير غير المسدّدة + الرصيد الافتتاحي. تصنيف الخطر: عالٍ = تجاوز الحدّ أو ذمم +90 يوم؛ متوسّط = 61-90 يوم أو استخدام >80٪ من الحدّ.";

function fmtDay(d: string | null): string {
  if (!d) return "—";
  return fmtDate(new Date(`${d}T00:00:00`));
}

export default function CreditExposureReport() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.creditExposure.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );

  const allRows = q.data?.rows ?? [];
  const summary = q.data?.summary;
  const rows = useMemo(() => (risk === "all" ? allRows : allRows.filter((r) => r.risk === risk)), [allRows, risk]);

  const kpis: KpiItem[] = summary
    ? [
        { label: "إجمالي التعرّض", value: formatIqd(summary.totalExposure), tone: "info" },
        { label: "عالي الخطورة", value: fmtAr(summary.highRiskCount), tone: "negative", hint: "عميل" },
        { label: "تجاوزوا الحدّ", value: fmtAr(summary.overLimitCount), tone: "warning", hint: formatIqd(summary.overLimitAmount) },
        { label: "إجمالي المتأخّر (+٣٠ يوم)", value: formatIqd(summary.totalOverdue), tone: "negative" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function reminderMessage(r: Row): string {
    return [
      `مرحباً ${r.customerName}،`,
      `نذكّركم بأنّ رصيدكم المستحقّ للمكتبة العربية للطباعة والقرطاسية (لنا عليكم) هو ${formatIqd(r.currentBalance)}.`,
      r.overdueAmount && Number(r.overdueAmount) > 0 ? `منه متأخّر: ${formatIqd(r.overdueAmount)}.` : "",
      "نرجو ترتيب السداد في أقرب وقت ممكن. شكراً لتعاونكم.",
    ].filter(Boolean).join("\n");
  }

  function onExport() {
    exportRows(rows, {
      filename: `التعرّض-الائتماني${branchId ? `-${branchLabel}` : ""}`,
      title: "التعرّض الائتماني للعملاء",
      meta: [
        { label: "الفرع", value: branchLabel },
        { label: "الخطر", value: risk === "all" ? "الكل" : RISK_LABEL[risk] },
        { label: "تاريخ الإصدار", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "customerName", header: "العميل" },
        { key: "risk", header: "الخطر", map: (r) => RISK_LABEL[r.risk] ?? r.risk },
        { key: "currentBalance", header: "الرصيد", money: true, map: (r) => Number(r.currentBalance) },
        { key: "overdueAmount", header: "المتأخّر", money: true, map: (r) => Number(r.overdueAmount) },
        { key: "daysOverdue", header: "أيام التأخّر", map: (r) => r.daysOverdue },
        { key: "highestUnpaid", header: "أعلى فاتورة", money: true, map: (r) => Number(r.highestUnpaid) },
        { key: "creditLimit", header: "حدّ الائتمان", money: true, map: (r) => (r.creditLimit == null ? "" : Number(r.creditLimit)) },
        { key: "availableCredit", header: "المتاح", money: true, map: (r) => (r.availableCredit == null ? "" : Number(r.availableCredit)) },
        { key: "lastPaymentDate", header: "آخر دفعة", map: (r) => r.lastPaymentDate ?? "" },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
      ],
      totalsRow: summary
        ? { customerName: "الإجمالي", currentBalance: Number(summary.totalExposure), overdueAmount: Number(summary.totalOverdue) }
        : undefined,
    });
  }

  function onPrint() {
    printReportDoc({
      title: "التعرّض الائتماني للعملاء",
      note: NOTE,
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        { label: "الخطر", value: risk === "all" ? "الكل" : RISK_LABEL[risk] },
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "customer", label: "العميل" },
        { key: "risk", label: "الخطر" },
        { key: "balance", label: "الرصيد", align: "left" },
        { key: "overdue", label: "المتأخّر", align: "left" },
        { key: "days", label: "أيام", align: "left" },
        { key: "highest", label: "أعلى فاتورة", align: "left" },
        { key: "limit", label: "الحدّ", align: "left" },
        { key: "lastPay", label: "آخر دفعة" },
      ],
      rows: rows.map((r) => ({
        customer: r.customerName,
        risk: RISK_LABEL[r.risk] ?? r.risk,
        balance: fmtAr(r.currentBalance),
        overdue: fmtAr(r.overdueAmount),
        days: r.daysOverdue > 0 ? fmtAr(r.daysOverdue) : "—",
        highest: fmtAr(r.highestUnpaid),
        limit: r.creditLimit == null ? "—" : fmtAr(r.creditLimit),
        lastPay: fmtDay(r.lastPaymentDate),
      })),
      summary: summary
        ? [
            { label: "عدد العملاء", value: fmtAr(summary.customers) },
            { label: "إجمالي المتأخّر", value: formatIqd(summary.totalOverdue) },
            { label: "إجمالي التعرّض", value: formatIqd(summary.totalExposure), large: true, bold: true },
          ]
        : undefined,
    });
  }
  /** أعمدة تعرّض الائتمان — «الخطر» شارةٌ لا لونٌ وحده (§color-not-only). */
  const exposureColumns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    {
      id: "customerName", header: "العميل",
      accessorFn: (r) => r.customerName,
      cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
      meta: { kind: "text", wrap: true },
    },
    {
      id: "risk", header: "الخطر",
      accessorFn: (r) => RISK_LABEL[r.risk] ?? r.risk,
      cell: ({ row }) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${RISK_CLS[row.original.risk] ?? "bg-muted"}`}>
          {RISK_LABEL[row.original.risk] ?? row.original.risk}
        </span>
      ),
      meta: { kind: "status" },
    },
    { id: "currentBalance", header: "الرصيد", accessorFn: (r) => Number(r.currentBalance), cell: ({ row }) => fmtAr(row.original.currentBalance), meta: { kind: "money" } },
    {
      id: "overdueAmount", header: "المتأخّر",
      accessorFn: (r) => Number(r.overdueAmount),
      cell: ({ row }) => <span className="text-money-negative">{Number(row.original.overdueAmount) > 0 ? fmtAr(row.original.overdueAmount) : "—"}</span>,
      meta: { kind: "money" },
    },
    {
      id: "daysOverdue", header: "أيام التأخّر",
      accessorFn: (r) => Number(r.daysOverdue),
      cell: ({ row }) => row.original.daysOverdue > 0 ? fmtAr(row.original.daysOverdue) : "—",
      meta: { kind: "number" },
    },
    {
      id: "highestUnpaid", header: "أعلى فاتورة",
      accessorFn: (r) => Number(r.highestUnpaid),
      cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.highestUnpaid)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "creditLimit", header: "حدّ الائتمان",
      accessorFn: (r) => (r.creditLimit == null ? -1 : Number(r.creditLimit)),
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.creditLimit == null ? "—" : fmtAr(row.original.creditLimit)}</span>,
      meta: { kind: "money" },
    },
    {
      id: "lastPaymentDate", header: "آخر دفعة",
      accessorFn: (r) => String(r.lastPaymentDate ?? ""),
      cell: ({ row }) => <span className="text-muted-foreground">{fmtDay(row.original.lastPaymentDate)}</span>,
      meta: { kind: "date" },
    },
    {
      id: "actions", header: "إجراء",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <RowActions
            mode="inline"
            actions={[
              {
                key: "statement", kind: "view", label: "كشف الحساب", icon: FileText,
                href: `/customers?tab=statement&id=${r.customerId}`,
                gate: { module: "crm", level: "READ" },
              },
              {
                key: "whatsapp", kind: "other", label: "تذكير واتساب", icon: MessageCircle,
                hidden: !r.phone,
                onSelect: () => r.phone && openWhatsApp(r.phone, reminderMessage(r)),
                gate: { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" },
              },
            ]}
          />
        );
      },
      meta: { kind: "actions" },
    },
  ], []);

  return (
    <ReportShell
      title="التعرّض الائتماني للعملاء"
      description="أرصدة العملاء ومخاطر التحصيل — من يحتاج متابعة أو إيقاف بيع آجل."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(value) => setBranchId(value ? Number(value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">مستوى الخطر</label>
            <AppSelect className="h-9" value={risk} onValueChange={(value) => setRisk(value as RiskFilter)}>
              <option value="all">الكل</option>
              <option value="high">عالٍ</option>
              <option value="medium">متوسّط</option>
              <option value="low">منخفض</option>
            </AppSelect>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={exposureColumns}
            data={rows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا عملاء مدينون في هذا النطاق."
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
