import type { Decimal } from "decimal.js";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingSourceComponents,
} from "./postingEngine";

export type AccruableExpenseRole =
  | "RENT"
  | "UTILITIES"
  | "OPERATING_EXPENSE"
  | "DELIVERY_EXPENSE"
  | "OTHER_EXPENSE";

export type AccrualPostingPlan = Readonly<{
  intent: PostingIntent;
  sourceComponents: PostingSourceComponents;
}>;

function signedComponents(
  debitRole: AccountRole,
  creditRole: AccountRole,
  amount: Decimal,
): PostingSourceComponents {
  const absolute = amount.abs();
  return amount.isNegative()
    ? {
        roleDebits: { [creditRole]: absolute },
        roleCredits: { [debitRole]: absolute },
      }
    : {
        roleDebits: { [debitRole]: absolute },
        roleCredits: { [creditRole]: absolute },
      };
}

function plan(
  profile: Parameters<typeof createPostingIntent>[0],
  entryType: "ADJUST" | "PAYMENT_OUT",
  debitRole: AccountRole,
  creditRole: AccountRole,
  amount: Decimal,
): AccrualPostingPlan {
  const sourceComponents = signedComponents(debitRole, creditRole, amount);
  return Object.freeze({
    intent: createPostingIntent(
      profile,
      entryType,
      signedPostingLines(debitRole, creditRole, amount),
      sourceComponents,
    ),
    sourceComponents,
  });
}

/** Recognition: Dr expense / Cr accrued expenses. `amount` must be positive. */
export function expenseAccrualRecognition(
  expenseRole: AccruableExpenseRole,
  amount: Decimal,
): AccrualPostingPlan {
  if (!amount.gt(0)) throw new Error("مبلغ استحقاق المصروف يجب أن يكون موجباً");
  return plan(
    "ADJUST_EXPENSE_ACCRUAL",
    "ADJUST",
    expenseRole,
    "ACCRUED_EXPENSES",
    amount,
  );
}

/** Append-only reversal; signed source amount is negative. */
export function expenseAccrualReversal(
  expenseRole: AccruableExpenseRole,
  amount: Decimal,
): AccrualPostingPlan {
  if (!amount.gt(0)) throw new Error("مبلغ عكس استحقاق المصروف يجب أن يكون موجباً");
  return plan(
    "ADJUST_EXPENSE_ACCRUAL_REVERSAL",
    "ADJUST",
    expenseRole,
    "ACCRUED_EXPENSES",
    amount.abs().neg(),
  );
}

/** Positive settles the liability; negative reverses a documented settlement. */
export function expenseAccrualSettlement(
  assetRole: AccountRole,
  signedAmount: Decimal,
): AccrualPostingPlan {
  if (signedAmount.isZero()) throw new Error("مبلغ تسوية استحقاق المصروف لا يجوز أن يكون صفراً");
  return plan(
    "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
    "PAYMENT_OUT",
    "ACCRUED_EXPENSES",
    assetRole,
    signedAmount,
  );
}

/** Recognition of an acquired, usable asset before cash settlement. */
export function fixedAssetAccrualRecognition(
  amount: Decimal,
): AccrualPostingPlan {
  if (!amount.gt(0)) throw new Error("مبلغ استحقاق الأصل يجب أن يكون موجباً");
  return plan(
    "ADJUST_FIXED_ASSET_ACCRUAL",
    "ADJUST",
    "FIXED_ASSETS",
    "ACCRUED_EXPENSES",
    amount,
  );
}

/** Append-only reversal of the asset recognition, not a synthetic cash refund. */
export function fixedAssetAccrualReversal(
  amount: Decimal,
): AccrualPostingPlan {
  if (!amount.gt(0)) throw new Error("مبلغ عكس استحقاق الأصل يجب أن يكون موجباً");
  return plan(
    "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL",
    "ADJUST",
    "FIXED_ASSETS",
    "ACCRUED_EXPENSES",
    amount.abs().neg(),
  );
}

/** Positive settles the liability; negative reverses a documented settlement. */
export function fixedAssetAccrualSettlement(
  assetRole: AccountRole,
  signedAmount: Decimal,
): AccrualPostingPlan {
  if (signedAmount.isZero()) throw new Error("مبلغ تسوية استحقاق الأصل لا يجوز أن يكون صفراً");
  return plan(
    "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
    "PAYMENT_OUT",
    "ACCRUED_EXPENSES",
    assetRole,
    signedAmount,
  );
}
