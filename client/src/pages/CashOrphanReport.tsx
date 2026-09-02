// تقرير «النقد خارج وردية الكاشير» — يَفصل دلالياً (تدقيق ١٧/٦):
//  - الخزينة الإدارية (TREASURY): معاملات admin/manager بـcashBucket='TREASURY' (متوقَّعة، مشروعة).
//  - نقد يتيم حقيقي (TRUE_ORPHAN): سجلات تاريخية قبل cashBucket (NULL) أو خَلل كاشير بـnull-shift.
// كلاهما خارج Z-report. تَسوية درج الكاشير تَبقى دقيقة، والمعاملات الإدارية تَدخل تَسوية شهرية مستقلّة.
import { useMemo, useState, type ReactNode } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { AlertTriangle, Building2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { selectCls } from "@/lib/ui/formStyles";

type CO = RouterOutputs["reports"]["cashOrphans"];
type OrphanRow = CO["rows"][number];
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


/** رقم المستند المعروض — نفس الاشتقاق المستعمَل في الطباعة كي لا ينجرف العرض عن المستند. */
function docLabel(r: OrphanRow): string {
  return r.voucherNumber ?? (r.sourceId != null ? `#${r.sourceId}` : `R#${r.receiptId}`);
}

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

  /*
   * الأعمدة تُبنى داخل المكوّن لأنّ ذيل الإجماليات يقرأ مجاميع الخادم (co) — والذيل
   * يُصيَّر في <tfoot> عبر `footer` على العمود، فلا صفَّ إجمالياتٍ داخل <tbody>.
   */
  const columns = useMemo<ColumnDef<OrphanRow, unknown>[]>(
    () => [
      {
        id: "createdAt",
        header: "التاريخ",
        accessorFn: (r) => fmtDate(r.createdAt),
        meta: { kind: "date" },
        cell: ({ row }) => fmtDate(row.original.createdAt),
        footer: () => <span className="font-bold">الإجمالي ({co ? co.count : 0} معاملة)</span>,
      },
      {
        id: "branch",
        header: "الفرع",
        accessorFn: (r) => r.branchName ?? "—",
        cell: ({ row }) => row.original.branchName ?? "—",
      },
      {
        id: "category",
        header: "الفئة",
        // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
        accessorFn: (r) => (r.category === "TREASURY" ? "خزينة" : "يتيم"),
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${row.original.category === "TREASURY" ? "badge-status-pending" : "badge-stock-low"}`}>
            {row.original.category === "TREASURY" ? <><Building2 aria-hidden className="size-3.5" />خزينة</> : <><AlertTriangle aria-hidden className="size-3.5" />يتيم</>}
          </span>
        ),
      },
      {
        id: "source",
        header: "النوع",
        accessorFn: (r) => SOURCE_LABEL[r.source] ?? r.source,
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-cancelled">
            {SOURCE_LABEL[row.original.source] ?? row.original.source}
          </span>
        ),
      },
      {
        id: "doc",
        header: "المستند",
        accessorFn: (r) => docLabel(r),
        meta: { kind: "code" },
        cell: ({ row }) => docLabel(row.original),
      },
      {
        id: "direction",
        header: "الاتجاه",
        accessorFn: (r) => DIR_LABEL[r.direction] ?? r.direction,
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
            {DIR_LABEL[row.original.direction] ?? row.original.direction}
          </span>
        ),
      },
      {
        id: "amount",
        header: "المبلغ",
        accessorFn: (r) => fmtAr(r.amount),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className={row.original.direction === "IN" ? "text-money-positive" : "text-money-negative"}>
            {fmtAr(row.original.amount)}
          </span>
        ),
        footer: () =>
          co ? (
            <span className="inline-flex flex-col items-end font-bold">
              <span>خزينة: {fmtAr(co.netTreasury)}</span>
              <span>يتيم: {fmtAr(co.netTrueOrphan)}</span>
            </span>
          ) : null,
      },
      {
        id: "description",
        header: "الوصف",
        accessorFn: (r) => r.description ?? "—",
        meta: { width: "wide" },
        cell: ({ row }) => (
          <span className="block max-w-xs truncate text-xs" title={row.original.description ?? ""}>
            {row.original.description ?? "—"}
          </span>
        ),
      },
      {
        id: "createdBy",
        header: "أنشأها",
        accessorFn: (r) => r.createdByName ?? "—",
        meta: { width: "actor" },
        cell: ({ row }) => <span className="text-xs">{row.original.createdByName ?? "—"}</span>,
      },
      {
        id: "role",
        header: "الدور",
        accessorFn: (r) => (r.createdByRole ? ROLE_LABEL[r.createdByRole]?.label ?? r.createdByRole : "—"),
        meta: { kind: "status" },
        cell: ({ row }) => {
          const roleInfo = row.original.createdByRole ? ROLE_LABEL[row.original.createdByRole] : null;
          return roleInfo ? (
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${roleInfo.cls}`}>{roleInfo.label}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          );
        },
      },
    ],
    [co],
  );

  /** رسالة الفراغ تتبع التبويب — «لا يتيم» خبرٌ سار لا نقصُ بيانات. */
  const emptyMessage = (
    <span className="text-money-positive">
      {tab === "TRUE_ORPHAN"
        ? "ممتاز — لا نقد يتيم حقيقي في هذه الفترة. تَسوية الصندوق متّسقة."
        : tab === "TREASURY"
          ? "لا معاملات خزينة إدارية في هذه الفترة."
          : "لا معاملات خارج وردية الكاشير."}
    </span>
  );

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
        { key: "cashBucket", header: "مكان النقد", map: (r) => (r.cashBucket === "DRAWER" ? "درج" : r.cashBucket === "TREASURY" ? "خزينة" : "") },
        { key: "source", header: "النوع", map: (r) => SOURCE_LABEL[r.source] ?? r.source },
        { key: "sourceId", header: "رقم المستند", map: (r) => r.sourceId ?? r.receiptId },
        { key: "voucherNumber", header: "رقم السند", map: (r) => r.voucherNumber ?? "" },
        { key: "direction", header: "الاتجاه", map: (r) => DIR_LABEL[r.direction] ?? r.direction },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
        { key: "partyType", header: "نوع الطرف", map: (r) => (r.partyType ? PARTY_LABEL[r.partyType] ?? r.partyType : "") },
        { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
        { key: "createdByName", header: "أنشأها", map: (r) => r.createdByName ?? "" },
        { key: "createdByRole", header: "الدور", map: (r) => (r.createdByRole ? ROLE_LABEL[r.createdByRole]?.label ?? r.createdByRole : "") },
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
        createdBy: r.createdByName ? `${r.createdByName}${r.createdByRole ? ` (${ROLE_LABEL[r.createdByRole]?.label ?? r.createdByRole})` : ""}` : "—",
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
      description="معاملات نقدية بـshiftId=NULL مفصولة: خزينة إدارية (admin/manager — متوقَّعة) ونقد يتيم حقيقي (سجلات قديمة/خَلل)."
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
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(value) => setBranchId(value ? Number(value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
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
          <DataTable<OrphanRow>
            columns={columns}
            data={co?.rows ?? []}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            /*
             * ⛔ لا بحثَ محلّيّ هنا: الخادم يقتطع الصفوف عند سقفٍ (LIMIT، افتراضه ١٠٠٠) فبحثٌ
             * فوق المحمَّل وحده يقول «لا نتائج» عن صفٍّ موجودٍ خلف السقف. وأسوأ: ذيلُ الإجماليات
             * أدناه مجاميعُ الخادم على **كامل** المحمَّل، فيتناقض مع الصفوف حين يُصفّيها بحثٌ
             * محلّيّ. الفلترة هنا خادمية وحدها (الفترة · الفرع · التبويب).
             */
            searchable={false}
            /* تبويب الفئة فلترٌ خارج الجدول — بلا هذا تُعلَن «لا صفوف بعد» بينما الصفوف محجوبةٌ بالتبويب. */
            externalFiltersActive={tab !== "all"}
            /*
             * تلوينُ الصفّ على **الخلايا** لا على `<tr>`: زِبرةُ `DataTable` تُصدَّر
             * `odd:bg-…`/`even:bg-…` أي `&:nth-child(odd)` بنوعيّةٍ (0,2,0) تغلب أيّ
             * `bg-…` عاريةٍ (0,1,0) في نفس العنصر ⇒ لونُ الفئة يموت صامتاً. والتمييزُ
             * بين «خزينة» و«يتيم» هو رسالةُ هذا التقرير كلّها، فلا يُترَك للصدفة.
             */
            getRowClassName={(r) =>
              r.category === "TREASURY"
                ? "[&>td]:bg-[var(--sem-info-bg)]"
                : "[&>td]:bg-[var(--sem-warn-bg)]/40"
            }
            emptyState={emptyMessage}
            emptyFilteredState={emptyMessage}
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
