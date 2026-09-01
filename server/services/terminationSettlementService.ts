import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  employeeAdvances,
  employeeTerminations,
  employees,
  payrollAccountingEvents,
  payrollObligationAllocations,
  payrollObligations,
  receipts,
  terminationAdvanceAllocations,
  users,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { baghdadToday } from "./businessDay";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
  type PostingSourceComponents,
} from "./accounting/postingEngine";
import { money, round2, toDbMoney } from "./money";
import {
  payrollSettlementPosting,
  postPayrollAccountingEvent,
} from "./payroll/accounting";
import { payrollHash } from "./payroll/helpers";
import type { PayrollPaymentMethod } from "./payroll/types";
import { assertPeriodOpen } from "./periodLockService";
import { withTx, type Actor } from "./tx";
import { createSystemPaymentRequestTx } from "./voucher/create";
import { lockMaterializedCashReceiptSourceForWrite } from "./cash/cashAvailability";

type TerminationActor = Omit<Actor, "branchId"> & { branchId: number | null };

export interface TerminationBreakdownInput {
  earnedGrossWages?: string | null;
  wageReductions?: string | null;
  advanceRecovery?: string | null;
  incomeTax?: string | null;
  employeeSocialSecurity?: string | null;
  employerSocialSecurity?: string | null;
  leaveCompensation?: string | null;
  noticeCompensation?: string | null;
  eosBenefit?: string | null;
  otherSettlement?: string | null;
  otherSettlementLabel?: string | null;
}

export interface TerminationBreakdown {
  earnedGrossWages: Decimal;
  wageReductions: Decimal;
  advanceRecovery: Decimal;
  incomeTax: Decimal;
  employeeSocialSecurity: Decimal;
  employerSocialSecurity: Decimal;
  earnedNetWages: Decimal;
  leaveCompensation: Decimal;
  noticeCompensation: Decimal;
  eosBenefit: Decimal;
  otherSettlement: Decimal;
  otherSettlementLabel: string | null;
  shortTermExpense: Decimal;
  total: Decimal;
}

