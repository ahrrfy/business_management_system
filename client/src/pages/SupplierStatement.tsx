import { CopyInline } from "@/components/CopyButton";
import SupplierPicker from "@/components/voucher/SupplierPicker";
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
import { D, fmt } from "@/lib/money";
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
import { Info } from "lucide-react";


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

/** صفٌّ واحد في دفتر حركات المورّد الموحَّد — يجمع أوامر الشراء والدفعات في جدولٍ واحد
 *  بنمط دفتر الأستاذ الفرعي (مدين/دائن/رصيدٌ جارٍ) المُتَّبع عالمياً (Odoo Partner Ledger،
 *  ERPNext General Ledger، GnuCash Owner Report، Dolibarr Grand Livre). */
type LedgerFilterGroup = "buy" | "pay_alloc" | "pay_unalloc" | "other";
interface LedgerRow {
  date: string;
  ref: string;
  description: string;
  descriptionSub?: string;
  actor: string;
  debit: string | null;
  credit: string | null;
  balance: string;
  filterGroup: LedgerFilterGroup;
  openHref?: string;
  paymentStatus?: "PAID" | "PARTIAL" | "UNPAID";
}

const FILTER_GROUP_LABEL: Record<"all" | LedgerFilterGroup, string> = {
  all: "الكل",
  buy: "فواتير شراء",
  pay_alloc: "دفعات مخصَّصة",
  pay_unalloc: "دفعات غير مخصَّصة",
  other: "أخرى",
};

const PAYMENT_STATUS_LABEL: Record<"PAID" | "PARTIAL" | "UNPAID", string> = {
  PAID: "مسدَّد",
  PARTIAL: "جزئي",
  UNPAID: "غير مسدَّد",
};
const PAYMENT_STATUS_CLS: Record<"PAID" | "PARTIAL" | "UNPAID", string> = {
  PAID: "badge-status-active",
  PARTIAL: "badge-status-pending",
  UNPAID: "badge-stock-out",
};

/** جمعُ عمود مدين/دائن بدقّة Decimal (§٥) — يتجاهل الخلايا الفارغة (—). */
function sumMoneyCol(values: (string | null | undefined)[]): ReturnType<typeof D> {
  return values.reduce((acc, v) => (v ? acc.plus(D(v)) : acc), D(0));
}

