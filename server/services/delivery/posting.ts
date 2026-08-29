import type Decimal from "decimal.js";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
} from "../accounting/postingEngine";

type CashBucket = "DRAWER" | "TREASURY" | null | undefined;
export type PaymentDirection = "IN" | "OUT";
export type DeliveryReturnSaleKind =
  | "WORK_ORDER_SERVICE"
  | "SERVICE"
  | "DIGITAL"
  | "INVENTORY"
  | "CONSIGNMENT"
  | "MIXED";

type DeliveryRevenueRole = Extract<
  AccountRole,
  "SALES_FLEX" | "SALES_PRINT" | "SALES_STATIONERY" | "OTHER_REVENUE"
>;

/**
 * Resolves the account that the operational receipt actually touched.
 * Cash needs its physical bucket; bank instruments never belong to a drawer.
 * Unsupported instruments are rejected instead of silently inflating cash.
 */
export function paymentAccountRole(
  paymentMethod: string | null | undefined,
  cashBucket: CashBucket,
  direction: PaymentDirection = "IN",
): Extract<
  AccountRole,
  "CASH" | "TREASURY_CASH" | "CARD_BANK" | "CHECKS_RECEIVABLE"
> {
  if (paymentMethod === "CARD" || paymentMethod === "TRANSFER") {
    return "CARD_BANK";
  }
  if (paymentMethod === "CHECK") {
    return direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK";
  }
  if (paymentMethod === "CASH" && cashBucket === "DRAWER") return "CASH";
  if (paymentMethod === "CASH" && cashBucket === "TREASURY")
    return "TREASURY_CASH";
  throw new Error(
    `تعذّر تحديد حساب الدفع (الطريقة=${paymentMethod ?? "NULL"}، الدلو=${cashBucket ?? "NULL"})`,
  );
}

/** Customer paid the courier: the asset moves from AR to courier custody, not to store cash. */
export function deliveryCustomerCollectionIntent(
  amount: Decimal,
): PostingIntent {
  return createPostingIntent("PAYMENT_IN_COURIER", "PAYMENT_IN", [
    debitLine("DELIVERY_FLOAT", amount),
    creditLine("AR", amount),
  ]);
}

/** Assignment/operational custody memo; collection is posted once by PAYMENT_IN_COURIER. */
export function deliveryDispatchMemoIntent(): PostingIntent {
  return createPostingIntent("DELIVERY_DISPATCH_COD", "DELIVERY_DISPATCH", []);
}

/** Courier remitted cash: courier custody becomes drawer or treasury cash. */
export function deliveryRemitIntent(
  amount: Decimal,
  cashBucket: Exclude<CashBucket, null | undefined>,
): PostingIntent {
  const destination = paymentAccountRole("CASH", cashBucket, "IN");
  return createPostingIntent(
    "DELIVERY_REMIT_COD",
    "DELIVERY_REMIT",
    [debitLine(destination, amount), creditLine("DELIVERY_FLOAT", amount)],
    {
      roleDebits: { [destination]: amount },
      roleCredits: { DELIVERY_FLOAT: amount },
    },
  );
}

/** The business incurs the courier fee when delivery succeeds, before cash is paid. */
export function deliveryFeeAccrualIntent(amount: Decimal): PostingIntent {
  return createPostingIntent("DELIVERY_FEE_ACCRUAL", "DELIVERY_FEE", [
    debitLine("DELIVERY_EXPENSE", amount),
    creditLine("COURIER_PAYABLE", amount),
  ]);
}

/** Paying an already accrued SHOP fee clears the courier liability; it is not a second expense. */
export function deliveryFeeSettlementIntent(
  amount: Decimal,
  cashBucket: Exclude<CashBucket, null | undefined>,
): PostingIntent {
  const paidFrom = paymentAccountRole("CASH", cashBucket, "OUT");
  return createPostingIntent(
    "DELIVERY_FEE_SETTLEMENT",
    "DELIVERY_FEE",
    [debitLine("COURIER_PAYABLE", amount), creditLine(paidFrom, amount)],
    {
      roleDebits: { COURIER_PAYABLE: amount },
      roleCredits: { [paidFrom]: amount },
    },
  );
}

