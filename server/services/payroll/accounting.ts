import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import {
  accountingEntries,
  payrollAccountingEvents,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { postEntry, type EntryType } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { payrollHash, type PayrollBreakdown } from "./helpers";
import type { PayrollPaymentMethod } from "./types";

export type PayrollEventKind =
  | "ACCRUAL"
  | "ACCRUAL_REVERSAL"
  | "SALARY_PAYMENT"
  | "SALARY_PAYMENT_RETURN"
  | "TAX_REMITTANCE"
  | "SOCIAL_SECURITY_REMITTANCE"
  | "REMITTANCE_RETURN"
  | "EOS_SETTLEMENT"
  | "EOS_SETTLEMENT_REVERSAL";

export function payrollPaymentAssetRole(
  method: PayrollPaymentMethod,
): Extract<
  AccountRole,
  "TREASURY_CASH" | "CARD_BANK" | "PAYMENT_WALLET"
> {
  if (method === "CASH") return "TREASURY_CASH";
  if (method === "WALLET") return "PAYMENT_WALLET";
  return "CARD_BANK";
}

function sourceComponents(
  roleDebits: Partial<Record<AccountRole, Decimal>>,
  roleCredits: Partial<Record<AccountRole, Decimal>>,
): PostingSourceComponents {
  return {
    roleDebits: Object.fromEntries(
      Object.entries(roleDebits).map(([role, value]) => [
        role,
        toDbMoney(value),
      ]),
    ),
    roleCredits: Object.fromEntries(
      Object.entries(roleCredits).map(([role, value]) => [
        role,
        toDbMoney(value),
      ]),
    ),
  };
}

export function payrollAccrualPosting(
  value: PayrollBreakdown,
  reverse = false,
): {
  profile: PostingProfile;
  intent: PostingIntent;
  source: PostingSourceComponents;
  amount: Decimal;
} {
  const debits: Partial<Record<AccountRole, Decimal>> = {
    SALARIES: value.earnedWage,
    SOCIAL_SECURITY_EXPENSE: value.socialSecurityEmployer,
    EOS_EXPENSE: value.eosProvision,
  };
  const credits: Partial<Record<AccountRole, Decimal>> = {
    ACCRUED_SALARY: value.net,
    EMPLOYEE_ADVANCES: value.advance,
    PAYROLL_TAX_PAYABLE: value.incomeTax,
    SOCIAL_SECURITY_PAYABLE: value.socialSecurityEmployee.plus(
      value.socialSecurityEmployer,
    ),
    EOS_PROVISION: value.eosProvision,
  };
  const normalSource = sourceComponents(debits, credits);
  const reversedSource = sourceComponents(credits, debits);
  const source = reverse ? reversedSource : normalSource;
  const profile: PostingProfile = reverse
    ? "ADJUST_PAYROLL_ACCRUAL_REVERSAL"
    : "ADJUST_PAYROLL_ACCRUAL";
  const lines = Object.entries(source.roleDebits ?? {})
    .filter(([, amount]) => money(amount).gt(0))
    .map(([role, amount]) => debitLine(role as AccountRole, amount))
    .concat(
      Object.entries(source.roleCredits ?? {})
        .filter(([, amount]) => money(amount).gt(0))
        .map(([role, amount]) => creditLine(role as AccountRole, amount)),
    );
  const amount = reverse ? value.expenseTotal.neg() : value.expenseTotal;
  return {
    profile,
    intent: createPostingIntent(profile, "ADJUST", lines, source),
    source,
    amount,
  };
}

export function payrollSettlementPosting(input: {
  kind: "SALARY" | "INCOME_TAX" | "SOCIAL_SECURITY";
  direction: "OUT" | "IN";
  paymentMethod: PayrollPaymentMethod;
  amount: Decimal;
}): {
  profile: PostingProfile;
  entryType: Extract<EntryType, "PAYMENT_OUT" | "PAYMENT_IN">;
  intent: PostingIntent;
  source: PostingSourceComponents;
} {
  const asset = payrollPaymentAssetRole(input.paymentMethod);
  const liability: AccountRole =
    input.kind === "SALARY"
      ? "ACCRUED_SALARY"
      : input.kind === "INCOME_TAX"
        ? "PAYROLL_TAX_PAYABLE"
        : "SOCIAL_SECURITY_PAYABLE";
  const profile: PostingProfile =
    input.direction === "OUT"
      ? input.kind === "SALARY"
        ? "PAYMENT_OUT_PAYROLL_NET"
        : input.kind === "INCOME_TAX"
          ? "PAYMENT_OUT_PAYROLL_TAX_REMIT"
          : "PAYMENT_OUT_PAYROLL_SS_REMIT"
      : input.kind === "SALARY"
        ? "PAYMENT_IN_PAYROLL_NET_RETURN"
        : input.kind === "INCOME_TAX"
          ? "PAYMENT_IN_PAYROLL_TAX_RETURN"
          : "PAYMENT_IN_PAYROLL_SS_RETURN";
  const debit = input.direction === "OUT" ? liability : asset;
  const credit = input.direction === "OUT" ? asset : liability;
  const source = sourceComponents(
    { [debit]: input.amount },
    { [credit]: input.amount },
  );
  const entryType = input.direction === "OUT" ? "PAYMENT_OUT" : "PAYMENT_IN";
  return {
    profile,
    entryType,
    intent: createPostingIntent(
      profile,
      entryType,
      signedPostingLines(debit, credit, input.amount),
      source,
    ),
    source,
  };
}

export async function postPayrollAccountingEvent(
  tx: Tx,
  input: {
    runId?: number | null;
    obligationId?: number | null;
    remittanceRequestId?: number | null;
    terminationId?: number | null;
    branchId: number;
    revisionNo: number;
    eventKind: PayrollEventKind;
    receiptId?: number | null;
    reversalOfId?: number | null;
    sourceKey: string;
    sourceHashPayload: unknown;
    occurredAt: Date;
    actorUserId: number;
    entryType: Extract<EntryType, "ADJUST" | "PAYMENT_OUT" | "PAYMENT_IN">;
    amount: Decimal;
    paymentMethod?: PayrollPaymentMethod | null;
    postingIntent: PostingIntent;
    postingSourceComponents: PostingSourceComponents;
    notes: string;
  },
): Promise<{ accountingEntryId: number; eventId: number; sourceHash: string }> {
  await postEntry(tx, {
    entryType: input.entryType,
    branchId: input.branchId,
    receiptId: input.receiptId ?? null,
    amount: round2(input.amount),
    revenue: money(0),
    cost: money(0),
    profit: money(0),
    entryDate: input.occurredAt,
    dedupeKey: input.sourceKey,
    notes: input.notes,
    createdBy: input.actorUserId,
    paymentMethod: input.paymentMethod ?? null,
    postingIntent: input.postingIntent,
    postingSourceComponents: input.postingSourceComponents,
  });
  const [entry] = await tx
    .select({ id: accountingEntries.id })
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, input.sourceKey))
    .limit(1);
  if (!entry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل ربط حدث الرواتب بقيده المحاسبي.",
    });
  }
  const sourceHash = payrollHash(input.sourceHashPayload);
  const result = await tx.insert(payrollAccountingEvents).values({
    runId: input.runId ?? null,
    obligationId: input.obligationId ?? null,
    remittanceRequestId: input.remittanceRequestId ?? null,
    terminationId: input.terminationId ?? null,
    branchIdSnapshot: input.branchId,
    revisionNo: input.revisionNo,
    eventKind: input.eventKind,
    accountingEntryId: Number(entry.id),
    receiptId: input.receiptId ?? null,
    reversalOfId: input.reversalOfId ?? null,
    sourceKey: input.sourceKey,
    sourceHash,
    occurredAt: input.occurredAt,
    createdBy: input.actorUserId,
  });
  return {
    accountingEntryId: Number(entry.id),
    eventId: extractInsertId(result),
    sourceHash,
  };
}