/** أعمدة دفتر الحركات الموحَّد — عمودا مدين/دائن + رصيدٌ جارٍ بارز، مطابقةً للنمط العالميّ. */
const ledgerColumns: ColumnDef<LedgerRow, unknown>[] = [
  { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" }, cell: ({ row }) => <span className="text-xs">{row.original.date}</span> },
  {
    id: "ref",
    header: "المستند",
    accessorFn: (r) => r.ref,
    meta: { kind: "code" },
    cell: ({ row }) => (row.original.ref === "—" ? <span className="text-xs text-muted-foreground">—</span> : <CopyInline value={row.original.ref} />),
  },
  {
    id: "description",
    header: "البيان",
    accessorFn: (r) => r.description,
    meta: { width: "wide" },
    cell: ({ row }) => (
      <div>
        <div className="text-xs">{row.original.description}</div>
        {row.original.descriptionSub && <div className="text-[10px] text-muted-foreground">{row.original.descriptionSub}</div>}
      </div>
    ),
  },
  {
    id: "actor",
    header: "المنفّذ",
    accessorFn: (r) => r.actor,
    meta: { kind: "actor" },
    cell: ({ row }) => <span className="text-xs">{row.original.actor}</span>,
  },
  {
    id: "debit",
    header: "مدين (دفع)",
    accessorFn: (r) => (r.debit == null ? "" : fmt(r.debit)),
    meta: { kind: "money" },
    cell: ({ row }) => (row.original.debit == null ? <span className="text-muted-foreground">—</span> : <span className="text-money-positive">{fmt(row.original.debit)}</span>),
    footer: ({ table }) => fmt(sumMoneyCol(table.getFilteredRowModel().rows.map((r) => r.original.debit)).toFixed(2)),
  },
  {
    id: "credit",
    header: "دائن (مشتريات)",
    accessorFn: (r) => (r.credit == null ? "" : fmt(r.credit)),
    meta: { kind: "money" },
    cell: ({ row }) => (row.original.credit == null ? <span className="text-muted-foreground">—</span> : fmt(row.original.credit)),
    footer: ({ table }) => fmt(sumMoneyCol(table.getFilteredRowModel().rows.map((r) => r.original.credit)).toFixed(2)),
  },
  {
    id: "balance",
    header: "الرصيد الجاري",
    accessorFn: (r) => fmt(r.balance),
    meta: { kind: "money" },
    cell: ({ row }) => <span className="font-bold">{fmt(row.original.balance)}</span>,
  },
  {
    id: "paymentStatus",
    header: "الحالة",
    accessorFn: (r) => (r.paymentStatus ? PAYMENT_STATUS_LABEL[r.paymentStatus] : "—"),
    meta: { kind: "status" },
    cell: ({ row }) =>
      row.original.paymentStatus ? (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${PAYMENT_STATUS_CLS[row.original.paymentStatus]}`}>
          {PAYMENT_STATUS_LABEL[row.original.paymentStatus]}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    id: "open",
    header: "فتح",
    enableSorting: false,
    meta: { kind: "actions" },
    cell: ({ row }) =>
      row.original.openHref ? (
        <Link href={row.original.openHref}>
          <Button variant="outline" size="sm">فتح</Button>
        </Link>
      ) : null,
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
  const [ledgerFilter, setLedgerFilter] = useState<"all" | LedgerFilterGroup>("all");
  const [to, setTo] = useState("");

  const stmt = trpc.reports.supplierStatement.useQuery(
    { supplierId: supplierId || 0, from: from || undefined, to: to || undefined },
    { enabled: !!supplierId }
  );
  const printAudit = usePrintAudit();

  // يبني دفتر الحركات (مدين/دائن/رصيد جارٍ) — يُشارَك بين الطباعة والتصدير **والعرض الحيّ**
  // في الجدول الموحَّد أدناه (لم يعد مقصوراً على الطباعة/التصدير كما كان).
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const poTxs = d.purchaseOrders.map((p) => {
      const poPaid = D(p.paidAmount);
      const poTotal = D(p.total);
      const paymentStatus: LedgerRow["paymentStatus"] = poTotal.gt(0) && poPaid.gte(poTotal) ? "PAID" : poPaid.gt(0) ? "PARTIAL" : "UNPAID";
      return {
        t: new Date(p.orderDate).getTime(),
        date: fmtDate(p.orderDate),
        ref: p.poNumber, description: "فاتورة شراء — بضاعة",
        actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
        debit: null as string | null, credit: p.total as string | null,
        filterGroup: "buy" as const,
        openHref: `/purchases/${p.id}`,
        paymentStatus,
      };
    });
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
        : (p.purchaseOrderId ? "دفعة للمورد" : "دفعة على الحساب — غير مخصَّصة");
      const descriptionSub =
        p.entryType === "PAYMENT_OUT" && p.purchaseOrderId ? `مخصَّصة لأمر الشراء #${p.purchaseOrderId}`
        : p.entryType === "PAYMENT_OUT" && !p.purchaseOrderId ? "بانتظار التخصيص لفاتورةٍ بعينها"
        : undefined;
      // §الفلترة: PAYMENT_OUT وحدها تُصنَّف مخصَّصة/غير مخصَّصة (بحسب purchaseOrderId)؛ كل
      // الأنواع الأخرى (مرتجع/استرداد/صيرفة/شراء يتيم/تصحيح افتتاحي) تقع في «أخرى».
      const filterGroup: LedgerFilterGroup =
        p.entryType === "PAYMENT_OUT" ? (p.purchaseOrderId ? "pay_alloc" : "pay_unalloc") : "other";
      return {
        t: new Date(p.entryDate).getTime(),
        date: fmtDate(p.entryDate),
        ref: p.voucherNumber ?? "—",
        description,
        descriptionSub,
        actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
        debit: signed.isNegative() ? signed.neg().toFixed(2) : (null as string | null),
        credit: signed.isPositive() ? signed.toFixed(2) : (null as string | null),
        filterGroup,
      };
    });
    // الفرز على طابع زمني خام — فرز نصّي على dd/mm/yyyy يخلط الشهور.
    const merged = [...poTxs, ...payTxs].sort((a, b) => a.t - b.t);
    // §٥: AP بـDecimal (دائن − مدين)، يبدأ من الرصيد المُرحَّل عند تقييد الفترة.
    let bal = from ? D(d.summary.openingBalance) : D(0);
    let totDebit = D(0), totCredit = D(0);
    const activityRows = merged.map(({ t: _t, ...x }) => {
      bal = bal.plus(D(x.credit)).minus(D(x.debit));
      totDebit = totDebit.plus(D(x.debit));
      totCredit = totCredit.plus(D(x.credit));
      return { ...x, balance: bal.toFixed(2) };
    });
    // صفّ «رصيد افتتاحي» أوّل السجل عند تقييد فترة — يُثبِّت عمود الرصيد الجاري لقارئٍ يفتح
    // الكشف منتصف الفترة (نمط Odoo «Initial Balance» / بداية سجلّ GnuCash). لا يُغيّر مجموع
    // مدين/دائن الفترة (خانتاه فارغتان) — رصيده وحده هو الرصيد المُرحَّل.
    const rows: LedgerRow[] = from
      ? [
          {
            date: fmtDate(from),
            ref: "—",
            description: "رصيد افتتاحي مُرحَّل",
            descriptionSub: "ما قبل الفترة (افتتاحي + نشاط سابق)",
            actor: "—",
            debit: null,
            credit: null,
            balance: D(d.summary.openingBalance).toFixed(2),
            filterGroup: "other",
          },
          ...activityRows,
        ]
      : activityRows;
    return {
      rows,
      totalDebit: totDebit.toFixed(2),
      totalCredit: totCredit.toFixed(2),
      // مع فترة: الختامي = المُرحَّل + حركة الفترة؛ بلا فترة: الرصيد الجاري (السلوك القديم).
      closingBalance: from ? bal.toFixed(2) : d.summary.currentBalance,
    };
  }, [stmt.data, from]);

  // فلترة نوع الحركة على دفتر الحركات المبنيّ أعلاه — بحثٌ حرّ عن طريق `DataTable` نفسه
  // (searchable افتراضيّاً)؛ هذه رقاقاتٌ إضافية تُقصر النوع (شراء/دفعة مخصَّصة/غير مخصَّصة/أخرى).
  const filteredLedgerRows = useMemo(() => {
    if (!ledger) return [];
    if (ledgerFilter === "all") return ledger.rows;
    return ledger.rows.filter((r) => r.filterGroup === ledgerFilter);
  }, [ledger, ledgerFilter]);

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
            <SupplierPicker
              label="المورد"
              supplierId={supplierId || null}
              onSupplierChange={(id) => selectSupplier(id ?? 0)}
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
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.supplier.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.supplier.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.supplier.city ?? "—"}
                    {stmt.data.supplier.paymentTerms ? ` · شروط الدفع: ${stmt.data.supplier.paymentTerms}` : ""}
                  </div>
                </div>
              </div>

              {/* صفّ مؤشراتٍ واحد (نمط عالمي: Odoo Partner Ledger / ERPNext AP Summary / GnuCash
                  Owner Report) — رصيدٌ رئيسيٌّ واحد بالدينار (والدولار مرجعٌ ثانويّ تحته، لا بطاقةٌ
                  منافسة)، رصيدٌ افتتاحي يُثبِّت عمود الرصيد الجاري، ثمّ حركة الفترة، ثمّ الأعمار. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <StatBalance
                  label="الرصيد المستحق"
                  value={stmt.data.summary.currentBalance}
                  entityType="supplier"
                  usdValue={stmt.data.supplier.currentBalanceUsd}
                />
                <Stat label="الرصيد الافتتاحي" value={stmt.data.summary.openingBalance} />
                <Stat label="إجمالي المشتريات (الفترة)" value={stmt.data.summary.totalPurchases} />
                <Stat label="إجمالي المسدَّد (الفترة)" value={stmt.data.summary.totalPaid} />
                <AgingCard aging={stmt.data.summary.aging} scoped={!!(from || to)} />
              </div>

              {/* بند تسوية صريح لفجوة تخصيص الدفعات — بدل أن يبقى الفرق بين مجموع «المتبقّي»
                  لكل فاتورة و«الرصيد المستحق» أعلاه صامتاً وغير مفسَّر (شكوى المالك الأصلية). */}
              {D(stmt.data.summary.unallocatedPayments).gt(0) && (
                <div className="flex items-start gap-2 rounded-md border bg-[var(--sem-warn-bg)]/60 px-3 py-2 text-xs">
                  <Info aria-hidden className="size-4 shrink-0 mt-0.5 text-[var(--sem-warn)]" />
                  <div>
                    <span className="font-semibold">دفعاتٌ على الحساب غير مخصَّصة لفاتورةٍ بعينها: </span>
                    <span className="tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.unallocatedPayments)}</span>
                    <span> — هذا يُفسِّر الفرق بين مجموع «المتبقّي» لكل فاتورةٍ في دفتر الحركات أدناه وبين «الرصيد المستحق» أعلاه. ابحث عن «دفعة على الحساب» في الجدول.</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.supplier.name}
            entityType="supplier"
            phone={stmt.data.supplier.phone}
            currentBalance={stmt.data.summary.currentBalance}
            onPdf={printStatement}
          />

          {/* دفتر حركاتٍ موحَّد واحد (مدين/دائن/رصيدٌ جارٍ) بدل جدولَي «أوامر الشراء»/«الدفعات»
              المنفصلَين سابقاً — نفس نمط Odoo Partner Ledger / ERPNext General Ledger / GnuCash
              Owner Report / Dolibarr Grand Livre. بحثٌ حرّ مدمج في DataTable + رقاقات نوع الحركة. */}
          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-muted/30">
                <span className="text-sm font-medium">دفتر الحركات</span>
                <div className="flex flex-wrap gap-1 ms-1">
                  {(["all", "buy", "pay_alloc", "pay_unalloc", "other"] as const).map((g) => (
                    <Button
                      key={g}
                      type="button"
                      size="sm"
                      variant={ledgerFilter === g ? "default" : "outline"}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setLedgerFilter(g)}
                    >
                      {FILTER_GROUP_LABEL[g]}
                    </Button>
                  ))}
                </div>
              </div>
              <DataTable<LedgerRow>
                embedded
                bounded={false}
                pageSize={Infinity}
                columns={ledgerColumns}
                data={filteredLedgerRows}
                searchPlaceholder="ابحث بالمرجع أو البيان أو المنفّذ…"
                emptyText="لا حركات لهذا المورد."
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

