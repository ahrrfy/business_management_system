// دفتر أستاذ حساب واحد من القيود المزدوجة — رصيد افتتاحي وجارٍ مع أثر مستندي وتصدير شامل.
import { useEffect, useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { DataTable } from "@/components/data-table/DataTable";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import {
  DEFAULT_PERIOD,
  PeriodFilter,
  type PeriodValue,
} from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState } from "@/components/PageState";
import { D, fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { clampDoubleEntryReportPeriod } from "@/lib/doubleEntryReportPeriod";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { splitDocumentNotes } from "@/components/invoice/TermsAndNotes";

function cleanLedgerNotes(raw: string | null | undefined): string {
  if (!raw) return "";
  const parsed = splitDocumentNotes(raw);
  return parsed.notes || (parsed.poReference ? `مرجع: ${parsed.poReference}` : "") || raw;
}

type Result = RouterOutputs["reports"]["generalLedger"];
type Row = Result["rows"][number];
type Account = RouterOutputs["accounts"]["list"][number];

const PAGE_SIZE = 100;
const selectCls =
  "h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SIDE_LABEL: Record<string, string> = {
  DEBIT: "مدين",
  CREDIT: "دائن",
  ZERO: "صفر",
};
const ENTRY_LABEL: Record<string, string> = {
  SHADOW_OPENING: "رصيد افتتاح SHADOW",
  SALE: "بيع",
  PURCHASE: "شراء",
  PAYMENT_IN: "قبض",
  PAYMENT_OUT: "صرف",
  RETURN: "مرتجع",
  ADJUST: "تسوية",
  OPENING: "افتتاحي",
  INTERNAL_USE: "استخدام داخلي",
  WASTAGE: "تالف وهدر",
  GIFT_OUT: "هدية صادرة",
  CASH_HANDOVER: "تسليم درج للخزينة",
  CASH_TRANSFER_OUT: "تحويل نقدي صادر",
  CASH_TRANSFER_IN: "تحويل نقدي وارد",
  SHIFT_FLOAT_OUT: "عهدة تمويل وردية",
  TREASURY_FUNDING: "تمويل خزينة",
  DELIVERY_DISPATCH: "عهدة توصيل",
  DELIVERY_REMIT: "توريد توصيل",
  DELIVERY_FEE: "مصروف توصيل",
  DELIVERY_FEE_HELD: "أجرة توصيل محتجزة",
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

function sourceView(row: Row): { label: string; href?: string } {
  if (row.sourceType === "SHADOW_OPENING") {
    return { label: "لقطة الرصيد الافتتاحي" };
  }
  if (row.invoiceId) {
    return {
      label: row.invoiceNumber ?? `فاتورة #${row.invoiceId}`,
      href: `/invoices/${row.invoiceId}`,
    };
  }
  if (row.purchaseOrderId) return { label: `أمر شراء #${row.purchaseOrderId}` };
  if (row.voucherNumber)
    return { label: row.voucherNumber, href: "/treasury?tab=vouchers" };
  if (row.receiptId)
    return { label: `إيصال #${row.receiptId}`, href: "/treasury?tab=vouchers" };
  return {
    label: row.entryId == null ? "مصدر غير مربوط" : `قيد #${row.entryId}`,
  };
}

function ModeNotice({ result, availableFrom }: { result: Result; availableFrom: string | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {result.mode === "SHADOW" ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--sem-warn)]">
            <Info aria-hidden className="size-3.5 shrink-0" />
            للمطابقة فقط (وضع الظل منذ {result.shadowStartedAt ?? "غير مسجّل"}) — الدفتر المعتمد ما زال المبسّط.
          </span>
        ) : result.mode === "OFF" ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-[var(--sem-warn)]" />
            الدفتر المزدوج متوقف؛ لا تعتمد هذا الكشف كدفتر حي.
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--sem-pos)]">
            <CheckCircle2 aria-hidden className="size-3.5 shrink-0" />
            الدفتر المزدوج في وضع ACTIVE.
          </span>
        )}
      </div>
      {availableFrom && (
        <span className="text-muted-foreground" title="ضُبطت الفترة تلقائياً؛ دفتر الأستاذ لا يدّعي حركةً أو رصيداً قبل لقطة القطع الحالية.">
          بداية تغطية الدورة: <strong className="font-mono text-foreground" dir="ltr">{availableFrom}</strong>
        </span>
      )}
    </div>
  );
}