function explicitAmount(value: string | null | undefined, label: string): Decimal {
  const raw = money(value?.trim() || "0");
  if (!raw.isFinite() || raw.isNegative() || !raw.eq(round2(raw))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label}: المبلغ يجب أن يكون غير سالب وبمنزلتين عشريتين كحد أقصى.`,
    });
  }
  return round2(raw);
}

/** No statutory rate is inferred: every number is an explicit reviewed input. */
export function normalizeTerminationBreakdown(
  input: TerminationBreakdownInput,
): TerminationBreakdown {
  const earnedGrossWages = explicitAmount(
    input.earnedGrossWages,
    "إجمالي الأجور المكتسبة",
  );
  const wageReductions = explicitAmount(input.wageReductions, "تخفيضات الأجر");
  const advanceRecovery = explicitAmount(input.advanceRecovery, "استرداد السلفة");
  const incomeTax = explicitAmount(input.incomeTax, "ضريبة الدخل");
  const employeeSocialSecurity = explicitAmount(
    input.employeeSocialSecurity,
    "حصة الموظف من الضمان الاجتماعي",
  );
  const employerSocialSecurity = explicitAmount(
    input.employerSocialSecurity,
    "حصة الشركة من الضمان الاجتماعي",
  );
  const leaveCompensation = explicitAmount(
    input.leaveCompensation,
    "تعويض رصيد الإجازات",
  );
  const noticeCompensation = explicitAmount(
    input.noticeCompensation,
    "بدل الإشعار",
  );
  const eosBenefit = explicitAmount(input.eosBenefit, "مكافأة نهاية الخدمة");
  const otherSettlement = explicitAmount(input.otherSettlement, "المستحق الآخر");
  const otherSettlementLabel = input.otherSettlementLabel?.trim() || null;
  if (otherSettlement.gt(0) && !otherSettlementLabel) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تصنيف المستحق الآخر إلزامي عندما تكون له قيمة.",
    });
  }
  const earnedNetWages = round2(
    earnedGrossWages
      .minus(wageReductions)
      .minus(advanceRecovery)
      .minus(incomeTax)
      .minus(employeeSocialSecurity),
  );
  if (earnedNetWages.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "صافي الأجور المكتسبة لا يجوز أن يكون سالباً؛ راجع التخفيضات والسلفة والضريبة والضمان المدخلة.",
    });
  }
  const shortTermExpense = round2(
    earnedGrossWages
      .minus(wageReductions)
      .plus(leaveCompensation)
      .plus(noticeCompensation)
      .plus(otherSettlement),
  );
  return {
    earnedGrossWages,
    wageReductions,
    advanceRecovery,
    incomeTax,
    employeeSocialSecurity,
    employerSocialSecurity,
    earnedNetWages,
    leaveCompensation,
    noticeCompensation,
    eosBenefit,
    otherSettlement,
    otherSettlementLabel,
    shortTermExpense,
    total: round2(
      earnedNetWages
        .plus(leaveCompensation)
        .plus(noticeCompensation)
        .plus(otherSettlement)
        .plus(eosBenefit),
    ),
  };
}

export function assertTerminationPaymentMethod(
  method: string | null | undefined,
  referenceNumber?: string | null,
): { method: PayrollPaymentMethod; referenceNumber: string | null } {
  if (
    method !== "CASH" &&
    method !== "CARD" &&
    method !== "TRANSFER" &&
    method !== "WALLET"
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "طريقة دفع التسوية غير صالحة." });
  }
  const reference = referenceNumber?.trim() || null;
  if (method !== "CASH" && !reference) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رقم مرجع التحويل/البطاقة/المحفظة إلزامي للتسوية غير النقدية.",
    });
  }
  if (method === "CARD" && !/^\d{4}$/.test(reference ?? "")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع البطاقة يجب أن يكون آخر أربعة أرقام منها.",
    });
  }
  return { method, referenceNumber: reference };
}

function roleComponents(
  debits: Partial<Record<AccountRole, Decimal>>,
  credits: Partial<Record<AccountRole, Decimal>>,
): PostingSourceComponents {
  return {
    roleDebits: Object.fromEntries(
      Object.entries(debits).map(([role, value]) => [role, toDbMoney(value)]),
    ),
    roleCredits: Object.fromEntries(
      Object.entries(credits).map(([role, value]) => [role, toDbMoney(value)]),
    ),
  };
}

function terminationRecognitionPosting(input: {
  shortTermExpense: Decimal;
  localAdvanceRecovery: Decimal;
  transferredAdvanceRecovery: Decimal;
  incomeTax: Decimal;
  employeeSocialSecurity: Decimal;
  employerSocialSecurity: Decimal;
  total: Decimal;
  localProvision: Decimal;
  transferredProvision: Decimal;
  provisionShortfall: Decimal;
  provisionRelease: Decimal;
  reverse?: boolean;
}) {
  const netTransferredClearing = round2(
    input.transferredProvision.minus(input.transferredAdvanceRecovery),
  );
  const normalDebits: Partial<Record<AccountRole, Decimal>> = {
    SALARIES: input.shortTermExpense,
    SOCIAL_SECURITY_EXPENSE: input.employerSocialSecurity,
    EOS_PROVISION: input.localProvision,
    EOS_EXPENSE: input.provisionShortfall,
    INTERBRANCH_CLEARING: Decimal.max(netTransferredClearing, 0),
  };
  const normalCredits: Partial<Record<AccountRole, Decimal>> = {
    ACCRUED_SALARY: input.total,
    EMPLOYEE_ADVANCES: input.localAdvanceRecovery,
    PAYROLL_TAX_PAYABLE: input.incomeTax,
    SOCIAL_SECURITY_PAYABLE: round2(
      input.employeeSocialSecurity.plus(input.employerSocialSecurity),
    ),
    EOS_EXPENSE: input.provisionRelease,
    INTERBRANCH_CLEARING: Decimal.max(netTransferredClearing.neg(), 0),
  };
  const debits = input.reverse ? normalCredits : normalDebits;
  const credits = input.reverse ? normalDebits : normalCredits;
  const source = roleComponents(debits, credits);
  const lines = Object.entries(debits)
    .filter(([, value]) => money(value).gt(0))
    .map(([role, value]) => debitLine(role as AccountRole, value))
    .concat(
      Object.entries(credits)
        .filter(([, value]) => money(value).gt(0))
        .map(([role, value]) => creditLine(role as AccountRole, value)),
    );
  const profile = input.reverse
    ? "ADJUST_EOS_SETTLEMENT_REVERSAL"
    : "ADJUST_EOS_SETTLEMENT";
  const expenseImpact = round2(
    input.shortTermExpense
      .plus(input.employerSocialSecurity)
      .plus(input.provisionShortfall)
      .minus(input.provisionRelease),
  );
  return {
    // Simplified P&L reports sum accountingEntries.amount for payroll accrual
    // events. The payable total lives in the obligation; only the new expense
    // (or released prior expense) belongs in this field.
    amount: input.reverse ? expenseImpact.neg() : expenseImpact,
    source,
    intent: createPostingIntent(profile, "ADJUST", lines, source),
  } as const;
}

function terminationAdvanceTransferPosting(amount: Decimal, reverse = false) {
  const debits: Partial<Record<AccountRole, Decimal>> = reverse
    ? { EMPLOYEE_ADVANCES: amount }
    : { INTERBRANCH_CLEARING: amount };
  const credits: Partial<Record<AccountRole, Decimal>> = reverse
    ? { INTERBRANCH_CLEARING: amount }
    : { EMPLOYEE_ADVANCES: amount };
  const source = roleComponents(debits, credits);
  const lines = Object.entries(debits)
    .map(([role, value]) => debitLine(role as AccountRole, value))
    .concat(
      Object.entries(credits).map(([role, value]) =>
        creditLine(role as AccountRole, value),
      ),
    );
  return {
    source,
    intent: createPostingIntent(
      reverse
        ? "ADJUST_TERMINATION_ADVANCE_TRANSFER_REVERSAL"
        : "ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT",
      "ADJUST",
      lines,
      source,
    ),
  } as const;
}

function terminationProvisionTransferPosting(amount: Decimal, reverse = false) {
  const debits: Partial<Record<AccountRole, Decimal>> = reverse
    ? { INTERBRANCH_CLEARING: amount }
    : { EOS_PROVISION: amount };
  const credits: Partial<Record<AccountRole, Decimal>> = reverse
    ? { EOS_PROVISION: amount }
    : { INTERBRANCH_CLEARING: amount };
  const source = roleComponents(debits, credits);
  const lines = Object.entries(debits)
    .map(([role, value]) => debitLine(role as AccountRole, value))
    .concat(
      Object.entries(credits).map(([role, value]) =>
        creditLine(role as AccountRole, value),
      ),
    );
  return {
    source,
    intent: createPostingIntent(
      reverse
        ? "ADJUST_EOS_PROVISION_TRANSFER_REVERSAL"
        : "ADJUST_EOS_PROVISION_TRANSFER_OUT",
      "ADJUST",
      lines,
      source,
    ),
  } as const;
}

export async function recognizeTerminationSettlementTx(
  tx: Tx,
  input: {
    terminationId: number;
    employeeId: number;
    branchId: number;
    lastDay: string;
    breakdown: TerminationBreakdown;
    evidenceNote: string;
    zeroAmountsAttested: boolean;
    actorUserId: number;
    recognizedAt: Date;
  },
): Promise<{
  obligationId: number | null;
  eventId: number | null;
  snapshotHash: string;
  provisionAvailable: string;
  provisionConsumed: string;
  provisionReleased: string;
  expenseRecognized: string;
}> {
  const duplicate = await tx
    .select({ id: payrollAccountingEvents.id })
    .from(payrollAccountingEvents)
    .where(
      and(
        eq(payrollAccountingEvents.terminationId, input.terminationId),
        eq(payrollAccountingEvents.eventKind, "EOS_SETTLEMENT"),
      ),
    )
    .limit(1);
  if (duplicate[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "استحقاق تسوية نهاية الخدمة مثبت مسبقاً.",
    });
  }
  await assertPeriodOpen(tx, input.recognizedAt);

  const evidenceNote = input.evidenceNote.trim();
  if (!input.zeroAmountsAttested || evidenceNote.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "إقرار القيم الصفرية ومرجع المراجعة البشرية التفصيلي إلزاميان قبل إثبات التسوية.",
    });
  }
  const activeAdvances = await tx
    .select()
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.employeeId, input.employeeId),
        eq(employeeAdvances.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(employeeAdvances.id))
    .for("update");
  const activeAdvanceBalance = round2(
    activeAdvances.reduce(
      (sum, advance) => sum.plus(money(advance.remaining)),
      money(0),
    ),
  );
  if (input.breakdown.advanceRecovery.gt(activeAdvanceBalance)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "مبلغ استرداد السلفة في التسوية يتجاوز الرصيد النشط المقفل للموظف.",
    });
  }
  const advanceApplicationPlan: Array<{
    advance: (typeof activeAdvances)[number];
    amount: Decimal;
  }> = [];
  let unplannedAdvanceRecovery = input.breakdown.advanceRecovery;
  for (const advance of activeAdvances) {
    if (unplannedAdvanceRecovery.lte(0)) break;
    const amount = round2(
      Decimal.min(money(advance.remaining), unplannedAdvanceRecovery),
    );
    if (amount.lte(0)) continue;
    advanceApplicationPlan.push({ advance, amount });
    unplannedAdvanceRecovery = round2(
      unplannedAdvanceRecovery.minus(amount),
    );
  }
  if (unplannedAdvanceRecovery.gt(0)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تعذر تخطيط كامل استرداد السلفة على الأرصدة المقفلة.",
    });
  }
  const advanceRecoveryByBranch = new Map<
    number,
    typeof advanceApplicationPlan
  >();
  for (const application of advanceApplicationPlan) {
    const sourceBranchId = Number(application.advance.branchId);
    if (!Number.isInteger(sourceBranchId) || sourceBranchId <= 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "سلفة الموظف بلا فرع مصدر صالح.",
      });
    }
    const rows = advanceRecoveryByBranch.get(sourceBranchId) ?? [];
    rows.push(application);
    advanceRecoveryByBranch.set(sourceBranchId, rows);
  }
  const advanceBranchAmount = (
    rows: typeof advanceApplicationPlan | undefined,
  ) =>
    round2(
      (rows ?? []).reduce(
        (sum, application) => sum.plus(application.amount),
        money(0),
      ),
    );
  const localAdvanceRecovery = advanceBranchAmount(
    advanceRecoveryByBranch.get(input.branchId),
  );
  const transferredAdvanceRecovery = round2(
    input.breakdown.advanceRecovery.minus(localAdvanceRecovery),
  );
  const remainingAdvanceAtRecognition = round2(
    activeAdvanceBalance.minus(input.breakdown.advanceRecovery),
  );

  const eosObligations = await tx
    .select()
    .from(payrollObligations)
    .where(
      and(
        eq(payrollObligations.employeeId, input.employeeId),
        eq(payrollObligations.kind, "EOS_PROVISION"),
        inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
      ),
    )
    .orderBy(asc(payrollObligations.dueDate), asc(payrollObligations.id))
    .for("update");
  const provisionAvailable = round2(
    eosObligations.reduce(
      (sum, row) => sum.plus(money(row.remainingAmount)),
      money(0),
    ),
  );
  const provisionConsumed = round2(
    Decimal.min(provisionAvailable, input.breakdown.eosBenefit),
  );
  const provisionReleased = round2(
    Decimal.max(provisionAvailable.minus(input.breakdown.eosBenefit), 0),
  );
  const expenseRecognized = round2(
    Decimal.max(input.breakdown.eosBenefit.minus(provisionAvailable), 0),
  );
  const provisionByBranch = new Map<number, typeof eosObligations>();
  for (const obligation of eosObligations) {
    // GLOBAL legacy/opening provisions have no branch ledger grain; the
    // explicit policy is to assign them to the employee's termination branch.
    const sourceBranchId = Number(obligation.branchIdSnapshot ?? input.branchId);
    if (!Number.isInteger(sourceBranchId) || sourceBranchId <= 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مصدر مخصص نهاية الخدمة بلا فرع صالح.",
      });
    }
    const rows = provisionByBranch.get(sourceBranchId) ?? [];
    rows.push(obligation);
    provisionByBranch.set(sourceBranchId, rows);
  }
  const branchAmount = (rows: typeof eosObligations | undefined) =>
    round2(
      (rows ?? []).reduce(
        (sum, row) => sum.plus(money(row.remainingAmount)),
        money(0),
      ),
    );
  const localProvision = branchAmount(provisionByBranch.get(input.branchId));
  const transferredProvision = round2(provisionAvailable.minus(localProvision));
  const canonical = {
    version: 2,
    basis: "EXPLICIT_HUMAN_APPROVED_GROSS_TO_NET",
    terminationId: input.terminationId,
    employeeId: input.employeeId,
    branchId: input.branchId,
    lastDay: input.lastDay,
    earnedGrossWages: input.breakdown.earnedGrossWages.toFixed(2),
    wageReductions: input.breakdown.wageReductions.toFixed(2),
    advanceRecovery: input.breakdown.advanceRecovery.toFixed(2),
    incomeTax: input.breakdown.incomeTax.toFixed(2),
    employeeSocialSecurity:
      input.breakdown.employeeSocialSecurity.toFixed(2),
    employerSocialSecurity:
      input.breakdown.employerSocialSecurity.toFixed(2),
    earnedNetWages: input.breakdown.earnedNetWages.toFixed(2),
    leaveCompensation: input.breakdown.leaveCompensation.toFixed(2),
    noticeCompensation: input.breakdown.noticeCompensation.toFixed(2),
    eosBenefit: input.breakdown.eosBenefit.toFixed(2),
    otherSettlement: input.breakdown.otherSettlement.toFixed(2),
    otherSettlementLabel: input.breakdown.otherSettlementLabel,
    evidenceNote,
    zeroAmountsAttested: input.zeroAmountsAttested,
    total: input.breakdown.total.toFixed(2),
    provisionAvailable: provisionAvailable.toFixed(2),
    provisionConsumed: provisionConsumed.toFixed(2),
    provisionReleased: provisionReleased.toFixed(2),
    expenseRecognized: expenseRecognized.toFixed(2),
    activeAdvanceBalance: activeAdvanceBalance.toFixed(2),
    remainingAdvanceAtRecognition: remainingAdvanceAtRecognition.toFixed(2),
    localAdvanceRecovery: localAdvanceRecovery.toFixed(2),
    transferredAdvanceRecovery: transferredAdvanceRecovery.toFixed(2),
    advanceSources: advanceApplicationPlan.map(({ advance, amount }) => ({
      id: Number(advance.id),
      sourceBranchId: Number(advance.branchId),
      amount: amount.toFixed(2),
    })),
    provisionSources: eosObligations.map((row) => ({
      id: Number(row.id),
      sourceKey: row.sourceKey,
      sourceBranchId: Number(row.branchIdSnapshot ?? input.branchId),
      amount: money(row.remainingAmount).toFixed(2),
    })),
  } as const;
  const snapshotHash = payrollHash(canonical);

  const createTerminationObligation = async (
    kind: "SALARY_NET" | "INCOME_TAX" | "SOCIAL_SECURITY",
    amount: Decimal,
  ): Promise<number | null> => {
    if (amount.lte(0)) return null;
    const result = await tx.insert(payrollObligations).values({
      runId: null,
      itemId: null,
      employeeId: input.employeeId,
      terminationId: input.terminationId,
      branchIdSnapshot: input.branchId,
      revisionNo: 0,
      kind,
      originalAmount: toDbMoney(amount),
      remainingAmount: toDbMoney(amount),
      dueDate: input.lastDay,
      status: "OPEN",
      sourceType: "TERMINATION",
      sourceKey: `TERMINATION:OBL:${input.terminationId}:${kind}`,
      authorityName: "تسوية نهاية الخدمة",
      authorityReference: `TERM-${input.terminationId}`,
    });
    return extractInsertId(result);
  };
  const obligationId = await createTerminationObligation(
    "SALARY_NET",
    input.breakdown.total,
  );
  await createTerminationObligation("INCOME_TAX", input.breakdown.incomeTax);
  await createTerminationObligation(
    "SOCIAL_SECURITY",
    round2(
      input.breakdown.employeeSocialSecurity.plus(
        input.breakdown.employerSocialSecurity,
      ),
    ),
  );

  let eventId: number | null = null;
  const hasRecognitionEffect =
    input.breakdown.shortTermExpense.gt(0) ||
    input.breakdown.employerSocialSecurity.gt(0) ||
    input.breakdown.advanceRecovery.gt(0) ||
    input.breakdown.incomeTax.gt(0) ||
    input.breakdown.employeeSocialSecurity.gt(0) ||
    input.breakdown.total.gt(0) ||
    provisionAvailable.gt(0);
  if (hasRecognitionEffect) {
    // Clear each historical branch's provision in that same branch and move
    // it through inter-branch clearing. Its event owns only that branch's EOS
    // allocations, so reversal can reconstruct the exact branch snapshot.
    for (const [sourceBranchId, obligations] of Array.from(provisionByBranch.entries())) {
      if (sourceBranchId === input.branchId) continue;
      const transferred = branchAmount(obligations);
      if (transferred.lte(0)) continue;
      const transferPosting = terminationProvisionTransferPosting(transferred);
      const transferEvent = await postPayrollAccountingEvent(tx, {
        terminationId: input.terminationId,
        obligationId: null,
        branchId: sourceBranchId,
        revisionNo: 0,
        eventKind: "EOS_SETTLEMENT",
        sourceKey: `TERMINATION:EOS_TRANSFER:${input.terminationId}:BRANCH:${sourceBranchId}`,
        sourceHashPayload: {
          ...canonical,
          kind: "EOS_PROVISION_INTERBRANCH_TRANSFER",
          sourceBranchId,
          destinationBranchId: input.branchId,
          amount: transferred.toFixed(2),
        },
        occurredAt: input.recognizedAt,
        actorUserId: input.actorUserId,
        entryType: "ADJUST",
        amount: money(0),
        postingIntent: transferPosting.intent,
        postingSourceComponents: transferPosting.source,
        notes: `نقل مخصص نهاية خدمة موظف #${input.employeeId} من فرع ${sourceBranchId}`,
      });
      for (const obligation of obligations) {
        const applied = money(obligation.remainingAmount);
        if (applied.lte(0)) continue;
        await tx.insert(payrollObligationAllocations).values({
          obligationId: Number(obligation.id),
          accountingEventId: transferEvent.eventId,
          direction: "APPLY",
          amount: toDbMoney(applied),
          sourceKey: `TERMINATION:EOS_ALLOC:${input.terminationId}:${Number(obligation.id)}`,
          occurredAt: input.recognizedAt,
          createdBy: input.actorUserId,
        });
        await tx
          .update(payrollObligations)
          .set({ remainingAmount: "0.00", status: "SETTLED" })
          .where(eq(payrollObligations.id, Number(obligation.id)));
      }
    }
    for (const [sourceBranchId, applications] of Array.from(
      advanceRecoveryByBranch.entries(),
    )) {
      if (sourceBranchId === input.branchId) continue;
      const transferred = advanceBranchAmount(applications);
      if (transferred.lte(0)) continue;
      const transferPosting = terminationAdvanceTransferPosting(transferred);
      const transferEvent = await postPayrollAccountingEvent(tx, {
        terminationId: input.terminationId,
        obligationId: null,
        branchId: sourceBranchId,
        revisionNo: 0,
        eventKind: "EOS_SETTLEMENT",
        sourceKey: `TERMINATION:ADVANCE_TRANSFER:${input.terminationId}:BRANCH:${sourceBranchId}`,
        sourceHashPayload: {
          ...canonical,
          kind: "EMPLOYEE_ADVANCE_INTERBRANCH_TRANSFER",
          sourceBranchId,
          destinationBranchId: input.branchId,
          amount: transferred.toFixed(2),
        },
        occurredAt: input.recognizedAt,
        actorUserId: input.actorUserId,
        entryType: "ADJUST",
        amount: money(0),
        postingIntent: transferPosting.intent,
        postingSourceComponents: transferPosting.source,
        notes: `تسوية سلفة موظف #${input.employeeId} في فرعها الأصلي ${sourceBranchId}`,
      });
      for (const application of applications) {
        const currentRemaining = money(application.advance.remaining);
        await tx.insert(terminationAdvanceAllocations).values({
          terminationId: input.terminationId,
          advanceId: Number(application.advance.id),
          accountingEventId: transferEvent.eventId,
          direction: "APPLY",
          amount: toDbMoney(application.amount),
          sourceKey: `TERMINATION:ADVANCE:${input.terminationId}:${Number(application.advance.id)}`,
          occurredAt: input.recognizedAt,
          createdBy: input.actorUserId,
        });
        await tx
          .update(employeeAdvances)
          .set({
            remaining: toDbMoney(currentRemaining.minus(application.amount)),
            status: currentRemaining.eq(application.amount)
              ? "SETTLED"
              : "ACTIVE",
          })
          .where(eq(employeeAdvances.id, Number(application.advance.id)));
      }
    }
    const posting = terminationRecognitionPosting({
      shortTermExpense: input.breakdown.shortTermExpense,
      localAdvanceRecovery,
      transferredAdvanceRecovery,
      incomeTax: input.breakdown.incomeTax,
      employeeSocialSecurity: input.breakdown.employeeSocialSecurity,
      employerSocialSecurity: input.breakdown.employerSocialSecurity,
      total: input.breakdown.total,
      localProvision,
      transferredProvision,
      provisionShortfall: expenseRecognized,
      provisionRelease: provisionReleased,
    });
    const event = await postPayrollAccountingEvent(tx, {
      terminationId: input.terminationId,
      obligationId,
      branchId: input.branchId,
      revisionNo: 0,
      eventKind: "EOS_SETTLEMENT",
      sourceKey: `TERMINATION:ACCRUAL:${input.terminationId}`,
      sourceHashPayload: canonical,
      occurredAt: input.recognizedAt,
      actorUserId: input.actorUserId,
      entryType: "ADJUST",
      amount: posting.amount,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `إثبات استحقاق تسوية نهاية خدمة موظف #${input.employeeId}`,
    });
    eventId = event.eventId;
    for (const application of advanceRecoveryByBranch.get(input.branchId) ?? []) {
      const currentRemaining = money(application.advance.remaining);
      await tx.insert(terminationAdvanceAllocations).values({
        terminationId: input.terminationId,
        advanceId: Number(application.advance.id),
        accountingEventId: event.eventId,
        direction: "APPLY",
        amount: toDbMoney(application.amount),
        sourceKey: `TERMINATION:ADVANCE:${input.terminationId}:${Number(application.advance.id)}`,
        occurredAt: input.recognizedAt,
        createdBy: input.actorUserId,
      });
      await tx
        .update(employeeAdvances)
        .set({
          remaining: toDbMoney(currentRemaining.minus(application.amount)),
          status: currentRemaining.eq(application.amount)
            ? "SETTLED"
            : "ACTIVE",
        })
        .where(eq(employeeAdvances.id, Number(application.advance.id)));
    }
    for (const obligation of provisionByBranch.get(input.branchId) ?? []) {
      const applied = money(obligation.remainingAmount);
      if (applied.lte(0)) continue;
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        direction: "APPLY",
        amount: toDbMoney(applied),
        sourceKey: `TERMINATION:EOS_ALLOC:${input.terminationId}:${Number(obligation.id)}`,
        occurredAt: input.recognizedAt,
        createdBy: input.actorUserId,
      });
      await tx
        .update(payrollObligations)
        .set({ remainingAmount: "0.00", status: "SETTLED" })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
  }

  await tx
    .update(employeeTerminations)
    .set({
      settlementSnapshotHash: snapshotHash,
      eosProvisionAvailable: toDbMoney(provisionAvailable),
      eosProvisionConsumed: toDbMoney(provisionConsumed),
      eosProvisionReleased: toDbMoney(provisionReleased),
      eosExpenseRecognized: toDbMoney(expenseRecognized),
      remainingAdvanceAtRecognition: toDbMoney(
        remainingAdvanceAtRecognition,
      ),
      recognizedAt: input.recognizedAt,
      recognizedBy: input.actorUserId,
      recognitionEventId: eventId,
    })
    .where(eq(employeeTerminations.id, input.terminationId));
  return {
    obligationId,
    eventId,
    snapshotHash,
    provisionAvailable: provisionAvailable.toFixed(2),
    provisionConsumed: provisionConsumed.toFixed(2),
    provisionReleased: provisionReleased.toFixed(2),
    expenseRecognized: expenseRecognized.toFixed(2),
  };
}

