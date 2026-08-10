// دفتر اليومية / الأستاذ — تصفّح قيود الدفتر بفلاتر (تاريخ/فرع/نوع) + إجماليات + تنقّل لمستند المصدر.
// عرض + تصدير Excel + طباعة A4 (ReportShell + printReportDoc). ترقيم صفحات بالخادم (limit/offset).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Search } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  PeriodFilter,
  DEFAULT_PERIOD,
  type PeriodValue,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

type Row = RouterOutputs["reports"]["generalLedger"]["rows"][number];
type EntryType =
  | "SALE"
  | "PURCHASE"
  | "PAYMENT_IN"
  | "PAYMENT_OUT"
  | "RETURN"
  | "ADJUST"
  | "OPENING"
  | "INTERNAL_USE"
  | "WASTAGE"
  | "GIFT_OUT"
  | "CASH_HANDOVER"
  | "CASH_TRANSFER_OUT"
  | "CASH_TRANSFER_IN"
  | "SHIFT_FLOAT_OUT"
  | "TREASURY_FUNDING"
  | "DELIVERY_DISPATCH"
  | "DELIVERY_REMIT"
  | "DELIVERY_FEE"
  | "DELIVERY_WRITEOFF"
  | "EXCHANGE_DEPOSIT"
  | "EXCHANGE_WITHDRAW"
  | "EXCHANGE_FX_BUY"
  | "EXCHANGE_SETTLE"
  | "EXCHANGE_FEE"
  | "EXCHANGE_FX_DIFF"
  | "DIGITAL_WALLET_DEPOSIT"
  | "DIGITAL_WALLET_WITHDRAWAL"
  | "DIGITAL_WALLET_CONSUMPTION"
  | "DIGITAL_WALLET_REVERSAL"
  | "DIGITAL_WALLET_ADJUSTMENT"
  | "DIGITAL_WRITEOFF";

const TYPE_LABEL: Record<string, string> = {
  SALE: "بيع",
  PURCHASE: "شراء",
  PAYMENT_IN: "قبض",
  PAYMENT_OUT: "صرف",
  RETURN: "مرتجع",
  ADJUST: "تسوية",
  OPENING: "افتتاحي",
  INTERNAL_USE: "نثرية",
  WASTAGE: "تلف",
  GIFT_OUT: "هدية صادرة",
  CASH_HANDOVER: "تسليم درج للخزينة",
  CASH_TRANSFER_OUT: "تحويل نقدي صادر",
  CASH_TRANSFER_IN: "تحويل نقدي وارد",
  SHIFT_FLOAT_OUT: "عهدة افتتاح وردية",
  TREASURY_FUNDING: "تمويل خزينة",
  DELIVERY_DISPATCH: "عهدة توصيل",
  DELIVERY_REMIT: "توريد توصيل",
  DELIVERY_FEE: "أجور توصيل",
  DELIVERY_WRITEOFF: "شطب عهدة توصيل",
  EXCHANGE_DEPOSIT: "إيداع صيرفة",
  EXCHANGE_WITHDRAW: "سحب صيرفة",
  EXCHANGE_FX_BUY: "شراء عملة",
  EXCHANGE_SETTLE: "تسوية صيرفة",
  EXCHANGE_FEE: "عمولة صيرفة",
  EXCHANGE_FX_DIFF: "فرق صرف",
  DIGITAL_WALLET_DEPOSIT: "إيداع محفظة",
  DIGITAL_WALLET_WITHDRAWAL: "سحب محفظة",
  DIGITAL_WALLET_CONSUMPTION: "استهلاك محفظة",
  DIGITAL_WALLET_REVERSAL: "عكس محفظة",
  DIGITAL_WALLET_ADJUSTMENT: "تسوية محفظة",
  DIGITAL_WRITEOFF: "شطب رقمي",
};
const TYPE_CLS: Record<string, string> = {
  SALE: "badge-status-active",
  PURCHASE: "badge-status-pending",
  PAYMENT_IN: "badge-status-active",
  PAYMENT_OUT: "badge-stock-low",
  RETURN: "badge-stock-out",
  ADJUST: "bg-muted text-muted-foreground",
  OPENING: "badge-status-done",
  INTERNAL_USE: "badge-stock-low",
  WASTAGE: "badge-stock-out",
};
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "شيك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  EXCHANGE: "صيرفة",
};
const WARNING_LABEL: Record<string, string> = {
  ACTOR_MISSING: "منفّذ القيد غير موثق",
  RECEIPT_MISSING: "الإيصال المرتبط غير موجود",
  DRAWER_SHIFT_MISSING: "نقد درج بلا وردية",
  APPROVAL_INCOMPLETE: "الاعتماد غير مكتمل",
  BRANCH_MISMATCH: "فرع القيد لا يطابق فرع الإيصال",
};
const PAGE = 200;
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function refLabel(r: Row): { text: string; href?: string } {
  if (r.invoiceId)
    return {
      text: r.invoiceNumber ?? `#${r.invoiceId}`,
      href: `/invoices/${r.invoiceId}`,
    };
  if (r.purchaseOrderId)
    return {
      text: `أمر شراء #${r.purchaseOrderId}`,
      href: `/purchases/${r.purchaseOrderId}`,
    };
  if (r.voucherNumber) return { text: r.voucherNumber };
  if (r.receiptId) return { text: `إيصال #${r.receiptId}` };
  return { text: `قيد #${r.id}` };
}

