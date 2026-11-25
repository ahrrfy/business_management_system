import { MovementTypeBadge, PaymentMethodChip } from "@/components/common/MovementBadges";
import { CopyInline } from "@/components/CopyButton";
import { PurchaseDetailDrawer } from "@/components/purchases/PurchaseDetailDrawer";
import { AccountHealthBanner } from "@/components/statements/AccountHealthBanner";
import { stmtMoneyCol } from "@/components/statements/CustomerLedgerSection";
import { BatchInvoicePrintDialog, PartyCommandBar, StatementPeriodDetailBar, type StatementDetailLevel } from "@/components/statements/PartyCommandBar";
import { SupplierDossierDrawer } from "@/components/suppliers/SupplierDossierDrawer";
import { QuickVoucherSheet } from "@/components/vouchers/QuickVoucherSheet";
import { VoucherDetailDrawer } from "@/components/vouchers/VoucherDetailDrawer";
import SupplierPicker from "@/components/vouchers/SupplierPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { balanceDirectionLabel } from "@shared/balanceTrail";
import { classifyGrniApEntry } from "@shared/grniDedupe";
import { getPurchaseSettlement } from "@shared/purchaseSettlement";
import { fmtQty } from "@shared/quantityFormat";
import { isUnifiedPaymentMethod } from "@shared/terms";
import { AlertCircle, ExternalLink, FileText, Info, RefreshCw } from "lucide-react";
import { AccountLedgerDrilldownDialog, type DrilldownTarget } from "@/components/financial/AccountLedgerDrilldownDialog";
import { splitDocumentNotes } from "@/components/invoice/TermsAndNotes";
import { balanceStatementRows, statementClosingBalance, sumStatementMoneyCol, type StatementLineItem } from "@/lib/statementPeriodLedger";

function cleanStmtNotes(raw: string | null | undefined): string {
  if (!raw) return "";
  const parsed = splitDocumentNotes(raw);
  return parsed.notes || (parsed.poReference ? `مرجع: ${parsed.poReference}` : "") || raw;
}

type SupplierStatementData = NonNullable<RouterOutputs["reports"]["supplierStatement"]>;
type LedgerFilterGroup = "buy" | "pay_alloc" | "pay_unalloc" | "other";

interface LedgerRow {
  date: string;
  ref: string;
  description: string;
  descriptionSub?: string;
  kind: string;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  cardLastFour?: string | null;
  actor: string;
  debit: string | null;
  credit: string | null;
  balanceBefore: string;
  balance: string;
  filterGroup: LedgerFilterGroup;
  openHref?: string;
  paymentStatus?: ReturnType<typeof getPurchaseSettlement>["status"];
  paymentStatusLabel?: string;
  paymentReview?: boolean;
  paidAmount?: string;
  returnedAmount?: string;
  remainingAmount?: string;
  poId?: number;
  receiptId?: number;
  items?: StatementLineItem[];
  provenance?: any;
}

function statusBadgeVariant(status: NonNullable<LedgerRow["paymentStatus"]>, review?: boolean): "success" | "warning" | "destructive" | "info" {
  if (review) return "warning";
  if (status === "PAID") return "success";
  if (status === "PARTIAL") return "warning";
  if (status === "CREDITED") return "info";
  return "destructive";
}

