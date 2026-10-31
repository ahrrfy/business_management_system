import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { money, toDbMoney, type DecimalInput } from "../money";
import { sha256, stableCanonical } from "./grniAccounting";
import { z } from "zod";

const amount = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/);
const signedAmount = z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/);
const positiveId = z.number().int().positive().safe();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const valuationSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("LOCKED_WAVG"),
    variantId: positiveId,
    branchId: positiveId,
    baseQuantity: positiveId,
    inventoryUnitCost: amount,
    inventoryAmount: amount,
    netAmount: amount,
    varianceAmount: signedAmount,
  })
  .strict();
const reversalSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("SAVED_RETURN"),
    purchaseReturnItemId: positiveId,
    originalValuationHash: hashSchema,
    baseQuantity: positiveId,
    inventoryAmount: amount,
    netAmount: amount,
    varianceAmount: signedAmount,
  })
  .strict();
const executionSchema = z
  .object({
    version: z.literal(1),
    sourceKind: z.enum(["SOURCE_BOUND", "OWNER_EXCEPTION"]),
    purchaseReturnId: positiveId,
    supplierId: positiveId,
    branchId: positiveId,
    requestId: positiveId,
    payloadHash: hashSchema,
    evidenceHash: hashSchema,
    ownerId: positiveId,
    ownerName: z.string(),
    ownerWasOwner: z.boolean(),
    ownerWasActive: z.literal(true),
    settlement: z.enum(["CREDIT", "CASH"]),
    paymentMethod: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]),
    cashRoute: z
      .object({
        cashBucket: z.enum(["DRAWER", "TREASURY"]),
        shiftId: positiveId.nullable(),
      })
      .strict()
      .nullable(),
    externalReference: z.string().nullable(),
    accountingEntryId: positiveId,
    receiptId: positiveId.nullable(),
    lines: z
      .array(
        z.object({ itemId: positiveId, valuationHash: hashSchema }).strict(),
      )
      .min(1),
  })
  .strict();

export function returnConflict(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر تثبيت مرتجع المورد",
      why,
      doThis:
        "راجع دليل المرتجع وبياناته ثم أعد المحاولة؛ يلزم تدقيق مستقل إذا كانت التكلفة التاريخية غير موثقة",
    }),
  });
}

/** Select only from validated, saved reversal values; null means stock only. */
export function reversalPostingProfile(
  ownerException: boolean,
  inventory: DecimalInput,
  total: DecimalInput,
  tax: DecimalInput,
) {
  if (ownerException && money(tax).isZero()) {
    if (money(total).isZero()) {
      if (money(inventory).isZero()) return null;
      if (money(inventory).gt(0))
        return "RETURN_PURCHASE_ZERO_AGREEMENT" as const;
    }
    if (money(total).gt(0) && money(inventory).isZero())
      return "RETURN_PURCHASE_ZERO_BOOK" as const;
  }
  return "RETURN_PURCHASE_INVENTORY" as const;
}
export type ReturnValuation = {
  version: 1;
  basis: "LOCKED_WAVG";
  variantId: number;
  branchId: number;
  baseQuantity: number;
  inventoryUnitCost: string;
  inventoryAmount: string;
  netAmount: string;
  varianceAmount: string;
};
export type ReversalValuation = {
  version: 1;
  basis: "SAVED_RETURN";
  purchaseReturnItemId: number;
  originalValuationHash: string;
  baseQuantity: number;
  inventoryAmount: string;
  netAmount: string;
  varianceAmount: string;
};
export const evidenceHash = (value: unknown) => sha256(stableCanonical(value));
export function readValuation(
  value: unknown,
  hash: string | null,
  identity: { variantId: number; branchId: number; baseQuantity: number },
): ReturnValuation {
  const parsed = valuationSchema.safeParse(value);
  const v = parsed.success ? parsed.data : null;
  if (
    !v ||
    !hash ||
    evidenceHash(v) !== hash ||
    v.version !== 1 ||
    v.basis !== "LOCKED_WAVG" ||
    v.variantId !== identity.variantId ||
    v.branchId !== identity.branchId ||
    v.baseQuantity !== identity.baseQuantity ||
    ![v.inventoryUnitCost, v.inventoryAmount, v.netAmount].every(
      (x) => typeof x === "string" && /^\d+\.\d{2}$/.test(x),
    ) ||
    money(v.inventoryUnitCost).times(v.baseQuantity).toFixed(2) !==
      v.inventoryAmount ||
    toDbMoney(money(v.inventoryAmount).minus(v.netAmount)) !== v.varianceAmount
  )
    returnConflict(
      "تكلفة التنفيذ الأصلية غير مثبتة أو بصمتها لا تطابق البند؛ لا يجوز استعمال تكلفة اليوم بديلاً عنها",
    );
  return v;
}
export function readReversalValuation(
  value: unknown,
  hash: string | null,
  itemId: number,
  originalHash: string,
  quantity: number,
): ReversalValuation {
  const parsed = reversalSchema.safeParse(value);
  const v = parsed.success ? parsed.data : null;
  if (
    !v ||
    !hash ||
    evidenceHash(v) !== hash ||
    v.version !== 1 ||
    v.basis !== "SAVED_RETURN" ||
    v.purchaseReturnItemId !== itemId ||
    v.originalValuationHash !== originalHash ||
    v.baseQuantity !== quantity ||
    ![v.inventoryAmount, v.netAmount].every(
      (x) => typeof x === "string" && /^\d+\.\d{2}$/.test(x),
    ) ||
    toDbMoney(money(v.inventoryAmount).minus(v.netAmount)) !== v.varianceAmount
  )
    returnConflict("دليل قيمة عكس سابق غير متسق مع المرتجع الأصلي");
  return v;
}
export function validExecutionEvidence(row: {
  id: number;
  supplierId: number;
  branchId: number;
  origin: string;
  settlement: string;
  paymentMethod: string;
  requestId: number | null;
  payloadHash: string | null;
  accountingEntryId: number | null;
  cashRefundReceiptId: number | null;
  postedBy: number | null;
  executionEvidence: unknown;
  executionEvidenceHash: string | null;
}): boolean {
  const parsed = executionSchema.safeParse(row.executionEvidence);
  if (!parsed.success) return false;
  const v = parsed.data;
  return (
    v.purchaseReturnId === row.id &&
    v.supplierId === row.supplierId &&
    v.branchId === row.branchId &&
    v.sourceKind ===
      (row.origin === "OWNER_EXCEPTION" ? "OWNER_EXCEPTION" : "SOURCE_BOUND") &&
    v.settlement === row.settlement &&
    v.paymentMethod === row.paymentMethod &&
    v.requestId === row.requestId &&
    v.payloadHash === row.payloadHash &&
    v.accountingEntryId === row.accountingEntryId &&
    v.receiptId === row.cashRefundReceiptId &&
    v.ownerId === row.postedBy &&
    (row.origin !== "OWNER_EXCEPTION" || v.ownerWasOwner) &&
    new Set(v.lines.map((line) => line.itemId)).size === v.lines.length &&
    evidenceHash(v) === row.executionEvidenceHash
  );
}