export async function settleTerminationVoucherTx(
  tx: Tx,
  input: {
    terminationId: number;
    employeeId: number;
    branchId: number;
    receiptId: number;
    amount: Decimal;
    paymentMethod: PayrollPaymentMethod;
    actorUserId: number;
    occurredAt: Date;
    attempt: number;
    originReturnEventId: number | null;
    settlementSnapshotHash: string;
    expectedObligationId: number;
  },
): Promise<{ eventId: number; obligationId: number }> {
  const [termination] = await tx
    .select()
    .from(employeeTerminations)
    .where(eq(employeeTerminations.id, input.terminationId))
    .for("update")
    .limit(1);
  if (
    !termination ||
    termination.status !== "completed" ||
    !termination.recognizedAt ||
    termination.recognitionReversedAt ||
    Number(termination.employeeId) !== input.employeeId ||
    !money(termination.settlement).eq(input.amount) ||
    termination.settlementSnapshotHash !== input.settlementSnapshotHash ||
    !Number.isInteger(input.attempt) ||
    input.attempt <= 0
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "استحقاق تسوية نهاية الخدمة غير موجود أو تغيّر أو عُكس.",
    });
  }
  const [obligation] = await tx
    .select()
    .from(payrollObligations)
    .where(
      and(
        eq(payrollObligations.terminationId, input.terminationId),
        eq(payrollObligations.kind, "SALARY_NET"),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !obligation ||
    Number(obligation.id) !== Number(input.expectedObligationId) ||
    Number(obligation.employeeId) !== input.employeeId ||
    Number(obligation.branchIdSnapshot) !== input.branchId ||
    !money(obligation.remainingAmount).eq(input.amount) ||
    !inArrayStatus(obligation.status, ["OPEN", "PARTIAL"])
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "التزام تسوية نهاية الخدمة غير مفتوح أو لا يطابق مبلغ الصرف.",
    });
  }
  const voucherAttempts = await tx
    .select({ id: receipts.id, approvalStatus: receipts.approvalStatus })
    .from(receipts)
    .where(
      like(receipts.referenceNumber, `TERM-SETTLEMENT-${input.terminationId}-%`),
    )
    .orderBy(asc(receipts.id))
    .for("update");
  const currentAttemptIndex = voucherAttempts.findIndex(
    (request) => Number(request.id) === Number(input.receiptId),
  );
  if (
    currentAttemptIndex < 0 ||
    currentAttemptIndex + 1 !== input.attempt ||
    currentAttemptIndex !== voucherAttempts.length - 1
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طلب الصرف ليس المحاولة النظامية الأحدث لهذه التسوية.",
    });
  }
  const paymentHistory = await tx
    .select({
      id: payrollAccountingEvents.id,
      eventKind: payrollAccountingEvents.eventKind,
      reversalOfId: payrollAccountingEvents.reversalOfId,
    })
    .from(payrollAccountingEvents)
    .where(
      and(
        eq(payrollAccountingEvents.terminationId, input.terminationId),
        inArray(payrollAccountingEvents.eventKind, [
          "SALARY_PAYMENT",
          "SALARY_PAYMENT_RETURN",
        ]),
      ),
    )
    .orderBy(asc(payrollAccountingEvents.id))
    .for("update");
  const priorPayments = paymentHistory.filter(
    (event) => event.eventKind === "SALARY_PAYMENT",
  );
  const priorReturns = paymentHistory.filter(
    (event) => event.eventKind === "SALARY_PAYMENT_RETURN",
  );
  if (
    (input.attempt === 1 && (paymentHistory.length > 0 || input.originReturnEventId != null)) ||
    (input.originReturnEventId != null &&
      Number(priorReturns[priorReturns.length - 1]?.id) !== Number(input.originReturnEventId)) ||
    (priorReturns.length > 0 && input.originReturnEventId == null) ||
    priorReturns.length !== priorPayments.length
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "محاولة صرف التسوية لا تطابق تسلسل الصرف والإعادة المحفوظ.",
    });
  }
  const posting = payrollSettlementPosting({
    kind: "SALARY",
    direction: "OUT",
    paymentMethod: input.paymentMethod,
    amount: input.amount,
  });
  const attempt = priorPayments.length + 1;
  const attemptSuffix = attempt === 1 ? "" : `:ATTEMPT:${attempt}`;
  const event = await postPayrollAccountingEvent(tx, {
    terminationId: input.terminationId,
    obligationId: Number(obligation.id),
    branchId: input.branchId,
    revisionNo: 0,
    eventKind: "SALARY_PAYMENT",
    receiptId: input.receiptId,
    sourceKey: `TERMINATION:PAYMENT:${input.terminationId}${attemptSuffix}`,
    sourceHashPayload: {
      version: 1,
      kind: "TERMINATION_PAYMENT",
      terminationId: input.terminationId,
      obligationSourceKey: obligation.sourceKey,
      amount: input.amount.toFixed(2),
      paymentMethod: input.paymentMethod,
      receiptId: input.receiptId,
      attempt,
    },
    occurredAt: input.occurredAt,
    actorUserId: input.actorUserId,
    entryType: posting.entryType,
    amount: input.amount,
    paymentMethod: input.paymentMethod,
    postingIntent: posting.intent,
    postingSourceComponents: posting.source,
    notes: `صرف تسوية نهاية خدمة موظف #${input.employeeId}`,
  });
  await tx.insert(payrollObligationAllocations).values({
    obligationId: Number(obligation.id),
    accountingEventId: event.eventId,
    direction: "APPLY",
    amount: toDbMoney(input.amount),
    sourceKey: `TERMINATION:PAYMENT_ALLOC:${input.terminationId}${attemptSuffix}`,
    occurredAt: input.occurredAt,
    createdBy: input.actorUserId,
  });
  await tx
    .update(payrollObligations)
    .set({ remainingAmount: "0.00", status: "SETTLED" })
    .where(eq(payrollObligations.id, Number(obligation.id)));
  return { eventId: event.eventId, obligationId: Number(obligation.id) };
}

