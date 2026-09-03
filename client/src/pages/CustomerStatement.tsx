import { CopyInline } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatementReconcile } from "@/components/StatementReconcile";
import { buildStatementMessage } from "@/lib/whatsapp";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printCustomerStmt } from "@/lib/printing/printTemplates";
import { D, fmt, positiveDiff } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Search, X as XIcon } from "lucide-react";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";
import { priceTierLabel, sourceTypeLabel } from "@/lib/labels";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { paymentMethodCompact, isUnifiedPaymentMethod } from "@shared/terms";
import { notify } from "@/lib/notify";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { usePrintAudit } from "@/hooks/usePrintAudit";

/** تاريخ محلي YYYY-MM-DD — لا toISOString: بغداد UTC+3 فينزاح اليوم قرب منتصف الليل. */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** اختصارات الفترة: اليوم / هذا الشهر / الشهر الماضي / الكل (فارغة). */
const PERIOD_PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: "اليوم", range: () => ({ from: ymd(new Date()), to: ymd(new Date()) }) },
  {
    label: "هذا الشهر",
    range: () => {
      const n = new Date();
      return { from: ymd(new Date(n.getFullYear(), n.getMonth(), 1)), to: ymd(n) };
    },
  },
  {
    label: "الشهر الماضي",
    range: () => {
      const n = new Date();
      return {
        from: ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
        to: ymd(new Date(n.getFullYear(), n.getMonth(), 0)),
      };
    },
  },
  { label: "الكل", range: () => ({ from: "", to: "" }) },
];

// تعريب حالة الفاتورة من `@shared/invoiceStatus` وحده — كان قاموساً محلّياً بلا `SUPERSEDED`
// يسبق `invoiceStatusLabel` في السلسلة، فيَحجب المصدر المركزيّ ويُخالف مسرده (PENDING).
/** حالة سند القبض/الصرف كما يعيدها كشف الحساب (COMPLETED/REVERSED فقط بعد فلترة الخادم). */
type CustomerStatementData = NonNullable<RouterOutputs["reports"]["customerStatement"]>;
type StmtInvoiceRow = CustomerStatementData["invoices"][number];
type StmtPaymentRow = CustomerStatementData["payments"][number];

/**
 * عمود مبلغ. `accessorFn` يُرجع النصّ المعروض (للنسخ)، و`sortingFn` رقميّ صريح بـDecimal:
 * الفرز الافتراضيّ يقارن نصّاً فيه فواصل آلاف («1,234» قبل «999») فيقلب ترتيب الذمم.
 */
function stmtMoneyCol<T>(
  id: string,
  header: string,
  get: (r: T) => string | number,
  display?: (r: T) => string,
  cls?: string,
): ColumnDef<T, unknown> {
  return {
    id,
    header,
    accessorFn: (r) => (display ? display(r) : fmt(get(r))),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => D(get(a.original)).cmp(D(get(b.original))),
    cell: ({ row }) => <span className={cls}>{display ? display(row.original) : fmt(get(row.original))}</span>,
  };
}

const RECEIPT_STATUS_LABEL: Record<string, string> = {
  COMPLETED: "مكتملة",
  REVERSED: "معكوسة",
};
const STATUS_CLS: Record<string, string> = {
  PENDING: "badge-status-pending",
  PARTIALLY_PAID: "badge-status-pending",
  PAID: "badge-status-active",
  CANCELLED: "badge-stock-out",
  RETURNED: "badge-stock-out",
  CONFIRMED: "bg-muted text-muted-foreground",
};
/**
 * وصلُ برنامج v2 §٦ ق٦ (٤/٩/٢٦): طرقُ الدفع من `shared/terms.ts` مباشرة — كان قاموساً
 * محلّياً بستّة مفاتيح لطريقة الدفع + ثلاثةُ رموزٍ خاصّة بهذه الشاشة (COD/RETURN/OPENING_ADJ).
 * الأخيرةُ تبقى محلّياً لأنّها ليست طرقَ دفعٍ في `receipts.paymentMethod` بل رموزُ سطرٍ في
 * هذا الكشف — لا نظيرَ لها في `terms.ts` بحكم التصميم. حارس `check:vocabulary`.
 */