/** بطاقة الرصيد الرئيسية — رصيدٌ واحد يقود كل شيء (نمط Odoo/ERPNext/Dolibarr المُجمَع عليه:
 *  لا رصيدان متنافسان). `usdValue` — حين وُجد — يُعرَض سطراً ثانوياً تحت الرصيد نفسه بدل
 *  بطاقةٍ منفصلة («الذمة الدولارية») كانت تبدو ديناً ثانياً غير مرتبط. */
function StatBalance({
  label, value, entityType, usdValue,
}: {
  label: string; value: string | number; entityType: "customer" | "supplier"; usdValue?: string | number | null;
}) {
  const num = Number(value);
  // للمورد: الموجب = "له علينا" (أحمر)؛ للعميل: الموجب = "لنا عليه" (أخضر)
  const weHaveClaim = entityType === "customer" ? num > 0 : num < 0;
  const hasBalance = num !== 0;
  const usdNum = usdValue != null ? Number(usdValue) : 0;
  return (
    <div className={`rounded-md p-2 ${hasBalance ? (weHaveClaim ? "badge-status-active" : "badge-stock-out") : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${hasBalance ? (weHaveClaim ? "text-money-positive" : "text-money-negative") : "text-muted-foreground"}`}>
        {!hasBalance ? "لا ذمم" : weHaveClaim ? "لنا عليه" : "له علينا"}
      </div>
      {usdNum !== 0 && (
        <div className="text-[10px] text-muted-foreground mt-1 pt-1 border-t border-current/10 tabular-nums" dir="ltr">
          المعادل الدولاريّ (نفس الدَّين): {fmt(Math.abs(usdNum))}$
        </div>
      )}
    </div>
  );
}

