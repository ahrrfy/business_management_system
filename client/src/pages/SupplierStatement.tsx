import { CopyInline } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { StatementReconcile } from "@/components/StatementReconcile";
import { buildStatementMessage } from "@/lib/whatsapp";
import { printSupplierStmt } from "@/lib/printing/printTemplates";
import { exportRows } from "@/lib/export";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { D, fmt, positiveDiff } from "@/lib/money";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { selectClsFull } from "@/lib/ui/formStyles";


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

/** صفوف كشف حساب المورّد — مشتقّةٌ من عقد `reports.supplierStatement` فلا تنجرف عن الخادم.
 *  ⚠️ `NonNullable` إلزاميّ: الراوتر يُرجع `res && {…}` و`getSupplierStatement` تُرجع `null`
 *  حين لا مورّد/لا قاعدة ⇒ نوع المخرَج اتحادٌ مع `null`، والفهرسةُ عليه مباشرةً خطأ ترجمة. */
type SupplierStatementData = NonNullable<RouterOutputs["reports"]["supplierStatement"]>;
type PoRow = SupplierStatementData["purchaseOrders"][number];
type PaymentRow = SupplierStatementData["payments"][number];

const PO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};
const PO_STATUS_CLS: Record<string, string> = {
  DRAFT: "badge-status-cancelled",
  SENT: "badge-status-pending",
  CONFIRMED: "badge-stock-low",
  RECEIVED: "badge-status-active",
  CANCELLED: "badge-stock-out",
};

/** أعمدة أوامر الشراء في كشف الحساب — بلا حالة مكوّن، فهي ثابتة على مستوى الوحدة. */
const poColumns: ColumnDef<PoRow, unknown>[] = [
  {
    id: "poNumber",
    header: "السند / المرجع",
    accessorFn: (p) => p.poNumber,
    meta: { kind: "code" },
    cell: ({ row }) => <CopyInline value={row.original.poNumber} />,
  },
  {
    id: "orderDate",
    header: "التاريخ",
    accessorFn: (p) => fmtDate(p.orderDate),
    meta: { kind: "date" },
    cell: ({ row }) => <span className="text-xs">{fmtDate(row.original.orderDate)}</span>,
  },
  {
    id: "dueDate",
    header: "الاستحقاق",
    accessorFn: (p) => (p.expectedDeliveryDate ? String(p.expectedDeliveryDate).slice(0, 10) : "—"),
    meta: { kind: "date" },
    cell: ({ row }) => (
      <span className="text-xs">{row.original.expectedDeliveryDate ? String(row.original.expectedDeliveryDate).slice(0, 10) : "—"}</span>
    ),
  },
  { id: "total", header: "الإجمالي", accessorFn: (p) => fmt(p.total), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.total) },
  { id: "paid", header: "المدفوع", accessorFn: (p) => fmt(p.paidAmount), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.paidAmount) },
  {
    id: "remaining",
    header: "المتبقّي",
    // §٥: نستعمل Decimal للطرح (positiveDiff) لا Number() float.
    accessorFn: (p) => fmt(positiveDiff(p.total, p.paidAmount).toFixed(2)),
    meta: { kind: "money" },
    cell: ({ row }) => <span className="font-semibold">{fmt(positiveDiff(row.original.total, row.original.paidAmount).toFixed(2))}</span>,
  },
  {
    id: "status",
    header: "الحالة",
    accessorFn: (p) => PO_STATUS_LABEL[p.status] ?? p.status,
    meta: { kind: "status" },
    cell: ({ row }) => (
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${PO_STATUS_CLS[row.original.status] ?? "bg-muted"}`}>
        {PO_STATUS_LABEL[row.original.status] ?? row.original.status}
      </span>
    ),
  },
  {
    id: "createdBy",
    header: "المنفذ",
    accessorFn: (p) => p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
    meta: { kind: "actor" },
    cell: ({ row }) => (
      <span className="text-xs">{row.original.createdByName ?? (row.original.createdBy ? `مستخدم #${row.original.createdBy}` : "غير موثق")}</span>
    ),
  },
  {
    id: "open",
    header: "فتح",
    enableSorting: false,
    meta: { kind: "actions" },
    cell: ({ row }) => (
      <Link href={`/purchases/${row.original.id}/receive`}>
        <Button variant="outline" size="sm">فتح</Button>
      </Link>
    ),
  },
];