const STATEMENT_ROW_KIND_LABEL: Record<string, string> = {
  COD: "تحصيل مندوب",
  RETURN: "مرتجع",
  OPENING_ADJ: "تصحيح افتتاحي",
};
function statementMethodLabel(v: string | null | undefined): string {
  if (v && STATEMENT_ROW_KIND_LABEL[v]) return STATEMENT_ROW_KIND_LABEL[v];
  if (isUnifiedPaymentMethod(v)) return paymentMethodCompact(v);
  return v ?? "—";
}

/*
 * §٥ + REP-06: المتبقّي = total − (المدفوع + المُرتجَع) بدقّة Decimal (لا Number float).
 * إغفال returnedTotal كان يُظهر متبقّياً موجباً لفاتورة مُرتجَعة جزئياً سُدِّد صافيها.
 */
const invoiceRemaining = (i: StmtInvoiceRow) =>
  positiveDiff(i.total, D(i.paidAmount).plus(i.returnedTotal).toFixed(2)).toFixed(2);

/** عربونٌ مقبوضٌ على طلب/أمر شغل ما زال له باقٍ مستحق — يُلوَّن صفُّه ويُوسَم. */
const isDepositDue = (i: StmtInvoiceRow) =>
  i.status !== "CANCELLED" &&
  i.status !== "RETURNED" &&
  (i.sourceType === "ORDER" || i.sourceType === "WORKORDER") &&
  D(i.paidAmount).gt(0) &&
  D(invoiceRemaining(i)).gt(0);