function getLedgerColumns(
  detailLevel: StatementDetailLevel,
  onDrilldown: (target: DrilldownTarget) => void,
  onOpenPo: (poId: number) => void,
  onOpenVoucher: (receiptId: number) => void,
): ColumnDef<LedgerRow, unknown>[] {
  return [
    { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" }, cell: ({ row }) => <span className="text-xs"><bdi dir="ltr">{row.original.date}</bdi></span> },
    {
      id: "ref",
      header: "المستند",
      accessorFn: (r) => r.ref,
      meta: { kind: "code" },
      cell: ({ row }) => {
        const r = row.original;
        if (r.ref === "—") return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-1.5">
            <CopyInline value={r.ref} />
            {(r.poId || r.receiptId) && (
              <button
                type="button"
                onClick={() => {
                  if (r.poId) onOpenPo(r.poId);
                  else if (r.receiptId) onOpenVoucher(r.receiptId);
                }}
                className="text-[11px] text-primary hover:underline cursor-pointer"
                title="عرض المستند الأصلي"
              >
                عرض
              </button>
            )}
          </div>
        );
      },
    },
    {
      id: "kind",
      header: "النوع",
      accessorFn: (r) => r.description,
      meta: { kind: "status" },
      cell: ({ row }) => <MovementTypeBadge kind={row.original.kind} />,
    },
    {
      id: "description",
      header: "البيان",
      accessorFn: (r) => r.description,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span>{r.description}</span>
              {r.paymentMethod && isUnifiedPaymentMethod(r.paymentMethod) && (
                <PaymentMethodChip method={r.paymentMethod} cashBucket={r.cashBucket} cardLastFour={r.cardLastFour} />
              )}
            </div>
            {r.descriptionSub && <div className="text-[11px] text-muted-foreground">{r.descriptionSub}</div>}
            {detailLevel === "detailed" && r.items && r.items.length > 0 && (
              <div className="space-y-0.5 rounded border border-border/50 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                {r.items.map((it, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-2">
                    <span>{it.productName}{it.unitName ? ` (${it.unitName})` : ""}</span>
                    <span className="tabular-nums" dir="ltr">{fmtQty(it.quantity)} × {fmt(it.unitPrice)} = {fmt(it.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      },
    },
    stmtMoneyCol<LedgerRow>(
      "debit",
      "مدين (دفع/مرتجع)",
      (r) => r.debit ?? "0",
      (r) => (r.debit == null ? "—" : fmt(r.debit)),
      "text-money-positive font-semibold",
      (r) => {
        if (r.receiptId) onOpenVoucher(r.receiptId);
        else onDrilldown({ type: "GENERIC", title: r.description, subtitle: r.descriptionSub, amount: r.debit ?? "0", date: r.date, direction: "DEBIT", details: { "المرجع": r.ref, "المنفذ": r.actor, "البيان": r.description, "التفاصيل": r.descriptionSub } });
      },
      ({ table }) => fmt(sumStatementMoneyCol(table.getFilteredRowModel().rows.map((r) => r.original.debit)).toFixed(2)),
    ),
    stmtMoneyCol<LedgerRow>(
      "credit",
      "دائن (مشتريات/له)",
      (r) => r.credit ?? "0",
      (r) => (r.credit == null ? "—" : fmt(r.credit)),
      "font-semibold",
      (r) => {
        if (r.poId) onOpenPo(r.poId);
        else onDrilldown({ type: "GENERIC", title: r.description, subtitle: r.descriptionSub, amount: r.credit ?? "0", date: r.date, direction: "CREDIT", details: { "المرجع": r.ref, "المنفذ": r.actor, "البيان": r.description, "التفاصيل": r.descriptionSub } });
      },
      ({ table }) => fmt(sumStatementMoneyCol(table.getFilteredRowModel().rows.map((r) => r.original.credit)).toFixed(2)),
    ),
    stmtMoneyCol<LedgerRow>("balanceBefore", "قبل", (r) => r.balanceBefore, undefined, "text-muted-foreground text-xs"),
    stmtMoneyCol<LedgerRow>(
      "balance",
      "الرصيد الجاري",
      (r) => r.balance,
      undefined,
      "font-bold",
      (r) => (r.poId ? onOpenPo(r.poId) : r.receiptId ? onOpenVoucher(r.receiptId) : onDrilldown({ type: "GENERIC", title: r.description, subtitle: r.descriptionSub, amount: r.balance, date: r.date, direction: D(r.balance).gte(0) ? "CREDIT" : "DEBIT", details: { "المرجع": r.ref, "قبل": fmt(r.balanceBefore), "بعد": fmt(r.balance) } })),
    ),
    {
      id: "paymentStatus",
      header: "الحالة",
      accessorFn: (r) => r.paymentStatusLabel ?? "—",
      meta: { kind: "status" },
      cell: ({ row }) =>
        row.original.paymentStatus ? (
          <Badge variant={statusBadgeVariant(row.original.paymentStatus, row.original.paymentReview)}>
            {row.original.paymentStatusLabel}
            {row.original.paymentReview ? " — مراجعة السداد" : ""}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    { id: "actor", header: "المنفذ", accessorFn: (r) => r.actor, meta: { kind: "actor" }, cell: ({ row }) => <span className="text-xs">{row.original.actor}</span> },
    {
      id: "open",
      header: "فتح",
      enableSorting: false,
      meta: { kind: "actions", stickyActions: false },
      cell: ({ row }) =>
        row.original.openHref ? (
          <Link href={row.original.openHref}><Button variant="outline" size="sm">فتح</Button></Link>
        ) : row.original.receiptId ? (
          <Button variant="outline" size="sm" onClick={() => onOpenVoucher(row.original.receiptId!)}>معاينة</Button>
        ) : null,
    },
  ];
}

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
  const [detailLevel, setDetailLevel] = useState<StatementDetailLevel>("normal");
  const [ledgerFilter, setLedgerFilter] = useState<"all" | LedgerFilterGroup>("all");
  const [drilldownTarget, setDrilldownTarget] = useState<DrilldownTarget | null>(null);
  const [drawerPoId, setDrawerPoId] = useState<number | null>(null);
  const [drawerVoucherId, setDrawerVoucherId] = useState<number | null>(null);
  const [quickVoucherType, setQuickVoucherType] = useState<"PAYMENT" | "RECEIPT" | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [batchPrintOpen, setBatchPrintOpen] = useState(false);

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWriteVoucher = treasuryOperationAllowed(
    me.data,
    "vouchers.create",
    me.data?.role === "manager" || me.data?.role === "accountant" || Boolean(me.data?.isOwner),
  );
  const refreshAll = () => {
    void utils.reports.supplierStatement.invalidate();
    void utils.reports.apAging.invalidate();
    void utils.suppliers.invalidate();
  };
  const autoSettleM = trpc.suppliers.autoSettle.useMutation({
    onSuccess: (res) => {
      notify.ok(
        "تمت تسوية الحساب بنجاح",
        `سوي ${res.settledOrdersCount} أمر شراء مفتوح بمبلغ ${fmt(res.totalSettledAmount)} د.ع.`,
      );
      refreshAll();
    },
    onError: (err) => notify.err(err.message),
  });

  const ledgerColumns = useMemo(
    () =>
      getLedgerColumns(
        detailLevel,
        (target) => setDrilldownTarget(target),
        (poId) => setDrawerPoId(poId),
        (receiptId) => setDrawerVoucherId(receiptId),
      ),
    [detailLevel],
  );

  const stmt = trpc.reports.supplierStatement.useQuery(
    { supplierId: supplierId || 0, from: from || undefined, to: to || undefined, includeItems: detailLevel === "detailed" },
    { enabled: !!supplierId },
  );
  const printAudit = usePrintAudit();

  const openOrdersCount = useMemo(() => {
    return (stmt.data?.purchaseOrders ?? []).filter((p) => {
      const agreedCurrency = (p as { agreedCurrency?: string | null }).agreedCurrency === "USD" ? "USD" : "IQD";
      const remaining = D(getPurchaseSettlement({ ...p, agreedCurrency }).remainingAmount);
      return p.status !== "CANCELLED" && remaining.gt(0);
    }).length;
  }, [stmt.data?.purchaseOrders]);

  const hasUnsettledMismatch = useMemo(() => {
    if (!stmt.data) return false;
    const unallocated = D(stmt.data.summary.unallocatedPayments);
    const bal = D(stmt.data.summary.currentBalance);
    const unpaid = D(stmt.data.summary.unpaid);
    return openOrdersCount > 0 && (unallocated.gt(0) || bal.lte(0) || unpaid.gt(bal));
  }, [stmt.data, openOrdersCount]);

  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const d = stmt.data;
    const poTxs = d.purchaseOrders.map((p) => {
      const settlement = getPurchaseSettlement({ ...p, agreedCurrency: (p as { agreedCurrency?: string }).agreedCurrency ?? "IQD" });
      return {
        t: new Date(p.orderDate).getTime(),
        date: fmtDate(p.orderDate),
        ref: p.poNumber,
        description: `فاتورة شراء — ${settlement.intentLabel}`,
        descriptionSub: undefined as string | undefined,
        kind: "PURCHASE",
        paymentMethod: null as string | null,
        cashBucket: null as string | null,
        cardLastFour: null as string | null,
        actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
        debit: null as string | null,
        credit: ((p as { periodTotal?: string }).periodTotal ?? p.total) as string | null,
        filterGroup: "buy" as const,
        openHref: `/purchases/${p.id}`,
        paymentStatus: settlement.status,
        paymentStatusLabel: settlement.statusLabel,
        paymentReview: settlement.requiresReview,
        paidAmount: settlement.paidAmount,
        returnedAmount: settlement.returnedAmount,
        remainingAmount: settlement.remainingAmount,
        poId: Number(p.id),
        receiptId: undefined as number | undefined,
        items: (p as { items?: StatementLineItem[] }).items,
        provenance: (p as { provenance?: unknown }).provenance,
      };
    });

    const payTxs = d.payments.map((p) => {
      const amt = D(p.amount);
      const dedupeKey = (p as { dedupeKey?: string | null }).dedupeKey ?? null;
      const isFulfillmentCost =
        dedupeKey?.startsWith("FULFILLMENT_CHARGE_COST:") ||
        (p.entryType as string) === "FULFILLMENT_CHARGE_COST";
      const grni = classifyGrniApEntry(p.entryType, dedupeKey);
      const reducesAP = p.entryType === "PAYMENT_OUT" || p.entryType === "EXCHANGE_SETTLE" || grni === "REVERSAL";
      const signed = p.entryType === "RETURN" ? amt : (reducesAP ? amt.neg() : amt);

      const kind = isFulfillmentCost
        ? "FULFILLMENT_CHARGE"
        : grni === "REVERSAL"
          ? "ADJUSTMENT"
          : grni === "FORWARD"
            ? "GRNI"
            : p.entryType === "RETURN"
              ? "PURCHASE_RETURN"
              : p.entryType === "PAYMENT_IN"
                ? "PAYMENT_IN"
                : p.entryType === "EXCHANGE_SETTLE"
                  ? "PAYMENT_OUT"
                  : p.entryType === "PURCHASE"
                    ? "PURCHASE"
                    : p.entryType === "OPENING"
                      ? "OPENING"
                      : "PAYMENT_OUT";

      const description = isFulfillmentCost
        ? "تكلفة تنفيذ مستحقة للمورد"
        : grni === "REVERSAL"
          ? "عكس فاتورة مورد"
          : grni === "FORWARD"
            ? "فاتورة شراء (عدة أوامر)"
            : p.entryType === "RETURN"
              ? "مرتجع شراء"
              : p.entryType === "PAYMENT_IN"
                ? "سند قبض / استرداد من المورد"
                : p.entryType === "EXCHANGE_SETTLE"
                  ? "تسوية عبر صيرفة"
                  : p.entryType === "PURCHASE"
                    ? "شراء (بلا أمر)"
                    : p.entryType === "OPENING"
                      ? "تصحيح رصيد افتتاحي"
                      : p.purchaseOrderId
                        ? "سند صرف للمورد"
                        : "سند صرف على الحساب";

      const descriptionSub = [
        p.entryType === "PAYMENT_OUT" && p.purchaseOrderId ? `مخصصة لأمر الشراء #${p.purchaseOrderId}` : undefined,
        p.entryType === "PAYMENT_OUT" && !p.purchaseOrderId ? "دفعة على الحساب (متاح للتسوية)" : undefined,
        p.entryType === "EXCHANGE_SETTLE" && p.exchangeHouseName
          ? `عبر ${p.exchangeHouseName}${p.referenceNumber ? ` — مرجع ${p.referenceNumber}` : ""}`
          : undefined,
        cleanStmtNotes(p.notes) || undefined,
      ].filter(Boolean).join(" · ") || undefined;

      const filterGroup: LedgerFilterGroup =
        grni === "FORWARD" ? "buy" : p.entryType === "PAYMENT_OUT" ? (p.purchaseOrderId ? "pay_alloc" : "pay_unalloc") : "other";

      return {
        t: new Date(p.entryDate).getTime(),
        date: fmtDate(p.entryDate),
        ref: p.voucherNumber ?? "—",
        description,
        descriptionSub,
        kind,
        paymentMethod: (p as { paymentMethod?: string | null }).paymentMethod ?? null,
        cashBucket: (p as { cashBucket?: string | null }).cashBucket ?? null,
        cardLastFour: (p as { cardLastFour?: string | null }).cardLastFour ?? null,
        actor: p.createdByName ?? (p.createdBy ? `مستخدم #${p.createdBy}` : "غير موثق"),
        debit: signed.isNegative() ? signed.neg().toFixed(2) : (null as string | null),
        credit: signed.isPositive() ? signed.toFixed(2) : (null as string | null),
        filterGroup,
        openHref: undefined as string | undefined,
        paymentStatus: undefined,
        paymentStatusLabel: undefined,
        paymentReview: undefined,
        paidAmount: undefined,
        returnedAmount: undefined,
        remainingAmount: undefined,
        poId: p.purchaseOrderId ? Number(p.purchaseOrderId) : undefined,
        receiptId: p.receiptId ? Number(p.receiptId) : undefined,
        items: undefined as StatementLineItem[] | undefined,
        provenance: (p as { provenance?: unknown }).provenance,
      };
    });

    const openingStr = (d.summary as { openingBeforeFrom?: string }).openingBeforeFrom ?? d.summary.openingBalance;
    const openingBal = D(openingStr);
    const balanced = balanceStatementRows([...poTxs, ...payTxs], openingStr, "supplier");
    const activityRows = balanced.rows;

    const rows: LedgerRow[] = openingBal.abs().gt(0)
      ? [
          {
            date: from ? fmtDate(from) : "—",
            ref: "—",
            description: "رصيد افتتاحي مرحل",
            descriptionSub: from ? "ما قبل الفترة (افتتاحي + نشاط سابق)" : "الرصيد الافتتاحي المستورد",
            kind: "OPENING",
            paymentMethod: null,
            cashBucket: null,
            cardLastFour: null,
            actor: "—",
            debit: null,
            credit: null,
            balanceBefore: openingBal.toFixed(2),
            balance: openingBal.toFixed(2),
            filterGroup: "other",
            provenance: {
              movementType: "balance",
              title: "رصيد افتتاحي مرحل للمورد",
              totalAmount: openingBal.toFixed(2),
              party: { name: d.supplier.name, kind: "supplier" },
            },
          },
          ...activityRows,
        ]
      : activityRows;
    return {
      rows,
      openingBeforeFrom: openingBal.toFixed(2),
      totalDebit: balanced.totalDebit,
      totalCredit: balanced.totalCredit,
      periodClosing: balanced.closingBalance,
      closingBalance: statementClosingBalance(from, to, balanced.closingBalance, d.summary.currentBalance),
    };
  }, [stmt.data, from, to]);

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
        doc: `${r.ref} — ${r.description}${r.paymentStatusLabel ? ` · ${r.paymentStatusLabel}` : ""}${r.paymentReview ? " · يحتاج مراجعة دليل السداد" : ""}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: ledger.closingBalance,
      asOfDate: to || undefined,
    });
    const tsv = formatTableAsTSV(
      ["التاريخ", "المرجع", "البيان", "المنفذ", "مدين", "دائن", "قبل", "الرصيد", "حالة السداد", "المدفوع", "تخفيض الذمة", "المتبقي"],
      ledger.rows.map((r) => ({
        "التاريخ": r.date,
        "المرجع": r.ref,
        "البيان": r.description,
        "المنفذ": r.actor,
        "مدين": r.debit == null ? "" : r.debit,
        "دائن": r.credit == null ? "" : r.credit,
        "قبل": r.balanceBefore,
        "الرصيد": r.balance,
        "حالة السداد": `${r.paymentStatusLabel ?? ""}${r.paymentReview ? " — يحتاج مراجعة" : ""}`,
        "المدفوع": r.paidAmount ?? "",
        "تخفيض الذمة": r.returnedAmount ?? "",
        "المتبقي": r.remainingAmount ?? "",
      })),
    );
    return { plain, whatsapp, tsv };
  }, [stmt.data, ledger, to]);

  const printStatement = async () => {
    if (!stmt.data || !ledger) return;
    if (!reservePrintWindow()) return notify.err("تعذر فتح نافذة الطباعة — تحقق من مانع النوافذ المنبثقة");
    const d = stmt.data;
    try {
      await printAudit.run({
        documentType: "SUPPLIER_STATEMENT",
        documentId: Number(d.supplier.id),
        channel: "PDF",
        open: (audit) => printSupplierStmt({
          supplierName: d.supplier.name,
          supplierPhone: d.supplier.phone ?? undefined,
          fromDate: from ? fmtDate(new Date(`${from}T00:00:00`)) : undefined,
          toDate: fmtDate(to ? new Date(`${to}T00:00:00`) : new Date()),
          usdReference: d.supplier.currentBalanceUsd,
          transactions: ledger.rows.map((r) => ({
            ...r,
            items: detailLevel === "detailed" ? r.items : undefined,
          })),
          totalDebit: ledger.totalDebit,
          totalCredit: ledger.totalCredit,
          openingBalance: ledger.openingBeforeFrom,
          currentBalance: d.summary.currentBalance,
          closingBalance: ledger.closingBalance,
          printedByName: audit.actorName,
          printRequestedAt: fmtDateTime(audit.requestedAt),
        }),
      });
    } catch (error) {
      releaseReservedPrintWindow();
      notify.err(error instanceof Error ? error.message : "تعذر تسجيل طلب الطباعة");
    }
  };

  const exportStatement = (format?: "csv") => {
    if (!stmt.data || !ledger) return;
    exportRows(ledger.rows, {
      filename: `كشف-حساب-مورد-${stmt.data.supplier.name}`,
      format,
      title: `كشف حساب مورد — ${stmt.data.supplier.name}`,
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "ref", header: "المرجع" },
        { key: "description", header: "البيان" },
        { key: "actor", header: "المنفذ" },
        { key: "debit", header: "مدين", map: (r) => (r.debit == null ? null : D(r.debit).toNumber()) },
        { key: "credit", header: "دائن", map: (r) => (r.credit == null ? null : D(r.credit).toNumber()) },
        { key: "balanceBefore", header: "قبل", map: (r) => D(r.balanceBefore).toNumber() },
        { key: "balance", header: "الرصيد", map: (r) => D(r.balance).toNumber() },
        { key: "paymentStatusLabel", header: "حالة السداد" },
        { key: "paymentReview", header: "مراجعة دليل السداد", map: (r) => r.paymentReview ? "تحتاج مراجعة" : "" },
        { key: "paidAmount", header: "المدفوع (د.ع)", map: (r) => r.paidAmount == null ? null : D(r.paidAmount).toNumber() },
        { key: "returnedAmount", header: "تخفيض الذمة (د.ع)", map: (r) => r.returnedAmount == null ? null : D(r.returnedAmount).toNumber() },
        { key: "remainingAmount", header: "المتبقي (د.ع)", map: (r) => r.remainingAmount == null ? null : D(r.remainingAmount).toNumber() },
        ...(detailLevel === "detailed" ? [{
          key: "items" as const,
          header: "بنود الأصناف",
          map: (r: LedgerRow) => r.items?.length
            ? r.items.map((it) => `${it.productName} × ${fmtQty(it.quantity)} = ${fmt(it.total)}`).join(" | ")
            : "",
        }] : []),
      ],
    });
  };

  return (
    <div className="space-y-2.5">
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
                onClick={() => exportStatement()}
              >
                تصدير Excel
              </Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.rows.length}
                onClick={() => exportStatement("csv")}
              >
                <FileText className="size-3.5 ms-1" />
                تصدير CSV
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
        <CardContent className="p-2.5 space-y-2.5">
          <div className="min-w-64">
            <SupplierPicker
              label="المورد"
              source="reports"
              supplierId={supplierId || null}
              onSupplierChange={(id) => selectSupplier(id ?? 0)}
            />
          </div>
          <StatementPeriodDetailBar
            from={from}
            to={to}
            onRangeChange={({ from: nextF, to: nextT }) => { setFrom(nextF); setTo(nextT); }}
            detailLevel={detailLevel}
            onDetailLevelChange={setDetailLevel}
          />
        </CardContent>
      </Card>

      {!supplierId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر مورداً لعرض كشف الحساب.</p>
      )}

      {supplierId > 0 && stmt.isLoading && <LoadingState />}

      {supplierId > 0 && stmt.isError && (
        <ErrorState message={stmt.error.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && ledger && (
        <>
          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="flex items-start justify-between flex-wrap gap-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-base font-semibold">{stmt.data.supplier.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.supplier.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.supplier.city ?? "—"}
                    {stmt.data.supplier.paymentTerms ? ` · شروط الدفع: ${stmt.data.supplier.paymentTerms}` : ""}
                  </div>
                </div>
                <PartyCommandBar
                  partyType="SUPPLIER"
                  partyName={stmt.data.supplier.name}
                  phone={stmt.data.supplier.phone}
                  whatsappMessage={copyPayload.plain}
                  canWriteVoucher={canWriteVoucher}
                  onOpenQuickVoucher={(type) => setQuickVoucherType(type)}
                  onOpenDossier={() => setDossierOpen(true)}
                  onOpenBatchPrint={() => setBatchPrintOpen(true)}
                />
              </div>

              <AccountHealthBanner partyType="SUPPLIER" partyId={supplierId} onResolved={refreshAll} />

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                <StatBalance
                  label="الرصيد المستحق"
                  value={stmt.data.summary.currentBalance}
                  entityType="supplier"
                  usdValue={stmt.data.supplier.currentBalanceUsd}
                />
                <Stat
                  label={from ? "الرصيد الافتتاحي (ما قبل الفترة)" : "الرصيد الافتتاحي"}
                  value={ledger.openingBeforeFrom}
                />
                <Stat
                  label="إجمالي المشتريات والمستحقات (دائن)"
                  value={ledger.totalCredit}
                  sub={!D(ledger.totalCredit).eq(D(stmt.data.summary.totalPurchases))
                    ? `أوامر الشراء وحدها: ${fmt(stmt.data.summary.totalPurchases)}`
                    : undefined}
                />
                <Stat
                  label="إجمالي المسدد والمرتجعات (مدين)"
                  value={ledger.totalDebit}
                  sub={!D(ledger.totalDebit).eq(D(stmt.data.summary.totalPaid))
                    ? `سندات الصرف وحدها: ${fmt(stmt.data.summary.totalPaid)}`
                    : undefined}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  معادلة الرصيد: الافتتاحي (<bdi dir="ltr">{fmt(ledger.openingBeforeFrom)}</bdi>) + الدائن (<bdi dir="ltr">{fmt(ledger.totalCredit)}</bdi>) − المدين (<bdi dir="ltr">{fmt(ledger.totalDebit)}</bdi>) = صافي نهاية الفترة (<bdi dir="ltr">{fmt(ledger.periodClosing)}</bdi>)
                </span>
                {!from && !to && !D(ledger.periodClosing).eq(D(stmt.data.summary.currentBalance)) && (
                  <Badge variant="warning">
                    فرق عن رصيد المورد المسجل: <bdi dir="ltr">{fmt(D(stmt.data.summary.currentBalance).minus(D(ledger.periodClosing)).toFixed(2))}</bdi>
                  </Badge>
                )}
              </div>

              <AgingCard aging={stmt.data.summary.aging} scoped={!!(from || to)} />

              {hasUnsettledMismatch && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-md border border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]/60 p-3 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertCircle aria-hidden className="size-4 shrink-0 mt-0.5 text-[var(--sem-warn)]" />
                    <div className="space-y-1">
                      <span className="font-semibold text-[var(--sem-warn)]">
                        تنبيه مطابقة الذمم — دفعات غير مخصصة مع أوامر شراء مفتوحة:{" "}
                      </span>
                      <span className="tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.unallocatedPayments)} د.ع</span>
                      <p className="text-muted-foreground leading-relaxed">
                        يوجد رصيد مسدد أو غير مخصص مع وجود أوامر شراء مفتوحة ({openOrdersCount} أمر). يمكنك إجراء تسوية تلقائية بنظام الأقدم فالأقدم لربط الدفعات بالأوامر وتصفية أعمار الذمم الدائنة تلقائياً.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0 gap-1.5"
                    disabled={autoSettleM.isPending}
                    onClick={() => autoSettleM.mutate({ supplierId })}
                  >
                    <RefreshCw className={`h-4 w-4 ${autoSettleM.isPending ? "animate-spin" : ""}`} />
                    تسوية الأوامر تلقائياً
                  </Button>
                </div>
              )}

              {!hasUnsettledMismatch && D(stmt.data.summary.unallocatedPayments).gt(0) && (
                <div className="flex items-start gap-2 rounded-md border border-border/60 bg-[var(--sem-info-bg)]/60 p-3 text-xs">
                  <Info aria-hidden className="size-4 shrink-0 mt-0.5 text-[var(--sem-info)]" />
                  <div className="space-y-1">
                    <span className="font-semibold text-[var(--sem-info)]">
                      رصيد دفعات غير مخصصة على الحساب:{" "}
                    </span>
                    <span className="tabular-nums font-semibold" dir="ltr">{fmt(stmt.data.summary.unallocatedPayments)} د.ع</span>
                    <p className="text-muted-foreground leading-relaxed">
                      يوجد رصيد دفعات مستقلة على حساب المورد دون وجود أوامر شراء مفتوحة حالياً (رصيد دائن / دفعة مقدمة).
                    </p>
                  </div>
                </div>
              )}

              {Boolean(stmt.data.unbilledReceipts?.length) && (
                <div className="rounded-md border border-border/60 bg-[var(--sem-info-bg)]/60 p-3 text-xs space-y-2.5">
                  <div className="flex items-start gap-2">
                    <Info aria-hidden className="size-4 shrink-0 mt-0.5 text-[var(--sem-info)]" />
                    <div>
                      <span className="font-semibold">بضاعة مستلمة مخزنياً بانتظار فاتورة المورد: </span>
                      <span>
                        توجد {stmt.data.unbilledReceipts?.length} أذونات استلام مخزني غير مفوترة بإجمالي{" "}
                        <span className="tabular-nums font-semibold" dir="ltr">
                          {fmt(
                            stmt.data.unbilledReceipts
                              ?.reduce((sum, r) => sum.plus(D(r.totalAmount || "0")), D(0))
                              .toFixed(2) ?? "0.00",
                          )}
                        </span>
                        {" "}دينار عراقي لم ترحل إلى ذمم الموردين بعد.
                      </span>
                    </div>
                  </div>
                  <div className="divide-y divide-border/40 rounded border border-border/40 bg-background/50">
                    {stmt.data.unbilledReceipts?.map((r) => (
                      <div key={r.goodsReceiptId} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-foreground">{r.receiptNumber}</span>
                            {r.receivedAt && <span className="text-muted-foreground">{fmtDate(r.receivedAt)}</span>}
                            {r.poNumber && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                أمر شراء: {r.poNumber}
                              </span>
                            )}
                          </div>
                          {r.notes && <p className="text-[11px] text-muted-foreground">{cleanStmtNotes(r.notes)}</p>}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="tabular-nums font-semibold text-foreground" dir="ltr">{fmt(r.totalAmount)}</span>
                          {r.purchaseOrderId && (
                            <Link href={`/purchases/${r.purchaseOrderId}`}>
                              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                                عرض أمر الشراء والمطابقة
                                <ExternalLink aria-hidden className="size-3" />
                              </Button>
                            </Link>
                          )}
                        </div>
                      </div>
                    ))}
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

          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-muted/30">
                <span className="text-sm font-medium">دفتر الحركات</span>
                <div className="flex flex-wrap gap-1 ms-1">
                  {([
                    ["all", "الكل"],
                    ["buy", "فواتير شراء"],
                    ["pay_alloc", "دفعات مخصصة"],
                    ["pay_unalloc", "دفعات غير مخصصة"],
                    ["other", "أخرى"],
                  ] as const).map(([g, lbl]) => (
                    <Button key={g} type="button" size="sm" variant={ledgerFilter === g ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setLedgerFilter(g)}>
                      {lbl}
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
                searchPlaceholder="ابحث بالمرجع أو البيان أو المنفذ…"
                emptyText="لا حركات لهذا المورد."
              />
            </CardContent>
          </Card>
        </>
      )}

      <AccountLedgerDrilldownDialog target={drilldownTarget} open={!!drilldownTarget} onOpenChange={(open) => !open && setDrilldownTarget(null)} />
      <PurchaseDetailDrawer purchaseOrderId={drawerPoId} onClose={() => setDrawerPoId(null)} />
      <VoucherDetailDrawer voucherId={drawerVoucherId} open={drawerVoucherId != null} onOpenChange={(o) => !o && setDrawerVoucherId(null)} onActionSuccess={refreshAll} />
      <SupplierDossierDrawer supplierId={dossierOpen ? supplierId : null} open={dossierOpen} onClose={() => setDossierOpen(false)} />

      {stmt.data && canWriteVoucher && quickVoucherType && (
        <QuickVoucherSheet
          open={!!quickVoucherType}
          onOpenChange={(o) => !o && setQuickVoucherType(null)}
          defaultType={quickVoucherType}
          defaultPartyType="SUPPLIER"
          defaultPartyId={supplierId}
          defaultPartyName={stmt.data.supplier.name}
          currentBalance={stmt.data.summary.currentBalance}
          onSuccess={refreshAll}
        />
      )}

      {stmt.data && batchPrintOpen && (
        <BatchInvoicePrintDialog
          open={batchPrintOpen}
          onOpenChange={setBatchPrintOpen}
          partyType="SUPPLIER"
          partyId={supplierId}
          partyName={stmt.data.supplier.name}
          partyPhone={stmt.data.supplier.phone}
          from={from}
          to={to}
        />
      )}
    </div>
  );
}

function Stat({ label, value, sub, emphasis }: { label: string; value: string | number; sub?: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md px-2.5 py-2 space-y-0.5 ${emphasis ? "bg-primary/5" : "bg-muted/40"}`}>
      <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-base font-bold" : "text-sm font-semibold"}`} dir="ltr">{fmt(value)}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StatBalance({
  label, value, entityType, usdValue,
}: {
  label: string; value: string | number; entityType: "customer" | "supplier"; usdValue?: string | number | null;
}) {
  const numD = D(value);
  const usdD = usdValue != null ? D(usdValue) : D(0);
  const weHaveClaimIqd = entityType === "customer" ? numD.gt(0) : numD.lt(0);
  const hasIqd = !numD.isZero();
  const hasUsd = !usdD.isZero();
  const weHaveClaimUsd = entityType === "customer" ? usdD.gt(0) : usdD.lt(0);
  const partyKind = entityType === "customer" ? "CUSTOMER" : "SUPPLIER";

  return (
    <div className={`rounded-md px-2.5 py-2 ${hasIqd ? (weHaveClaimIqd ? "badge-status-active" : "badge-stock-out") : hasUsd ? (weHaveClaimUsd ? "badge-status-active" : "badge-stock-out") : "bg-muted/40"}`}>
      <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
      <div className={`tabular-nums text-base font-bold ${hasIqd ? (weHaveClaimIqd ? "text-money-positive" : "text-money-negative") : ""}`} dir="ltr">
        {fmt(numD.abs().toFixed(2))}
      </div>
      <div className={`text-xs font-semibold ${hasIqd ? (weHaveClaimIqd ? "text-money-positive" : "text-money-negative") : "text-muted-foreground"}`}>
        {!hasIqd ? (hasUsd ? "لا ذمة بالدينار" : "متوازن") : balanceDirectionLabel(partyKind, numD)}
      </div>
      {hasUsd && (
        <div className="text-xs mt-1.5 pt-1.5 border-t border-current/15 flex flex-wrap items-center justify-between gap-1.5">
          <span className="font-bold tabular-nums" dir="ltr">${fmt(usdD.abs().toFixed(2))}</span>
          <span className="font-medium text-muted-foreground">
            مرجع الفواتير الدولارية — مشمول بالدينار المثبت ({balanceDirectionLabel(partyKind, usdD)})
          </span>
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

function AgingCard({ aging, scoped }: { aging: { d0_30: string; d31_60: string; d61_90: string; d91p: string; unbucketed: string }; scoped: boolean }) {
  const values = AGING_BUCKETS.map((b) => D(aging[b.key]));
  const unbucketed = D(aging.unbucketed);
  const barTotal = values.reduce((acc, v) => acc.plus(v), D(0)).plus(unbucketed.gt(0) ? unbucketed : D(0));
  return (
    <div className="rounded-md p-2.5 bg-muted/40 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          تحليل أعمار الذمم {scoped && <span className="opacity-70">(لأوامر ضمن الفترة)</span>}
        </span>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-muted">
        {barTotal.gt(0)
          ? [
              ...AGING_BUCKETS.map((b, i) => {
                const pct = values[i].dividedBy(barTotal).times(100).toNumber();
                return pct > 0 ? <div key={b.key} className={b.barCls} style={{ width: `${pct}%` }} /> : null;
              }),
              unbucketed.gt(0) ? (
                <div key="unbucketed" className="bg-[var(--sem-info)]" style={{ width: `${unbucketed.dividedBy(barTotal).times(100).toNumber()}%` }} />
              ) : null,
            ]
          : <div className="w-full bg-border" />}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        {AGING_BUCKETS.map((b, i) => (
          <div key={b.key} className="rounded border bg-background/70 px-2 py-1 text-center">
            <div className={`font-semibold tabular-nums ${b.textCls}`} dir="ltr">{b.label}</div>
            <div className="tabular-nums text-foreground font-medium" dir="ltr">{fmt(values[i].toFixed(0))}</div>
          </div>
        ))}
        <div className="rounded border bg-background/70 px-2 py-1 text-center">
          <div className="font-semibold text-[var(--sem-info)]">غير مصنف</div>
          <div className="tabular-nums text-foreground font-medium" dir="ltr">{fmt(unbucketed.toFixed(0))}</div>
        </div>
      </div>
    </div>
  );
}
