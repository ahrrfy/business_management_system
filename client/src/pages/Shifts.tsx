import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { useClipboard } from "@/hooks/useClipboard";
import { formatZReportAsText } from "@/lib/copy/formatters";
import { fmtDateTime } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printShiftClose } from "@/lib/printing/print";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { invoiceStatusLabel } from "@/lib/labels";
import { Check, Copy, Lock, Printer, Receipt } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

/* ═══════════ سجلّ الورديات + إعادة طباعة Z-report ═══════════
   يستهلك shifts.list (branch-scoped): ورديات الكاشير مع فُتحت/أُغلقت/المتوقع/المعدود/الفرق.
   فلاتر فرع/حالة + ترقيم خادمي + تصدير Excel + زر إعادة طباعة تقرير الوردية (Z) عبر printShiftClose.
═══════════════════════════════════════════════════════════ */

const PAGE = 50;
const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = { OPEN: "مفتوحة", CLOSED: "مغلقة" };
const STATUS_CLS: Record<string, string> = {
  OPEN: "badge-status-pending",
  CLOSED: "badge-status-active",
};
const SHIFT_TYPE_LABEL: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "خدمة العملاء",
  PRINT_SERVICES: "خدمات طباعة",
};

const fmtDT = (d: string | number | Date | null | undefined) =>
  fmtDateTime(d);

// نوع الصفّ صريحاً (الإجراء يُعيد {rows,total}) — حسمٌ يُجنّب فشل استدلال T في fetchAllPaged.
type Row = RouterOutputs["shifts"]["list"]["rows"][number];

