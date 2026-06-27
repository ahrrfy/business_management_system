// التعرّض الائتماني للعملاء — من أعطيه آجلاً؟ من أوقف عنه؟ من يحتاج اتصال تحصيل؟
// رصيد/متأخّر/آخر دفعة/أيام تأخّر/أعلى فاتورة/حدّ ائتمان + تصنيف خطر (عالٍ/متوسّط/منخفض).
// أزرار الصفّ: كشف الحساب · تذكير واتساب (صفري التكلفة). عرض + تصدير Excel + طباعة A4 (ReportShell).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { MessageCircle, FileText } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { openWhatsApp } from "@/lib/whatsapp";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Row = RouterOutputs["reports"]["creditExposure"]["rows"][number];
type RiskFilter = "all" | "high" | "medium" | "low";

const RISK_LABEL: Record<string, string> = { high: "عالٍ", medium: "متوسّط", low: "منخفض" };
const RISK_CLS: Record<string, string> = {
  high: "badge-stock-out",
  medium: "badge-stock-low",
  low: "bg-muted text-muted-foreground",
};
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const NOTE =
  "الرصيد الجاري والمتأخّر مشتقّان من الفواتير غير المسدّدة + الرصيد الافتتاحي. تصنيف الخطر: عالٍ = تجاوز الحدّ أو ذمم +٩٠ يوم؛ متوسّط = ٦١–٩٠ يوم أو استخدام >٨٠٪ من الحدّ.";

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
      `نذكّركم بأنّ الرصيد المستحقّ لدى المكتبة العربية للطباعة والقرطاسية هو ${formatIqd(r.currentBalance)}.`,
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
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">مستوى الخطر</label>
            <select className={selectCls} value={risk} onChange={(e) => setRisk(e.target.value as RiskFilter)}>
              <option value="all">الكل</option>
              <option value="high">عالٍ</option>
              <option value="medium">متوسّط</option>
              <option value="low">منخفض</option>
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">العميل</th>
                    <th className="p-2.5 text-right font-medium">الخطر</th>
                    <th className="p-2.5 text-right font-medium">الرصيد</th>
                    <th className="p-2.5 text-right font-medium">المتأخّر</th>
                    <th className="p-2.5 text-right font-medium">أيام التأخّر</th>
                    <th className="p-2.5 text-right font-medium">أعلى فاتورة</th>
                    <th className="p-2.5 text-right font-medium">حدّ الائتمان</th>
                    <th className="p-2.5 text-right font-medium">آخر دفعة</th>
                    <th className="p-2.5 text-right font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows.length ? (
                    <TableEmptyRow colSpan={9} message="لا عملاء مدينون في هذا النطاق." />
                  ) : rows.map((r) => (
                    <tr key={r.customerId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right font-medium">{r.customerName}</td>
                      <td className="p-2.5 text-right">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${RISK_CLS[r.risk] ?? "bg-muted"}`}>
                          {RISK_LABEL[r.risk] ?? r.risk}
                        </span>
                      </td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.currentBalance)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{Number(r.overdueAmount) > 0 ? fmtAr(r.overdueAmount) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.daysOverdue > 0 ? fmtAr(r.daysOverdue) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.highestUnpaid)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.creditLimit == null ? "—" : fmtAr(r.creditLimit)}</td>
                      <td className="p-2.5 text-right text-muted-foreground">{fmtDay(r.lastPaymentDate)}</td>
                      <td className="p-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Link
                            href={`/customers?tab=statement&id=${r.customerId}`}
                            className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-foreground"
                            title="كشف الحساب"
                            aria-label="كشف الحساب"
                          >
                            <FileText className="size-4" aria-hidden />
                          </Link>
                          {r.phone && (
                            <button
                              type="button"
                              onClick={() => openWhatsApp(r.phone, reminderMessage(r))}
                              className="inline-flex size-8 items-center justify-center rounded-md border text-money-positive hover:bg-money-positive/10"
                              title="تذكير واتساب"
                              aria-label="تذكير واتساب"
                            >
                              <MessageCircle className="size-4" aria-hidden />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
