import type Decimal from "decimal.js";
import type { FulfillmentChargeCategory } from "../../../shared/fulfillment";
import {
  createPostingIntent,
  debitLine,
  creditLine,
  type AccountRole,
} from "../accounting/postingEngine";
import { paymentAccountRole } from "../delivery/posting";

export type ChargePayableRole = Extract<
  AccountRole,
  "AP" | "COURIER_PAYABLE" | "ACCRUED_EXPENSES"
>;
export function chargePayableRole(row: {
  payeeSupplierId?: number | null;
  payeePartyId?: number | null;
}): ChargePayableRole {
  return row.payeeSupplierId
    ? "AP"
    : row.payeePartyId
      ? "COURIER_PAYABLE"
      : "ACCRUED_EXPENSES";
}
export function chargeAccrualIntent(
  category: FulfillmentChargeCategory,
  amount: Decimal,
) {
  const credit =
    category === "PASS_THROUGH"
      ? "OTHER_LIABILITY"
      : category === "SERVICE" || category === "OUTSOURCED"
        ? "DEFERRED_REVENUE"
        : "OTHER_REVENUE";
  return createPostingIntent(
    "FULFILLMENT_CHARGE_ACCRUAL",
    "ADJUST",
    [debitLine("AR", amount), creditLine(credit, amount)],
    { roleDebits: { AR: amount }, roleCredits: { [credit]: amount } },
  );
}
/** Immediate checkout services are completed in the same transaction and bypass deferral. */
export function immediateServiceAccrualIntent(amount: Decimal) {
  return createPostingIntent(
    "FULFILLMENT_CHARGE_ACCRUAL",
    "ADJUST",
    [debitLine("AR", amount), creditLine("OTHER_REVENUE", amount)],
    {
      roleDebits: { AR: amount },
      roleCredits: { OTHER_REVENUE: amount },
    },
  );
}
export function chargeRecognitionIntent(amount: Decimal) {
  return createPostingIntent(
    "FULFILLMENT_CHARGE_RECOGNITION",
    "ADJUST",
    [
      debitLine("DEFERRED_REVENUE", amount),
      creditLine("OTHER_REVENUE", amount),
    ],
    {
      roleDebits: { DEFERRED_REVENUE: amount },
      roleCredits: { OTHER_REVENUE: amount },
    },
  );
}
export function chargeCostIntent(cost: Decimal, payable: ChargePayableRole) {
  return createPostingIntent(
    "FULFILLMENT_CHARGE_COST",
    "ADJUST",
    [debitLine("OPERATING_EXPENSE", cost), creditLine(payable, cost)],
    {
      roleDebits: { OPERATING_EXPENSE: cost },
      roleCredits: { [payable]: cost },
    },
  );
}
export function chargeCollectionIntent(
  amount: Decimal,
  allocated: Decimal,
  method: string,
  bucket: "DRAWER" | "TREASURY" | null,
) {
  const cash = paymentAccountRole(method, bucket);
  const excess = amount.minus(allocated);
  return createPostingIntent(
    "FULFILLMENT_CHARGE_COLLECTION",
    "PAYMENT_IN",
    [
      debitLine(cash, amount),
      creditLine("AR", allocated),
      ...(excess.gt(0) ? [creditLine("OTHER_LIABILITY", excess)] : []),
    ],
    {
      roleDebits: { [cash]: amount },
      roleCredits: {
        AR: allocated,
        ...(excess.gt(0) ? { OTHER_LIABILITY: excess } : {}),
      },
    },
  );
}
export function chargeCreditIntent(
  category: FulfillmentChargeCategory,
  amount: Decimal,
  recognized = true,
) {
  const debit =
    category === "PASS_THROUGH"
      ? "OTHER_LIABILITY"
      : !recognized && (category === "SERVICE" || category === "OUTSOURCED")
        ? "DEFERRED_REVENUE"
        : "OTHER_REVENUE";
  return createPostingIntent(
    "FULFILLMENT_CHARGE_CREDIT",
    "ADJUST",
    [debitLine(debit, amount), creditLine("AR", amount)],
    { roleDebits: { [debit]: amount }, roleCredits: { AR: amount } },
  );
}
export function chargeRefundIntent(
  amount: Decimal,
  method: string,
  bucket: "DRAWER" | "TREASURY" | null,
) {
  const cash = paymentAccountRole(method, bucket, "OUT");
  return createPostingIntent(
    "PAYMENT_OUT_CUSTOMER_REFUND",
    "PAYMENT_OUT",
    [debitLine("AR", amount), creditLine(cash, amount)],
    { roleDebits: { AR: amount }, roleCredits: { [cash]: amount } },
  );
}
export function chargePayeeIntent(
  amount: Decimal,
  payable: ChargePayableRole,
  method: string,
  bucket: "DRAWER" | "TREASURY" | null,
) {
  const cash = paymentAccountRole(method, bucket, "OUT");
  return createPostingIntent(
    "FULFILLMENT_CHARGE_PAYEE",
    "PAYMENT_OUT",
    [debitLine(payable, amount), creditLine(cash, amount)],
    { roleDebits: { [payable]: amount }, roleCredits: { [cash]: amount } },
  );
}
export function chargeCustodyIntent(amount: Decimal) {
  return createPostingIntent(
    "FULFILLMENT_CHARGE_CUSTODY",
    "PAYMENT_IN",
    [debitLine("DELIVERY_FLOAT", amount), creditLine("AR", amount)],
    { roleDebits: { DELIVERY_FLOAT: amount }, roleCredits: { AR: amount } },
  );
}

export function immediateServiceIntent(
  amount: Decimal,
  method: string,
  bucket: "DRAWER" | "TREASURY" | null,
  refund = false,
) {
  const cash = paymentAccountRole(method, bucket, refund ? "OUT" : "IN");
  return createPostingIntent(
    refund ? "FULFILLMENT_SERVICE_REFUND" : "FULFILLMENT_SERVICE_IMMEDIATE",
    refund ? "PAYMENT_OUT" : "PAYMENT_IN",
    refund
      ? [debitLine("OTHER_REVENUE", amount), creditLine(cash, amount)]
      : [debitLine(cash, amount), creditLine("OTHER_REVENUE", amount)],
    refund
      ? {
          roleDebits: { OTHER_REVENUE: amount },
          roleCredits: { [cash]: amount },
        }
      : {
          roleDebits: { [cash]: amount },
          roleCredits: { OTHER_REVENUE: amount },
        },
  );
}
