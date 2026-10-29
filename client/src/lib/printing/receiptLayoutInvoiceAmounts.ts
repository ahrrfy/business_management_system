import { D, round2 } from "@/lib/money";
import { invoiceStatusLabel, isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { invoiceDeliveryCollection } from "@shared/invoiceDeliveryCollection";

type PrintMoney = string | number | null;
export interface InvoicePrintAmountsInput {
  total: string | number;
  paidAmount?: PrintMoney;
  returnedTotal?: PrintMoney;
  currentTotal?: PrintMoney;
  remainingAmount?: PrintMoney;
  status?: string | null;
  paymentMode?: string | null;
  collectCreditOnDelivery?: boolean | null;
  customerBalance?: PrintMoney;
  customerBalanceBefore?: PrintMoney;
  customerBalanceAfter?: PrintMoney;
}

/** Historical total stays unchanged; live obligations use explicit current facts when supplied. */
export function invoicePrintAmounts(data: InvoicePrintAmountsInput) {
  const dead = isDeadInvoiceStatus(data.status);
  const returned = round2(D(data.returnedTotal ?? 0).clamp(0, Infinity));
  const current = dead
    ? D(0)
    : round2(
        (data.currentTotal != null
          ? D(data.currentTotal)
          : D(data.total).minus(returned)
        ).clamp(0, Infinity),
      );
  const remaining = dead
    ? D(0)
    : round2(
        (data.remainingAmount != null
          ? D(data.remainingAmount)
          : current.minus(D(data.paidAmount ?? 0))
        ).clamp(0, Infinity),
      );
  const afterRaw = data.customerBalanceAfter ?? data.customerBalance;
  const after =
    afterRaw == null || afterRaw === "" ? null : round2(D(afterRaw));
  const before =
    data.customerBalanceBefore != null
      ? round2(D(data.customerBalanceBefore))
      : (after?.minus(remaining) ?? null);
  const cod = data.paymentMode === "COD" || data.collectCreditOnDelivery === true;
  const paid = D(data.paidAmount ?? 0).gt(0);
  const collection = invoiceDeliveryCollection({
    remainingAmount: remaining.toFixed(2),
    paymentMode: data.paymentMode,
    collectCreditOnDelivery: data.collectCreditOnDelivery,
    status: data.status,
  });
  return {
    dead,
    currentTotal: current.toFixed(2),
    returnedTotal: returned.toFixed(2),
    remainingAmount: remaining.toFixed(2),
    courierGoodsDue: collection.goodsDue,
    creditDue: collection.creditDue,
    balanceAfter: after?.toFixed(2) ?? null,
    balanceBefore: before?.toFixed(2) ?? null,
    statusLabel: dead
      ? invoiceStatusLabel(data.status)
      : remaining.isZero()
        ? "مدفوعة"
        : cod
          ? "دفع عند الاستلام (COD)"
          : paid
            ? "مدفوعة جزئياً"
            : "آجلة",
    statusColor: dead
      ? "#8A1F11"
      : remaining.isZero()
        ? "#0D6B52"
        : cod
          ? "#0284C7"
          : paid
            ? "#92400E"
            : "#8A1F11",
  };
}