const stmtInvoiceColumns: ColumnDef<StmtInvoiceRow, unknown>[] = [
  {
    id: "invoiceNumber",
    header: "الفاتورة",
    accessorFn: (i) => i.invoiceNumber,
    meta: { kind: "code" },
    cell: ({ row }) => <CopyInline value={row.original.invoiceNumber} />,
  },
  {
    id: "invoiceDate",
    header: "التاريخ",
    accessorFn: (i) => fmtDate(i.invoiceDate),
    meta: { kind: "date" },
    cell: ({ row }) => fmtDate(row.original.invoiceDate),
  },
  {
    id: "dueDate",
    header: "الاستحقاق",
    accessorFn: (i) => (i.dueDate ? String(i.dueDate).slice(0, 10) : "—"),
    meta: { kind: "date" },
    cell: ({ row }) => (row.original.dueDate ? String(row.original.dueDate).slice(0, 10) : "—"),
  },
  {
    id: "sourceType",
    header: "المصدر",
    accessorFn: (i) => sourceTypeLabel(i.sourceType),
    cell: ({ row }) => <span className="text-xs">{sourceTypeLabel(row.original.sourceType)}</span>,
  },
  stmtMoneyCol<StmtInvoiceRow>("total", "الإجمالي", (i) => i.total),
  stmtMoneyCol<StmtInvoiceRow>("paidAmount", "المدفوع", (i) => i.paidAmount),
  stmtMoneyCol<StmtInvoiceRow>(
    "returnedTotal",
    "مُرتجَع",
    (i) => i.returnedTotal,
    (i) => (D(i.returnedTotal).isZero() ? "—" : fmt(D(i.returnedTotal).toFixed(2))),
  ),
  stmtMoneyCol<StmtInvoiceRow>("remaining", "المتبقّي", invoiceRemaining, undefined, "font-semibold"),
  {
    id: "status",
    header: "الحالة",
    // القاموس الموحّد `invoiceStatusLabel` — لا تسميةً محلّية (shared/invoiceStatus).
    accessorFn: (i) => invoiceStatusLabel(i.status),
    meta: { kind: "status", wrap: true },
    cell: ({ row }) => (
      <>
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.status] ?? "bg-muted"}`}>
          {invoiceStatusLabel(row.original.status)}
        </span>
        {isDepositDue(row.original) && (
          <span className="mt-1 block w-fit rounded-full px-2 py-0.5 text-[11px] font-bold badge-stock-low">عربون — الباقي مستحق</span>
        )}
      </>
    ),
  },
  {
    id: "createdBy",
    header: "المنفذ",
    accessorFn: (i) => i.createdByName ?? (i.createdBy ? "مستخدم #" + i.createdBy : "غير موثق"),
    meta: { kind: "actor" },
    cell: ({ row }) => (
      <span className="text-xs">{row.original.createdByName ?? (row.original.createdBy ? "مستخدم #" + row.original.createdBy : "غير موثق")}</span>
    ),
  },
  {
    id: "open",
    header: "فتح",
    meta: { kind: "actions" },
    enableSorting: false,
    cell: ({ row }) => (
      <Link href={`/invoices/${row.original.id}`}>
        <Button variant="outline" size="sm">فتح</Button>
      </Link>
    ),
  },
];

const stmtPaymentColumns: ColumnDef<StmtPaymentRow, unknown>[] = [
  {
    id: "createdAt",
    header: "التاريخ",
    accessorFn: (p) => fmtDateTime(p.createdAt),
    meta: { kind: "datetime" },
    cell: ({ row }) => fmtDateTime(row.original.createdAt),
  },
  {
    id: "invoice",
    header: "الفاتورة",
    accessorFn: (p) => (p.isStandalone ? (p.voucherNumber ?? "سند مستقل") : String(p.invoiceId ?? "")),
    meta: { kind: "code" },
    cell: ({ row }) =>
      row.original.isStandalone ? (
        // سند مستقل (بلا فاتورة): كان غائباً عن الكشف فيبدو الرصيد منحرفاً بلا تفسير.
        <span className="inline-flex items-center gap-1" title={row.original.description ?? undefined}>
          <span className="inline-block rounded badge-status-done px-2 py-0.5 text-xs">سند مستقل</span>
          {row.original.voucherNumber && <CopyInline value={row.original.voucherNumber} />}
        </span>
      ) : (
        <CopyInline value={row.original.invoiceId} />
      ),
  },
  {
    id: "direction",
    header: "الاتجاه",
    accessorFn: (p) => (p.direction === "IN" ? "وارد" : "صادر/استرداد"),
    meta: { kind: "status" },
    cell: ({ row }) => (
      <span className={`inline-block rounded px-2 py-0.5 text-xs ${row.original.direction === "IN" ? "badge-status-active" : "badge-stock-out"}`}>
        {row.original.direction === "IN" ? "وارد" : "صادر/استرداد"}
      </span>
    ),
  },
  {
    id: "paymentMethod",
    header: "طريقة الدفع",
    accessorFn: (p) => statementMethodLabel(p.paymentMethod),
    cell: ({ row }) => <span className="text-xs">{statementMethodLabel(row.original.paymentMethod)}</span>,
  },
  stmtMoneyCol<StmtPaymentRow>("amount", "المبلغ", (p) => p.amount),
  {
    // حالة السند (receipts.status): COMPLETED/REVERSED — ليست حالة فاتورة فلا تصلح invoiceStatusLabel.
    id: "status",
    header: "الحالة",
    accessorFn: (p) => RECEIPT_STATUS_LABEL[p.status] ?? p.status,
    meta: { kind: "status" },
    cell: ({ row }) => <span className="text-xs">{RECEIPT_STATUS_LABEL[row.original.status] ?? row.original.status}</span>,
  },
  {
    id: "createdBy",
    header: "المنفذ",
    accessorFn: (p) => p.createdByName ?? (p.createdBy ? "مستخدم #" + p.createdBy : "غير موثق"),
    meta: { kind: "actor" },
    cell: ({ row }) => (
      <span className="text-xs">{row.original.createdByName ?? (row.original.createdBy ? "مستخدم #" + row.original.createdBy : "غير موثق")}</span>
    ),
  },
];

export default function CustomerStatement() {
  // الـURL مصدر الحقيقة لهوية العميل ⇒ رابط مستقلّ قابل للمشاركة + يتحدّث فوراً عند تغيّر ?id=
  // (يُصلح فقدان الاستقلالية: كان يُقرأ مرّة واحدة عند التركيب فلا يتبع تغيّر الرابط داخل الـhub).
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const customerId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);
  // اختيار العميل يكتب المعرّف في الـURL (مع حفظ بقية المعاملات مثل tab) فيبقى الكشف مشاركاً ومستقلاً.
  const selectCustomer = (id: number) => {
    const p = new URLSearchParams(search);
    if (id) p.set("id", String(id)); else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  };
  // فترة الكشف + فلتر الفواتير محفوظان في الرابط (useUrlFilters) — رابطٌ للكشف بفترته المحدَّدة
  // يبقى صالحاً بعد إعادة تحميل الصفحة أو مشاركته، لا يُعاد لـ«الكل» صامتاً. id يبقى بآليته الحالية
  // (useSearch/navigate أعلاه) — لا تعارض: write() في useUrlFilters يقرأ الرابط الحيّ عند كل كتابة.
  const [periodF, setPeriodF] = useUrlFilters({ from: "", to: "", filter: "ALL" });
  const from = periodF.from;
  const to = periodF.to;
  const invoiceFilter = periodF.filter as "ALL" | "DEPOSIT_DUE" | "OUTSTANDING" | "SETTLED";
  const setFrom = (v: string) => setPeriodF({ from: v });
  const setTo = (v: string) => setPeriodF({ to: v });
  const setInvoiceFilter = (v: string) => setPeriodF({ filter: v });

  const index = trpc.reports.customersIndex.useQuery();
  const stmt = trpc.reports.customerStatement.useQuery(
    { customerId: customerId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!customerId }
  );
  /**
   * Tier-3 #6 (٢٧/٨): تفصيلٌ محاسبيٌّ إضافيّ من `journalLines` (يحتاج SHADOW/ACTIVE
   * ليعود بصفوف). في وضع OFF الافتراضيّ الاستعلامُ يُرجع صفوفاً صفراً — الشاشة لا تعرض
   * القسم أصلاً، فلا رأسٌ فارغٌ يُشوّش المستخدم.
   */
  const journal = trpc.reports.customerJournalBreakdown.useQuery(
    { customerId: customerId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!customerId }
  );
  const printAudit = usePrintAudit();
  const shownInvoices = useMemo(() => (stmt.data?.invoices ?? []).filter((i) => {
    const remaining = D(i.total).minus(D(i.paidAmount)).minus(D(i.returnedTotal ?? "0"));
    const active = i.status !== "CANCELLED" && i.status !== "RETURNED";
    if (invoiceFilter === "DEPOSIT_DUE") return active && (i.sourceType === "ORDER" || i.sourceType === "WORKORDER") && D(i.paidAmount).gt(0) && remaining.gt(0);
    if (invoiceFilter === "OUTSTANDING") return active && remaining.gt(0);
    if (invoiceFilter === "SETTLED") return active && remaining.lte(0);
    return true;
  }), [stmt.data?.invoices, invoiceFilter]);

  // دفتر الحركات (مدين/دائن/رصيد جارٍ) — يُبنى مرّة ويُشارَك بين الطباعة وتصدير Excel.
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const invTxs = d.invoices.filter((i) => i.status !== "CANCELLED").map((i) => ({
      t: new Date(i.invoiceDate).getTime(),
      date: fmtDate(i.invoiceDate),
      ref: i.invoiceNumber, description: "فاتورة مبيعات",
      actor: i.createdByName ?? (i.createdBy ? `مستخدم #${i.createdBy}` : "غير موثق"),
      debit: i.total as string | null, credit: null as string | null,
    }));
    const payTxs = d.payments.map((p) => ({
      t: new Date(p.createdAt).getTime(),
      date: fmtDate(p.createdAt),
      ref: p.voucherNumber ?? "دفعة",
      description:
        // ب-١: قيد تصحيح الرصيد الافتتاحيّ يظهر حركةً داخل فترته (isStandalone صحيح لكنه ليس
        // سنداً) — بلا هذا الفرع يُعرَض «سند صرف مستقل» فيبحث المحاسب عن سندٍ لا وجود له.
        p.paymentMethod === "OPENING_ADJ"
        ? "تصحيح رصيد افتتاحي"
        : p.isStandalone
        ? (p.direction === "IN" ? "سند قبض مستقل" : "سند صرف مستقل")
        : (p.direction === "IN" ? "دفعة وارد" : "استرداد"),
      actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
      // الاتجاه المحاسبي: IN ينقص ذمة العميل (دائن)، OUT (استرداد/صرف له) يزيدها (مدين).
      debit: p.direction === "OUT" ? (p.amount as string | null) : null,
      credit: p.direction === "IN" ? (p.amount as string | null) : null,
    }));
    // الفرز على طابع زمني خام — فرز نصّي على dd/mm/yyyy يخلط الشهور.
    const merged = [...invTxs, ...payTxs].sort((a, b) => a.t - b.t);
    // §٥: الرصيد الجاري بـDecimal، يبدأ من الرصيد المُرحَّل عند تقييد الفترة.
    let bal = from ? D(d.summary.openingBalance) : D(0);
    let totDebit = D(0), totCredit = D(0);
    const txs = merged.map(({ t: _t, ...x }) => {
      bal = bal.plus(D(x.debit)).minus(D(x.credit));
      totDebit = totDebit.plus(D(x.debit));
      totCredit = totCredit.plus(D(x.credit));
      return { ...x, balance: bal.toFixed(2) };
    });
    return { txs, totDebit: totDebit.toFixed(2), totCredit: totCredit.toFixed(2), closingBalance: bal.toFixed(2) };
  }, [stmt.data, from]);

  // حُمولة نَسخ الكَشف بِثَلاث صِيَغ (نَصّ مُلَخَّص / واتساب مُفَصَّل / TSV لِلَصق في Excel).
  // تُبنى مَرّة واحِدة على دَفتَر الحَرَكات المُجمَّع لِضَمان اتِّساق المَجاميع مَع الطِباعة والتَصدير.
  const copyPayload = useMemo(() => {
    if (!stmt.data || !ledger) return { plain: "", whatsapp: "", tsv: "" };
    const d = stmt.data;
    const plain = buildStatementMessage({
      entityName: d.customer.name,
      entityType: "customer",
      currentBalance: d.summary.currentBalance,
      totalSales: d.summary.totalSales,
      totalPaid: d.summary.totalPaid,
      unpaid: d.summary.unpaid,
    });
    const whatsapp = formatStatementAsWhatsApp({
      entityName: d.customer.name,
      entityType: "customer",
      lines: ledger.txs.map((r) => ({
        date: r.date,
        doc: `${r.ref} — ${r.description}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: from ? ledger.closingBalance : d.summary.currentBalance,
      asOfDate: to || undefined,
    });
    const tsv = formatTableAsTSV(
      ["التاريخ", "المرجع", "البيان", "المنفذ", "مدين", "دائن", "الرصيد"],
      ledger.txs.map((r) => ({
        "التاريخ": r.date,
        "المرجع": r.ref,
        "البيان": r.description,
        "المنفذ": r.actor,
        "مدين": r.debit == null ? "" : r.debit,
        "دائن": r.credit == null ? "" : r.credit,
        "الرصيد": r.balance,
      })),
    );
    return { plain, whatsapp, tsv };
  }, [stmt.data, ledger, from, to]);

  // يفتح نافذة الطباعة (المتصفّح: «حفظ كـ PDF») اعتماداً على دفتر الحركات المُجمَّع.
  const printStatement = async () => {
    if (!stmt.data || !ledger) return;
    if (!reservePrintWindow()) return notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
    const d = stmt.data;
    const { txs, totDebit, totCredit, closingBalance } = ledger;
    try {
      await printAudit.run({
        documentType: "CUSTOMER_STATEMENT",
        documentId: Number(d.customer.id),
        channel: "PDF",
        open: (audit) => printCustomerStmt({
          customerName: d.customer.name, customerPhone: d.customer.phone ?? undefined,
          fromDate: from ? fmtDate(new Date(`${from}T00:00:00`)) : undefined,
          toDate: fmtDate(to ? new Date(`${to}T00:00:00`) : new Date()),
          transactions: txs,
          totalDebit: totDebit, totalCredit: totCredit,
          openingBalance: from ? d.summary.openingBalance : undefined,
          currentBalance: d.summary.currentBalance,
          closingBalance: from ? closingBalance : d.summary.currentBalance,
          printedByName: audit.actorName,
          printRequestedAt: fmtDateTime(audit.requestedAt),
        }),
      });
    } catch (error) {
      releaseReservedPrintWindow();
      notify.err(error instanceof Error ? error.message : "تعذّر تسجيل طلب الطباعة");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "العملاء", href: "/customers" }, { label: "كشف حساب" }]}
        title="كشف حساب عميل"
        description="كل الفواتير والدفعات لعميل واحد، مع ملخّص الرصيد الحالي."
        actions={
          <>
            {stmt.data && (
              <Button variant="outline" size="sm" disabled={printAudit.pending} onClick={() => void printStatement()}>طباعة / PDF الكشف</Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.txs.length}
                onClick={() =>
                  exportRows(ledger?.txs ?? [], {
                    filename: `كشف-حساب-${stmt.data!.customer.name}`,
                    columns: [
                      { key: "date", header: "التاريخ" },
                      { key: "ref", header: "المرجع" },
                      { key: "description", header: "البيان" },
                      { key: "actor", header: "المنفذ" },
                      { key: "debit", header: "مدين", map: (r) => (r.debit == null ? 0 : Number(r.debit)) },
                      { key: "credit", header: "دائن", map: (r) => (r.credit == null ? 0 : Number(r.credit)) },
                      { key: "balance", header: "الرصيد", map: (r) => Number(r.balance) },
                    ],
                  })
                }
              >
                تصدير Excel
              </Button>
            )}
            {stmt.data && (
              <CopyAsMenu
                plain={copyPayload.plain}
                whatsapp={copyPayload.whatsapp}
                tsv={copyPayload.tsv}
                label="نسخ الكشف"
              />
            )}
            {stmt.data && (
              <WhatsAppShare
                phone={stmt.data.customer.phone}
                message={buildStatementMessage({
                  entityName: stmt.data.customer.name,
                  entityType: "customer",
                  currentBalance: stmt.data.summary.currentBalance,
                  totalSales: stmt.data.summary.totalSales,
                  totalPaid: stmt.data.summary.totalPaid,
                  unpaid: stmt.data.summary.unpaid,
                })}
                label="إرسال كشف الحساب"
              />
            )}
            <Link href="/ar-aging"><Button variant="outline">أعمار الذمم</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">العميل</Label>
            <CustomerSearchPicker
              customers={index.data ?? []}
              value={customerId}
              onChange={selectCustomer}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="md:col-span-4 flex flex-wrap gap-2">
            {PERIOD_PRESETS.map((p) => (
              <Button key={p.label} variant="secondary" size="sm" onClick={() => { const r = p.range(); setFrom(r.from); setTo(r.to); }}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {!customerId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر عميلاً لعرض كشف الحساب.</p>
      )}

      {customerId > 0 && stmt.isLoading && <LoadingState />}

      {customerId > 0 && stmt.isError && (
        <ErrorState message={stmt.error?.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.customer.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.customer.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.customer.customerType} · فئة سعرية {priceTierLabel(stmt.data.customer.defaultPriceTier)}
                    {stmt.data.customer.creditLimit && Number(stmt.data.customer.creditLimit) > 0
                      ? ` · سقف ائتمان ${fmt(stmt.data.customer.creditLimit)}`
                      : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                  <Stat label="إجمالي المبيعات" value={stmt.data.summary.totalSales} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مدفوع" value={stmt.data.summary.unpaid} emphasis />
                  {/* عقد import-integration §٦: رصيد غير مفوتر = الرصيد الجاري − غير المدفوع (Decimal لا parseFloat) — يشمل الافتتاحي المستورد. */}
                  <Stat
                    label="رصيد غير مفوتر — يشمل الافتتاحي المستورد"
                    value={D(stmt.data.summary.currentBalance).minus(D(stmt.data.summary.unpaid)).toFixed(2)}
                  />
                  <StatBalance label="الرصيد الحالي" value={stmt.data.summary.currentBalance} />
                </div>
                {/* ش٤ (I11): سطر إفصاح العرابين المحتجزة — مالٌ مقبوضٌ بإيصالٍ لم يُطبَّق على فاتورةٍ
                    ولا يمسّ الرصيد الجاري؛ بدونه يسأل العميل «أين عربوني؟» والكشف صامت. */}
                {Number(stmt.data.summary.heldDepositsTotal ?? 0) > 0 && (
                  <div className="mt-2 rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-3 py-2 text-xs font-bold text-[var(--sem-info)]">
                    عربون قيد الاحتجاز — غير مُطبَّق على فاتورة: {fmt(stmt.data.summary.heldDepositsTotal)} د.ع
                    <span className="ms-2 font-semibold text-muted-foreground">(يُخصَم من الطلب عند تثبيته أو يُستردّ بسنده)</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.customer.name}
            entityType="customer"
            phone={stmt.data.customer.phone}
            currentBalance={stmt.data.summary.currentBalance}
            onPdf={printStatement}
          />

          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-3">
                <span className="text-sm font-medium">الفواتير</span>
                <AppSelect className="h-8 px-2 text-xs" value={invoiceFilter} onValueChange={(value) => setInvoiceFilter(value as typeof invoiceFilter)}>
                  <option value="ALL">كل الفواتير</option>
                  <option value="DEPOSIT_DUE">عربون — متبقّي للتحصيل</option>
                  <option value="OUTSTANDING">عليها مبلغ متبقٍ</option>
                  <option value="SETTLED">مسوّاة بالكامل</option>
                </AppSelect>
              </div>
              {/* الرصيد المُرحَّل = افتتاحي مستورد + كل النشاط قبل from — يبقى فوق الجدول
                  (لا صفّاً داخله) كي يبقى الجدولُ صفوفاً متجانسة، ويظلّ رصيدُ نهاية الفترة
                  قابلاً للتتبّع. */}
              {from && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-[var(--sem-warn-bg)]/60 px-3 py-2 text-xs font-medium">
                  <span>
                    رصيد مُرحَّل حتى <span className="tabular-nums" dir="ltr">{from}</span>
                    <span className="ms-2 font-normal text-muted-foreground">ما قبل الفترة (افتتاحي + نشاط سابق)</span>
                  </span>
                  <span className="tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.openingBalance)}</span>
                </div>
              )}
              <DataTable<StmtInvoiceRow>
                columns={stmtInvoiceColumns}
                data={shownInvoices}
                /* الفلترة بمنتقي «كل الفواتير/…» أعلاه (يغذّي shownInvoices). */
                searchable={false}
                externalFiltersActive={invoiceFilter !== "ALL"}
                /* `!bg-…` ضرورةٌ لا زينة: `DataTable` يلوّن الصفوف بـ`odd:`/`even:`
                   وتخصّصُهما (0,2,0) يتجاوز صنفَ خلفيةٍ عادياً (0,1,0) ⇒ بلا `!` يبقى
                   وسمُ «عربون — الباقي مستحق» ظلَّ حدٍّ جانبيّ بلا خلفية. */
                getRowClassName={(i) => (isDepositDue(i) ? "!bg-[var(--sem-warn-bg)] shadow-[inset_-3px_0_0_var(--sem-warn)]" : undefined)}
                emptyText="لا فواتير مطابقة لهذا الفلتر."
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {/* stmt.data.payments مُقيَّدة بالفترة (from/to) خادمياً فعلاً — getCustomerStatement
                  (server/services/reports/arAging.ts) يُطبِّق نفس شرط from/to على الإيصالات
                  والتحصيلات المندوبيّة (COD) ومرتجعات البيع (RETURN) الثلاثة، لا الفواتير وحدها.
                  تحقّقٌ صريح (لا تُطبَّق فلترة عميل إضافية هنا كي لا نُكرّر منطقاً صحيحاً أصلاً). */}
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات والاستردادات</div>
              <DataTable<StmtPaymentRow>
                columns={stmtPaymentColumns}
                data={stmt.data.payments}
                searchable={false}
                emptyText="لا دفعات."
              />
            </CardContent>
          </Card>

          {/*
            Tier-3 #6 (٢٧/٨): تفصيلٌ محاسبيٌّ للحركات من journalLines — حسابٌ بحساب،
            بمدين وائتمان وصافٍ. يظهر فقط في وضع SHADOW/ACTIVE (وضع OFF ⇒ الجدول فارغ
            ⇒ القسم يبقى مطويّاً). يستهلك أبعاد Tier-3 #2 (customerId + accountId).
          */}
          {(journal.data?.rows.length ?? 0) > 0 && (
            <Card>
              <CardContent className="p-0">
                <div className="p-3 border-b bg-muted/30 text-sm font-medium">
                  التفصيل المحاسبيّ (الدفتر المزدوج) — {journal.data?.rows.length} حسابٌ
                </div>
                <ScrollTableShell bordered={false}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-start">الكود</TableHead>
                        <TableHead className="text-start">الحساب</TableHead>
                        <TableHead className="text-start">النوع</TableHead>
                        <TableHead className="text-right">مدين</TableHead>
                        <TableHead className="text-right">دائن</TableHead>
                        <TableHead className="text-right">الصافي</TableHead>
                        <TableHead className="text-center">أسطر</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {journal.data?.rows.map((r) => (
                        <TableRow key={r.accountId}>
                          <TableCell className="font-mono text-xs" dir="ltr">{r.code}</TableCell>
                          <TableCell>{r.name}</TableCell>
                          <TableCell className="text-xs">{r.type}</TableCell>
                          <TableCell className="text-right tabular-nums" dir="ltr">{fmt(r.debitTotal)}</TableCell>
                          <TableCell className="text-right tabular-nums" dir="ltr">{fmt(r.creditTotal)}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold" dir="ltr">{fmt(r.net)}</TableCell>
                          <TableCell className="text-center tabular-nums">{r.lineCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollTableShell>
                <div className="p-3 border-t bg-muted/30 text-xs text-muted-foreground flex justify-between">
                  <span>مجموع المدين: <b dir="ltr">{fmt(journal.data?.totalDebit ?? "0")}</b></span>
                  <span>مجموع الدائن: <b dir="ltr">{fmt(journal.data?.totalCredit ?? "0")}</b></span>
                  <span>الصافي: <b dir="ltr">{fmt(journal.data?.totalNet ?? "0")}</b></span>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string | number; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-2 ${emphasis ? "bg-primary/5" : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-base font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}

function StatBalance({ label, value }: { label: string; value: string | number }) {
  const num = Number(value);
  return (
    <div className={`rounded-md p-2 ${num > 0 ? "badge-status-active" : num < 0 ? "badge-stock-out" : "bg-muted/40"}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${num > 0 ? "text-money-positive" : num < 0 ? "text-money-negative" : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${num > 0 ? "text-money-positive" : num < 0 ? "text-money-negative" : "text-muted-foreground"}`}>
        {num > 0 ? "لنا عليه" : num < 0 ? "له علينا" : "لا ذمم"}
      </div>
    </div>
  );
}

/** منتقي عميل قابل للبحث بالكتابة (اسم/هاتف) — يَستبدل native select الذي لا يَدعم filter حيّاً مع 300+ عميل. */
function CustomerSearchPicker({
  customers,
  value,
  onChange,
}: {
  customers: { id: number; name: string; phone?: string | null }[];
  value: number;
  onChange: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => customers.find((c) => c.id === value) ?? null, [customers, value]);

  // النص المعروض في الحقل: اسم العميل المختار حين الإغلاق، أو نص البحث حين الفتح.
  const display = open ? q : selected ? `${selected.name}${selected.phone ? ` · ${selected.phone}` : ""}` : "";

  const filtered = useMemo(() => {
    const needle = q.trim();
    if (!needle) return customers.slice(0, 50);
    const lower = needle.toLowerCase();
    return customers
      .filter((c) => c.name.toLowerCase().includes(lower) || (c.phone ?? "").toLowerCase().includes(lower))
      .slice(0, 50);
  }, [customers, q]);

  useEffect(() => { setHighlight(0); }, [q, open]);

  // إغلاق عند النقر خارج المركّب.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(id: number) {
    onChange(id);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && filtered[highlight]) { e.preventDefault(); pick(filtered[highlight].id); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Search aria-hidden className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={display}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="ابحث بالاسم أو الهاتف…"
          className="pr-9 pl-9"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
        {(selected || q) && (
          <button
            type="button"
            onClick={() => { onChange(0); setQ(""); inputRef.current?.focus(); }}
            aria-label="مسح"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">لا نتائج لـ«{q}»</div>
          ) : (
            filtered.map((c, i) => (
              <button
                type="button"
                key={c.id}
                role="option"
                aria-selected={c.id === value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(c.id)}
                className={`w-full text-right px-3 py-2 text-sm hover:bg-accent ${i === highlight ? "bg-accent" : ""} ${c.id === value ? "font-bold" : ""}`}
              >
                <div>{c.name}</div>
                {c.phone && <div className="text-xs text-muted-foreground" dir="ltr">{c.phone}</div>}
              </button>
            ))
          )}
          {customers.length > filtered.length && q.trim() === "" && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30 text-center">
              يَعرض ٥٠ من أصل {customers.length} — اكتب للبحث
            </div>
          )}
        </div>
      )}
    </div>
  );
}