/** أعمدة الدفعات المسجّلة في كشف الحساب. */
const paymentColumns: ColumnDef<PaymentRow, unknown>[] = [
  {
    id: "entryDate",
    header: "التاريخ",
    accessorFn: (p) => fmtDate(p.entryDate),
    meta: { kind: "date" },
    cell: ({ row }) => <span className="text-xs">{fmtDate(row.original.entryDate)}</span>,
  },
  {
    id: "reference",
    header: "أمر الشراء",
    accessorFn: (p) => p.voucherNumber ?? (p.purchaseOrderId ? String(p.purchaseOrderId) : "دفعة مستقلة"),
    meta: { kind: "code" },
    cell: ({ row }) => {
      const p = row.original;
      if (p.voucherNumber) {
        return (
          <div>
            <CopyInline value={p.voucherNumber} />
            {p.paymentMethod === "EXCHANGE" && (
              <div className="text-[10px] text-muted-foreground">
                صيرفة{p.exchangeHouseName ? `: ${p.exchangeHouseName}` : ""}
                {p.referenceNumber ? ` · ${p.referenceNumber}` : ""}
              </div>
            )}
          </div>
        );
      }
      if (p.purchaseOrderId) return <CopyInline value={p.purchaseOrderId} />;
      // دفعة بلا أمر شراء (سند صرف مستقل للمورد) — وسمها يمنع الالتباس.
      return <span className="inline-block rounded badge-status-done px-2 py-0.5 text-xs">دفعة مستقلة</span>;
    },
  },
  { id: "amount", header: "المبلغ", accessorFn: (p) => fmt(p.amount), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.amount) },
  {
    id: "notes",
    header: "ملاحظات",
    accessorFn: (p) => p.notes ?? "—",
    meta: { width: "wide", wrap: true },
    cell: ({ row }) => <span className="text-xs">{row.original.notes ?? "—"}</span>,
  },
  {
    id: "createdBy",
    header: "المنفذ",
    accessorFn: (p) => p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
    meta: { kind: "actor" },
    cell: ({ row }) => (
      <span className="text-xs">{row.original.createdByName ?? (row.original.createdBy ? `مستخدم #${row.original.createdBy}` : "غير موثق")}</span>
    ),
  },
];

