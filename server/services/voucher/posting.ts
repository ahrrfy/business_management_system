import type { Decimal } from "decimal.js";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import type { PartyType, PaymentMethod } from "./types";
import {
  isVoucherCategoryRoleCompatible,
  type VoucherCategoryPostingRole,
} from "../../../shared/voucherCategoryAccounting";

type VoucherEntryType = "PAYMENT_IN" | "PAYMENT_OUT";

type CashBucket = "DRAWER" | "TREASURY" | null;

function paymentAssetRole(
  method: PaymentMethod,
  direction: "IN" | "OUT",
  cashBucket: CashBucket,
): AccountRole | null {
  switch (method) {
    case "CASH":
      if (cashBucket === "DRAWER") return "CASH";
      if (cashBucket === "TREASURY") return "TREASURY_CASH";
      return null;
    case "CARD":
    case "TRANSFER":
      return "CARD_BANK";
    case "CHECK":
      return direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK";
    case "WALLET":
      return "PAYMENT_WALLET";
    case "EXCHANGE":
      // The exchange module supplies its own identified custody accounts.
      return null;
  }
}

export type VoucherPostingPlan = {
  intent: PostingIntent;
  sourceComponents: PostingSourceComponents;
};

function sourceComponents(
  debitRole: AccountRole,
  creditRole: AccountRole,
  amount: Decimal,
): PostingSourceComponents {
  return amount.isNegative()
    ? {
        roleDebits: { [creditRole]: amount.abs() },
        roleCredits: { [debitRole]: amount.abs() },
      }
    : {
        roleDebits: { [debitRole]: amount },
        roleCredits: { [creditRole]: amount },
      };
}

function postingPlan(
  profile: Parameters<typeof createPostingIntent>[0],
  entryType: VoucherEntryType,
  debitRole: AccountRole,
  creditRole: AccountRole,
  amount: Decimal,
): VoucherPostingPlan {
  const components = sourceComponents(debitRole, creditRole, amount);
  return {
    intent: createPostingIntent(
      profile,
      entryType,
      signedPostingLines(debitRole, creditRole, amount),
      components,
    ),
    sourceComponents: components,
  };
}

/**
 * يبني intent فقط حين تحمل حقول السند حقيقة الطرف والغرض كاملةً.
 * OTHER العام يبقى فجوةً متعمّدة. مسارات النظام (ومنها سلفة الموظف)
 * تمرّر هويتها الموثقة إلى خدمة الاعتماد ولا تُستنتج من مرجع يكتبه المستخدم.
 */
export function voucherPostingPlan(args: {
  entryType: VoucherEntryType;
  partyType: PartyType | null;
  paymentMethod: PaymentMethod;
  cashBucket?: CashBucket;
  amount: Decimal;
  referenceNumber?: string | null;
  categoryPostingRole?: VoucherCategoryPostingRole | null;
  categoryReversalOfDirection?: "IN" | "OUT" | null;
}): VoucherPostingPlan | undefined {
  const direction = args.entryType === "PAYMENT_IN" ? "IN" : "OUT";
  // Category reversal must move the very asset role materialized by the
  // original entry. This matters for CHECK: inbound uses CHECKS_RECEIVABLE,
  // while outbound uses CARD_BANK. Reversal direction is not the source fact.
  const assetDirection = args.categoryReversalOfDirection ?? direction;
  const assetRole = paymentAssetRole(
    args.paymentMethod,
    assetDirection,
    args.cashBucket ?? null,
  );
  if (assetRole == null) return undefined;

  if (args.partyType === "CUSTOMER") {
    return args.entryType === "PAYMENT_IN"
      ? postingPlan(
          "PAYMENT_IN_CUSTOMER",
          "PAYMENT_IN",
          assetRole,
          "AR",
          args.amount,
        )
      : postingPlan(
          "PAYMENT_OUT_CUSTOMER_REFUND",
          "PAYMENT_OUT",
          "AR",
          assetRole,
          args.amount,
        );
  }

  if (args.partyType === "SUPPLIER") {
    return args.entryType === "PAYMENT_OUT"
      ? postingPlan(
          "PAYMENT_OUT_SUPPLIER",
          "PAYMENT_OUT",
          "AP",
          assetRole,
          args.amount,
        )
      : postingPlan(
          "PAYMENT_IN_SUPPLIER_REFUND",
          "PAYMENT_IN",
          assetRole,
          "AP",
          args.amount,
        );
  }

  if (args.partyType === "OTHER" && args.categoryPostingRole) {
    if (args.categoryReversalOfDirection) {
      if (
        !isVoucherCategoryRoleCompatible(
          args.categoryReversalOfDirection,
          args.categoryPostingRole,
        ) ||
        (args.categoryReversalOfDirection === "IN" &&
          args.entryType !== "PAYMENT_OUT") ||
        (args.categoryReversalOfDirection === "OUT" &&
          args.entryType !== "PAYMENT_IN")
      ) {
        return undefined;
      }
      return args.categoryReversalOfDirection === "IN"
        ? postingPlan(
            "PAYMENT_OUT_CATEGORY_REVERSAL",
            "PAYMENT_OUT",
            args.categoryPostingRole,
            assetRole,
            args.amount,
          )
        : postingPlan(
            "PAYMENT_IN_CATEGORY_REVERSAL",
            "PAYMENT_IN",
            assetRole,
            args.categoryPostingRole,
            args.amount,
          );
    }
    if (!isVoucherCategoryRoleCompatible(direction, args.categoryPostingRole)) {
      return undefined;
    }
    return args.entryType === "PAYMENT_IN"
      ? postingPlan(
          "PAYMENT_IN_CATEGORY",
          "PAYMENT_IN",
          assetRole,
          args.categoryPostingRole,
          args.amount,
        )
      : postingPlan(
          "PAYMENT_OUT_CATEGORY",
          "PAYMENT_OUT",
          args.categoryPostingRole,
          assetRole,
          args.amount,
        );
  }

  return undefined;
}

export function voucherPostingIntent(
  args: Parameters<typeof voucherPostingPlan>[0],
): PostingIntent | undefined {
  return voucherPostingPlan(args)?.intent;
}