function inArrayStatus<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.includes(value as T);
}

async function assertActiveOwner(
  tx: Tx,
  actor: TerminationActor,
  forbidden: Array<number | null | undefined>,
  operation: string,
) {
  const [row] = await tx
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!row?.isActive || !row.isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${operation}: يلزم مالك نشط.` });
  }
  if (forbidden.filter((id): id is number => id != null).map(Number).includes(Number(row.id))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${operation}: يلزم مالك مستقل عن مُنشئ/مثبت التسوية.`,
    });
  }
}

function terminationPaymentReturnHashPayload(input: {
  terminationId: number;
  originalEventId: number;
  amount: Decimal;
  paymentMethod: PayrollPaymentMethod;
  referenceNumber: string | null;
  reversalDate: string;
  reason: string;
}) {
  return {
    version: 1,
    kind: "TERMINATION_PAYMENT_RETURN",
    terminationId: input.terminationId,
    originalEventId: input.originalEventId,
    amount: input.amount.toFixed(2),
    paymentMethod: input.paymentMethod,
    referenceNumber: input.referenceNumber,
    reversalDate: input.reversalDate,
    reason: input.reason,
  } as const;
}

function terminationReissueClientRequestId(
  terminationId: number,
  attempt: number,
  reason: string,
) {
  const reasonFingerprint = payrollHash({
    version: 1,
    kind: "TERMINATION_PAYMENT_REISSUE",
    terminationId,
    attempt,
    reason,
  }).slice(0, 16);
  return `termination-settlement-reissue-${terminationId}-A${attempt}-${reasonFingerprint}`;
}