export default function SupplierStatement() {
  // الـURL مصدر الحقيقة لهوية المورد ⇒ رابط مستقلّ قابل للمشاركة + يتحدّث فوراً عند تغيّر ?id=
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const supplierId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);
  // اختيار المورد يكتب المعرّف في الـURL (مع حفظ بقية المعاملات مثل tab) فيبقى الكشف مشاركاً ومستقلاً.
  const selectSupplier = (id: number) => {
    const p = new URLSearchParams(search);
    if (id) p.set("id", String(id)); else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  };
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const index = trpc.reports.suppliersIndex.useQuery();
  const stmt = trpc.reports.supplierStatement.useQuery(
    { supplierId: supplierId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!supplierId }
  );
  const printAudit = usePrintAudit();

  // يبني دفتر الحركات (مدين/دائن/رصيد جارٍ) — يُشارَك بين الطباعة وتصدير Excel.
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const poTxs = d.purchaseOrders.map((p) => ({
      t: new Date(p.orderDate).getTime(),
      date: fmtDate(p.orderDate),
      ref: p.poNumber, description: "أمر شراء",
      actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
      debit: null as string | null, credit: p.total as string | null,
    }));
    // F7 (تدقيق ٢/٧): إشارة الأثر على AP لكل نوع قيد (مطابقة reconcileSupplierBalances):
    //  PAYMENT_OUT/EXCHANGE_SETTLE ⇒ يخفض AP (−amount) = مدين؛ PAYMENT_IN/PURCHASE (يتيم) ⇒ يزيد (+amount) = دائن؛
    //  RETURN ⇒ amount مخزَّن سالباً فأثره يخفض AP = مدين. كان الكود السابق يضع كل الدفعات مديناً بلا نظر للنوع
    //  ⇒ مرتجع الشراء/الاسترداد/الشراء اليتيم بإشارة معكوسة والرصيد الجاري لا يتّزن مع currentBalance.
    const payTxs = d.payments.map((p) => {
      const amt = D(p.amount);
      const reducesAP = p.entryType === "PAYMENT_OUT" || p.entryType === "EXCHANGE_SETTLE";
      // signed = أثر AP الموقَّع (موجب=يزيد، سالب=يخفض). RETURN وحده amount سالب أصلاً ⇒ نستعمله كما هو.
      const signed = p.entryType === "RETURN" ? amt : (reducesAP ? amt.neg() : amt);
      const description =
        p.entryType === "RETURN" ? "مرتجع شراء"
        : p.entryType === "PAYMENT_IN" ? "استرداد من المورد"
        : p.entryType === "EXCHANGE_SETTLE" ? "تسوية عبر صيرفة"
        : p.entryType === "PURCHASE" ? "شراء (بلا أمر)"
        // ب-١: تصحيح الرصيد الافتتاحيّ صار قيد فرقٍ مؤرَّخاً يظهر حركةً داخل فترته (إشارته
        // كما هي: موجب يزيد ما علينا). بلا هذا السطر يُعرَض باسم «دفعة مستقلة للمورد».
        : p.entryType === "OPENING" ? "تصحيح رصيد افتتاحي"
        : (p.purchaseOrderId ? "دفعة للمورد" : "دفعة مستقلة للمورد");
      return {
        t: new Date(p.entryDate).getTime(),
        date: fmtDate(p.entryDate),
        ref: "دفعة",
        description,
        actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
        debit: signed.isNegative() ? signed.neg().toFixed(2) : (null as string | null),
        credit: signed.isPositive() ? signed.toFixed(2) : (null as string | null),
      };
    });
    // الفرز على طابع زمني خام — فرز نصّي على dd/mm/yyyy يخلط الشهور.
    const merged = [...poTxs, ...payTxs].sort((a, b) => a.t - b.t);
    // §٥: AP بـDecimal (دائن − مدين)، يبدأ من الرصيد المُرحَّل عند تقييد الفترة.
    let bal = from ? D(d.summary.openingBalance) : D(0);
    let totDebit = D(0), totCredit = D(0);
    const rows = merged.map(({ t: _t, ...x }) => {
      bal = bal.plus(D(x.credit)).minus(D(x.debit));
      totDebit = totDebit.plus(D(x.debit));
      totCredit = totCredit.plus(D(x.credit));
      return { ...x, balance: bal.toFixed(2) };
    });
    return {
      rows,
      totalDebit: totDebit.toFixed(2),
      totalCredit: totCredit.toFixed(2),
      // مع فترة: الختامي = المُرحَّل + حركة الفترة؛ بلا فترة: الرصيد الجاري (السلوك القديم).
      closingBalance: from ? bal.toFixed(2) : d.summary.currentBalance,
    };
  }, [stmt.data, from]);

  // حُمولة نَسخ الكَشف بِثَلاث صِيَغ (نَصّ مُلَخَّص / واتساب مُفَصَّل / TSV لِلَصق في Excel).
  // تُبنى مَرّة واحِدة على دَفتَر الحَرَكات المُجمَّع لِضَمان اتِّساق المَجاميع مَع الطِباعة والتَصدير.
  const copyPayload = useMemo(() => {
    if (!stmt.data || !ledger) return { plain: "", whatsapp: "", tsv: "" };
    const d = stmt.data;
    const plain = buildStatementMessage({
      entityName: d.supplier.name,
      entityType: "supplier",
      currentBalance: d.summary.currentBalance,
      totalSales: d.summary.totalPurchases,
      totalPaid: d.summary.totalPaid,
      unpaid: d.summary.unpaid,
    });
    const whatsapp = formatStatementAsWhatsApp({
      entityName: d.supplier.name,
      entityType: "supplier",
      lines: ledger.rows.map((r) => ({
        date: r.date,
        doc: `${r.ref} — ${r.description}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: ledger.closingBalance,
      asOfDate: to || undefined,
    });
    const tsv = formatTableAsTSV(
      ["التاريخ", "المرجع", "البيان", "المنفذ", "مدين", "دائن", "الرصيد"],
      ledger.rows.map((r) => ({
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
  }, [stmt.data, ledger, to]);

  // يفتح نافذة الطباعة (المتصفّح: «حفظ كـ PDF»).
  const printStatement = async () => {
    if (!stmt.data || !ledger) return;
    if (!reservePrintWindow()) return notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
    const d = stmt.data;
    try {
      await printAudit.run({
        documentType: "SUPPLIER_STATEMENT",
        documentId: Number(d.supplier.id),
        channel: "PDF",
        open: (audit) => printSupplierStmt({
          supplierName: d.supplier.name, supplierPhone: d.supplier.phone ?? undefined,
          fromDate: from ? fmtDate(new Date(`${from}T00:00:00`)) : undefined,
          toDate: fmtDate(to ? new Date(`${to}T00:00:00`) : new Date()),
          transactions: ledger.rows,
          totalDebit: ledger.totalDebit, totalCredit: ledger.totalCredit,
          openingBalance: from ? d.summary.openingBalance : undefined,
          currentBalance: d.summary.currentBalance,
          closingBalance: ledger.closingBalance,
          printedByName: audit.actorName,
          printRequestedAt: fmtDateTime(audit.requestedAt),
        }),
      });
    } catch (error) {
      releaseReservedPrintWindow();
      notify.err(error instanceof Error ? error.message : "تعذّر تسجيل طلب الطباعة");
    }
  };

  // يصدّر دفتر الحركات نفسه (تاريخ/مرجع/بيان/مدين/دائن/رصيد) إلى Excel.
  const exportStatement = () => {
    if (!stmt.data || !ledger) return;
    exportRows(ledger.rows, {
      filename: `كشف-حساب-مورد-${stmt.data.supplier.name}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "ref", header: "المرجع" },
        { key: "description", header: "البيان" },
        { key: "actor", header: "المنفذ" },
        { key: "debit", header: "مدين", map: (r) => (r.debit == null ? null : Number(r.debit)) },
        { key: "credit", header: "دائن", map: (r) => (r.credit == null ? null : Number(r.credit)) },
        { key: "balance", header: "الرصيد", map: (r) => Number(r.balance) },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[{ label: "الموردون", href: "/suppliers" }, { label: "كشف حساب" }]}
        title="كشف حساب مورد"
        description="كل أوامر الشراء والدفعات لمورد واحد، مع ملخّص الرصيد الحالي."
        actions={
          <>
            {stmt.data && (
              <Button variant="outline" size="sm" disabled={printAudit.pending} onClick={() => void printStatement()}>طباعة / PDF الكشف</Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.rows.length}
                onClick={exportStatement}
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
                phone={stmt.data.supplier.phone}
                message={buildStatementMessage({
                  entityName: stmt.data.supplier.name,
                  entityType: "supplier",
                  currentBalance: stmt.data.summary.currentBalance,
                  totalSales: stmt.data.summary.totalPurchases,
                  totalPaid: stmt.data.summary.totalPaid,
                  unpaid: stmt.data.summary.unpaid,
                })}
                label="إرسال كشف الحساب"
              />
            )}
            <Link href="/ap-aging"><Button variant="outline">أعمار الذمم الدائنة</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">المورد</Label>
            <AppSelect className="h-9" value={String(supplierId)} onValueChange={(value) => selectSupplier(Number(value))}>
              <option value={0}>— اختر مورداً —</option>
              {(index.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.phone ? `· ${s.phone}` : ""}
                </option>
              ))}
            </AppSelect>
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

      {!supplierId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر مورداً لعرض كشف الحساب.</p>
      )}

      {supplierId > 0 && stmt.isLoading && <LoadingState />}

      {supplierId > 0 && stmt.isError && (
        <ErrorState message={stmt.error.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.supplier.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.supplier.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.supplier.city ?? "—"}
                    {stmt.data.supplier.paymentTerms ? ` · شروط الدفع: ${stmt.data.supplier.paymentTerms}` : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
                  <Stat label="إجمالي المشتريات" value={stmt.data.summary.totalPurchases} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مدفوع" value={stmt.data.summary.unpaid} emphasis />
                  {/* عقد import-integration §٦: رصيد غير مفوتر = الرصيد الجاري − غير المدفوع (Decimal لا parseFloat) — يشمل الافتتاحي المستورد. */}
                  <Stat
                    label="رصيد غير مفوتر — يشمل الافتتاحي المستورد"
                    value={D(stmt.data.summary.currentBalance).minus(D(stmt.data.summary.unpaid)).toFixed(2)}
                  />
                  <StatBalance label="الرصيد الحالي" value={stmt.data.summary.currentBalance} entityType="supplier" />
                  <Stat label="الذمة الدولارية ($)" value={stmt.data.supplier.currentBalanceUsd ?? "0"} />
                </div>
              </div>
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.supplier.name}
            entityType="supplier"
            phone={stmt.data.supplier.phone}
            currentBalance={stmt.data.summary.currentBalance}
            onPdf={printStatement}
          />

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">أوامر الشراء</div>
              {/* الرصيد المُرحَّل = افتتاحي مستورد + مشتريات ملتزمة − دفعات قبل from — يجعل رصيد
                  الفترة قابلاً للتتبّع. كان صفّاً أوّل في الجدول الخامّ بخلايا مدموجة؛ وهو ليس
                  أمر شراء، فصار شريطاً فوق الجدول (نفس المعلومة بلا صفٍّ كاذبِ النوع). */}
              {from && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-[var(--sem-warn-bg)]/60 px-3 py-2 text-xs font-medium">
                  <span>رصيد مُرحَّل</span>
                  <span dir="ltr">{fmtDate(from)}</span>
                  <span className="text-muted-foreground">ما قبل الفترة (افتتاحي + نشاط سابق)</span>
                  <span className="ms-auto tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.openingBalance)}</span>
                </div>
              )}
              {/* مُضمَّن في بطاقةٍ تحمل عنوان القسم ⇒ بلا شريط حالةٍ ولا بحثٍ ولا ترقيم. */}
              <DataTable<PoRow>
                embedded
                searchable={false}
                bounded={false}
                pageSize={Infinity}
                columns={poColumns}
                data={stmt.data.purchaseOrders}
                emptyText="لا أوامر شراء لهذا المورد."
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات المسجّلة</div>
              <DataTable<PaymentRow>
                embedded
                searchable={false}
                bounded={false}
                pageSize={Infinity}
                columns={paymentColumns}
                data={stmt.data.payments}
                emptyText="لا دفعات مسجّلة لهذا المورد."
              />
            </CardContent>
          </Card>
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

function StatBalance({ label, value, entityType }: { label: string; value: string | number; entityType: "customer" | "supplier" }) {
  const num = Number(value);
  // للمورد: الموجب = "له علينا" (أحمر)؛ للعميل: الموجب = "لنا عليه" (أخضر)
  const weHaveClaim = entityType === "customer" ? num > 0 : num < 0;
  const hasBalance = num !== 0;
  return (
    <div className={`rounded-md p-2 ${hasBalance ? (weHaveClaim ? "badge-status-active" : "badge-stock-out") : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : "text-muted-foreground"}`}>
        {!hasBalance ? "لا ذمم" : weHaveClaim ? "لنا عليه" : "له علينا"}
      </div>
    </div>
  );
}