function actorName(r: Row) {
  return (
    r.createdByName ??
    r.receiptCreatedByName ??
    (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق")
  );
}

export default function GeneralLedger() {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  // نوع القيد: اختيار متعدّد (كان مفرداً) — كل الأنواع افتراضياً (مصفوفة فارغة = بلا فلترة).
  const [entryTypes, setEntryTypes] = useState<EntryType[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);

  const dq = useDebouncedValue(query, 250);
  const branches = trpc.branches.list.useQuery();
  function toggleType(t: EntryType) {
    setEntryTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
    setPage(0);
  }
  // مدخلات الفلترة الحالية بلا limit/offset — تُعاد استعمالها للاستعلام والتصدير الشامل.
  const filterInput = {
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
    entryTypes: entryTypes.length ? entryTypes : undefined,
    q: dq.trim() || undefined,
  };
  const q = trpc.reports.generalLedger.useQuery({
    ...filterInput,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  const kpis: KpiItem[] = totals
    ? [
        { label: "عدد القيود", value: total },
        { label: "إجمالي الإيراد", value: fmtAr(totals.revenue), tone: "info" },
        { label: "إجمالي التكلفة", value: fmtAr(totals.cost), tone: "warning" },
        {
          label: "صافي الربح",
          value: fmtAr(totals.profit),
          tone: Number(totals.profit) < 0 ? "negative" : "positive",
        },
      ]
    : [];

  const periodLabel = `${period.from} — ${period.to}`;

  // إعادة ضبط الصفحة عند تغيّر الفلاتر.
  function changePeriod(p: PeriodValue) {
    setPeriod(p);
    setPage(0);
  }

  async function onExport() {
    if (exporting) return;
    setExporting(true);
    try {
      // جلب كل القيود المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط).
      const allRows = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.generalLedger
            .fetch({ ...filterInput, limit, offset })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 },
      );
      exportRows(allRows, {
        filename: `دفتر-الأستاذ-${period.from}-${period.to}`,
        columns: [
          { key: "id", header: "رقم القيد" },
          { key: "entryDate", header: "تاريخ القيد" },
          { key: "createdAt", header: "وقت الإنشاء" },
          {
            key: "entryType",
            header: "النوع",
            map: (r) => TYPE_LABEL[r.entryType] ?? r.entryType,
          },
          { key: "partyName", header: "الطرف", map: (r) => r.partyName ?? "" },
          {
            key: "branchName",
            header: "الفرع",
            map: (r) => r.branchName ?? "",
          },
          { key: "revenue", header: "الإيراد", map: (r) => Number(r.revenue) },
          { key: "cost", header: "التكلفة", map: (r) => Number(r.cost) },
          { key: "profit", header: "الربح", map: (r) => Number(r.profit) },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
          { key: "document", header: "المستند", map: (r) => refLabel(r).text },
          {
            key: "invoiceId",
            header: "معرّف الفاتورة",
            map: (r) => r.invoiceId ?? "",
          },
          {
            key: "receiptId",
            header: "معرّف الإيصال",
            map: (r) => r.receiptId ?? "",
          },
          {
            key: "voucherNumber",
            header: "رقم السند",
            map: (r) => r.voucherNumber ?? "",
          },
          {
            key: "receiptReferenceNumber",
            header: "مرجع الدفع",
            map: (r) => r.receiptReferenceNumber ?? "",
          },
          {
            key: "receiptDirection",
            header: "اتجاه النقد",
            map: (r) => r.receiptDirection ?? "",
          },
          {
            key: "paymentMethod",
            header: "طريقة الدفع",
            map: (r) =>
              r.paymentMethod
                ? (METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod)
                : "",
          },
          {
            key: "cashBucket",
            header: "مصدر النقد",
            map: (r) =>
              r.cashBucket === "DRAWER"
                ? "درج"
                : r.cashBucket === "TREASURY"
                  ? "خزينة"
                  : "",
          },
          { key: "shiftId", header: "الوردية", map: (r) => r.shiftId ?? "" },
          {
            key: "shiftOwnerName",
            header: "صاحب الدرج",
            map: (r) => r.shiftOwnerName ?? "",
          },
          {
            key: "createdByName",
            header: "منشئ القيد",
            map: (r) => actorName(r),
          },
          {
            key: "receiptCreatedByName",
            header: "منفّذ الإيصال",
            map: (r) => r.receiptCreatedByName ?? "",
          },
          {
            key: "approvedByName",
            header: "المعتمد",
            map: (r) => r.approvedByName ?? "",
          },
          {
            key: "receiptStatus",
            header: "حالة الإيصال",
            map: (r) => r.receiptStatus ?? "",
          },
          {
            key: "receiptApprovalStatus",
            header: "حالة الاعتماد",
            map: (r) => r.receiptApprovalStatus ?? "",
          },
          {
            key: "dedupeKey",
            header: "مفتاح منع التكرار",
            map: (r) => r.dedupeKey ?? "",
          },
          {
            key: "notes",
            header: "الشرح / الملاحظات",
            map: (r) => r.notes ?? "",
          },
          {
            key: "integrityWarnings",
            header: "تنبيهات التدقيق",
            map: (r) =>
              r.integrityWarnings.map((w) => WARNING_LABEL[w] ?? w).join(" | "),
          },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  // كانت الطباعة تطبع الصفحة المعروضة فقط (limit=200) — الآن تجلب كل الصفحات المطابقة (نمط onExport).
  async function onPrint() {
    setPrinting(true);
    try {
      const allRows = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.reports.generalLedger
            .fetch({ ...filterInput, limit, offset })
            .then((r) => ({ rows: r.rows, total: r.total })),
        { pageSize: 500 },
      );
      printReportDoc({
        title: "دفتر اليومية / الأستاذ",
        headerExtra: [
          { label: "الفترة", value: periodLabel },
          {
            label: "الفرع",
            value: branchId
              ? (branches.data?.find((b) => b.id === branchId)?.name ??
                String(branchId))
              : "الكل",
          },
          {
            label: "النوع",
            value: entryTypes.length
              ? entryTypes.map((t) => TYPE_LABEL[t]).join("، ")
              : "الكل",
          },
        ],
        columns: [
          { key: "date", label: "التاريخ / القيد" },
          { key: "type", label: "النوع" },
          { key: "party", label: "الطرف" },
          { key: "amounts", label: "المبالغ", align: "left" },
          { key: "document", label: "المستندات" },
          { key: "source", label: "المصدر / الوردية" },
          { key: "actors", label: "التنفيذ / الاعتماد" },
          { key: "audit", label: "الشرح / التدقيق" },
        ],
        rows: allRows.map((r) => ({
          date: `${r.entryDate} | قيد #${r.id}`,
          type: TYPE_LABEL[r.entryType] ?? r.entryType,
          party: `${r.partyName ?? "—"} | ${r.branchName ?? "بلا فرع"}`,
          amounts: `مبلغ ${fmtAr(r.amount)} | إيراد ${fmtAr(r.revenue)} | كلفة ${fmtAr(r.cost)} | ربح ${fmtAr(r.profit)}`,
          document: `${refLabel(r).text}${r.receiptId ? ` | إيصال #${r.receiptId}` : ""}${r.receiptReferenceNumber ? ` | ${r.receiptReferenceNumber}` : ""}`,
          source: `${r.paymentMethod ? (METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod) : "غير نقدي"}${r.cashBucket ? ` | ${r.cashBucket === "DRAWER" ? "درج" : "خزينة"}` : ""}${r.shiftId ? ` | وردية #${r.shiftId} — ${r.shiftOwnerName ?? "بلا صاحب"}` : ""}`,
          actors: `القيد: ${actorName(r)}${r.receiptCreatedByName ? ` | الإيصال: ${r.receiptCreatedByName}` : ""}${r.approvedByName ? ` | الاعتماد: ${r.approvedByName}` : ""}`,
          audit: `${r.notes ?? "بلا شرح"}${r.integrityWarnings.length ? ` | ${r.integrityWarnings.map((w) => WARNING_LABEL[w] ?? w).join("، ")}` : ""}`,
        })),
        summary: totals
          ? [
              { label: "إجمالي الإيراد", value: fmtAr(totals.revenue) },
              { label: "إجمالي التكلفة", value: fmtAr(totals.cost) },
              {
                label: "صافي الربح",
                value: fmtAr(totals.profit),
                large: true,
                bold: true,
              },
            ]
          : undefined,
      });
    } finally {
      setPrinting(false);
    }
  }

  return (
    <ReportShell
      title="دفتر اليومية / الأستاذ"
      description="كل القيود المحاسبية بفلاتر وتنقّل لمستند المصدر."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length || exporting}
      printDisabled={!rows.length || printing}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={changePeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value ? Number(e.target.value) : "");
                setPage(0);
              }}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">بحث</label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="الطرف أو الملاحظات أو رقم الفاتورة…"
                className="h-9 w-56 pr-8"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">
              نوع القيد — اختيار متعدّد
            </label>
            <div
              className="flex flex-wrap gap-1 max-w-md"
              role="group"
              aria-label="فلترة نوع القيد"
            >
              {TYPE_OPTIONS.map((t) => {
                const active = entryTypes.includes(t as EntryType);
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleType(t as EntryType)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                      active
                        ? "border-primary bg-primary text-primary-foreground font-medium"
                        : "border-input bg-transparent text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                );
              })}
              {entryTypes.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setEntryTypes([]);
                    setPage(0);
                  }}
                  className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  مسح
                </button>
              )}
            </div>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState
              message="تعذّر تحميل دفتر الأستاذ."
              onRetry={() => q.refetch()}
            />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              لا قيود في هذا النطاق.
            </p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="min-w-[1780px] w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-end font-medium">
                      القيد والتوقيت
                    </th>
                    <th className="p-2.5 text-end font-medium">النوع</th>
                    <th className="p-2.5 text-end font-medium">الطرف والفرع</th>
                    <th className="p-2.5 text-end font-medium">
                      المبالغ المحاسبية
                    </th>
                    <th className="p-2.5 text-end font-medium">
                      المستندات والمراجع
                    </th>
                    <th className="p-2.5 text-end font-medium">
                      الحركة النقدية
                    </th>
                    <th className="p-2.5 text-end font-medium">
                      الوردية والعهدة
                    </th>
                    <th className="p-2.5 text-end font-medium">
                      التنفيذ والاعتماد
                    </th>
                    <th className="p-2.5 text-end font-medium">
                      الشرح والتدقيق
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ref = refLabel(r);
                    return (
                      <tr
                        key={r.id}
                        className="border-b last:border-0 hover:bg-accent/40"
                      >
                        <td className="p-2.5 text-end align-top">
                          <div className="font-semibold">قيد #{r.id}</div>
                          <div
                            className="mt-1 tabular-nums text-xs text-muted-foreground"
                            dir="ltr"
                          >
                            {r.entryDate}
                          </div>
                          <div
                            className="tabular-nums text-[11px] text-muted-foreground"
                            dir="ltr"
                          >
                            {r.createdAt}
                          </div>
                        </td>
                        <td className="p-2.5 text-end">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs ${TYPE_CLS[r.entryType] ?? "bg-muted text-muted-foreground"}`}
                          >
                            {TYPE_LABEL[r.entryType] ?? r.entryType}
                          </span>
                        </td>
                        <td className="p-2.5 text-end align-top">
                          <div className="font-medium">
                            {r.partyName ?? "لا يوجد طرف"}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {r.branchName ?? "بلا فرع"}
                          </div>
                        </td>
                        <td className="p-2.5 text-end align-top tabular-nums">
                          <div className="font-semibold">
                            المبلغ: {fmtAr(r.amount)}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            إيراد: {fmtAr(r.revenue)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            كلفة: {fmtAr(r.cost)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            ربح: {fmtAr(r.profit)}
                          </div>
                        </td>
                        <td className="p-2.5 text-end align-top">
                          {ref.href ? (
                            <Link
                              href={ref.href}
                              className="text-primary underline-offset-2 hover:underline"
                            >
                              {ref.text}
                            </Link>
                          ) : (
                            <span className="font-medium">{ref.text}</span>
                          )}
                          {r.receiptId && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              إيصال #{r.receiptId}
                            </div>
                          )}
                          {r.voucherNumber && (
                            <div className="text-xs text-muted-foreground">
                              سند: {r.voucherNumber}
                            </div>
                          )}
                          {r.receiptReferenceNumber && (
                            <div className="text-xs text-muted-foreground">
                              مرجع: {r.receiptReferenceNumber}
                            </div>
                          )}
                          {r.dedupeKey && (
                            <div className="mt-1 max-w-64 break-all text-[11px] text-muted-foreground">
                              منع التكرار: {r.dedupeKey}
                            </div>
                          )}
                        </td>
                        <td className="p-2.5 text-end align-top">
                          {r.paymentMethod ? (
                            <>
                              <div className="font-medium">
                                {METHOD_LABEL[r.paymentMethod] ??
                                  r.paymentMethod}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {r.receiptDirection === "IN"
                                  ? "وارد"
                                  : r.receiptDirection === "OUT"
                                    ? "صادر"
                                    : "بلا اتجاه"}
                                {r.cashBucket
                                  ? ` — ${r.cashBucket === "DRAWER" ? "درج" : "خزينة"}`
                                  : ""}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {r.receiptStatus ?? "بلا حالة"} /{" "}
                                {r.receiptApprovalStatus ?? "بلا اعتماد"}
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              لا إيصال نقدي مرتبط
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-end align-top">
                          {r.shiftId ? (
                            <>
                              <div className="font-medium">
                                وردية #{r.shiftId}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                صاحب الدرج: {r.shiftOwnerName ?? "غير موثق"}
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              بلا وردية
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-end align-top">
                          <div className="font-medium">
                            القيد: {actorName(r)}
                          </div>
                          {r.receiptCreatedByName && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              الإيصال: {r.receiptCreatedByName}
                            </div>
                          )}
                          {r.approvedByName ? (
                            <div className="text-xs text-muted-foreground">
                              اعتمد: {r.approvedByName}
                              {r.approvedAt ? ` — ${r.approvedAt}` : ""}
                            </div>
                          ) : (
                            r.receiptId && (
                              <div className="text-xs text-muted-foreground">
                                لا يوجد معتمد منفصل
                              </div>
                            )
                          )}
                        </td>
                        <td className="p-2.5 text-end align-top">
                          <div className="max-w-72 whitespace-normal text-xs">
                            {r.notes ?? "لا يوجد شرح للعملية"}
                          </div>
                          {r.integrityWarnings.length > 0 ? (
                            <div className="mt-2 space-y-1">
                              {r.integrityWarnings.map((warning) => (
                                <div
                                  key={warning}
                                  className="flex items-start gap-1 text-[11px] text-destructive"
                                >
                                  <AlertTriangle
                                    className="mt-0.5 size-3 shrink-0"
                                    aria-hidden
                                  />
                                  <span>
                                    {WARNING_LABEL[warning] ?? warning}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="mt-2 text-[11px] text-money-positive">
                              لا تنبيهات بنيوية
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            السابق
          </Button>
          <span className="text-muted-foreground tabular-nums">
            صفحة {page + 1} من {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            التالي
          </Button>
        </div>
      )}
    </ReportShell>
  );
}
