import type {
  ShiftCashReconciliationData,
  ShiftCashReconciliationEntry,
  ShiftCashMoneyValue,
} from "./ShiftCashReconciliation";

type ApiTraceItem = {
  receiptId?: number | null;
  documentType?: string | null;
  documentId?: string | number | null;
  invoiceNumber?: string | null;
  voucherNumber?: string | null;
  referenceNumber?: string | null;
  description?: string | null;
  amount: ShiftCashMoneyValue;
  createdByName?: string | null;
  timestamp?: string | Date | null;
  receiptStatus?: string | null;
  approvalStatus?: string | null;
};

type ApiCashReconciliation = {
  opening?: ShiftCashMoneyValue;
  cashSales?: ShiftCashMoneyValue;
  priorInvoiceCollections?: ShiftCashMoneyValue;
  otherCashIn?: ShiftCashMoneyValue;
  cashRefunds?: ShiftCashMoneyValue;
  expenses?: ShiftCashMoneyValue;
  cashDrops?: ShiftCashMoneyValue;
  otherCashOut?: ShiftCashMoneyValue;
  expectedCash?: ShiftCashMoneyValue;
  breakdown?: Partial<
    Record<
      | "opening"
      | "cashSales"
      | "priorInvoiceCollections"
      | "otherCashIn"
      | "cashRefunds"
      | "expenses"
      | "cashDrops"
      | "otherCashOut",
      readonly ApiTraceItem[]
    >
  >;
};

export type ShiftReportWithCashReconciliation = {
  expectedCash?: ShiftCashMoneyValue;
  cashReconciliation?: ApiCashReconciliation | null;
};

function documentNumber(item: ApiTraceItem): string {
  return (
    item.invoiceNumber ??
    item.voucherNumber ??
    item.referenceNumber ??
    (item.documentId != null ? `#${String(item.documentId)}` : "—")
  );
}

function mapEntries(
  items: readonly ApiTraceItem[] | undefined,
): ShiftCashReconciliationEntry[] {
  return (items ?? []).map((item, index) => ({
    id:
      item.receiptId ??
      `${item.documentType ?? "DOC"}-${String(item.documentId ?? index)}`,
    documentType: item.documentType ?? "مستند",
    documentNumber: documentNumber(item),
    voucherNumber: item.voucherNumber ?? null,
    description: item.description ?? null,
    actorName: item.createdByName ?? null,
    occurredAt: item.timestamp ?? null,
    amount: item.amount,
    statusLabel:
      item.approvalStatus === "PENDING_APPROVAL"
        ? "بانتظار الاعتماد"
        : item.receiptStatus === "REVERSED"
          ? "معكوس"
          : item.receiptStatus === "PENDING"
            ? "معلّق"
            : item.receiptStatus === "COMPLETED"
              ? "مكتمل"
              : null,
  }));
}

/** يحوّل عقد تقرير الوردية الخادمي إلى عقد العرض المشترك من دون إعادة حساب الأرقام. */
export function adaptShiftCashReconciliation(
  report: ShiftReportWithCashReconciliation | null | undefined,
  options: {
    countedCash?: ShiftCashMoneyValue;
    variance?: ShiftCashMoneyValue;
    isMatched?: boolean | null;
  } = {},
): ShiftCashReconciliationData {
  const cash = report?.cashReconciliation;
  const breakdown = cash?.breakdown;

  const bucket = (
    amount: ShiftCashMoneyValue,
    entries: readonly ApiTraceItem[] | undefined,
  ) => ({ amount, entries: mapEntries(entries), count: entries?.length ?? 0 });

  return {
    openingBalance: bucket(cash?.opening ?? 0, breakdown?.opening),
    cashSales: bucket(cash?.cashSales ?? 0, breakdown?.cashSales),
    laterCollections: bucket(
      cash?.priorInvoiceCollections ?? 0,
      breakdown?.priorInvoiceCollections,
    ),
    otherCashIn: bucket(cash?.otherCashIn ?? 0, breakdown?.otherCashIn),
    cashReturns: bucket(cash?.cashRefunds ?? 0, breakdown?.cashRefunds),
    cashExpenses: bucket(cash?.expenses ?? 0, breakdown?.expenses),
    cashDrops: bucket(cash?.cashDrops ?? 0, breakdown?.cashDrops),
    otherCashOut: bucket(cash?.otherCashOut ?? 0, breakdown?.otherCashOut),
    expectedCash: cash?.expectedCash ?? report?.expectedCash,
    countedCash: options.countedCash,
    variance: options.variance,
    isMatched: options.isMatched,
  };
}
