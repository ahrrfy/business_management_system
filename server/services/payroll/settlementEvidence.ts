import { appErrorMessage } from "@shared/errors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
  payrollAccountingEvents,
  payrollObligations,
  receipts,
} from "../../../drizzle/schema";
import { money, toDateStr } from "../money";
import { payrollHash } from "./helpers";
import { payrollSettlementPosting } from "./accounting";
import type { PostingSourceComponents } from "../accounting/postingEngine";

const amount = z.string().regex(/^\d+\.\d{2}$/);
const roleAmounts = z.record(z.string(), amount);
const salaryEvidence = z
  .object({
    version: z.literal(2),
    kind: z.enum(["SALARY_PAYMENT", "SALARY_PAYMENT_RETURN"]),
    sourceKey: z.string(),
    batchId: z.string(),
    obligationId: z.number().int().positive(),
    obligationSourceKey: z.string(),
    runId: z.number().int().positive(),
    employeeId: z.number().int().positive(),
    branchId: z.number().int().positive(),
    revisionNo: z.number().int().nonnegative(),
    approvalSnapshotHash: z.string(),
    entitlementSettled: amount,
    actualPayout: amount,
    signedDifference: z.string().regex(/^-?\d+\.\d{2}$/),
    roundingRule: z.enum(["IQD_250_HALF_UP_V1", "EXACT_V1"]),
    classification: z.enum(["ROUNDING_DIFF", "EXACT"]),
    method: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]),
    cashBucket: z.enum(["TREASURY", "DRAWER"]).nullable(),
    shiftId: z.number().int().positive().nullable(),
    referenceNumber: z.string().nullable(),
    paymentYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    postingProfile: z.enum([
      "PAYMENT_OUT_PAYROLL_NET",
      "PAYMENT_IN_PAYROLL_NET_RETURN",
    ]),
    components: z
      .object({ roleDebits: roleAmounts, roleCredits: roleAmounts })
      .strict(),
    originalSourceHash: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

export type SalarySettlementEvidence = z.infer<typeof salaryEvidence>;

/** Validate the frozen contract before any v2 payment proof is displayed or replayed. */
export function assertSalaryReceiptEvidence(
  evidence: SalarySettlementEvidence | null,
  source: {
    event: typeof payrollAccountingEvents.$inferSelect;
    receipt: typeof receipts.$inferSelect | null;
    obligation?: typeof payrollObligations.$inferSelect | null;
    entryAmount?: string;
    reversed: boolean;
  },
) {
  if (!evidence) return; // Legacy evidence is explicitly unclassified, never inferred.
  const { event, receipt, obligation, entryAmount, reversed } = source;
  const actual = money(evidence.actualPayout);
  const expectedStatus = reversed ? "REVERSED" : "COMPLETED";
  if (
    evidence.sourceKey !== event.sourceKey ||
    evidence.kind !== event.eventKind ||
    evidence.runId !== event.runId ||
    evidence.obligationId !== event.obligationId ||
    evidence.revisionNo !== event.revisionNo ||
    evidence.branchId !== event.branchIdSnapshot ||
    toDateStr(event.occurredAt) !== evidence.paymentYmd ||
    (obligation != null &&
      (evidence.obligationId !== obligation.id ||
        evidence.obligationSourceKey !== obligation.sourceKey ||
        evidence.employeeId !== obligation.employeeId ||
        evidence.branchId !== obligation.branchIdSnapshot)) ||
    (actual.isZero()
      ? event.receiptId != null || receipt != null
      : !receipt ||
        event.receiptId !== receipt.id ||
        !actual.eq(receipt.amount) ||
        receipt.branchId !== evidence.branchId ||
        receipt.direction !==
          (evidence.kind === "SALARY_PAYMENT" ? "OUT" : "IN") ||
        receipt.paymentMethod !== evidence.method ||
        receipt.cashBucket !== evidence.cashBucket ||
        receipt.shiftId !== evidence.shiftId ||
        (receipt.referenceNumber?.trim() || null) !==
          evidence.referenceNumber ||
        (evidence.method === "CARD" &&
          receipt.cardLastFour !== evidence.referenceNumber) ||
        toDateStr(receipt.voucherDate ?? receipt.createdAt) !==
          evidence.paymentYmd ||
        receipt.status !== expectedStatus ||
        receipt.approvalStatus !== "APPROVED") ||
    (entryAmount != null && !actual.eq(entryAmount))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "دليل تسوية الراتب لا يطابق مستند الصرف",
        why: "المبلغ أو الهوية أو المصدر أو التاريخ أو حالة الإيصال تتعارض مع الدليل المحفوظ",
        doThis:
          "راجع الحدث والإيصال مع المحاسب قبل طباعة إثبات الصرف أو إعادة المحاولة",
      }),
    });
  }
}

export function salaryEvidenceComponents(
  source: PostingSourceComponents,
): SalarySettlementEvidence["components"] {
  return {
    roleDebits: Object.fromEntries(
      Object.entries(source.roleDebits ?? {}).map(([role, value]) => [
        role,
        money(value).toFixed(2),
      ]),
    ),
    roleCredits: Object.fromEntries(
      Object.entries(source.roleCredits ?? {}).map(([role, value]) => [
        role,
        money(value).toFixed(2),
      ]),
    ),
  };
}

export function readSalarySettlementEvidence(
  value: unknown,
  sourceHash?: string,
): SalarySettlementEvidence | null {
  if (value == null) return null; // Historical events retain their original two-leg contract.
  const parsed = salaryEvidence.safeParse(value);
  const fail = () => {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "دليل تسوية الراتب مفقود أو غير مطابق؛ راجع الحدث الأصلي قبل المتابعة.",
        why: "دليل المصدر المحفوظ لا يحقق عقد تسوية الراتب",
        doThis: "راجع الحدث والتخصيص الأصليين مع المحاسب قبل إعادة المحاولة",
      }),
    });
  };
  if (!parsed.success) return fail();
  const evidence = parsed.data;
  if (sourceHash && payrollHash(evidence) !== sourceHash) return fail();
  const delta = money(evidence.actualPayout).minus(evidence.entitlementSettled);
  if (
    !delta.eq(money(evidence.signedDifference)) ||
    evidence.classification !== (delta.isZero() ? "EXACT" : "ROUNDING_DIFF") ||
    evidence.roundingRule !==
      (evidence.method === "CASH" ? "IQD_250_HALF_UP_V1" : "EXACT_V1") ||
    (evidence.method !== "CASH" &&
      (evidence.cashBucket != null || evidence.shiftId != null)) ||
    (evidence.cashBucket !== "DRAWER" && evidence.shiftId != null)
  )
    return fail();
  const posting = payrollSettlementPosting({
    kind: "SALARY",
    direction: evidence.kind === "SALARY_PAYMENT" ? "OUT" : "IN",
    paymentMethod: evidence.method,
    amount: money(evidence.actualPayout),
    entitlementAmount: money(evidence.entitlementSettled),
    cashBucket: evidence.cashBucket,
  });
  if (
    posting.profile !== evidence.postingProfile ||
    payrollHash(posting.source) !== payrollHash(evidence.components)
  )
    return fail();
  return evidence;
}
