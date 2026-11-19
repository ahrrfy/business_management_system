import { MovementTypeBadge, PaymentMethodChip } from "@/components/common/MovementBadges";
import { CopyInline } from "@/components/CopyButton";
import { DataTable } from "@/components/data-table/DataTable";
import { FinancialCellProvenanceHover } from "@/components/financial";
import type { DrilldownTarget } from "@/components/financial/AccountLedgerDrilldownDialog";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { sourceTypeLabel } from "@/lib/labels";
import { D, fmt } from "@/lib/money";
import { statementMethodDisplayLabel, sumStatementMoneyCol, type CustomerLedgerRow, type StatementMovementKind } from "@/lib/statementPeriodLedger";
import type { RouterOutputs } from "@/lib/trpc";
import type { FinancialCellProvenancePayload } from "@shared/financialProvenance";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { isDeadInvoice } from "@shared/predicates";
import { fmtQty } from "@shared/quantityFormat";
import { isUnifiedPaymentMethod } from "@shared/terms";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

type CustomerStatementData = NonNullable<RouterOutputs["reports"]["customerStatement"]>;
type StmtInvoiceRow = CustomerStatementData["invoices"][number];
type StmtPaymentRow = CustomerStatementData["payments"][number];

export function stmtMoneyCol<T>(
  id: string,
  header: string,
  get: (r: T) => string | number,
  display?: (r: T) => string,
  cls?: string,
  onClick?: (r: T) => void,
  footer?: ColumnDef<T, unknown>["footer"],
): ColumnDef<T, unknown> {
  return {
    id,
    header,
    accessorFn: (r) => (display ? display(r) : fmt(get(r))),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => D(get(a.original)).cmp(D(get(b.original))),
    cell: ({ row }) => {
      const val = display ? display(row.original) : fmt(get(row.original));
      const prov = (row.original as { provenance?: FinancialCellProvenancePayload }).provenance;
      const content = onClick ? (
        <button type="button" onClick={() => onClick(row.original)} className={`${cls ?? ""} hover:underline cursor-pointer text-end block w-full`}>
          {val}
        </button>
      ) : (
        <span className={`${cls ?? ""} text-end block w-full`}>{val}</span>
      );
      return <FinancialCellProvenanceHover data={prov}>{content}</FinancialCellProvenanceHover>;
    },
    ...(footer ? { footer } : {}),
  };
}

const isDepositDue = (i: StmtInvoiceRow) =>
  i.status !== "CANCELLED" && i.status !== "RETURNED" && (i.sourceType === "ORDER" || i.sourceType === "WORKORDER") && D(i.paidAmount).gt(0) && D(i.remainingAmount).gt(0);

const invoiceBadgeVariant = (status: string): "success" | "warning" | "destructive" | "neutral" =>
  status === "PAID" ? "success" : status === "PARTIALLY_PAID" || status === "PENDING" ? "warning" : status === "CANCELLED" || status === "RETURNED" ? "destructive" : "neutral";

export interface CustomerLedgerSectionProps {
  customerId: number;
  from: string;
  openingBalance: string;
  currentBalance: string;
  unallocatedCredit?: string | null;
  detailLevel: "normal" | "detailed";
  ledgerRows: CustomerLedgerRow[];
  invoices: StmtInvoiceRow[];
  payments: StmtPaymentRow[];
  fulfillmentCharges?: CustomerStatementData["fulfillmentCharges"];
  fulfillmentHeldExcess?: string | null;
  invoiceFilter: "ALL" | "DEPOSIT_DUE" | "OUTSTANDING" | "SETTLED";
  onInvoiceFilterChange: (v: "ALL" | "DEPOSIT_DUE" | "OUTSTANDING" | "SETTLED") => void;
  hasUnsettledMismatch: boolean;
  canAutoSettle: boolean;
  isAutoSettling: boolean;
  onAutoSettle: () => void;
  onApplyCreditToInvoice?: (invoiceId: number) => void;
  isApplyingInvoiceCredit?: boolean;
  onDrilldown: (target: DrilldownTarget) => void;
  onOpenVoucher?: (receiptId: number) => void;
}