export default function GeneralLedger() {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const me = trpc.auth.me.useQuery();
  const availability = trpc.reports.doubleEntryReportAvailability.useQuery();
  const availableFrom = availability.data?.availableFrom ?? null;
  const accounts = trpc.accounts.list.useQuery();
  const postingAccounts = useMemo(
    () => (accounts.data ?? []).filter((account) => account.systemRole != null),
    [accounts.data],
  );
  useEffect(() => {
    if (accountId == null && postingAccounts.length > 0)
      setAccountId(postingAccounts[0].id);
  }, [accountId, postingAccounts]);
  useEffect(() => {
    setPeriod((current) =>
      clampDoubleEntryReportPeriod(current, availableFrom),
    );
  }, [availableFrom]);
  const canChooseBranch = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, {
    enabled: canChooseBranch,
  });
  const filterInput = {
    accountId: accountId ?? 1,
    from: period.from,
    to: period.to,
    branchId: canChooseBranch && branchId ? Number(branchId) : undefined,
  };
  const q = trpc.reports.generalLedger.useQuery(
    { ...filterInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    {
      enabled:
        accountId != null &&
        period.from <= period.to &&
        (!availableFrom || period.from >= availableFrom),
    },
  );
  const result = q.data;

  function changePeriod(next: PeriodValue) {
    setPeriod(clampDoubleEntryReportPeriod(next, availableFrom));
    setPage(0);
  }

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      { accessorKey: "entryDate", header: "التاريخ" },
      {
        id: "entry",
        header: "القيد",
        accessorFn: (row) => row.entryId ?? row.journalId,
        cell: ({ row }) => (
          <div>
            <p className="font-medium">
              {row.original.entryId == null
                ? `يومية #${row.original.journalId}`
                : `#${row.original.entryId}`}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {ENTRY_LABEL[row.original.entryType] ?? row.original.entryType}
            </p>
          </div>
        ),
      },
      {
        id: "source",
        header: "المستند المصدر",
        accessorFn: (row) => sourceView(row).label,
        cell: ({ row }) => {
          const source = sourceView(row.original);
          return source.href ? (
            <Link
              href={source.href}
              className="font-medium text-primary hover:underline"
            >
              {source.label}
            </Link>
          ) : (
            source.label
          );
        },
      },
      {
        id: "description",
        header: "البيان / الطرف",
        accessorFn: (row) =>
          cleanLedgerNotes(row.notes) || row.customerName || row.supplierName || "",
        cell: ({ row }) => (
          <div className="max-w-80 whitespace-normal">
            <p>
              {cleanLedgerNotes(row.original.notes) ||
                ENTRY_LABEL[row.original.entryType] ||
                row.original.entryType}
            </p>
            {(row.original.customerName || row.original.supplierName) && (
              <p className="text-[10px] text-muted-foreground">
                {row.original.customerName ?? row.original.supplierName}
              </p>
            )}
          </div>
        ),
      },
      {
        accessorKey: "debit",
        header: "مدين",
        meta: { kind: "money" },
        cell: ({ row }) => <Money value={row.original.debit} />,
      },
      {
        accessorKey: "credit",
        header: "دائن",
        meta: { kind: "money" },
        cell: ({ row }) => <Money value={row.original.credit} />,
      },
      {
        id: "balance",
        header: "الرصيد الجاري",
        accessorFn: (row) => row.runningBalance,
        meta: { kind: "money" },
        cell: ({ row }) => (
          <div className="tabular-nums" dir="ltr">
            <span className="font-semibold">
              {fmtAr(row.original.runningBalance)}
            </span>
            <span className="ms-1 text-[10px] text-muted-foreground">
              {SIDE_LABEL[row.original.runningSide]}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "branchName",
        header: "الفرع",
        cell: ({ row }) => row.original.branchName ?? "عام",
      },
    ],
    [],
  );

  const operation = useMemo(
    () => ({
      getOperation: (row: Row) => ({
        actor: {
          name: row.createdByName,
          source: row.createdByName ? ("user" as const) : ("legacy" as const),
        },
        action: {
          code: `accounting.${row.entryType}`,
          label: ENTRY_LABEL[row.entryType] ?? row.entryType,
        },
        subject: {
          type: "accountingEntry",
          label: sourceView(row).label,
        },
        at: row.createdAt,
      }),
      label: "تتبّع القيد",
    }),
    [],
  );

  const kpis: KpiItem[] = result
    ? [
        {
          label: "الرصيد الافتتاحي",
          value: fmtAr(result.openingBalance),
          hint: SIDE_LABEL[result.openingSide],
          tone: "info",
        },
        {
          label: "مدين الفترة",
          value: fmtAr(result.totals.debit),
          tone: "info",
        },
        {
          label: "دائن الفترة",
          value: fmtAr(result.totals.credit),
          tone: "info",
        },
        {
          label: "الرصيد الختامي",
          value: fmtAr(result.totals.closingBalance),
          hint: SIDE_LABEL[result.totals.closingSide],
          tone: "info",
        },
      ]
    : [];

  const branchLabel =
    canChooseBranch && branchId
      ? (branches.data?.find((branch) => branch.id === Number(branchId))
          ?.name ?? String(branchId))
      : canChooseBranch
        ? "كل الشركة"
        : "الفرع المعيّن";

  function onExport() {
    if (!result || accountId == null) return;
    exportRows(
      () =>
        fetchAllPaged<Row>(
          (offset, limit) =>
            utils.reports.generalLedger.fetch({
              ...filterInput,
              limit,
              offset,
            }),
          { pageSize: 500 },
        ),
      {
        filename: `دفتر-الأستاذ-${result.account.code}-${period.from}-${period.to}`,
        title: `دفتر الأستاذ — ${result.account.code} ${result.account.name}`,
        meta: [
          { label: "الفترة", value: `${period.from} — ${period.to}` },
          { label: "الفرع", value: branchLabel },
          { label: "الوضع", value: result.mode },
          { label: "دورة الدفتر", value: result.cycleId ?? "غير مفعلة" },
          {
            label: "بداية تغطية الدورة",
            value: result.availableFrom ?? "لا توجد دورة مفعلة",
          },
          {
            label: "الرصيد الافتتاحي",
            value: `${fmtAr(result.openingBalance)} ${SIDE_LABEL[result.openingSide]}`,
          },
          {
            label: "فجوات قبل الفترة",
            value: String(result.openingUnmappedCount),
          },
          {
            label: "فجوات داخل الفترة",
            value: String(result.periodUnmappedCount),
          },
        ],
        columns: [
          { key: "entryDate", header: "التاريخ" },
          { key: "entryId", header: "رقم القيد" },
          {
            key: "entryType",
            header: "نوع القيد",
            map: (row) => ENTRY_LABEL[row.entryType] ?? row.entryType,
          },
          {
            key: "source",
            header: "المستند المصدر",
            map: (row) => sourceView(row).label,
          },
          { key: "notes", header: "البيان", map: (row) => cleanLedgerNotes(row.notes) },
          {
            key: "party",
            header: "الطرف",
            map: (row) => row.customerName ?? row.supplierName ?? "",
          },
          {
            key: "debit",
            header: "مدين",
            money: true,
            map: (row) => D(row.debit).toNumber(),
          },
          {
            key: "credit",
            header: "دائن",
            money: true,
            map: (row) => D(row.credit).toNumber(),
          },
          {
            key: "runningBalance",
            header: "الرصيد الجاري",
            money: true,
            map: (row) => D(row.runningBalance).toNumber(),
          },
          {
            key: "runningSide",
            header: "جهة الرصيد",
            map: (row) => SIDE_LABEL[row.runningSide],
          },
          {
            key: "branchName",
            header: "الفرع",
            map: (row) => row.branchName ?? "عام",
          },
          {
            key: "createdByName",
            header: "المنفّذ",
            map: (row) => row.createdByName ?? "غير موثّق",
          },
        ],
        totalsRow: {
          entryDate: "الإجمالي",
          debit: D(result.totals.debit).toNumber(),
          credit: D(result.totals.credit).toNumber(),
          runningBalance: D(result.totals.closingBalance).toNumber(),
          runningSide: SIDE_LABEL[result.totals.closingSide],
        },
      },
    );
  }

  async function onPrint() {
    if (!result || accountId == null) return;
    const allRows = await fetchAllPaged<Row>(
      (offset, limit) =>
        utils.reports.generalLedger.fetch({
          ...filterInput,
          limit,
          offset,
        }),
      { pageSize: 500 },
    );
    printReportDoc({
      title: `دفتر الأستاذ — ${result.account.code} ${result.account.name}`,
      orientation: "landscape",
      headerExtra: [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "الوضع", value: result.mode },
        { label: "الرصيد الافتتاحي", value: `${fmtAr(result.openingBalance)} ${SIDE_LABEL[result.openingSide]}` },
      ],
      columns: [
        { key: "entryDate", label: "التاريخ" },
        { key: "entry", label: "القيد" },
        { key: "source", label: "المستند المصدر" },
        { key: "description", label: "البيان / الطرف" },
        { key: "debit", label: "مدين", align: "left" },
        { key: "credit", label: "دائن", align: "left" },
        { key: "balance", label: "الرصيد الجاري", align: "left" },
        { key: "branchName", label: "الفرع" },
      ],
      rows: allRows.map((row) => ({
        entryDate: row.entryDate,
        entry: `${row.entryId == null ? `يومية #${row.journalId}` : `#${row.entryId}`} (${ENTRY_LABEL[row.entryType] ?? row.entryType})`,
        source: sourceView(row).label,
        description: [cleanLedgerNotes(row.notes) || ENTRY_LABEL[row.entryType] || row.entryType, row.customerName ?? row.supplierName].filter(Boolean).join(" — "),
        debit: D(row.debit).isZero() ? "—" : fmtAr(row.debit),
        credit: D(row.credit).isZero() ? "—" : fmtAr(row.credit),
        balance: `${fmtAr(row.runningBalance)} ${SIDE_LABEL[row.runningSide]}`,
        branchName: row.branchName ?? "عام",
      })),
      summary: [
        { label: "الرصيد الافتتاحي", value: `${fmtAr(result.openingBalance)} ${SIDE_LABEL[result.openingSide]}` },
        { label: "مدين الفترة", value: fmtAr(result.totals.debit) },
        { label: "دائن الفترة", value: fmtAr(result.totals.credit) },
        { label: "الرصيد الختامي", value: `${fmtAr(result.totals.closingBalance)} ${SIDE_LABEL[result.totals.closingSide]}`, large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="دفتر الأستاذ العام"
      description="حركات حساب واحد من القيود المزدوجة، مرتبة زمنياً وبرصيد جارٍ مرتبط بمستند المصدر."
      kpis={kpis}
      onExport={onExport}
      onPrint={() => void onPrint()}
      exportDisabled={!result || result.total === 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-64 flex-col gap-1 text-[11px] text-muted-foreground">
            الحساب
            <AppSelect
              className="h-9"
              searchable searchPlaceholder="ابحث برمز الحساب أو اسمه..." value={String(accountId ?? "")}
              onValueChange={(next) => {
                setAccountId(
                  next ? Number(next) : null,
                );
                setPage(0);
              }}
            >
              {postingAccounts.length === 0 && (
                <option value="">لا حسابات قابلة للترحيل</option>
              )}
              {postingAccounts.map((account: Account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </AppSelect>
          </label>
          <PeriodFilter value={period} onChange={changePeriod} />
          {canChooseBranch && (
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              الفرع
              <AppSelect
                className="h-9"
                value={String(branchId)}
                onValueChange={(next) => {
                  setBranchId(
                    next ? Number(next) : "",
                  );
                  setPage(0);
                }}
              >
                <option value="">كل الشركة</option>
                {branches.data?.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </AppSelect>
            </label>
          )}
        </div>
      }
    >
      {q.isError ? (
        <ErrorState
          message="تعذّر تحميل دفتر الأستاذ."
          onRetry={() => void q.refetch()}
        />
      ) : (
        <div className="space-y-2.5">
          {result && <ModeNotice result={result} availableFrom={availableFrom} />}
          {result && result.unmappedCount > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] px-3 py-1.5 text-xs text-[var(--sem-neg)]">
              <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
              توجد {result.openingUnmappedCount} فجوة قبل الفترة قد تؤثر في
              الرصيد الافتتاحي، و{result.periodUnmappedCount} فجوة داخل الفترة؛
              الكشف غير مكتمل للاعتماد.
            </div>
          )}
          <Card>
            <CardContent className="p-3">
              <DataTable
                columns={columns}
                data={result?.rows ?? []}
                operation={operation}
                loading={q.isLoading || accounts.isLoading}
                searchable={false}
                emptyText={
                  accountId == null
                    ? "اختر حساباً."
                    : "لا حركات لهذا الحساب ضمن الفترة."
                }
                serverPagination={{
                  page,
                  onPageChange: setPage,
                  pageSize: PAGE_SIZE,
                  total: result?.total ?? 0,
                }}
                viewKey="double-entry-general-ledger"
              />
            </CardContent>
          </Card>
        </div>
      )}
    </ReportShell>
  );
}

function Money({ value }: { value: string }) {
  return (
    <span className="block text-left tabular-nums" dir="ltr">
      {D(value).isZero() ? "—" : fmtAr(value)}
    </span>
  );
}
