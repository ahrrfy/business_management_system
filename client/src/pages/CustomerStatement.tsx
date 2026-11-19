import { CopyInline } from "@/components/CopyButton";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { AccountLedgerDrilldownDialog, type DrilldownTarget } from "@/components/financial/AccountLedgerDrilldownDialog";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { StatementReconcile } from "@/components/StatementReconcile";
import { AccountHealthBanner } from "@/components/statements/AccountHealthBanner";
import { CustomerLedgerSection } from "@/components/statements/CustomerLedgerSection";
import {
  BatchInvoicePrintDialog,
  PartyCommandBar,
  StatementPeriodDetailBar,
  type StatementDetailLevel,
} from "@/components/statements/PartyCommandBar";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QuickVoucherSheet } from "@/components/vouchers/QuickVoucherSheet";
import { VoucherDetailDrawer } from "@/components/vouchers/VoucherDetailDrawer";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatStatementAsWhatsApp, formatTableAsTSV } from "@/lib/copy/formatters";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { priceTierLabel } from "@/lib/labels";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { printCustomerStmt } from "@/lib/printing/printTemplates";
import { customerStatementLedger, statementClosingBalance } from "@/lib/statementPeriodLedger";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { buildStatementMessage, toIraqiIntl } from "@/lib/whatsapp";
import { balanceDirectionLabel } from "@shared/balanceTrail";
import { isDeadInvoice } from "@shared/predicates";
import { fmtQty } from "@shared/quantityFormat";
import { FileText, Phone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";

type CustomerStatementData = NonNullable<RouterOutputs["reports"]["customerStatement"]>;
type StmtPaymentRow = CustomerStatementData["payments"][number];

export default function CustomerStatement() {
  const { can } = useCatalogPeopleOperationAccess();
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const customerId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);
  const selectCustomer = (id: number) => {
    const p = new URLSearchParams(search);
    if (id) p.set("id", String(id));
    else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  };

  const [periodF, setPeriodF] = useUrlFilters({ from: "", to: "", filter: "ALL" });
  const from = periodF.from;
  const to = periodF.to;
  const invoiceFilter = periodF.filter as "ALL" | "DEPOSIT_DUE" | "OUTSTANDING" | "SETTLED";
  const setInvoiceFilter = (v: string) => setPeriodF({ filter: v });
  const [detailLevel, setDetailLevel] = useState<StatementDetailLevel>("normal");

  const index = trpc.reports.customersIndex.useQuery(undefined, { enabled: can("reports.customersIndex") });
  const stmt = trpc.reports.customerStatement.useQuery(
    { customerId: customerId || 0, from: from || undefined, to: to || undefined, includeItems: detailLevel === "detailed" },
    { enabled: can("reports.customerStatement") && !!customerId },
  );
  const journal = trpc.reports.customerJournalBreakdown.useQuery(
    { customerId: customerId || 0, from: from || undefined, to: to || undefined },
    { enabled: can("reports.customerJournalBreakdown") && !!customerId },
  );

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const canWriteVoucher = treasuryOperationAllowed(
    me.data,
    "vouchers.create",
    me.data?.role === "manager" || me.data?.role === "accountant" || Boolean(me.data?.isOwner),
  );
  const printAudit = usePrintAudit();
  const [drilldownTarget, setDrilldownTarget] = useState<DrilldownTarget | null>(null);
  const [drawerVoucherId, setDrawerVoucherId] = useState<number | null>(null);
  const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);
  const [quickVoucherType, setQuickVoucherType] = useState<"PAYMENT" | "RECEIPT" | null>(null);
  const [batchPrintOpen, setBatchPrintOpen] = useState(false);

  const refreshAll = () => {
    void utils.reports.customerStatement.invalidate();
    void utils.reports.arAging.invalidate();
    void utils.customers.invalidate();
  };

  const autoSettleM = trpc.customers.autoSettle.useMutation({
    onSuccess: (res) => {
      notify.ok(
        "تمت تسوية الحساب بنجاح",
        `سُوّيت ${res.settledInvoicesCount} فاتورة مفتوحة بمبلغ ${fmt(res.totalSettledAmount)} د.ع.`,
      );
      refreshAll();
    },
    onError: (err) => notify.err(err.message),
  });

  const applyCreditM = trpc.sales.pay.useMutation({
    onSuccess: (res) => {
      const applied = (res as { creditApplied?: string }).creditApplied;
      notify.ok(
        "تم تطبيق الرصيد الدائن بنجاح",
        applied ? `تم تسديد مبلغ ${fmt(applied)} د.ع من رصيد العميل دون حركة نقدية.` : "تم تحديث حالة الفاتورة من رصيد العميل.",
      );
      refreshAll();
    },
    onError: (err) => notify.err(err.message),
  });

  const openInvoicesCount = useMemo(() => {
    return (stmt.data?.invoices ?? []).filter((i) => {
      const remaining = D(i.remainingAmount);
      const active = !isDeadInvoice(i.status);
      return active && remaining.gt(0);
    }).length;
  }, [stmt.data?.invoices]);

  const hasUnsettledMismatch = useMemo(() => {
    if (!stmt.data) return false;
    const bal = D(stmt.data.summary.currentBalance);
    const unpaid = D(stmt.data.summary.unpaid);
    return openInvoicesCount > 0 && (bal.lte(0) || unpaid.gt(bal));
  }, [stmt.data, openInvoicesCount]);

  // دفتر الحركات الموحد — مصدر الحقيقة للجدول والطباعة والتصدير ومعادلة الرصيد.
  const ledger = useMemo(() => {
    if (!stmt.data) return null;
    const chargeRows = new Map<string, StmtPaymentRow>();
    const payments = stmt.data.payments.map((payment) => {
      if (payment.paymentMethod !== "CHARGE_ADJUSTMENT") return payment;
      const ref = `\u0000charge:${payment.id}`;
      chargeRows.set(ref, payment);
      return { ...payment, voucherNumber: ref };
    });
    const openingBeforeFrom =
      (stmt.data.summary as { openingBeforeFrom?: string }).openingBeforeFrom ?? stmt.data.summary.openingBalance;
    const result = customerStatementLedger({
      ...stmt.data,
      summary: { ...stmt.data.summary, openingBalance: openingBeforeFrom },
      payments,
    });
    return {
      ...result,
      openingBeforeFrom,
      periodClosing: result.closingBalance,
      txs: result.txs.map((row) => {
        const charge = chargeRows.get(row.ref);
        return charge
          ? {
              ...row,
              ref: charge.voucherNumber ?? "أجر إضافي",
              description: charge.description ?? "مطالبة أو عكس أجر إضافي",
            }
          : row;
      }),
    };
  }, [stmt.data]);

  const scopedBranchId = stmt.data?.summary.scopedBranchId;
  const reportScopeLabel = scopedBranchId
    ? (branches.data?.find((b) => b.id === scopedBranchId)?.name ?? `الفرع #${scopedBranchId}`)
    : "الشركة (كل الفروع)";
  const reportScopeMeta = stmt.data
    ? [
        { label: "نطاق الكشف", value: reportScopeLabel },
        { label: "الفترة", value: `${from || "البداية"} — ${to || "الآن"}` },
        { label: "رصيد الشركة الحالي (كل الفروع)", value: fmt(stmt.data.summary.companyCurrentBalance) },
      ]
    : [];

  const copyPayload = useMemo(() => {
    if (!stmt.data || !ledger) return { plain: "", whatsapp: "", tsv: "" };
    const d = stmt.data;
    const plain = buildStatementMessage({
      entityName: d.customer.name,
      entityType: "customer",
      currentBalance: d.summary.companyCurrentBalance,
      scopeLabel: reportScopeLabel,
      scopedBalance: d.summary.scopedBranchId ? d.summary.currentBalance : undefined,
      totalSales: d.summary.totalSales,
      totalPaid: d.summary.totalPaid,
      unpaid: d.summary.unpaid,
    });
    const whatsapp = formatStatementAsWhatsApp({
      scopeLabel: reportScopeLabel,
      companyCurrentBalance: d.summary.companyCurrentBalance,
      entityName: d.customer.name,
      entityType: "customer",
      lines: ledger.txs.map((r) => ({
        date: r.date,
        doc: `${r.ref} — ${r.description}`,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
      })),
      closingBalance: statementClosingBalance(from, to, ledger.closingBalance, d.summary.currentBalance),
      asOfDate: to || undefined,
    });
    const tsv =
      `${reportScopeLabel}\nرصيد الشركة الحالي (كل الفروع): ${fmt(d.summary.companyCurrentBalance)}\n` +
      formatTableAsTSV(
        ["التاريخ", "المرجع", "البيان", "المنفذ", "مدين", "دائن", "قبل", "الرصيد"],
        ledger.txs.map((r) => ({
          "التاريخ": r.date,
          "المرجع": r.ref,
          "البيان": r.description,
          "المنفذ": r.actor,
          "مدين": r.debit == null ? "" : r.debit,
          "دائن": r.credit == null ? "" : r.credit,
          "قبل": r.balanceBefore,
          "الرصيد": r.balance,
        })),
      );
    return { plain, whatsapp, tsv };
  }, [stmt.data, ledger, from, to, reportScopeLabel]);

  const exportStatement = (format?: "csv") => {
    if (!stmt.data || !ledger) return;
    exportRows(ledger.txs, {
      filename: `كشف-حساب-${stmt.data.customer.name}`,
      meta: reportScopeMeta,
      ...(format === "csv" ? { format: "csv" as const, title: `كشف حساب عميل — ${stmt.data.customer.name}` } : {}),
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "ref", header: "المرجع" },
        { key: "description", header: "البيان" },
        { key: "actor", header: "المنفذ" },
        { key: "debit", header: "مدين", map: (r) => (r.debit == null ? 0 : D(r.debit).toNumber()) },
        { key: "credit", header: "دائن", map: (r) => (r.credit == null ? 0 : D(r.credit).toNumber()) },
        { key: "balanceBefore", header: "قبل", map: (r) => D(r.balanceBefore).toNumber() },
        { key: "balance", header: "الرصيد", map: (r) => D(r.balance).toNumber() },
        ...(detailLevel === "detailed"
          ? [
              {
                key: "items" as const,
                header: "بنود الأصناف",
                map: (r: (typeof ledger.txs)[number]) =>
                  r.items?.length
                    ? r.items.map((it) => `${it.productName} × ${fmtQty(it.quantity)} = ${fmt(it.total)}`).join(" | ")
                    : "",
              },
            ]
          : []),
      ],
    });
  };

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
        open: (audit) =>
          printCustomerStmt({
            customerName: d.customer.name,
            customerPhone: d.customer.phone ?? undefined,
            fromDate: from ? fmtDate(new Date(`${from}T00:00:00`)) : undefined,
            toDate: fmtDate(to ? new Date(`${to}T00:00:00`) : new Date()),
            transactions: txs.map((t) => ({
              ...t,
              items: detailLevel === "detailed" ? t.items : undefined,
            })),
            totalDebit: totDebit,
            totalCredit: totCredit,
            openingBalance: ledger.openingBeforeFrom,
            scopeLabel: reportScopeLabel,
            companyCurrentBalance: d.summary.companyCurrentBalance,
            currentBalance: d.summary.currentBalance,
            closingBalance: statementClosingBalance(from, to, closingBalance, d.summary.currentBalance),
            heldDepositsTotal: d.summary.heldDepositsTotal ?? null,
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
    <div className="space-y-2.5">
      <PageHeader
        breadcrumbs={[{ label: "العملاء", href: "/customers" }, { label: "كشف حساب" }]}
        title="كشف حساب عميل"
        description="كل الفواتير والدفعات لعميل واحد، مع ملخّص الرصيد الحالي."
        actions={
          <>
            {stmt.data && (
              <Button variant="outline" size="sm" disabled={printAudit.pending} onClick={() => void printStatement()}>
                طباعة / PDF الكشف
              </Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.txs.length}
                onClick={() => exportStatement()}
              >
                تصدير Excel
              </Button>
            )}
            {stmt.data && (
              <Button
                variant="outline"
                size="sm"
                disabled={!ledger?.txs.length}
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
                phone={stmt.data.customer.phone}
                message={copyPayload.plain}
                label="إرسال كشف الحساب"
              />
            )}
            <Link href="/ar-aging"><Button variant="outline">أعمار الذمم</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="p-2.5 space-y-2.5">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">العميل</Label>
            <CustomerSearchPicker
              customers={index.data ?? []}
              value={customerId}
              onChange={selectCustomer}
            />
          </div>
          <StatementPeriodDetailBar
            from={from}
            to={to}
            onRangeChange={({ from: nextF, to: nextT }) => setPeriodF({ from: nextF, to: nextT })}
            detailLevel={detailLevel}
            onDetailLevelChange={setDetailLevel}
          />
        </CardContent>
      </Card>

      {!customerId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر عميلاً لعرض كشف الحساب.</p>
      )}

      {customerId > 0 && stmt.isLoading && <LoadingState />}

      {customerId > 0 && stmt.isError && (
        <ErrorState message={stmt.error?.message} onRetry={() => stmt.refetch()} />
      )}

      {stmt.data && ledger && (
        <>
          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="flex items-start justify-between flex-wrap gap-2.5">
                <div>
                  <div className="text-base font-semibold">{stmt.data.customer.name}</div>
                  {stmt.data.customer.phone && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <a
                        href={`tel:${toIraqiIntl(stmt.data.customer.phone) || stmt.data.customer.phone}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        dir="ltr"
                      >
                        <Phone className="size-3" />
                        {stmt.data.customer.phone}
                      </a>
                      <CopyInline value={stmt.data.customer.phone} />
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {stmt.data.customer.customerType} · فئة سعرية {priceTierLabel(stmt.data.customer.defaultPriceTier)}
                    {stmt.data.customer.creditLimit && D(stmt.data.customer.creditLimit).gt(0)
                      ? ` · سقف ائتمان ${fmt(stmt.data.customer.creditLimit)}`
                      : ""}
                  </div>
                </div>
                <PartyCommandBar
                  partyType="CUSTOMER"
                  partyName={stmt.data.customer.name}
                  whatsappMessage={copyPayload.plain}
                  canWriteVoucher={canWriteVoucher}
                  onOpenQuickVoucher={(t) => setQuickVoucherType(t)}
                  onOpenDossier={() => setDossierCustomerId(customerId)}
                  onOpenBatchPrint={() => setBatchPrintOpen(true)}
                />
              </div>

              <AccountHealthBanner partyType="CUSTOMER" partyId={customerId} onResolved={refreshAll} />

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 text-sm">
                <StatBalance
                  label={stmt.data.summary.scopedBranchId == null ? "الرصيد الحالي" : "رصيد الفرع الحالي"}
                  value={stmt.data.summary.currentBalance}
                />
                {stmt.data.summary.scopedBranchId != null && (
                  <StatBalance label="رصيد الشركة عبر الفروع" value={stmt.data.summary.companyCurrentBalance} />
                )}
                <Stat
                  label={from ? "الرصيد الافتتاحي (ما قبل الفترة)" : "الرصيد الافتتاحي"}
                  value={ledger.openingBeforeFrom}
                />
                <Stat
                  label="إجمالي المبيعات (مدين)"
                  value={ledger.totDebit}
                  sub={!D(ledger.totDebit).eq(D(stmt.data.summary.totalSales))
                    ? `صافي الفواتير: ${fmt(stmt.data.summary.totalSales)}`
                    : undefined}
                />
                <Stat
                  label="إجمالي المحصل والمرتجعات (دائن)"
                  value={ledger.totCredit}
                  sub={!D(ledger.totCredit).eq(D(stmt.data.summary.totalPaid))
                    ? `المقبوض على الفواتير: ${fmt(stmt.data.summary.totalPaid)}`
                    : undefined}
                />
                <Stat label="فواتير غير مدفوعة" value={stmt.data.summary.unpaid} emphasis />
                <Stat
                  label="رصيد غير مفوتر (يشمل الافتتاحي)"
                  value={D(stmt.data.summary.currentBalance).minus(D(stmt.data.summary.unpaid)).toFixed(2)}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">
                  معادلة الرصيد: الافتتاحي (<bdi dir="ltr">{fmt(ledger.openingBeforeFrom)}</bdi>) + المدين (<bdi dir="ltr">{fmt(ledger.totDebit)}</bdi>) − الدائن (<bdi dir="ltr">{fmt(ledger.totCredit)}</bdi>) = صافي نهاية الفترة (<bdi dir="ltr">{fmt(ledger.periodClosing)}</bdi>)
                </span>
                {!from && !to && !D(ledger.periodClosing).eq(D(stmt.data.summary.currentBalance)) && (
                  <Badge variant="warning">
                    فرق عن الرصيد المسجل: <bdi dir="ltr">{fmt(D(stmt.data.summary.currentBalance).minus(D(ledger.periodClosing)).toFixed(2))}</bdi>
                  </Badge>
                )}
              </div>

              {D(stmt.data.summary.heldDepositsTotal ?? 0).gt(0) && (
                <div className="rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-3 py-2 text-xs font-bold text-[var(--sem-info)]">
                  عربون قيد الاحتجاز — غير مطبق على فاتورة: <bdi dir="ltr">{fmt(stmt.data.summary.heldDepositsTotal)} د.ع</bdi>
                  <span className="ms-2 font-semibold text-muted-foreground">(يخصم من الطلب عند تثبيته أو يسترد بسنده)</span>
                </div>
              )}
            </CardContent>
          </Card>

          <StatementReconcile
            entityName={stmt.data.customer.name}
            entityType="customer"
            phone={stmt.data.customer.phone}
            currentBalance={stmt.data.summary.companyCurrentBalance}
            onPdf={printStatement}
          />

          <CustomerLedgerSection
            customerId={customerId}
            from={from}
            openingBalance={ledger.openingBeforeFrom}
            currentBalance={stmt.data.summary.currentBalance}
            unallocatedCredit={(stmt.data.summary as { unallocatedCredit?: string }).unallocatedCredit ?? null}
            detailLevel={detailLevel}
            ledgerRows={ledger.txs}
            invoices={stmt.data.invoices}
            payments={stmt.data.payments}
            fulfillmentCharges={stmt.data.fulfillmentCharges}
            fulfillmentHeldExcess={stmt.data.fulfillmentHeldExcess}
            invoiceFilter={invoiceFilter}
            onInvoiceFilterChange={setInvoiceFilter}
            hasUnsettledMismatch={hasUnsettledMismatch}
            canAutoSettle={can("customers.autoSettle")}
            isAutoSettling={autoSettleM.isPending}
            onAutoSettle={() => autoSettleM.mutate({ customerId })}
            onApplyCreditToInvoice={(invoiceId) => applyCreditM.mutate({ invoiceId, useCustomerCredit: true })}
            isApplyingInvoiceCredit={applyCreditM.isPending}
            onDrilldown={(target) => setDrilldownTarget(target)}
            onOpenVoucher={(receiptId) => setDrawerVoucherId(receiptId)}
          />

          {(journal.data?.rows.length ?? 0) > 0 && (
            <Card>
              <CardContent className="p-0">
                <div className="p-3 border-b bg-muted/30 text-sm font-medium">
                  التفصيل المحاسبي (الدفتر المزدوج) — {journal.data?.rows.length} حساب
                </div>
                <ScrollTableShell bordered={false}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-start">الكود</TableHead>
                        <TableHead className="text-start">الحساب</TableHead>
                        <TableHead className="text-start">النوع</TableHead>
                        <TableHead className="text-end">مدين</TableHead>
                        <TableHead className="text-end">دائن</TableHead>
                        <TableHead className="text-end">الصافي</TableHead>
                        <TableHead className="text-center">أسطر</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {journal.data?.rows.map((r) => (
                        <TableRow key={r.accountId}>
                          <TableCell className="font-mono text-xs" dir="ltr">{r.code}</TableCell>
                          <TableCell>{r.name}</TableCell>
                          <TableCell className="text-xs">{r.type}</TableCell>
                          <TableCell className="text-end tabular-nums" dir="ltr">{fmt(r.debitTotal)}</TableCell>
                          <TableCell className="text-end tabular-nums" dir="ltr">{fmt(r.creditTotal)}</TableCell>
                          <TableCell className="text-end tabular-nums font-semibold" dir="ltr">{fmt(r.net)}</TableCell>
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

      <AccountLedgerDrilldownDialog
        target={drilldownTarget}
        open={!!drilldownTarget}
        onOpenChange={(open) => !open && setDrilldownTarget(null)}
      />

      <VoucherDetailDrawer
        voucherId={drawerVoucherId}
        open={drawerVoucherId != null}
        onOpenChange={(o) => !o && setDrawerVoucherId(null)}
        onActionSuccess={refreshAll}
      />

      <CustomerDossierDrawer
        customerId={dossierCustomerId}
        open={dossierCustomerId != null}
        onClose={() => setDossierCustomerId(null)}
      />

      {stmt.data && canWriteVoucher && quickVoucherType && (
        <QuickVoucherSheet
          open={!!quickVoucherType}
          onOpenChange={(o) => !o && setQuickVoucherType(null)}
          defaultType={quickVoucherType}
          defaultPartyType="CUSTOMER"
          defaultPartyId={customerId}
          defaultPartyName={stmt.data.customer.name}
          currentBalance={stmt.data.summary.currentBalance}
          pendingReserved={stmt.data.summary.heldDepositsTotal ?? undefined}
          onSuccess={refreshAll}
        />
      )}

      {stmt.data && batchPrintOpen && (
        <BatchInvoicePrintDialog
          open={batchPrintOpen}
          onOpenChange={setBatchPrintOpen}
          partyType="CUSTOMER"
          partyId={customerId}
          partyName={stmt.data.customer.name}
          partyPhone={stmt.data.customer.phone}
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

function StatBalance({ label, value }: { label: string; value: string | number }) {
  const numD = D(value);
  const pos = numD.gt(0);
  const neg = numD.lt(0);
  return (
    <div className={`rounded-md px-2.5 py-2 ${pos ? "badge-status-active" : neg ? "badge-stock-out" : "bg-muted/40"}`}>
      <div className="text-[11px] opacity-80 leading-tight">{label}</div>
      <div className={`tabular-nums text-base font-bold ${pos ? "text-money-positive" : neg ? "text-money-negative" : ""}`} dir="ltr">
        {fmt(numD.abs().toFixed(2))}
      </div>
      <div className={`text-xs font-semibold ${pos ? "text-money-positive" : neg ? "text-money-negative" : "text-muted-foreground"}`}>
        {numD.isZero() ? "متوازن" : balanceDirectionLabel("CUSTOMER", numD)}
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
    if (!q) return customers.slice(0, 50);
    const lower = q.toLowerCase();
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
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); setQ(""); }
  }

  return (
    <div ref={wrapRef} className="relative">
      <UnifiedSearchInput
        ref={inputRef}
        value={display}
        debounceMs={0}
        barcode={false}
        onChange={(val) => { setQ(val); setOpen(true); }}
        onClear={() => { onChange(0); setQ(""); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="ابحث بالاسم أو الهاتف…"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
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
                className={`w-full text-start px-3 py-2 text-sm hover:bg-accent ${i === highlight ? "bg-accent" : ""} ${c.id === value ? "font-bold" : ""}`}
              >
                <div>{c.name}</div>
                {c.phone && <div className="text-xs text-muted-foreground" dir="ltr">{c.phone}</div>}
              </button>
            ))
          )}
          {customers.length > filtered.length && q === "" && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30 text-center">
              يَعرض ٥٠ من أصل {customers.length} — اكتب للبحث
            </div>
          )}
        </div>
      )}
    </div>
  );
}