export default function Shifts() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const [branchId, setBranchId] = useState<number | "">("");
  const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">("");
  const [shiftType, setShiftType] = useState<"" | "RETAIL" | "RECEPTION" | "PRINT_SERVICES">("");
  const [varianceState, setVarianceState] = useState<"" | "WITH_VARIANCE" | "MATCHED" | "UNRECONCILED">("");
  // فلتر الفترة خادمي (openedAt) — أسماء dateFrom/dateTo لتفادي تصادم from/to الترقيم أدناه.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [printing, setPrinting] = useState<number | null>(null);
  const [copying, setCopying] = useState<number | null>(null);
  const [closingShiftId, setClosingShiftId] = useState<number | null>(null);
  const [closeCounted, setCloseCounted] = useState("");
  // فواتير الوردية — لتحقيق فروقات النقد (فتح قائمة مضمَّنة بدل الانتقال لشاشة مبيعات منفصلة).
  const [invoicesShiftId, setInvoicesShiftId] = useState<number | null>(null);
  const { copy } = useClipboard({ successMessage: "نُسِخ تقرير Z" });

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // إدارة أي وردية مفتوحة عن بُعد (كاشير نسي إغلاقها) — بنفس صلاحيات closeShift الخادمية
  // (admin أي فرع، manager فرعه فقط)؛ الكاشير لا يرى الزرّ أصلاً (والخادم يرفضه لو حاول).
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery();
  const list = trpc.shifts.list.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    status: status || undefined,
    shiftType: shiftType || undefined,
    varianceState: varianceState || undefined,
    q: debouncedQuery || undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    limit: PAGE,
    offset: page * PAGE,
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  const branchName = useMemo(() => {
    const m = new Map((branches.data ?? []).map((b) => [Number(b.id), b.name]));
    return (id: number | null | undefined) => (id != null ? m.get(Number(id)) ?? `#${id}` : "—");
  }, [branches.data]);

  const setFilter = <T,>(fn: (v: T) => void, v: T) => { fn(v); setPage(0); };

  // الفرق: موجب = فائض (أخضر)، سالب = عجز (أحمر)، صفر/غير محسوب = محايد.
  const varianceCls = (v: string | null) => {
    if (v == null) return "text-muted-foreground";
    const d = D(v);
    if (d.gt(0)) return "text-money-positive";
    if (d.lt(0)) return "text-money-negative";
    return "text-foreground";
  };

  // فواتير الوردية — قائمة مضمَّنة (بدل التنقّل لشاشة المبيعات) لتحقيق فروقات النقد سطراً بسطر.
  const invoicesShiftQ = trpc.sales.list.useQuery(
    { shiftId: invoicesShiftId ?? 0, limit: 200 },
    { enabled: invoicesShiftId != null },
  );
  const invoicesShiftRow = rows.find((r) => r.id === invoicesShiftId) ?? null;

  // إغلاق وردية عن بُعد (نسيها كاشيرها مفتوحة) — نفس منطق نوافذ POS/الاستقبال/الطباعة:
  // المتوقع = الافتتاحي + نقد وارد − نقد صادر، ولا يُقبل إغلاقٌ بفرق (نفس حوكمة closeShift الخادمية).
  const closingRow = rows.find((r) => r.id === closingShiftId) ?? null;
  const closeReportQ = trpc.shifts.report.useQuery(
    { shiftId: closingShiftId ?? 0 },
    { enabled: closingShiftId != null },
  );
  const closeExpected = closeReportQ.data ? D(closeReportQ.data.expectedCash) : null;
  const closeDiff = closeExpected != null && closeCounted ? D(closeCounted).minus(closeExpected) : null;
  const closeHasVariance = closeDiff != null && closeDiff.abs().gt("0.005");

  const closeShiftM = trpc.shifts.close.useMutation({
    onSuccess: async () => {
      notify.ok("أُغلقت الوردية");
      setClosingShiftId(null);
      setCloseCounted("");
      await utils.shifts.list.invalidate();
    },
    onError: (e) => notify.errBig(e),
  });

  function openCloseDialog(shiftId: number) {
    setCloseCounted("");
    setClosingShiftId(shiftId);
  }

  async function reprintZ(shiftId: number) {
    setPrinting(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) { notify.err("تعذّر جلب تقرير الوردية"); return; }
      const sh = rep.shift as {
        openingBalance: string; expectedCash: string | null; countedCash: string | null; variance: string | null;
        status: string; openedAt: string | Date; closedAt: string | Date | null;
      };
      const open = sh.status === "OPEN";
      // اسم الكاشير واسم الفرع من صف الوردية المعروض
      const row = rows.find((r) => r.id === shiftId);
      const cashierName = row?.userName ?? `#${shiftId}`;
      const bName = branchName(row?.branchId);

      const payments = (rep.payments ?? []).map((p) => ({
        method:    p.method,
        direction: p.direction as "IN" | "OUT",
        count:     Number(p.count),
        total:     p.total,
      }));

      if (open) {
        // وردية مفتوحة: تقرير مبدئي بالتصميم الجديد (النقد المتوقع = الرصيد الافتتاحي مبدئياً)
        await printShiftClose({
          shiftId,
          openedAt:       sh.openedAt,
          closedAt:       new Date(),
          cashierName,
          branchName:     bName,
          openingBalance: sh.openingBalance,
          invoiceCount:   rep.invoiceCount,
          salesTotal:     rep.salesTotal,
          payments,
          expectedCash:   sh.expectedCash ?? sh.openingBalance,
          countedCash:    sh.countedCash  ?? "0",
          variance:       sh.variance     ?? "0",
        });
      } else {
        // وردية مغلقة: Z-Report نهائي
        await printShiftClose({
          shiftId,
          openedAt:       sh.openedAt,
          closedAt:       sh.closedAt ? new Date(sh.closedAt) : new Date(),
          cashierName,
          branchName:     bName,
          openingBalance: sh.openingBalance,
          invoiceCount:   rep.invoiceCount,
          salesTotal:     rep.salesTotal,
          payments,
          expectedCash:   sh.expectedCash ?? "0",
          countedCash:    sh.countedCash  ?? "0",
          variance:       sh.variance     ?? "0",
        });
      }
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(null);
    }
  }

  // نَسخ مُلَخَّص Z نَصّياً (للَصق في واتساب/مُلاحَظة الإدارة) — يَجلب نَفس تَقرير الطباعة ويُمَرِّرُه إلى formatZReportAsText.
  async function copyZ(shiftId: number) {
    setCopying(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) { notify.err("تعذّر جلب تقرير الوردية"); return; }
      const sh = rep.shift as {
        openingBalance: string; expectedCash: string | null; countedCash: string | null; variance: string | null;
        openedAt: string | Date; closedAt: string | Date | null;
      };
      // النَقد الداخل/الخارج = مَجموع الحَركات النَقدِية (CASH) حَسَب الاتجاه.
      let cashIn = D(0);
      let cashOut = D(0);
      for (const p of rep.payments ?? []) {
        if (p.method !== "CASH") continue;
        if (p.direction === "IN") cashIn = cashIn.plus(D(p.total));
        else if (p.direction === "OUT") cashOut = cashOut.plus(D(p.total));
      }
      const text = formatZReportAsText({
        shiftId,
        opened: sh.openedAt,
        closed: sh.closedAt ?? undefined,
        openingFloat: sh.openingBalance,
        cashIn: cashIn.toFixed(2),
        cashOut: cashOut.toFixed(2),
        expectedCash: sh.expectedCash ?? sh.openingBalance,
        countedCash: sh.countedCash,
        variance: sh.variance,
      });
      await copy(text);
    } catch (e) {
      notify.err(e);
    } finally {
      setCopying(null);
    }
  }

  const activeFilterCount = [branchId, status, shiftType, varianceState, dateFrom, dateTo]
    .filter((value) => value !== "").length;
  const anyFilter = query.trim() !== "" || activeFilterCount > 0;

  function resetFilters() {
    setQuery("");
    setBranchId("");
    setStatus("");
    setShiftType("");
    setVarianceState("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

  function printVisibleShifts() {
    const filterLabels = [
      query.trim() ? `بحث: ${query.trim()}` : null,
      status ? `الحالة: ${STATUS_LABEL[status]}` : null,
      shiftType ? `النوع: ${SHIFT_TYPE_LABEL[shiftType]}` : null,
      varianceState === "WITH_VARIANCE"
        ? "المطابقة: بفرق نقدي"
        : varianceState === "MATCHED"
          ? "المطابقة: مطابقة"
          : varianceState === "UNRECONCILED"
            ? "المطابقة: غير محسوبة"
            : null,
    ].filter(Boolean).join(" · ");

    const opened = printReportDoc({
      title: "سجلّ الورديات",
      headerExtra: [
        { label: "الفرع", value: branchId ? branchName(Number(branchId)) : "كل الفروع" },
        {
          label: "الفترة",
          value: dateFrom || dateTo ? `${dateFrom || "البداية"} — ${dateTo || "اليوم"}` : "كل الفترات",
        },
        { label: "نطاق الطباعة", value: total === 0 ? "لا نتائج" : `${from}–${to} من ${total}` },
        ...(filterLabels ? [{ label: "الفلاتر", value: filterLabels }] : []),
      ],
      note: "تطبع هذه النسخة الصفحة المعروضة المطابقة للفلاتر. استخدم تصدير Excel للحصول على جميع الصفوف المطابقة.",
      columns: [
        { key: "id", label: "#" },
        { key: "employee", label: "الموظف" },
        { key: "type", label: "النوع" },
        { key: "branch", label: "الفرع" },
        { key: "opened", label: "فُتحت" },
        { key: "closed", label: "أُغلقت" },
        { key: "expected", label: "المتوقع", align: "left" },
        { key: "variance", label: "الفرق", align: "left" },
        { key: "status", label: "الحالة" },
      ],
      rows: rows.map((row) => ({
        id: String(row.id),
        employee: row.userName ?? `#${row.userId}`,
        type: SHIFT_TYPE_LABEL[row.shiftType] ?? row.shiftType,
        branch: branchName(row.branchId),
        opened: fmtDT(row.openedAt),
        closed: fmtDT(row.closedAt),
        expected: row.expectedCash != null ? fmt(row.expectedCash) : "—",
        variance: row.variance != null ? fmt(row.variance) : "—",
        status: STATUS_LABEL[row.status] ?? row.status,
      })),
    });
    if (!opened) notify.err("حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  }
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ الورديات"
        description="ورديات الكاشير (فتح/إغلاق الصندوق) مع النقد المتوقّع والمعدود والفرق. أعد طباعة تقرير نهاية الوردية (Z) لأي وردية مغلقة."
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="الورديات"
            count={total}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: (value) => setFilter(setQuery, value),
              placeholder: "اسم الموظف أو رقم الوردية…",
              ariaLabel: "البحث في الورديات باسم الموظف أو رقم الوردية",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetFilters}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={printVisibleShifts}
            printLabel="طباعة القائمة"
            printDisabled={rows.length === 0}
            filters={
              <>
                <FilterField label="الحالة">
                  <select className={selectCls} value={status} onChange={(e) => setFilter(setStatus, e.target.value as "" | "OPEN" | "CLOSED")}>
                    <option value="">الكل</option>
                    <option value="OPEN">مفتوحة</option>
                    <option value="CLOSED">مغلقة</option>
                  </select>
                </FilterField>
                <FilterField label="نوع الوردية">
                  <select
                    className={selectCls}
                    value={shiftType}
                    onChange={(e) => setFilter(setShiftType, e.target.value as "" | "RETAIL" | "RECEPTION" | "PRINT_SERVICES")}
                  >
                    <option value="">الكل</option>
                    <option value="RETAIL">تجزئة</option>
                    <option value="RECEPTION">خدمة العملاء</option>
                    <option value="PRINT_SERVICES">خدمات طباعة</option>
                  </select>
                </FilterField>
                <FilterField label="المطابقة النقدية">
                  <select
                    className={selectCls}
                    value={varianceState}
                    onChange={(e) => setFilter(setVarianceState, e.target.value as "" | "WITH_VARIANCE" | "MATCHED" | "UNRECONCILED")}
                  >
                    <option value="">الكل</option>
                    <option value="WITH_VARIANCE">بفرق نقدي</option>
                    <option value="MATCHED">مطابقة</option>
                    <option value="UNRECONCILED">غير محسوبة</option>
                  </select>
                </FilterField>
                <FilterField label="الفرع">
                  <select className={selectCls} value={branchId} onChange={(e) => setFilter(setBranchId, e.target.value ? Number(e.target.value) : "")}>
                    <option value="">كل الفروع</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="من تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={dateFrom}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFilter(setDateFrom, value);
                      if (value && dateTo && value > dateTo) setDateTo(value);
                    }}
                  />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={dateTo}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFilter(setDateTo, value);
                      if (value && dateFrom && value < dateFrom) setDateFrom(value);
                    }}
                  />
                </FilterField>
              </>
            }
            exportSpec={{
              filename: "سجلّ-الورديات",
              rows,
              // تصدير كل النتائج المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط) — pageSize=200 (سقف الخادم).
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, limit) =>
                    utils.shifts.list
                      .fetch({
                        branchId: branchId ? Number(branchId) : undefined,
                        status: status || undefined,
                        shiftType: shiftType || undefined,
                        varianceState: varianceState || undefined,
                        q: debouncedQuery || undefined,
                        from: dateFrom || undefined,
                        to: dateTo || undefined,
                        limit,
                        offset,
                      })
                      .then((r) => ({ rows: (r.rows ?? []) as Row[], total: r.total })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "id", header: "رقم الوردية" },
                { key: "userName", header: "الموظف", map: (r) => r.userName ?? `#${r.userId}` },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "shiftType", header: "نوع الوردية", map: (r) => SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType },
                { key: "openedAt", header: "فُتحت", map: (r) => fmtDT(r.openedAt) },
                { key: "closedAt", header: "أُغلقت", map: (r) => fmtDT(r.closedAt) },
                { key: "openingBalance", header: "الافتتاحي", map: (r) => Number(r.openingBalance ?? 0) },
                { key: "expectedCash", header: "المتوقع", map: (r) => (r.expectedCash != null ? Number(r.expectedCash) : "") },
                { key: "countedCash", header: "المعدود", map: (r) => (r.countedCash != null ? Number(r.countedCash) : "") },
                { key: "variance", header: "الفرق", map: (r) => (r.variance != null ? Number(r.variance) : "") },
                { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status] ?? r.status },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">#</th>
                <th className="p-2">الموظف</th>
                <th className="p-2">الفرع</th>
                <th className="p-2">النوع</th>
                <th className="p-2">فُتحت</th>
                <th className="p-2">أُغلقت</th>
                <th className="p-2 text-right">الافتتاحي</th>
                <th className="p-2 text-right">المتوقع</th>
                <th className="p-2 text-right">المعدود</th>
                <th className="p-2 text-right">الفرق</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 tabular-nums" dir="ltr">{r.id}</td>
                  <td className="p-2 font-medium">{r.userName ?? `#${r.userId}`}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 whitespace-nowrap text-xs">{SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType}</td>
                  <td className="p-2 text-xs whitespace-nowrap tabular-nums" dir="ltr">{fmtDT(r.openedAt)}</td>
                  <td className="p-2 text-xs whitespace-nowrap tabular-nums" dir="ltr">{fmtDT(r.closedAt)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.openingBalance)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{r.expectedCash != null ? fmt(r.expectedCash) : "—"}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{r.countedCash != null ? fmt(r.countedCash) : "—"}</td>
                  <td className={`p-2 text-right font-semibold tabular-nums ${varianceCls(r.variance)}`} dir="ltr">
                    {r.variance != null ? fmt(r.variance) : "—"}
                  </td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    {/* زر Z-report + نَسخ مُلَخَّص نَصّي (RowActions inline). */}
                    <RowActions
                      mode="inline"
                      actions={[
                        {
                          key: "invoices",
                          kind: "view",
                          label: "الفواتير",
                          icon: Receipt,
                          onSelect: () => setInvoicesShiftId(r.id),
                          gate: { module: "sales", level: "READ" },
                        },
                        {
                          key: "zreport",
                          kind: "print",
                          label: printing === r.id ? "جارٍ…" : "Z-report",
                          icon: Printer,
                          disabled: printing === r.id,
                          disabledReason: "التقرير قيد التحضير",
                          onSelect: () => void reprintZ(r.id),
                          gate: { module: "treasury", level: "READ" },
                        },
                        {
                          key: "copy",
                          kind: "export",
                          label: copying === r.id ? "جارٍ…" : "نسخ",
                          icon: Copy,
                          disabled: copying === r.id,
                          disabledReason: "الملخص قيد التحضير",
                          onSelect: () => void copyZ(r.id),
                          gate: { module: "treasury", level: "READ" },
                        },
                        {
                          key: "close",
                          kind: "reverse",
                          label: "إغلاق",
                          icon: Lock,
                          hidden: r.status !== "OPEN" || !isElevated,
                          onSelect: () => openCloseDialog(r.id),
                          gate: { roles: ["cashier", "manager"], module: "treasury", level: "READ" },
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <TableEmptyRow
                  colSpan={12}
                  message={total === 0 && !anyFilter ? "لا ورديات بعد. تُفتح الورديات من نقطة البيع." : "لا ورديات مطابقة. غيّر الفلتر."}
                />
              )}
              {list.isLoading && (
                <tr><td colSpan={12}><LoadingState /></td></tr>
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground" dir="ltr">
          {total === 0 ? "لا صفوف" : `${from}–${to} / ${total.toLocaleString("ar-IQ-u-nu-latn")}`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>السابق</Button>
          <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>التالي</Button>
        </div>
      </div>

      {/* إغلاق وردية عن بُعد (admin/manager) — لموظّف نسي إغلاق ورديته. نفس حوكمة نوافذ POS/
          الاستقبال/الطباعة تماماً: لا إغلاق بفرق (closeShift الخادمية ترفضه دون استثناء). */}
      <Dialog open={closingShiftId != null} onOpenChange={(open) => { if (!open) { setClosingShiftId(null); setCloseCounted(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>إغلاق وردية #{closingShiftId} — {closingRow?.userName ?? ""}</DialogTitle>
          </DialogHeader>
          {closeReportQ.isLoading ? (
            <LoadingState />
          ) : (
            <>
              {([
                ["عدد الفواتير", `${closeReportQ.data?.invoiceCount ?? 0}`],
                ["إجمالي المبيعات", `${fmt(Number(closeReportQ.data?.salesTotal ?? 0))} د.ع`],
                ["الرصيد الافتتاحي", `${fmt(Number(closeReportQ.data?.shift.openingBalance ?? 0))} د.ع`],
                ...(closeExpected != null ? [["النقد المتوقّع بالصندوق", `${fmt(closeExpected.toNumber())} د.ع`] as [string, string]] : []),
              ] as [string, string][]).map(([l, v]) => (
                <div key={l} className="flex justify-between border-b py-2 text-sm">
                  <span className="text-muted-foreground">{l}</span>
                  <span className="font-bold tabular-nums" dir="ltr">{v}</span>
                </div>
              ))}
              <div className="space-y-1.5">
                <label htmlFor="close-counted-cash" className="block text-sm font-bold">النقد المعدود (د.ع)</label>
                <MoneyInput
                  id="close-counted-cash"
                  value={closeCounted}
                  onChange={setCloseCounted}
                  placeholder="0"
                  ariaLabel="النقد المعدود عند إغلاق الوردية"
                  className="h-11 text-center text-lg font-extrabold"
                />
              </div>
              {closeDiff != null && (
                <div className={`flex items-center gap-1 text-sm font-bold ${varianceCls(closeDiff.toFixed(2))}`}>
                  <span>الفرق: {closeDiff.gte(0) ? "+" : ""}{fmt(closeDiff.toNumber())} د.ع</span>
                  {closeDiff.isZero() && <Check aria-hidden className="size-3.5" />}
                </div>
              )}
              {closeHasVariance && (
                <div className="rounded-xl border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                  لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الافتتاحي مضافاً إليه صافي المبيعات النقدية المسجّلة. راجع الفواتير والمرتجعات لهذه الوردية أولاً.
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingShiftId(null)}>إلغاء</Button>
            <Button
              disabled={!closeCounted || closeShiftM.isPending || closeHasVariance || closeExpected == null}
              onClick={() => closingShiftId != null && closeShiftM.mutate({ shiftId: closingShiftId, countedCash: closeCounted })}
            >
              {closeShiftM.isPending ? "جارٍ الإغلاق…" : "إغلاق"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* فواتير الوردية — قائمة مضمَّنة لتحقيق الفروقات النقدية بلا مغادرة الشاشة (سطراً بسطر). */}
      <Dialog open={invoicesShiftId != null} onOpenChange={(open) => { if (!open) setInvoicesShiftId(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              فواتير وردية #{invoicesShiftId} — {invoicesShiftRow?.userName ?? ""}
            </DialogTitle>
          </DialogHeader>
          {invoicesShiftQ.isLoading ? (
            <LoadingState />
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {invoicesShiftQ.data?.length ?? 0} فاتورة — الإجمالي{" "}
                <b className="tabular-nums" dir="ltr">
                  {fmt((invoicesShiftQ.data ?? []).reduce((s, r) => s.plus(D(r.total)), D(0)).toString())}
                </b>{" "}
                د.ع
              </div>
              <ScrollTableShell bordered maxHeightClass="max-h-[60vh]">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2">رقم الفاتورة</th>
                      <th className="p-2">الوقت</th>
                      <th className="p-2">طريقة الدفع</th>
                      <th className="p-2 text-right">الإجمالي</th>
                      <th className="p-2 text-right">المدفوع</th>
                      <th className="p-2 text-center">الحالة</th>
                      <th className="p-2 text-center">فتح</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoicesShiftQ.data ?? []).map((inv) => (
                      <tr key={inv.id} className="border-t">
                        <td className="p-2 font-medium tabular-nums" dir="ltr">{inv.invoiceNumber}</td>
                        <td className="p-2 text-xs whitespace-nowrap tabular-nums" dir="ltr">{fmtDT(inv.invoiceDate)}</td>
                        <td className="p-2 text-xs">{inv.paymentMethod ? paymentMethodLabel(inv.paymentMethod) : "—"}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(inv.total)}</td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(inv.paidAmount)}</td>
                        <td className="p-2 text-center text-xs">{invoiceStatusLabel(inv.status)}</td>
                        <td className="p-2 text-center">
                          <Link href={`/invoices/${inv.id}`} className="text-primary underline-offset-2 hover:underline">
                            فتح
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {(invoicesShiftQ.data ?? []).length === 0 && (
                      <TableEmptyRow colSpan={7} message="لا فواتير على هذه الوردية." />
                    )}
                  </tbody>
                </table>
              </ScrollTableShell>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoicesShiftId(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
