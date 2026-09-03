import { TRPCError } from "@trpc/server";

export const LEGACY_PURCHASE_MUTATION_REPLACEMENTS = Object.freeze({
  "purchases.receive": "goodsReceipts.create",
  "purchases.pay": "supplierPayments.requestPayment",
  "purchaseReturns.create": "purchaseReturnGovernance.requestReturn",
} as const);

export type LegacyPurchaseMutation = keyof typeof LEGACY_PURCHASE_MUTATION_REPLACEMENTS;

/** Fail closed: legacy aggregate writers remain read-compatible only after S3/S5/S6 activation. */
export function rejectLegacyPurchaseMutation(operation: LegacyPurchaseMutation): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `المسار ${operation} متوقف للكتابة الجديدة؛ استخدم ${LEGACY_PURCHASE_MUTATION_REPLACEMENTS[operation]}`,
  });
}
