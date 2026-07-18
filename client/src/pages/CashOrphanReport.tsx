// تقرير «النقد خارج وردية الكاشير» — يَفصل دلالياً (تدقيق ١٧/٦):
//  - الخزينة الإدارية (TREASURY): معاملات admin/manager بـcashBucket='TREASURY' (متوقَّعة، مشروعة).
//  - نقد يتيم حقيقي (TRUE_ORPHAN): سجلات تاريخية قبل cashBucket (NULL) أو خَلل كاشير بـnull-shift.
// كلاهما خارج Z-report. تَسوية درج الكاشير تَبقى دقيقة، والمعاملات الإدارية تَدخل تَسوية شهرية مستقلّة.
import { useState, type ReactNode } from "react";
import { AlertTriangle, Building2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";

type CO = RouterOutputs["reports"]["cashOrphans"];
type Tab = "all" | "TREASURY" | "TRUE_ORPHAN";

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
const ROLE_LABEL: Record<string, { label: string; cls: string }> = {
  admin: { label: "مدير عام", cls: "badge-status-done" },
  manager: { label: "مدير", cls: "badge-status-pending" },
  cashier: { label: "كاشير", cls: "badge-stock-low" },
  warehouse: { label: "مخزن", cls: "badge-stock-low" },
};

const NOTE =
  "تَبويب «الخزينة الإدارية» (admin/manager بـcashBucket=TREASURY) متوقَّع ومشروع — يَدخل تَسوية الخزينة الشهرية المستقلّة، لا تَسوية درج الكاشير. " +
  "تَبويب «النقد اليتيم الحقيقي» (cashBucket=NULL أو DRAWER+shiftId=null) سجلات تاريخية قبل ١٧/٦/٢٠٢٦ أو خَلل يَستدعي قيد تَسوية يدوي. " +
  "كلتا الفئتَين خارج Z-report.";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ymdOf(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

export default function CashOrphanReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [tab, setTab] = useState<Tab>("all");
  const branches = trpc.branches.list.useQuery();

  const q = trpc.reports.cashOrphans.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    category: tab === "all" ? undefined : (tab as "TREASURY" | "TRUE_ORPHAN"),
  });
  const co: CO | undefined = q.data;

  const kpis: KpiItem[] = co
    ? [
        { label: "الخزينة الإدارية (مشروع)", value: String(co.countTreasury), tone: "info" },
        { label: "صافي خزينة إدارية", value: fmtAr(co.netTreasury), tone: "info" },
        { label: "نقد يتيم حقيقي (فحص)", value: String(co.countTrueOrphan), tone: co.countTrueOrphan > 0 ? "warning" : "info" },
        { label: "صافي يتيم حقيقي", value: fmtAr(co.netTrueOrphan), tone: co.countTrueOrphan > 0 ? "warning" : "info" },
      ]
    : [];

  const branchLabel = branchId
    ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
    : "الكل";

  function onExport() {
    if (!co) return;
    exportRows(co.rows, {
      filename: `نقد-خارج-الوردية-${tab}-${period.from}-${period.to}`,
      columns: [
        { key: "createdAt", header: "التاريخ", map: (r) => ymdOf(r.createdAt) },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "category", header: "الفئة", map: (r) => (r.category === "TREASURY" ? "خزينة إدارية" : "يتيم حقيقي") },
        { key: "cashBucket", header: "الدلو", map: (r) => r.cashBucket ?? "" },
        { key: "source", header: "النوع", map: (r) => SOURCE_LABEL[r.source] ?? r.source },
        { key: "sourceId", header: "رقم المستند", map: (r) => r.sourceId ?? r.receiptId },
        { key: "voucherNumber", header: "رقم السند", map: (r) => r.voucherNumber ?? "" },
        { key: "direction", header: "الاتجاه", map: (r) => DIR_LABEL[r.direction] ?? r.direction },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
        { key: "partyType", header: "نوع الطرف", map: (r) => (r.partyType ? PARTY_LABEL[r.partyType] ?? r.partyType : "") },
        { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
        { key: "createdByName", header: "أنشأها", map: (r) => r.createdByName ?? "" },
        { key: "createdByRole", header: "الدور", map: (r) => r.createdByRole ?? "" },
      ],
    });
  }

  function onPrint() {
    if (!co) return;
    printReportDoc({
      title: tab === "all" ? "النقد خارج الوردية — كامل" : tab === "TREASURY" ? "الخزينة الإدارية" : "نقد يتيم حقيقي (فحص)",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "العدد", value: String(co.count) },
      ],
      note: NOTE,
      columns: [
        { key: "createdAt", label: "التاريخ" },
        { key: "branch", label: "الفرع" },
        { key: "category", label: "الفئة" },
        { key: "source", label: "النوع" },
        { key: "doc", label: "المستند" },
        { key: "direction", label: "الاتجاه" },
        { key: "amount", label: "المبلغ", align: "left" },
        { key: "description", label: "الوصف" },
        { key: "createdBy", label: "أنشأها" },
      ],
      rows: co.rows.map((r) => ({
        createdAt: fmtDate(r.createdAt),
        branch: r.branchName ?? "—",
        category: r.category === "TREASURY" ? "خزينة" : "يتيم",
        source: SOURCE_LABEL[r.source] ?? r.source,
        doc: r.voucherNumber ?? (r.sourceId != null ? `#${r.sourceId}` : `R#${r.receiptId}`),
        direction: DIR_LABEL[r.direction] ?? r.direction,
        amount: fmtAr(r.amount),
        description: r.description ?? "",
        createdBy: r.createdByName ? `${r.createdByName}${r.createdByRole ? ` (${r.createdByRole})` : ""}` : "—",
      })),
      showIndex: true,
      summary: [
        { label: "خزينة إدارية", value: formatIqd(co.netTreasury), bold: true },
        { label: "يتيم حقيقي", value: formatIqd(co.netTrueOrphan), bold: true },
        { label: "الإجمالي", value: formatIqd(co.net), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="النقد خارج وردية الكاشير — سجلّ إداري + يتيم تاريخي"
      description="معاملات نقدية بـshiftId=NULL مفصولة: خزينة إدارية (admin/manager — متوقَّعة) ومتيتم حقيقي (سجلات قديمة/خَلل)."
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
      {/* تبويبات الفئات */}
      <div className="flex gap-1">
        {([
          { key: "all" as Tab, label: "الكلّ" as ReactNode },
          { key: "TREASURY" as Tab, label: (<span className="inline-flex items-center gap-1"><Building2 aria-hidden className="size-3.5" />خزينة إدارية</span>) as ReactNode },
          { key: "TRUE_ORPHAN" as Tab, label: (<span className="inline-flex items-center gap-1"><AlertTriangle aria-hidden className="size-3.5" />يتيم حقيقي</span>) as ReactNode },
        ]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs transition ${
              tab === t.key
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-muted/60 text-foreground/70 hover:bg-accent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isLoading || !co ? (
            <LoadingState />
          ) : co.rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-money-positive">
              {tab === "TRUE_ORPHAN"
                ? "ممتاز — لا نقد يتيم حقيقي في هذه الفترة. تَسوية الصندوق متّسقة."
                : tab === "TREASURY"
                ? "لا معاملات خزينة إدارية في هذه الفترة."
                : "لا معاملات خارج وردية الكاشير."}
            </p>
          ) : (
            <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground bg-muted/30">
                  <th className="p-3 text-right font-medium">التاريخ</th>
                  <th className="p-3 text-right font-medium">الفرع</th>
                  <th className="p-3 text-right font-medium">الفئة</th>
                  <th className="p-3 text-right font-medium">النوع</th>
                  <th className="p-3 text-right font-medium">المستند</th>
                  <th className="p-3 text-right font-medium">الاتجاه</th>
                  <th className="p-3 text-right font-medium">المبلغ</th>
                  <th className="p-3 text-right font-medium">الوصف</th>
                  <th className="p-3 text-right font-medium">أنشأها</th>
                  <th className="p-3 text-right font-medium">الدور</th>
                </tr>
              </thead>
              <tbody>
                {co.rows.map((r) => {
                  const rowBg = r.category === "TREASURY" ? "bg-[var(--sem-info-bg)]" : "bg-amber-50/40";
                  const roleInfo = r.createdByRole ? ROLE_LABEL[r.createdByRole] : null;
                  return (
                    <tr key={r.receiptId} className={`border-b last:border-0 ${rowBg}`}>
                      <td className="p-3 text-right text-xs" dir="ltr">
                        {fmtDate(r.createdAt)}
                      </td>
                      <td className="p-3 text-right">{r.branchName ?? "—"}</td>
                      <td className="p-3 text-right">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${r.category === "TREASURY" ? "badge-status-pending" : "badge-stock-low"}`}>
                          {r.category === "TREASURY" ? <><Building2 aria-hidden className="size-3.5" />خزينة</> : <><AlertTriangle aria-hidden className="size-3.5" />يتيم</>}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-cancelled">
                          {SOURCE_LABEL[r.source] ?? r.source}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-xs" dir="ltr">
                        {r.voucherNumber ?? (r.sourceId != null ? `#${r.sourceId}` : `R#${r.receiptId}`)}
                      </td>
                      <td className="p-3 text-right">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                            r.direction === "IN" ? "badge-status-active" : "badge-stock-out"
                          }`}
                        >
                          {DIR_LABEL[r.direction] ?? r.direction}
                        </span>
                      </td>
                      <td
                        className={`p-3 text-right tabular-nums ${
                          r.direction === "IN" ? "text-money-positive" : "text-money-negative"
                        }`}
                        dir="ltr"
                      >
                        {fmtAr(r.amount)}
                      </td>
                      <td className="p-3 text-right text-xs max-w-xs truncate" title={r.description ?? ""}>
                        {r.description ?? "—"}
                      </td>
                      <td className="p-3 text-right text-xs">{r.createdByName ?? "—"}</td>
                      <td className="p-3 text-right">
                        {roleInfo ? (
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${roleInfo.cls}`}>
                            {roleInfo.label}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t font-bold bg-muted/30">
                  <td colSpan={6} className="p-3 text-right">
                    الإجمالي ({co.count} معاملة)
                  </td>
                  <td className="p-3 text-right tabular-nums" dir="ltr">
                    خزينة: {fmtAr(co.netTreasury)} / يتيم: {fmtAr(co.netTrueOrphan)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