/**
 * H2 (٢٩/٨/٢٦) — تسويةٌ باستبدال الأجرة بالعمولة:
 *   DR COURIER_PAYABLE = feeAmount   (يُخفَّض الالتزام كاملاً كما لو دُفعت الأجرة)
 *   CR CASH            = commissionAmount   (النقد المدفوع فعلياً للمندوب — العمولة الأقلّ)
 *   CR DELIVERY_REVENUE = feeAmount − commissionAmount   (الفارقُ إيرادُ توصيلٍ للمكتبة)
 *
 * حين commission == fee ⇒ سطرُ الإيراد صفرٌ (يُقتطع)، فالقيدُ يعود لنمط `deliveryFeeSettlementIntent`.
 * commission > fee مرفوضٌ في fees.ts قبل بلوغِ هذه الدالّة (لا نُقيّد إيراداً سالباً).
 */
export function deliveryCommissionSettlementIntent(
  feeAmount: Decimal,
  commissionAmount: Decimal,
  cashBucket: Exclude<CashBucket, null | undefined>,
): PostingIntent {
  const paidFrom = paymentAccountRole("CASH", cashBucket, "OUT");
  const margin = feeAmount.minus(commissionAmount);
  const credits = [creditLine(paidFrom, commissionAmount)];
  const roleCredits: Record<string, Decimal> = { [paidFrom]: commissionAmount };
  if (margin.gt(0)) {
    credits.push(creditLine("DELIVERY_REVENUE", margin));
    roleCredits.DELIVERY_REVENUE = margin;
  }
  return createPostingIntent(
    "DELIVERY_COMMISSION_SETTLEMENT",
    "DELIVERY_FEE",
    [debitLine("COURIER_PAYABLE", feeAmount), ...credits],
    { roleDebits: { COURIER_PAYABLE: feeAmount }, roleCredits },
  );
}

/** A fee collected from the customer is held for the courier, not recognised as revenue. */
export function deliveryFeeHeldReceiptIntent(
  amount: Decimal,
  paymentMethod: string,
  cashBucket: CashBucket,
): PostingIntent {
  const receivedTo = paymentAccountRole(paymentMethod, cashBucket, "IN");
  return createPostingIntent(
    "DELIVERY_FEE_HELD_RECEIPT",
    "DELIVERY_FEE_HELD",
    [debitLine(receivedTo, amount), creditLine("COURIER_PAYABLE", amount)],
    {
      roleDebits: { [receivedTo]: amount },
      roleCredits: { COURIER_PAYABLE: amount },
    },
  );
}

/** Negative held-fee amount means the customer's held cash is paid out/refunded. */
export function deliveryFeeHeldPayoutIntent(
  signedAmount: Decimal,
  cashBucket: Exclude<CashBucket, null | undefined>,
): PostingIntent {
  const paidFrom = paymentAccountRole("CASH", cashBucket, "OUT");
  const absolute = signedAmount.abs();
  const sourceComponents = signedAmount.isNegative()
    ? {
        roleDebits: { COURIER_PAYABLE: absolute },
        roleCredits: { [paidFrom]: absolute },
      }
    : {
        roleDebits: { [paidFrom]: absolute },
        roleCredits: { COURIER_PAYABLE: absolute },
      };
  return createPostingIntent(
    "DELIVERY_FEE_HELD_PAYOUT",
    "DELIVERY_FEE_HELD",
    signedPostingLines(paidFrom, "COURIER_PAYABLE", signedAmount),
    sourceComponents,
  );
}

/** Positive = recognise a loss and clear custody; negative = recover the prior loss. */
export function deliveryWriteoffIntent(signedAmount: Decimal): PostingIntent {
  return createPostingIntent(
    "DELIVERY_WRITEOFF_FLOAT",
    "DELIVERY_WRITEOFF",
    signedPostingLines("LOSSES", "DELIVERY_FLOAT", signedAmount),
  );
}

/** Cash refund of a customer deposit restores AR and removes the paid account. */
export function deliveryCustomerRefundIntent(
  amount: Decimal,
  cashBucket: Exclude<CashBucket, null | undefined>,
): PostingIntent {
  const paidFrom = paymentAccountRole("CASH", cashBucket, "OUT");
  return createPostingIntent(
    "PAYMENT_OUT_CUSTOMER_REFUND",
    "PAYMENT_OUT",
    [debitLine("AR", amount), creditLine(paidFrom, amount)],
    {
      roleDebits: { AR: amount },
      roleCredits: { [paidFrom]: amount },
    },
  );
}