export async function reverseTerminationPayment(
  terminationId: number,
  actor: TerminationActor,
  input: {
    reason: string;
    paymentMethod: PayrollPaymentMethod;
    referenceNumber?: string | null;
    reversalDate?: string | null;
  },
) {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب عكس الصرف التفصيلي إلزامي." });
  }
  const evidence = assertTerminationPaymentMethod(
    input.paymentMethod,
    input.referenceNumber,
  );
  const reversalDate = input.reversalDate?.trim() || baghdadToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reversalDate) || reversalDate > baghdadToday()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ عكس الصرف غير صالح أو مستقبلي." });
  }
  return withTx(async (tx) => {
    // اعتماد الصرف يقفل treasury قبل termination/payroll rows. عكس الاتجاه هنا كان
    // سيصنع دورة أقفال؛ لذلك نعاين آخر حدث أولاً ونقفل المصدر قبل أي صف عمل.
    const [latestPaymentPreview] = await tx
      .select({
        eventKind: payrollAccountingEvents.eventKind,
        branchId: payrollObligations.branchIdSnapshot,
      })
      .from(payrollAccountingEvents)
      .leftJoin(
        payrollObligations,
        eq(payrollObligations.id, payrollAccountingEvents.obligationId),
      )
      .where(
        and(
          eq(payrollAccountingEvents.terminationId, terminationId),
          inArray(payrollAccountingEvents.eventKind, [
            "SALARY_PAYMENT",
            "SALARY_PAYMENT_RETURN",
          ]),
        ),
      )
      .orderBy(desc(payrollAccountingEvents.id))
      .limit(1);
    let prelockedCashBranchId: number | null = null;
    if (
      evidence.method === "CASH" &&
      latestPaymentPreview?.eventKind === "SALARY_PAYMENT" &&
      latestPaymentPreview.branchId != null
    ) {
      prelockedCashBranchId = Number(latestPaymentPreview.branchId);
      await lockMaterializedCashReceiptSourceForWrite(tx, {
        branchId: prelockedCashBranchId,
        shiftId: null,
        cashBucket: "TREASURY",
        paymentMethod: "CASH",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      });
    }
    const [termination] = await tx
      .select()
      .from(employeeTerminations)
      .where(eq(employeeTerminations.id, terminationId))
      .for("update")
      .limit(1);
    if (!termination || termination.recognitionReversedAt) {
      throw new TRPCError({ code: "NOT_FOUND", message: "تسوية نهاية الخدمة غير متاحة للعكس." });
    }
    await assertActiveOwner(
      tx,
      actor,
      [termination.createdBy, termination.recognizedBy],
      "عكس صرف تسوية نهاية الخدمة",
    );
    const paymentHistory = await tx
      .select()
      .from(payrollAccountingEvents)
      .where(
        and(
          eq(payrollAccountingEvents.terminationId, terminationId),
          inArray(payrollAccountingEvents.eventKind, [
            "SALARY_PAYMENT",
            "SALARY_PAYMENT_RETURN",
          ]),
        ),
      )
      .orderBy(asc(payrollAccountingEvents.id))
      .for("update");
    const returnedPaymentIds = new Set(
      paymentHistory
        .filter((event) => event.eventKind === "SALARY_PAYMENT_RETURN")
        .map((event) => Number(event.reversalOfId)),
    );
    const paymentEvent = [...paymentHistory]
      .reverse()
      .find(
        (event) =>
          event.eventKind === "SALARY_PAYMENT" &&
          !returnedPaymentIds.has(Number(event.id)),
      );
    if (!paymentEvent?.receiptId || !paymentEvent.obligationId) {
      const latestReturn = [...paymentHistory]
        .reverse()
        .find((event) => event.eventKind === "SALARY_PAYMENT_RETURN");
      if (latestReturn?.receiptId) {
        const originalPayment = paymentHistory.find(
          (event) => Number(event.id) === Number(latestReturn.reversalOfId),
        );
        if (!originalPayment) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "حدث الصرف الأصلي المرتبط بإعادة المبلغ مفقود.",
          });
        }
        const [returnReceipt] = await tx
          .select({ amount: receipts.amount })
          .from(receipts)
          .where(eq(receipts.id, Number(latestReturn.receiptId)))
          .for("share")
          .limit(1);
        if (!returnReceipt) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "إيصال إعادة مبلغ التسوية مفقود.",
          });
        }
        await assertActiveOwner(
          tx,
          actor,
          [
            termination.createdBy,
            termination.recognizedBy,
            originalPayment.createdBy,
          ],
          "إعادة محاولة عكس صرف تسوية نهاية الخدمة",
        );
        const expectedReplayHash = payrollHash(
          terminationPaymentReturnHashPayload({
            terminationId,
            originalEventId: Number(originalPayment.id),
            amount: money(returnReceipt.amount),
            paymentMethod: evidence.method,
            referenceNumber: evidence.referenceNumber,
            reversalDate,
            reason,
          }),
        );
        if (latestReturn.sourceHash !== expectedReplayHash) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "إعادة محاولة عكس الصرف لا تطابق السبب أو التاريخ أو وسيلة الإثبات المحفوظة.",
          });
        }
        return {
          terminationId,
          receiptId: Number(latestReturn.receiptId),
          eventId: Number(latestReturn.id),
          replayed: true,
          replacementVoucher: null,
        };
      }
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد صرف مثبت لهذه التسوية." });
    }
    await assertActiveOwner(
      tx,
      actor,
      [
        termination.createdBy,
        termination.recognizedBy,
        paymentEvent.createdBy,
      ],
      "عكس صرف تسوية نهاية الخدمة",
    );
    const [obligation] = await tx
      .select()
      .from(payrollObligations)
      .where(eq(payrollObligations.id, Number(paymentEvent.obligationId)))
      .for("update")
      .limit(1);
    const [applied] = await tx
      .select()
      .from(payrollObligationAllocations)
      .where(
        and(
          eq(payrollObligationAllocations.obligationId, Number(paymentEvent.obligationId)),
          eq(payrollObligationAllocations.accountingEventId, Number(paymentEvent.id)),
          eq(payrollObligationAllocations.direction, "APPLY"),
        ),
      )
      .for("update")
      .limit(1);
    if (!obligation || !applied || obligation.status !== "SETTLED" || money(obligation.remainingAmount).gt(0)) {
      throw new TRPCError({ code: "CONFLICT", message: "أثر الصرف أو تخصيصه لا يطابق الالتزام." });
    }
    const amount = money(applied.amount);
    const [employee] = await tx
      .select({
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(eq(employees.id, Number(termination.employeeId)))
      .limit(1);
    const occurredAt = new Date(`${reversalDate}T12:00:00.000Z`);
    if (reversalDate < baghdadToday(new Date(paymentEvent.occurredAt))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تاريخ إعادة المبلغ لا يجوز أن يسبق تاريخ الصرف الأصلي.",
      });
    }
    if (
      evidence.method === "CASH" &&
      prelockedCashBranchId !== Number(obligation.branchIdSnapshot)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر مصدر صرف تسوية نهاية الخدمة أثناء القفل؛ أعد المحاولة",
      });
    }
    const receiptResult = await tx.insert(receipts).values({
      branchId: Number(obligation.branchIdSnapshot),
      shiftId: null,
      cashBucket: evidence.method === "CASH" ? "TREASURY" : null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: evidence.method,
      referenceNumber:
        evidence.referenceNumber ?? `TERM-RETURN-${terminationId}`,
      cardLastFour: evidence.method === "CARD" ? evidence.referenceNumber : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: occurredAt,
      partyType: "OTHER",
      counterpartyName: employee ? fullEmployeeName(employee) : `موظف #${termination.employeeId}`,
      voucherDate: new Date(`${reversalDate}T00:00:00.000Z`),
      description: `إعادة مبلغ تسوية نهاية خدمة #${terminationId} — ${reason}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const posting = payrollSettlementPosting({
      kind: "SALARY",
      direction: "IN",
      paymentMethod: evidence.method,
      amount,
    });
    const returnHashPayload = terminationPaymentReturnHashPayload({
      terminationId,
      originalEventId: Number(paymentEvent.id),
      amount,
      paymentMethod: evidence.method,
      referenceNumber: evidence.referenceNumber,
      reversalDate,
      reason,
    });
    const event = await postPayrollAccountingEvent(tx, {
      terminationId,
      obligationId: Number(obligation.id),
      branchId: Number(obligation.branchIdSnapshot),
      revisionNo: 0,
      eventKind: "SALARY_PAYMENT_RETURN",
      receiptId,
      reversalOfId: Number(paymentEvent.id),
      sourceKey: `TERMINATION:PAYMENT_RETURN:${terminationId}:EVENT:${Number(paymentEvent.id)}`,
      sourceHashPayload: returnHashPayload,
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: evidence.method,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `عكس صرف تسوية نهاية خدمة #${terminationId} — ${reason}`,
    });
    await tx.insert(payrollObligationAllocations).values({
      obligationId: Number(obligation.id),
      accountingEventId: event.eventId,
      direction: "REVERSE",
      amount: toDbMoney(amount),
      reversalOfId: Number(applied.id),
      sourceKey: `TERMINATION:PAYMENT_RETURN_ALLOC:${terminationId}:EVENT:${Number(paymentEvent.id)}`,
      occurredAt,
      createdBy: actor.userId,
    });
    await tx
      .update(payrollObligations)
      .set({ remainingAmount: toDbMoney(amount), status: "OPEN" })
      .where(eq(payrollObligations.id, Number(obligation.id)));
    await tx
      .update(employeeTerminations)
      .set({
        paymentReversedAt: occurredAt,
        paymentReversedBy: actor.userId,
        paymentReversalReason: reason,
      })
      .where(eq(employeeTerminations.id, terminationId));
    const repayment = assertTerminationPaymentMethod(
      termination.settlementPaymentMethod,
      termination.settlementPaymentReference,
    );
    const priorRequests = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(like(receipts.referenceNumber, `TERM-SETTLEMENT-${terminationId}-%`))
      .orderBy(asc(receipts.id))
      .for("update");
    const requestAttempt = priorRequests.length + 1;
    const replacement = await createSystemPaymentRequestTx(
      tx,
      {
        branchId: Number(obligation.branchIdSnapshot),
        amount: toDbMoney(amount),
        paymentMethod: repayment.method,
        partyType: "OTHER",
        counterpartyName: employee
          ? fullEmployeeName(employee)
          : `موظف #${termination.employeeId}`,
        description: `إعادة إصدار صرف تسوية نهاية خدمة #${terminationId}`,
        referenceNumber: `TERM-SETTLEMENT-${terminationId}-REPAY-${event.eventId}-A${requestAttempt}`,
        cardLastFour:
          repayment.method === "CARD" ? repayment.referenceNumber : null,
        voucherDate: baghdadToday(),
        clientRequestId: `termination-settlement-repay-${terminationId}-${event.eventId}`,
      },
      { ...actor, branchId: Number(obligation.branchIdSnapshot) },
      {
        kind: "TERMINATION_SETTLEMENT",
        terminationId,
        employeeId: Number(termination.employeeId),
        expectedAmount: toDbMoney(amount),
        attempt: requestAttempt,
        originReturnEventId: event.eventId,
        paymentEvidenceReference: repayment.referenceNumber,
        settlementSnapshotHash: termination.settlementSnapshotHash!,
        obligationId: Number(obligation.id),
      },
    );
    return {
      terminationId,
      receiptId,
      eventId: event.eventId,
      replayed: false,
      replacementVoucher: {
        receiptId: replacement.receiptId,
        voucherNumber: replacement.voucherNumber,
      },
    };
  });
}

