// تقرير المعاملات النقدية اليتيمة — receipts بـshiftId IS NULL وpaymentMethod='CASH'.
// هذه المعاملات تختفي من Z-report (computeExpectedCash يفلتر بـeq(receipts.shiftId, shiftId))
// فيظهر فرق صامت في تسوية الصندوق. التقرير للقراءة فقط — يَرصد السجلات التاريخية
// المُكتَبة قبل تفعيل إنفاذ الوردية ليُسوّيها المالك يدوياً. لا يُنشأ سطر جديد بعد التفعيل.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, formatIqd } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type CO = RouterOutputs["reports"]["cashOrphans"];

const SOURCE_LABEL: Record<string, string> = {
  EXPENSE: "مصروف",
  VOUCHER: "سند",
  OTHER: "أخرى",
};
const DIR_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "عميل",
  SUPPLIER: "مورّد",
  OTHER: "متفرّق",
};

const NOTE =
  "السجلات هنا حُفظت بـreceipts.shiftId=NULL وطريقة دفع نقدية، فلا يَراها Z-report. " +
  "اليوم تُحجَب آلياً (الخدمات ترمي خطأً)، لكن سجلات تاريخية قد تبقى — راجعها وسوّها يدوياً.";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ymdOf(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

export default function CashOrphanReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();

  const q = trpc.reports.cashOrphans.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const co: CO | undefined = q.data;

  const kpis: KpiItem[] = co
    ? [
        { label: "عدد المعاملات اليتيمة", value: String(co.count), tone: co.count > 0 ? "warning" : "info" },
        { label: "إجمالي قبض نقدي بلا وردية", value: fmtAr(co.totalIn), tone: "info" },
        { label: "إجمالي صرف نقدي بلا وردية", value: fmtAr(co.totalOut), tone: "warning" },
        { label: "الصافي (يتيم)", value: fmtAr(co.net), tone: co.net.startsWith("-") ? "warning" : "info" },
      ]
    : [];

  const branchLabel = branchId
    ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
    : "الكل";

  function onExport() {
    if (!co) return;
    exportRows(co.rows, {
      filename: `معاملات-نقدية-بلا-وردية-${period.from}-${period.to}`,
      columns: [
        { key: "createdAt", header: "التاريخ", map: (r) => ymdOf(r.createdAt) },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "source", header: "النوع", map: (r) => SOURCE_LABEL[r.source] ?? r.source },
        { key: "sourceId", header: "رقم المستند", map: (r) => r.sourceId ?? r.receiptId },
        { key: "voucherNumber", header: "رقم السند", map: (r) => r.voucherNumber ?? "" },
        { key: "direction", header: "الاتجاه", map: (r) => DIR_LABEL[r.direction] ?? r.direction },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
        { key: "partyType", header: "نوع الطرف", map: (r) => (r.partyType ? PARTY_LABEL[r.partyType] ?? r.partyType : "") },
        { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
        { key: "createdByName", header: "أنشأها", map: (r) => r.createdByName ?? "" },
      ],
    });
  }

  function onPrint() {
    if (!co) return;
    printReportDoc({
      title: "المعاملات النقدية اليتيمة (بلا وردية)",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "العدد", value: String(co.count) },
      ],
      note: NOTE,
      columns: [
        { key: "createdAt", label: "التاريخ" },
        { key: "branch", label: "الفرع" },
        { key: "source", label: "النوع" },
        { key: "doc", label: "المستند" },
        { key: "direction", label: "الاتجاه" },
        { key: "amount", label: "المبلغ", align: "left" },
        { key: "description", label: "الوصف" },
        { key: "createdBy", label: "أنشأها" },
      ],
      rows: co.rows.map((r) => ({
        createdAt: ymdOf(r.createdAt),
        branch: r.branchName ?? "—",
        source: SOURCE_LABEL[r.source] ?? r.source,
        doc: r.voucherNumber ?? (r.sourceId != null ? `#${r.sourceId}` : `R#${r.receiptId}`),
        direction: DIR_LABEL[r.direction] ?? r.direction,
        amount: fmtAr(r.amount),
        description: r.description ?? "",
        createdBy: r.createdByName ?? "—",
      })),
      showIndex: true,
      summary: [
        { label: "إجمالي القبض اليتيم", value: formatIqd(co.totalIn), bold: true },
        { label: "إجمالي الصرف اليتيم", value: formatIqd(co.totalOut), bold: true },
        { label: "الصافي اليتيم", value: formatIqd(co.net), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="المعاملات النقدية اليتيمة (بلا وردية)"
      description="receipts بـshiftId=NULL وpaymentMethod='CASH' — لا يَراها Z-report ⇒ خسارة تسوية صامتة."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!co || co.rows.length === 0}
      printDisabled={!co || co.rows.length === 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading || !co ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {q.isLoading ? "جارٍ التحميل…" : "لا بيانات."}
            </p>
          ) : co.rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-emerald-700">
              ممتاز — لا معاملات نقدية يتيمة في هذه الفترة. تسوية الصندوق متّسقة.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground bg-muted/30">
                  <th className="p-3 text-right font-medium">التاريخ</th>
                  <th className="p-3 text-right font-medium">الفرع</th>
                  <th className="p-3 text-right font-medium">النوع</th>
                  <th className="p-3 text-right font-medium">المستند</th>
                  <th className="p-3 text-right font-medium">الاتجاه</th>
                  <th className="p-3 text-left font-medium">المبلغ</th>
                  <th className="p-3 text-right font-medium">الوصف</th>
                  <th className="p-3 text-right font-medium">أنشأها</th>
                </tr>
              </thead>
              <tbody>
                {co.rows.map((r) => (
                  <tr key={r.receiptId} className="border-b last:border-0">
                    <td className="p-3 text-right text-xs" dir="ltr">
                      {ymdOf(r.createdAt)}
                    </td>
                    <td className="p-3 text-right">{r.branchName ?? "—"}</td>
                    <td className="p-3 text-right">
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-amber-100 text-amber-700">
                        {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-xs" dir="ltr">
                      {r.voucherNumber ?? (r.sourceId != null ? `#${r.sourceId}` : `R#${r.receiptId}`)}
                    </td>
                    <td className="p-3 text-right">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                          r.direction === "IN" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                        }`}
                      >
                        {DIR_LABEL[r.direction] ?? r.direction}
                      </span>
                    </td>
                    <td
                      className={`p-3 text-left tabular-nums ${
                        r.direction === "IN" ? "text-emerald-700" : "text-rose-700"
                      }`}
                      dir="ltr"
                    >
                      {fmtAr(r.amount)}
                    </td>
                    <td className="p-3 text-right text-xs max-w-xs truncate" title={r.description ?? ""}>
                      {r.description ?? "—"}
                    </td>
                    <td className="p-3 text-right text-xs">{r.createdByName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-bold bg-muted/30">
                  <td colSpan={5} className="p-3 text-right">
                    الإجمالي ({co.count} معاملة)
                  </td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">
                    قبض: {fmtAr(co.totalIn)} / صرف: {fmtAr(co.totalOut)} / صافي: {fmtAr(co.net)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