export function CustomerLedgerSection(props: CustomerLedgerSectionProps) {
  const {
    from, openingBalance, currentBalance, unallocatedCredit, detailLevel, ledgerRows, invoices, payments,
    fulfillmentCharges, fulfillmentHeldExcess, invoiceFilter, onInvoiceFilterChange, hasUnsettledMismatch,
    canAutoSettle, isAutoSettling, onAutoSettle, onApplyCreditToInvoice, isApplyingInvoiceCredit, onDrilldown, onOpenVoucher,
  } = props;

  const [ledgerGroup, setLedgerGroup] = useState<"all" | "sale" | "pay" | "adj">("all");
  const [ledgerSearch, setLedgerSearch] = useState("");
  const hasAvailableCredit = D(unallocatedCredit ?? 0).gt(0) || D(currentBalance).lt(0) || hasUnsettledMismatch;

  const shownInvoices = useMemo(
    () => invoices.filter((i) => {
      const rem = D(i.remainingAmount);
      const active = !isDeadInvoice(i.status);
      if (invoiceFilter === "DEPOSIT_DUE") return active && (i.sourceType === "ORDER" || i.sourceType === "WORKORDER") && D(i.paidAmount).gt(0) && rem.gt(0);
      if (invoiceFilter === "OUTSTANDING") return active && rem.gt(0);
      if (invoiceFilter === "SETTLED") return active && rem.lte(0);
      return true;
    }),
    [invoices, invoiceFilter],
  );

  const filteredLedgerRows = useMemo(() => {
    const q = ledgerSearch.toLowerCase();
    return ledgerRows.filter((r) => {
      if (ledgerGroup === "sale" && r.kind !== "SALE") return false;
      if (ledgerGroup === "pay" && r.kind !== "PAYMENT_IN" && r.kind !== "PAYMENT_OUT" && r.kind !== "COD") return false;
      if (ledgerGroup === "adj" && r.kind !== "RETURN" && r.kind !== "ADJUSTMENT" && r.kind !== "OPENING" && r.kind !== "FULFILLMENT_CHARGE") return false;
      if (q && !`${r.ref} ${r.description} ${r.actor} ${r.date}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [ledgerRows, ledgerGroup, ledgerSearch]);

  const ledgerColumns = useMemo<ColumnDef<CustomerLedgerRow, unknown>[]>(() => [
    { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" }, cell: ({ row }) => <span className="text-xs"><bdi dir="ltr">{row.original.date}</bdi></span> },
    {
      id: "ref", header: "المستند", accessorFn: (r) => r.ref, meta: { kind: "code" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex items-center gap-1">
            <CopyInline value={r.ref} />
            {(r.invoiceId || r.receiptId) && (
              <button type="button" className="text-xs text-primary hover:underline cursor-pointer" onClick={() => {
                if (r.receiptId && onOpenVoucher && !r.invoiceId) onOpenVoucher(r.receiptId);
                else if (r.invoiceId) onDrilldown({ type: "INVOICE", invoiceId: r.invoiceId });
                else if (r.receiptId) onDrilldown({ type: "VOUCHER", receiptId: r.receiptId });
              }}>عرض</button>
            )}
          </div>
        );
      },
    },
    { id: "kind", header: "النوع", accessorFn: (r) => r.description, meta: { kind: "status" }, cell: ({ row }) => <MovementTypeBadge kind={row.original.kind as StatementMovementKind} /> },
    {
      id: "description", header: "البيان وطريقة الدفع", accessorFn: (r) => r.description, meta: { width: "wide", wrap: true },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span>{r.description}</span>
              {r.paymentMethod && (
                <PaymentMethodChip
                  method={isUnifiedPaymentMethod(r.paymentMethod) ? r.paymentMethod : undefined}
                  cashBucket={r.cashBucket}
                  cardLastFour={r.cardLastFour}
                  creditLabel={!isUnifiedPaymentMethod(r.paymentMethod) ? statementMethodDisplayLabel(r.paymentMethod) : undefined}
                />
              )}
            </div>
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
    stmtMoneyCol<CustomerLedgerRow>("debit", "مدين (لنا)", (r) => r.debit ?? "0", (r) => (r.debit == null ? "—" : fmt(r.debit)), "font-semibold",
      (r) => (r.invoiceId ? onDrilldown({ type: "INVOICE", invoiceId: r.invoiceId }) : r.receiptId && onOpenVoucher ? onOpenVoucher(r.receiptId) : undefined),
      ({ table }) => fmt(sumStatementMoneyCol(table.getFilteredRowModel().rows.map((x) => x.original.debit)).toFixed(2)),
    ),
    stmtMoneyCol<CustomerLedgerRow>("credit", "دائن (مسدد/مرتجع)", (r) => r.credit ?? "0", (r) => (r.credit == null ? "—" : fmt(r.credit)), "font-semibold text-money-positive",
      (r) => (r.receiptId && onOpenVoucher ? onOpenVoucher(r.receiptId) : r.receiptId ? onDrilldown({ type: "VOUCHER", receiptId: r.receiptId }) : undefined),
      ({ table }) => fmt(sumStatementMoneyCol(table.getFilteredRowModel().rows.map((x) => x.original.credit)).toFixed(2)),
    ),
    stmtMoneyCol<CustomerLedgerRow>("balanceBefore", "قبل", (r) => r.balanceBefore, undefined, "text-muted-foreground text-xs"),
    stmtMoneyCol<CustomerLedgerRow>("balance", "الرصيد الجاري", (r) => r.balance, undefined, "font-bold"),
    { id: "actor", header: "المنفذ", accessorFn: (r) => r.actor, meta: { kind: "actor" }, cell: ({ row }) => <span className="text-xs">{row.original.actor}</span> },
    {
      id: "open", header: "فتح", enableSorting: false, meta: { kind: "actions", stickyActions: false },
      cell: ({ row }) => row.original.openHref ? (
        <Link href={row.original.openHref}><Button variant="outline" size="sm">فتح</Button></Link>
      ) : row.original.receiptId && onOpenVoucher ? (
        <Button variant="outline" size="sm" onClick={() => onOpenVoucher(row.original.receiptId!)}>معاينة</Button>
      ) : null,
    },
  ], [detailLevel, onDrilldown, onOpenVoucher]);

  const invoiceColumns = useMemo<ColumnDef<StmtInvoiceRow, unknown>[]>(() => [
    {
      id: "invoiceNumber", header: "الفاتورة", accessorFn: (i) => i.invoiceNumber, meta: { kind: "code" },
      cell: ({ row }) => <button type="button" onClick={() => onDrilldown({ type: "INVOICE", invoiceId: row.original.id })} className="font-mono text-primary underline font-bold text-xs">{row.original.invoiceNumber}</button>,
    },
    { id: "invoiceDate", header: "التاريخ", accessorFn: (i) => fmtDate(i.invoiceDate), meta: { kind: "date" }, cell: ({ row }) => <bdi dir="ltr">{fmtDate(row.original.invoiceDate)}</bdi> },
    { id: "sourceType", header: "المصدر", accessorFn: (i) => sourceTypeLabel(i.sourceType), cell: ({ row }) => <span className="text-xs">{sourceTypeLabel(row.original.sourceType)}</span> },
    stmtMoneyCol<StmtInvoiceRow>("total", "الصافي الحالي", (i) => i.currentTotal, undefined, "font-semibold", (i) => onDrilldown({ type: "INVOICE", invoiceId: i.id })),
    stmtMoneyCol<StmtInvoiceRow>("paidAmount", "المدفوع", (i) => i.paidAmount),
    stmtMoneyCol<StmtInvoiceRow>("remaining", "المتبقي", (i) => i.remainingAmount, undefined, "font-semibold"),
    {
      id: "status", header: "الحالة", accessorFn: (i) => invoiceStatusLabel(i.status), meta: { kind: "status", wrap: true },
      cell: ({ row }) => (
        <div className="flex flex-col items-center gap-1">
          <Badge variant={invoiceBadgeVariant(row.original.status)}>{invoiceStatusLabel(row.original.status)}</Badge>
          {isDepositDue(row.original) && <Badge variant="warning">عربون — الباقي مستحق</Badge>}
        </div>
      ),
    },
    {
      id: "open", header: "إجراء", meta: { kind: "actions", stickyActions: false }, enableSorting: false,
      cell: ({ row }) => {
        const i = row.original;
        const canApplyOne = hasAvailableCredit && !isDeadInvoice(i.status) && D(i.remainingAmount).gt(0) && onApplyCreditToInvoice;
        return (
          <div className="flex items-center gap-1">
            {canApplyOne && <Button type="button" size="sm" variant="outline" disabled={isApplyingInvoiceCredit} onClick={() => onApplyCreditToInvoice!(i.id)}>تطبيق رصيد</Button>}
            <Link href={`/invoices/${i.id}`}><Button variant="outline" size="sm">فتح</Button></Link>
          </div>
        );
      },
    },
  ], [hasAvailableCredit, isApplyingInvoiceCredit, onApplyCreditToInvoice, onDrilldown]);

  const paymentColumns = useMemo<ColumnDef<StmtPaymentRow, unknown>[]>(() => [
    { id: "createdAt", header: "التاريخ", accessorFn: (p) => fmtDateTime(p.createdAt), meta: { kind: "datetime" }, cell: ({ row }) => <bdi dir="ltr">{fmtDateTime(row.original.createdAt)}</bdi> },
    {
      id: "ref", header: "المرجع / السند", accessorFn: (p) => p.voucherNumber ?? p.invoiceNumber ?? `#${p.id}`, meta: { kind: "code" },
      cell: ({ row }) => {
        const p = row.original;
        const label = p.voucherNumber ?? (p.invoiceNumber ? `INV-${p.invoiceNumber}` : `#${p.id}`);
        return p.id > 0 && onOpenVoucher ? <button type="button" onClick={() => onOpenVoucher(p.id)} className="font-mono text-xs text-primary underline">{label}</button> : <span className="font-mono text-xs">{label}</span>;
      },
    },
    { id: "direction", header: "النوع", accessorFn: (p) => (p.direction === "IN" ? "وارد" : "صادر/استرداد"), meta: { kind: "status" }, cell: ({ row }) => <MovementTypeBadge kind={row.original.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT"} /> },
    {
      id: "paymentMethod", header: "طريقة الدفع", accessorFn: (p) => statementMethodDisplayLabel(p.paymentMethod),
      cell: ({ row }) => (
        <PaymentMethodChip
          method={isUnifiedPaymentMethod(row.original.paymentMethod) ? row.original.paymentMethod : undefined}
          creditLabel={!isUnifiedPaymentMethod(row.original.paymentMethod) ? statementMethodDisplayLabel(row.original.paymentMethod) : undefined}
        />
      ),
    },
    stmtMoneyCol<StmtPaymentRow>("amount", "المبلغ", (p) => p.amount, undefined, "font-semibold", (p) => (p.id > 0 && onOpenVoucher ? onOpenVoucher(p.id) : onDrilldown({ type: "VOUCHER", receiptId: p.id }))),
    { id: "createdBy", header: "المنفذ", accessorFn: (p) => p.createdByName ?? "غير موثق", meta: { kind: "actor" }, cell: ({ row }) => <span className="text-xs">{row.original.createdByName ?? "غير موثق"}</span> },
  ], [onDrilldown, onOpenVoucher]);

  return (
    <div className="space-y-2.5">
      {hasUnsettledMismatch && (
        <Card className="border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]/40 shadow-sm">
          <CardContent className="p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="size-4 text-[var(--sem-warn)] mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="font-semibold text-[var(--sem-warn)]">يوجد رصيد دائن غير مخصص وفواتير مفتوحة</div>
                <p className="text-muted-foreground">يمكنك تطبيق الرصيد الدائن تلقائياً على الفواتير المفتوحة دون قبض نقد جديد.</p>
              </div>
            </div>
            <Button size="sm" className="shrink-0 gap-1.5" disabled={!canAutoSettle || isAutoSettling} onClick={onAutoSettle}>
              <RefreshCw className={`size-3.5 ${isAutoSettling ? "animate-spin" : ""}`} />
              <span>تطبيق الرصيد الدائن على الفواتير المفتوحة</span>
            </Button>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="ledger" className="w-full">
        <TabsList>
          <TabsTrigger value="ledger" className="text-xs">دفتر الحركات الموحد ({ledgerRows.length})</TabsTrigger>
          <TabsTrigger value="invoices" className="text-xs">الفواتير ({invoices.length})</TabsTrigger>
          <TabsTrigger value="payments" className="text-xs">الدفعات والاستردادات ({payments.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="ledger" className="mt-2">
          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 border-b bg-muted/30">
                <div className="flex flex-wrap gap-1">
                  {([["all", "الكل"], ["sale", "فواتير"], ["pay", "سندات وتحصيلات"], ["adj", "مرتجعات وتسويات"]] as const).map(([key, label]) => (
                    <Button key={key} type="button" size="sm" variant={ledgerGroup === key ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setLedgerGroup(key)}>{label}</Button>
                  ))}
                </div>
                <UnifiedSearchInput value={ledgerSearch} onChange={setLedgerSearch} debounceMs={0} barcode={false} size="compact" placeholder="بحث في الحركات…" className="w-56" />
              </div>
              {(from || !D(openingBalance).isZero()) && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-[var(--sem-warn-bg)]/50 px-3 py-1.5 text-xs font-medium">
                  <span>{from ? <>رصيد مرحل قبل <bdi dir="ltr">{from}</bdi></> : "الرصيد الافتتاحي (ما قبل الحركات)"}</span>
                  <span className="tabular-nums font-semibold" dir="ltr">{fmt(openingBalance)}</span>
                </div>
              )}
              <DataTable<CustomerLedgerRow> embedded bounded={false} pageSize={Infinity} columns={ledgerColumns} data={filteredLedgerRows} searchable={false} emptyText="لا حركات في هذا النطاق." />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="invoices" className="mt-2">
          <Card>
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 p-2.5">
                <span className="text-xs font-medium">تفصيل الفواتير</span>
                <AppSelect className="h-8 px-2 text-xs" value={invoiceFilter} onValueChange={(value) => onInvoiceFilterChange(value as typeof invoiceFilter)}>
                  <option value="ALL">كل الفواتير</option>
                  <option value="DEPOSIT_DUE">عربون — متبق للتحصيل</option>
                  <option value="OUTSTANDING">عليها مبلغ متبق</option>
                  <option value="SETTLED">مسواة بالكامل</option>
                </AppSelect>
              </div>
              <DataTable<StmtInvoiceRow>
                columns={invoiceColumns} data={shownInvoices} searchable={false} externalFiltersActive={invoiceFilter !== "ALL"}
                getRowClassName={(i) => (isDepositDue(i) ? "!bg-[var(--sem-warn-bg)] shadow-[inset_-3px_0_0_var(--sem-warn)]" : undefined)}
                emptyText="لا فواتير مطابقة لهذا الفلتر."
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments" className="mt-2">
          <Card><CardContent className="p-0"><DataTable<StmtPaymentRow> columns={paymentColumns} data={payments} searchable={false} emptyText="لا دفعات." /></CardContent></Card>
        </TabsContent>
      </Tabs>

      {((fulfillmentCharges?.length ?? 0) > 0 || D(fulfillmentHeldExcess ?? "0").gt(0)) && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="text-sm font-medium">الأجور الإضافية وأمانات فائض القبض</div>
            <p className="text-xs">أمانة فائض القبض القابلة للرد: <bdi dir="ltr">{fmt(fulfillmentHeldExcess ?? "0")} د.ع</bdi> — منفصلة عن الذمم</p>
            <DataTable
              data={fulfillmentCharges ?? []} searchable={false}
              columns={[
                { accessorKey: "id", header: "مستند الأجر" },
                { accessorKey: "description", header: "البيان" },
                { accessorKey: "amount", header: "أجر العميل", meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.amount) },
                { accessorKey: "paidAmount", header: "المقبوض", meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.paidAmount) },
                { accessorKey: "refundedAmount", header: "المردود", meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.refundedAmount) },
                { accessorKey: "remainingAmount", header: "المتبقي", meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.remainingAmount) },
                { id: "source", header: "المصدر", cell: () => <Link className="underline text-primary" href="/delivery?tab=fulfillment&kind=charges">تفاصيل الأجور</Link> },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