/**
 * Re-issues only the payment request for an already recognized, still-open
 * termination obligation. Recognition is never repeated. This is the governed
 * escape hatch after a voucher rejection and remains maker/checker at voucher
 * approval.
 */
export async function reissueTerminationPayment(
  terminationId: number,
  actor: TerminationActor,
  reasonInput: string,
) {
  const reason = reasonInput.trim();
  if (reason.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب إعادة إصدار طلب الصرف التفصيلي إلزامي.",
    });
  }
  return withTx(async (tx) => {
    const [termination] = await tx
      .select()
      .from(employeeTerminations)
      .where(eq(employeeTerminations.id, terminationId))
      .for("update")
      .limit(1);
    if (
      !termination?.recognizedAt ||
      !termination.settlementSnapshotHash ||
      termination.recognitionReversedAt ||
      money(termination.settlement).lte(0)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "استحقاق نهاية الخدمة غير مثبت أو عُكس ولا يمكن إعادة إصدار صرفه.",
      });
    }
    await assertActiveOwner(
      tx,
      actor,
      [],
      "إعادة إصدار طلب صرف تسوية نهاية الخدمة",
    );
    const [obligation] = await tx
      .select()
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.terminationId, terminationId),
          eq(payrollObligations.kind, "SALARY_NET"),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !obligation ||
      obligation.status !== "OPEN" ||
      !money(obligation.remainingAmount).eq(obligation.originalAmount)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "التزام التسوية ليس مفتوحاً بالكامل؛ لا يمكن إصدار طلب صرف آخر.",
      });
    }
    const requests = await tx
      .select({
        id: receipts.id,
        voucherNumber: receipts.voucherNumber,
        approvalStatus: receipts.approvalStatus,
        description: receipts.description,
      })
      .from(receipts)
      .where(like(receipts.referenceNumber, `TERM-SETTLEMENT-${terminationId}-%`))
      .orderBy(asc(receipts.id))
      .for("update");
    const pending = requests.find(
      (request) => request.approvalStatus === "PENDING_APPROVAL",
    );
    if (pending?.voucherNumber) {
      const pendingAttempt =
        requests.findIndex(
          (request) => Number(request.id) === Number(pending.id),
        ) + 1;
      if (
        pending.description !==
        `إعادة إصدار صرف تسوية نهاية خدمة #${terminationId} — ${reason}`
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "يوجد طلب صرف معلّق؛ إعادة المحاولة لا تطابق سبب إعادة الإصدار المحفوظ.",
        });
      }
      return {
        terminationId,
        receiptId: Number(pending.id),
        voucherNumber: pending.voucherNumber,
        attempt: pendingAttempt,
        replayed: true,
      };
    }
    const attempt = requests.length + 1;
    const payment = assertTerminationPaymentMethod(
      termination.settlementPaymentMethod,
      termination.settlementPaymentReference,
    );
    const [employee] = await tx
      .select({
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(eq(employees.id, Number(termination.employeeId)))
      .limit(1);
    const [latestReturn] = await tx
      .select({ id: payrollAccountingEvents.id })
      .from(payrollAccountingEvents)
      .where(
        and(
          eq(payrollAccountingEvents.terminationId, terminationId),
          eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT_RETURN"),
        ),
      )
      .orderBy(desc(payrollAccountingEvents.id))
      .for("update")
      .limit(1);
    const originReturnEventId = latestReturn ? Number(latestReturn.id) : null;
    const request = await createSystemPaymentRequestTx(
      tx,
      {
        branchId: Number(obligation.branchIdSnapshot),
        amount: toDbMoney(obligation.remainingAmount),
        paymentMethod: payment.method,
        partyType: "OTHER",
        counterpartyName: employee
          ? fullEmployeeName(employee)
          : `موظف #${termination.employeeId}`,
        description: `إعادة إصدار صرف تسوية نهاية خدمة #${terminationId} — ${reason}`,
        referenceNumber: originReturnEventId == null
          ? `TERM-SETTLEMENT-${terminationId}-A${attempt}`
          : `TERM-SETTLEMENT-${terminationId}-REPAY-${originReturnEventId}-A${attempt}`,
        cardLastFour: payment.method === "CARD" ? payment.referenceNumber : null,
        voucherDate: baghdadToday(),
        clientRequestId: terminationReissueClientRequestId(
          terminationId,
          attempt,
          reason,
        ),
      },
      { ...actor, branchId: Number(obligation.branchIdSnapshot) },
      {
        kind: "TERMINATION_SETTLEMENT",
        terminationId,
        employeeId: Number(termination.employeeId),
        expectedAmount: toDbMoney(obligation.remainingAmount),
        attempt,
        originReturnEventId,
        paymentEvidenceReference: payment.referenceNumber,
        settlementSnapshotHash: termination.settlementSnapshotHash,
        obligationId: Number(obligation.id),
      },
    );
    return {
      terminationId,
      receiptId: request.receiptId,
      voucherNumber: request.voucherNumber,
      attempt,
      replayed: false,
    };
  });
}