/** Work-order dispatch recognises a service sale and releases its collected deposit. */
export function deliveryWorkOrderSaleIntent(
  salePrice: Decimal,
  appliedDeposit: Decimal,
  materialsCost: Decimal,
): PostingIntent {
  return createPostingIntent(
    "SALE_SERVICE_FLEX",
    "SALE",
    [
      debitLine("AR", salePrice),
      creditLine("SALES_FLEX", salePrice),
      ...(materialsCost.isZero()
        ? []
        : [
            debitLine("COGS", materialsCost),
            creditLine("WORK_IN_PROGRESS", materialsCost),
          ]),
      ...(appliedDeposit.isZero()
        ? []
        : [
            debitLine("OTHER_LIABILITY", appliedDeposit),
            creditLine("AR", appliedDeposit),
          ]),
    ],
    {
      roleDebits: {
        AR: salePrice,
        COGS: materialsCost,
        OTHER_LIABILITY: appliedDeposit,
      },
      roleCredits: {
        SALES_FLEX: salePrice,
        WORK_IN_PROGRESS: materialsCost,
        AR: appliedDeposit,
      },
    },
  );
}

/** Mirrors the original delivery invoice sale without inventing inventory for services/consignment. */
export function deliveryReturnSaleIntent(input: {
  kind: DeliveryReturnSaleKind;
  sectorRevenue: Decimal;
  revenueByRole?: ReadonlyArray<{
    role: DeliveryRevenueRole;
    amount: Decimal;
  }>;
  deliveryRevenue: Decimal;
  tax: Decimal;
  total: Decimal;
  ownedInventoryCost: Decimal;
}): PostingIntent {
  const profile =
    input.kind === "WORK_ORDER_SERVICE"
      ? "RETURN_SALE_FLEX"
      : input.kind === "SERVICE"
        ? "RETURN_SALE_SERVICE"
        : input.kind === "DIGITAL"
          ? "RETURN_SALE_DIGITAL"
          : input.kind === "MIXED"
            ? "RETURN_SALE_MIXED"
            : input.kind === "CONSIGNMENT"
              ? "RETURN_SALE_CONSIGNMENT"
              : "RETURN_SALE_INVENTORY";
  const salesRole =
    input.kind === "WORK_ORDER_SERVICE"
      ? "SALES_FLEX"
      : input.kind === "SERVICE"
        ? "SALES_PRINT"
        : input.kind === "DIGITAL"
          ? "OTHER_REVENUE"
          : "SALES_STATIONERY";
  const sectorLines =
    input.revenueByRole ??
    (input.sectorRevenue.isZero()
      ? []
      : [{ role: salesRole, amount: input.sectorRevenue }]);
  const reversesOwnedInventory =
    input.kind === "INVENTORY" ||
    input.kind === "DIGITAL" ||
    input.kind === "MIXED";

  const lines = [
    ...sectorLines
      .filter(({ amount }) => !amount.isZero())
      .map(({ role, amount }) => debitLine(role, amount)),
    ...(input.deliveryRevenue.isZero()
      ? []
      : [debitLine("DELIVERY_REVENUE", input.deliveryRevenue)]),
    ...(input.tax.isZero() ? [] : [debitLine("TAX_PAYABLE", input.tax)]),
    creditLine("AR", input.total),
    ...(reversesOwnedInventory && !input.ownedInventoryCost.isZero()
      ? [
          debitLine("INVENTORY", input.ownedInventoryCost),
          creditLine("COGS", input.ownedInventoryCost),
        ]
      : []),
  ];
  const sourceComponents = {
    roleDebits: Object.fromEntries([
      ...sectorLines
        .filter(({ amount }) => !amount.isZero())
        .map(({ role, amount }) => [role, amount] as const),
      ...(input.deliveryRevenue.isZero()
        ? []
        : [["DELIVERY_REVENUE", input.deliveryRevenue] as const]),
      ...(input.tax.isZero() ? [] : [["TAX_PAYABLE", input.tax] as const]),
      ...(reversesOwnedInventory && !input.ownedInventoryCost.isZero()
        ? [["INVENTORY", input.ownedInventoryCost] as const]
        : []),
    ]),
    roleCredits: {
      AR: input.total,
      ...(reversesOwnedInventory && !input.ownedInventoryCost.isZero()
        ? { COGS: input.ownedInventoryCost }
        : {}),
    },
  };

  return createPostingIntent(profile, "RETURN", lines, sourceComponents);
}