const AGING_BUCKETS: { key: "d0_30" | "d31_60" | "d61_90" | "d91p"; label: string; barCls: string; textCls: string }[] = [
  { key: "d0_30", label: "0–30", barCls: "bg-[var(--sem-pos)]", textCls: "text-[var(--sem-pos)]" },
  { key: "d31_60", label: "31–60", barCls: "bg-[var(--sem-warn)]", textCls: "text-[var(--sem-warn)]" },
  { key: "d61_90", label: "61–90", barCls: "bg-[var(--sem-warn)]", textCls: "text-[var(--sem-warn)]" },
  { key: "d91p", label: "+90", barCls: "bg-[var(--sem-neg)]", textCls: "text-[var(--sem-neg)]" },
];

/** تحليل أعمار الذمم — دلوٌ مدمج داخل نفس صفّ المؤشرات (نمط ERPNext: رسمٌ فوق الجدول مباشرةً
 *  بدل تقريرٍ منفصل كما في Odoo/GnuCash). المجموع قد لا يُطابق «الرصيد المستحق» بالضبط (دفعاتٌ
 *  غير مخصَّصة/رصيدٌ افتتاحيّ) — الفرق مكشوفٌ في بند «غير مصنَّف» بدل إخفائه. */
function AgingCard({ aging, scoped }: { aging: { d0_30: string; d31_60: string; d61_90: string; d91p: string; unbucketed: string }; scoped: boolean }) {
  const values = AGING_BUCKETS.map((b) => D(aging[b.key]));
  const total = values.reduce((acc, v) => acc.plus(v), D(0));
  return (
    <div className="rounded-md p-2 bg-muted/40">
      <div className="text-xs text-muted-foreground">
        تحليل الأعمار {scoped && <span className="opacity-70">(لأوامرَ نشطة ضمن الفترة)</span>}
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-muted mt-2 mb-1.5">
        {total.gt(0)
          ? AGING_BUCKETS.map((b, i) => {
              const pct = values[i].dividedBy(total).times(100).toNumber();
              return pct > 0 ? <div key={b.key} className={b.barCls} style={{ width: `${pct}%` }} /> : null;
            })
          : <div className="w-full bg-border" />}
      </div>
      <div className="grid grid-cols-4 gap-x-1 text-[10px]">
        {AGING_BUCKETS.map((b, i) => (
          <div key={b.key} className="text-center">
            {/* bidi: "0–30" بلا مرساةٍ عربية تُعاد كتابتُها بصرياً "30-0" داخل حاويةٍ RTL بلا
                عزلٍ صريح — dir="ltr" هنا إلزاميٌّ لا تجميليّ (أمسكته جولةٌ بصرية فعلية). */}
            <div className={`font-semibold tabular-nums ${b.textCls}`} dir="ltr">{b.label}</div>
            <div className="tabular-nums text-muted-foreground truncate" dir="ltr">{fmt(values[i].toFixed(0))}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