export async function reverseTerminationRecognition(
  terminationId: number,
  actor: TerminationActor,
  reasonInput: string,
) {
  const reason = reasonInput.trim();
  if (reason.length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب عكس الاستحقاق التفصيلي إلزامي." });
  }
  return withTx(async (tx) => {
    const [termination] = await tx
      .select()
      .from(employeeTerminations)
      .where(eq(employeeTerminations.id, terminationId))
      .for("update")
      .limit(1);
    if (!termination?.recognizedAt || !termination.settlementSnapshotHash) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد استحقاق مثبت لعكسه." });
    }
    await assertActiveOwner(
      tx,
      actor,
      [termination.createdBy, termination.recognizedBy],
      "عكس استحقاق تسوية نهاية الخدمة",
    );
    if (termination.recognitionReversedAt && termination.recognitionReversalEventId) {
      const [reversalEvent] = await tx
        .select()
        .from(payrollAccountingEvents)
        .where(
          eq(
            payrollAccountingEvents.id,
            Number(termination.recognitionReversalEventId),
          ),
        )
        .for("share")
        .limit(1);
      if (!reversalEvent?.reversalOfId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "حدث عكس الاستحقاق المحفوظ غير مكتمل.",
        });
      }
      const originalAllocations = await tx
        .select({ amount: payrollObligationAllocations.amount })
        .from(payrollObligationAllocations)
        .where(
          and(
            eq(
              payrollObligationAllocations.accountingEventId,
              Number(reversalEvent.reversalOfId),
            ),
            eq(payrollObligationAllocations.direction, "APPLY"),
          ),
        );
      const allocatedProvision = round2(
        originalAllocations.reduce(
          (sum, allocation) => sum.plus(money(allocation.amount)),
          money(0),
        ),
      );
      const expectedReplayHash = payrollHash({
        version: 1,
        kind: "TERMINATION_ACCRUAL_REVERSAL",
        terminationId,
        recognitionEventId: Number(reversalEvent.reversalOfId),
        settlementSnapshotHash: termination.settlementSnapshotHash,
        amount: allocatedProvision.toFixed(2),
        reason,
      });
      if (
        termination.recognitionReversalReason !== reason ||
        reversalEvent.sourceHash !== expectedReplayHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "إعادة محاولة عكس الاستحقاق لا تطابق السبب المحفوظ.",
        });
      }
      return {
        terminationId,
        eventId: Number(termination.recognitionReversalEventId),
        replayed: true,
      };
    }
    const [pendingVoucher] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          like(receipts.referenceNumber, `TERM-SETTLEMENT-${terminationId}-%`),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      )
      .for("update")
      .limit(1);
    if (pendingVoucher) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "ارفض طلب صرف التسوية المعلّق قبل عكس الاستحقاق.",
      });
    }
    const recognitionEvents = await tx
      .select()
      .from(payrollAccountingEvents)
      .where(
        and(
          eq(payrollAccountingEvents.terminationId, terminationId),
          eq(payrollAccountingEvents.eventKind, "EOS_SETTLEMENT"),
        ),
      )
      .orderBy(asc(payrollAccountingEvents.id))
      .for("update")
      ;
    const settlementObligations = await tx
      .select()
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.terminationId, terminationId),
          inArray(payrollObligations.kind, [
            "SALARY_NET",
            "INCOME_TAX",
            "SOCIAL_SECURITY",
          ]),
        ),
      )
      .orderBy(asc(payrollObligations.id))
      .for("update")
      ;
    const salaryObligation = settlementObligations.find(
      (obligation) => obligation.kind === "SALARY_NET",
    );
    if (settlementObligations.some(
      (obligation) =>
        !money(obligation.remainingAmount).eq(obligation.originalAmount) ||
        obligation.status !== "OPEN",
    )) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "أعد مبلغ الصرف أولاً ثم اعكس إثبات الاستحقاق.",
      });
    }
    const shortTermExpense = money(termination.earnedGrossWages)
      .minus(money(termination.wageReductions))
      .plus(money(termination.leaveCompensation))
      .plus(money(termination.noticeCompensation))
      .plus(money(termination.otherSettlement));
    const total = money(termination.settlement);
    const advanceRecovery = money(termination.advanceRecovery);
    const incomeTax = money(termination.incomeTax);
    const employeeSocialSecurity = money(termination.employeeSocialSecurity);
    const employerSocialSecurity = money(termination.employerSocialSecurity);
    const provisionAvailable = money(termination.eosProvisionAvailable);
    const expenseRecognized = money(termination.eosExpenseRecognized);
    const provisionReleased = money(termination.eosProvisionReleased);
    const mainRecognitionEvent = recognitionEvents.find(
      (event) => Number(event.id) === Number(termination.recognitionEventId),
    );
    if ((total.gt(0) || provisionAvailable.gt(0)) && !mainRecognitionEvent) {
      throw new TRPCError({ code: "CONFLICT", message: "حدث إثبات الاستحقاق مفقود." });
    }
    if (!mainRecognitionEvent) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يحمل الإجراء أثراً مالياً يمكن عكسه.",
      });
    }
    const occurredAt = new Date(mainRecognitionEvent.occurredAt);
    await assertPeriodOpen(tx, occurredAt);
    // Discover the immutable APPLY rows without locking their ledger first.
    // Every advance consumer/canceller must lock employeeAdvances (ascending
    // id) before terminationAdvanceAllocations, otherwise voucher cancellation
    // and recognition reversal can deadlock in opposite directions.
    const advanceApplicationPreview = await tx
      .select({
        id: terminationAdvanceAllocations.id,
        advanceId: terminationAdvanceAllocations.advanceId,
      })
      .from(terminationAdvanceAllocations)
      .where(
        and(
          eq(terminationAdvanceAllocations.terminationId, terminationId),
          eq(terminationAdvanceAllocations.direction, "APPLY"),
        ),
      )
      .orderBy(
        asc(terminationAdvanceAllocations.advanceId),
        asc(terminationAdvanceAllocations.id),
      );
    const advanceIds = Array.from(
      new Set(
        advanceApplicationPreview.map((application) =>
          Number(application.advanceId),
        ),
      ),
    ).sort((left, right) => left - right);
    const lockedTerminationAdvances = advanceIds.length > 0
      ? await tx
          .select()
          .from(employeeAdvances)
          .where(inArray(employeeAdvances.id, advanceIds))
          .orderBy(asc(employeeAdvances.id))
          .for("update")
      : [];
    const lockedAdvanceById = new Map(
      lockedTerminationAdvances.map((advance) => [Number(advance.id), advance]),
    );
    const restoredAdvanceBalanceById = new Map(
      lockedTerminationAdvances.map((advance) => [
        Number(advance.id),
        money(advance.remaining),
      ]),
    );
    const advanceApplications = await tx
      .select()
      .from(terminationAdvanceAllocations)
      .where(
        and(
          eq(terminationAdvanceAllocations.terminationId, terminationId),
          eq(terminationAdvanceAllocations.direction, "APPLY"),
        ),
      )
      .orderBy(
        asc(terminationAdvanceAllocations.advanceId),
        asc(terminationAdvanceAllocations.id),
      )
      .for("update");
    const previewFingerprint = advanceApplicationPreview
      .map(
        (application) =>
          `${Number(application.id)}:${Number(application.advanceId)}`,
      )
      .join("|");
    const lockedFingerprint = advanceApplications
      .map(
        (application) =>
          `${Number(application.id)}:${Number(application.advanceId)}`,
      )
      .join("|");
    if (
      lockedTerminationAdvances.length !== advanceIds.length ||
      previewFingerprint !== lockedFingerprint
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تعذّر تثبيت السلف وتخصيصات تسوية نهاية الخدمة أثناء العكس؛ أعد المحاولة.",
      });
    }
    const localAdvanceRecovery = round2(
      advanceApplications
        .filter(
          (application) =>
            Number(application.accountingEventId) ===
            Number(mainRecognitionEvent.id),
        )
        .reduce(
          (sum, application) => sum.plus(money(application.amount)),
          money(0),
        ),
    );
    const transferredAdvanceRecovery = round2(
      advanceRecovery.minus(localAdvanceRecovery),
    );
    let reversalEventId: number | null = null;
    for (const originalEvent of recognitionEvents) {
      const eosApplications = await tx
        .select()
        .from(payrollObligationAllocations)
        .where(
          and(
            eq(payrollObligationAllocations.accountingEventId, Number(originalEvent.id)),
            eq(payrollObligationAllocations.direction, "APPLY"),
          ),
        )
        .orderBy(asc(payrollObligationAllocations.id))
        .for("update");
      const allocatedProvision = round2(
        eosApplications.reduce(
          (sum, allocation) => sum.plus(money(allocation.amount)),
          money(0),
        ),
      );
      const eventAdvanceApplications = advanceApplications.filter(
        (application) =>
          Number(application.accountingEventId) === Number(originalEvent.id),
      );
      const allocatedAdvance = round2(
        eventAdvanceApplications.reduce(
          (sum, application) => sum.plus(money(application.amount)),
          money(0),
        ),
      );
      const isMain = Number(originalEvent.id) === Number(mainRecognitionEvent.id);
      const posting = isMain
        ? terminationRecognitionPosting({
            shortTermExpense,
            localAdvanceRecovery,
            transferredAdvanceRecovery,
            incomeTax,
            employeeSocialSecurity,
            employerSocialSecurity,
            total,
            localProvision: allocatedProvision,
            transferredProvision: round2(provisionAvailable.minus(allocatedProvision)),
            provisionShortfall: expenseRecognized,
            provisionRelease: provisionReleased,
            reverse: true,
          })
        : allocatedProvision.gt(0)
          ? {
            ...terminationProvisionTransferPosting(allocatedProvision, true),
            amount: money(0),
          }
          : {
              ...terminationAdvanceTransferPosting(allocatedAdvance, true),
              amount: money(0),
            };
      if (!isMain && allocatedProvision.lte(0) && allocatedAdvance.lte(0)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "حدث نقل تسوية نهاية الخدمة بلا تخصيصات أصلية.",
        });
      }
      const event = await postPayrollAccountingEvent(tx, {
        terminationId,
        obligationId: isMain && salaryObligation ? Number(salaryObligation.id) : null,
        branchId: Number(originalEvent.branchIdSnapshot),
        revisionNo: 0,
        eventKind: "EOS_SETTLEMENT_REVERSAL",
        reversalOfId: Number(originalEvent.id),
        sourceKey: isMain
          ? `TERMINATION:ACCRUAL_REVERSAL:${terminationId}`
          : `TERMINATION:EOS_TRANSFER_REV:${terminationId}:EVENT:${Number(originalEvent.id)}`,
        sourceHashPayload: {
          version: 1,
          kind: isMain
            ? "TERMINATION_ACCRUAL_REVERSAL"
            : allocatedProvision.gt(0)
              ? "EOS_PROVISION_INTERBRANCH_TRANSFER_REVERSAL"
              : "EMPLOYEE_ADVANCE_INTERBRANCH_TRANSFER_REVERSAL",
          terminationId,
          recognitionEventId: Number(originalEvent.id),
          settlementSnapshotHash: termination.settlementSnapshotHash,
          amount: allocatedProvision.toFixed(2),
          ...(!isMain
            ? { advanceAmount: allocatedAdvance.toFixed(2) }
            : {}),
          reason,
        },
        occurredAt,
        actorUserId: actor.userId,
        entryType: "ADJUST",
        amount: isMain ? posting.amount : money(0),
        postingIntent: posting.intent,
        postingSourceComponents: posting.source,
        notes: isMain
          ? `عكس استحقاق تسوية نهاية خدمة #${terminationId} — ${reason}`
          : allocatedProvision.gt(0)
            ? `عكس نقل مخصص نهاية خدمة #${terminationId} — ${reason}`
            : `عكس تسوية سلفة نهاية خدمة #${terminationId} — ${reason}`,
      });
      if (isMain) reversalEventId = event.eventId;
      for (const allocation of eosApplications) {
        const [obligation] = await tx
          .select()
          .from(payrollObligations)
          .where(eq(payrollObligations.id, Number(allocation.obligationId)))
          .for("update")
          .limit(1);
        if (!obligation || money(obligation.remainingAmount).gt(0)) {
          throw new TRPCError({ code: "CONFLICT", message: "مخصص نهاية الخدمة تغيّر بعد التسوية؛ أوقف العكس." });
        }
        const restored = round2(money(obligation.remainingAmount).plus(allocation.amount));
        await tx.insert(payrollObligationAllocations).values({
          obligationId: Number(obligation.id),
          accountingEventId: event.eventId,
          direction: "REVERSE",
          amount: allocation.amount,
          reversalOfId: Number(allocation.id),
          sourceKey: `TERMINATION:EOS_ALLOC_REV:${terminationId}:${Number(allocation.id)}`,
          occurredAt,
          createdBy: actor.userId,
        });
        await tx
          .update(payrollObligations)
          .set({
            remainingAmount: toDbMoney(restored),
            status: restored.eq(obligation.originalAmount) ? "OPEN" : "PARTIAL",
          })
          .where(eq(payrollObligations.id, Number(obligation.id)));
      }
      for (const application of eventAdvanceApplications) {
        const advanceId = Number(application.advanceId);
        const advance = lockedAdvanceById.get(advanceId);
        const currentRemaining = restoredAdvanceBalanceById.get(advanceId);
        if (!advance || !currentRemaining) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "سجل السلفة المرتبط بتسوية نهاية الخدمة مفقود.",
          });
        }
        const restored = round2(
          currentRemaining.plus(money(application.amount)),
        );
        if (restored.gt(advance.amount)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "رصيد السلفة تغيّر بعد التسوية؛ أوقف العكس.",
          });
        }
        await tx.insert(terminationAdvanceAllocations).values({
          terminationId,
          advanceId: Number(advance.id),
          accountingEventId: event.eventId,
          direction: "REVERSE",
          amount: application.amount,
          reversalOfId: Number(application.id),
          sourceKey: `TERMINATION:ADVANCE_REV:${terminationId}:${Number(application.id)}`,
          occurredAt,
          createdBy: actor.userId,
        });
        await tx
          .update(employeeAdvances)
          .set({ remaining: toDbMoney(restored), status: "ACTIVE" })
          .where(eq(employeeAdvances.id, Number(advance.id)));
        restoredAdvanceBalanceById.set(advanceId, restored);
      }
    }
    if (settlementObligations.length > 0) {
      await tx
        .update(payrollObligations)
        .set({ remainingAmount: "0.00", status: "REVERSED" })
        .where(eq(payrollObligations.terminationId, terminationId));
    }
    await tx
      .update(employeeTerminations)
      .set({
        recognitionReversedAt: occurredAt,
        recognitionReversedBy: actor.userId,
        recognitionReversalReason: reason,
        recognitionReversalEventId: reversalEventId,
      })
      .where(eq(employeeTerminations.id, terminationId));
    return { terminationId, eventId: reversalEventId, replayed: false };
  });
}
