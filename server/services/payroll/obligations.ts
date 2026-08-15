import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accountingEntries,
  advanceSettlements,
  employeeAdvances,
  payrollAccountingEvents,
  payrollItems,
  payrollObligations,
  payrollRuns,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { getPayrollLegalSettingsForUpdate } from "../payrollLegalService";
import { money, round2, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { payrollAccrualPosting, postPayrollAccountingEvent } from "./accounting";
import { buildPayrollLegalPolicyEvidence } from "./legalSnapshot";
import {
  payrollBreakdown,
  payrollHash,
  periodAccrualDate,
  type PayrollBreakdown,
} from "./helpers";

type PayrollItemRow = typeof payrollItems.$inferSelect;
type PayrollRunRow = typeof payrollRuns.$inferSelect;

export interface PayrollApprovalItem {
  row: PayrollItemRow;
  branchId: number;
  breakdown: PayrollBreakdown;
  snapshotHash: string;
}

function canonicalItem(
  item: PayrollItemRow,
  branchId: number,
  revisionNo: number,
  breakdown: PayrollBreakdown,
) {
  return {
    version: 1,
    runId: Number(item.runId),
    itemId: Number(item.id),
    employeeId: Number(item.employeeId),
    branchId,
    revisionNo,
    payType: item.payType,
    hours: item.hours == null ? null : String(item.hours),
    gross: money(item.gross).toFixed(2),
    overtime: money(item.overtime).toFixed(2),
    commission: money(item.commission).toFixed(2),
    wageReduction: breakdown.wageReduction.toFixed(2),
    advance: breakdown.advance.toFixed(2),
    incomeTax: breakdown.incomeTax.toFixed(2),
    socialSecurityEmployee: breakdown.socialSecurityEmployee.toFixed(2),
    socialSecurityEmployer: breakdown.socialSecurityEmployer.toFixed(2),
    eosProvision: breakdown.eosProvision.toFixed(2),
    earnedWage: breakdown.earnedWage.toFixed(2),
    net: breakdown.net.toFixed(2),
    expenseTotal: breakdown.expenseTotal.toFixed(2),
  } as const;
}

function canonicalApproval(input: {
  run: PayrollRunRow;
  revisionNo: number;
  accrualDate: string;
  legalPolicyHash: string;
  items: PayrollApprovalItem[];
}) {
  return {
    version: 1,
    runId: Number(input.run.id),
    period: input.run.period,
    revisionNo: input.revisionNo,
    accrualDate: input.accrualDate,
    legalPolicyHash: input.legalPolicyHash,
    employeeCount: Number(input.run.employeeCount),
    totalGross: money(input.run.totalGross).toFixed(2),
    totalOvertime: money(input.run.totalOvertime).toFixed(2),
    totalCommission: money(input.run.totalCommission).toFixed(2),
    totalDeductions: money(input.run.totalDeductions).toFixed(2),
    totalNet: money(input.run.totalNet).toFixed(2),
    terminationWageCoverage: input.run.notes ?? null,
    itemHashes: input.items.map((item) => item.snapshotHash),
  } as const;
}

async function insertObligation(
  tx: Tx,
  input: {
    runId: number;
    itemId: number;
    employeeId: number;
    branchId: number;
    revisionNo: number;
    kind: "SALARY_NET" | "INCOME_TAX" | "SOCIAL_SECURITY" | "EOS_PROVISION";
    amount: Decimal;
    dueDate: string;
  },
): Promise<number | null> {
  const amount = round2(input.amount);
  if (amount.isZero()) return null;
  if (amount.isNegative()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لا يمكن إنشاء التزام رواتب سالب.",
    });
  }
  const result = await tx.insert(payrollObligations).values({
    runId: input.runId,
    itemId: input.itemId,
    employeeId: input.employeeId,
    branchIdSnapshot: input.branchId,
    revisionNo: input.revisionNo,
    kind: input.kind,
    originalAmount: toDbMoney(amount),
    remainingAmount: toDbMoney(amount),
    dueDate: input.dueDate,
    status: "OPEN",
    sourceType: "PAYROLL_APPROVAL",
    sourceKey: `PAYROLL:OBL:${input.runId}:${input.revisionNo}:${input.itemId}:${input.kind}`,
  });
  return extractInsertId(result);
}

async function settleItemAdvanceTx(
  tx: Tx,
  input: {
    runId: number;
    revisionNo: number;
    itemId: number;
    employeeId: number;
    amount: Decimal;
    actorUserId: number;
    occurredAt: Date;
  },
): Promise<void> {
  let left = round2(input.amount);
  if (left.isZero()) return;
  const advances = await tx
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
  for (const advance of advances) {
    if (left.lte(0)) break;
    const remaining = money(advance.remaining);
    if (remaining.lte(0)) continue;
    const amount = round2(Decimal.min(remaining, left));
    const after = round2(remaining.minus(amount));
    left = round2(left.minus(amount));
    await tx
      .update(employeeAdvances)
      .set({
        remaining: toDbMoney(after),
        status: after.isZero() ? "SETTLED" : "ACTIVE",
      })
      .where(eq(employeeAdvances.id, Number(advance.id)));
    await tx.insert(advanceSettlements).values({
      runId: input.runId,
      advanceId: Number(advance.id),
      employeeId: input.employeeId,
      amount: toDbMoney(amount),
      revisionNo: input.revisionNo,
      direction: "APPLY",
      sourceKey: `PAYROLL:ADV:${input.runId}:${input.revisionNo}:${input.itemId}:${Number(advance.id)}`,
      createdBy: input.actorUserId,
      occurredAt: input.occurredAt,
    });
  }
  if (left.gt(0)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "استقطاع السلفة يفوق الرصيد النشط وقت اعتماد المسيّر — أعد المسيّر لمسودة وحدّثه.",
    });
  }
}

export async function approvePayrollAccrualTx(
  tx: Tx,
  input: {
    run: PayrollRunRow;
    items: Array<PayrollItemRow & { currentBranchId: number | null }>;
    actorUserId: number;
    approvedAt: Date;
  },
): Promise<{ approvalSnapshotHash: string; accrualDate: string }> {
  const revisionNo = Number(input.run.revisionNo);
  const accrualDate = periodAccrualDate(input.run.period);
  const occurrence = new Date(`${accrualDate}T12:00:00.000Z`);
  const legalPolicy = await getPayrollLegalSettingsForUpdate(tx);
  const currentLegalPolicy = buildPayrollLegalPolicyEvidence(legalPolicy);
  if (
    input.run.legalPolicySnapshot == null ||
    input.run.legalPolicyHash == null ||
    payrollHash(input.run.legalPolicySnapshot) !== input.run.legalPolicyHash ||
    currentLegalPolicy.hash !== input.run.legalPolicyHash
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "تغيّرت السياسة القانونية بعد توليد المسيّر؛ احذف المسودة وأعد توليدها قبل الاعتماد.",
    });
  }
  const legalPolicySnapshot = input.run.legalPolicySnapshot;
  const legalPolicyHash = input.run.legalPolicyHash;

  const frozen: PayrollApprovalItem[] = input.items.map((row) => {
    const branchId = row.branchIdSnapshot ?? row.currentBranchId ?? input.run.branchId;
    if (branchId == null || Number(branchId) <= 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الموظف #${row.employeeId} بلا فرع؛ لا يمكن اعتماد استحقاق غير منسوب.`,
      });
    }
    const breakdown = payrollBreakdown(row);
    const snapshot = canonicalItem(row, Number(branchId), revisionNo, breakdown);
    return {
      row,
      branchId: Number(branchId),
      breakdown,
      snapshotHash: payrollHash(snapshot),
    };
  });

  const netTotal = frozen.reduce(
    (sum, item) => sum.plus(item.breakdown.net),
    money(0),
  );
  if (!round2(netTotal).eq(round2(money(input.run.totalNet)))) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "إجمالي صافي المسيّر لا يطابق اللقطات المصنفة.",
    });
  }

  for (const item of frozen) {
    await tx
      .update(payrollItems)
      .set({
        branchIdSnapshot: item.branchId,
        revisionNo,
        snapshotHash: item.snapshotHash,
      })
      .where(eq(payrollItems.id, Number(item.row.id)));

    const common = {
      runId: Number(input.run.id),
      itemId: Number(item.row.id),
      employeeId: Number(item.row.employeeId),
      branchId: item.branchId,
      revisionNo,
      dueDate: accrualDate,
    };
    await insertObligation(tx, {
      ...common,
      kind: "SALARY_NET",
      amount: item.breakdown.net,
    });
    await insertObligation(tx, {
      ...common,
      kind: "INCOME_TAX",
      amount: item.breakdown.incomeTax,
    });
    await insertObligation(tx, {
      ...common,
      kind: "SOCIAL_SECURITY",
      amount: item.breakdown.socialSecurityEmployee.plus(
        item.breakdown.socialSecurityEmployer,
      ),
    });
    await insertObligation(tx, {
      ...common,
      kind: "EOS_PROVISION",
      amount: item.breakdown.eosProvision,
    });

    if (item.breakdown.expenseTotal.gt(0)) {
      const posting = payrollAccrualPosting(item.breakdown);
      await postPayrollAccountingEvent(tx, {
        runId: Number(input.run.id),
        branchId: item.branchId,
        revisionNo,
        eventKind: "ACCRUAL",
        sourceKey: `PAYROLL:ACCRUAL:${Number(input.run.id)}:${revisionNo}:${Number(item.row.id)}`,
        sourceHashPayload: {
          kind: "ACCRUAL",
          itemSnapshotHash: item.snapshotHash,
          legalPolicyHash,
        },
        occurredAt: occurrence,
        actorUserId: input.actorUserId,
        entryType: "ADJUST",
        amount: posting.amount,
        postingIntent: posting.intent,
        postingSourceComponents: posting.source,
        notes: `استحقاق راتب — مسيّر ${input.run.period} — موظف #${item.row.employeeId}`,
      });
    }
    await settleItemAdvanceTx(tx, {
      runId: Number(input.run.id),
      revisionNo,
      itemId: Number(item.row.id),
      employeeId: Number(item.row.employeeId),
      amount: item.breakdown.advance,
      actorUserId: input.actorUserId,
      occurredAt: input.approvedAt,
    });
  }

  const approvalSnapshotHash = payrollHash(
    canonicalApproval({
      run: input.run,
      revisionNo,
      accrualDate,
      legalPolicyHash,
      items: frozen,
    }),
  );
  await tx
    .update(payrollRuns)
    .set({
      status: "approved",
      accrualDate,
      legalPolicySnapshot,
      legalPolicyHash,
      approvalSnapshotHash,
      approvedAt: input.approvedAt,
      approvedBy: input.actorUserId,
      paidAt: null,
      paidBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
    })
    .where(eq(payrollRuns.id, Number(input.run.id)));
  return { approvalSnapshotHash, accrualDate };
}

async function verifyApprovalSnapshotTx(
  tx: Tx,
  run: PayrollRunRow,
): Promise<PayrollApprovalItem[]> {
  if (!run.accrualDate || !run.legalPolicyHash || !run.approvalSnapshotHash) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "لقطة اعتماد المسيّر ناقصة؛ لا يمكن عكسه تلقائياً.",
    });
  }
  if (
    run.legalPolicySnapshot == null ||
    payrollHash(run.legalPolicySnapshot) !== run.legalPolicyHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت لقطة السياسة القانونية بعد الاعتماد؛ العكس موقوف.",
    });
  }
  const items = await tx
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.runId, Number(run.id)))
    .orderBy(asc(payrollItems.id))
    .for("update");
  const frozen = items.map((row) => {
    if (row.branchIdSnapshot == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لقطة فرع بند الراتب ناقصة.",
      });
    }
    const breakdown = payrollBreakdown(row);
    const snapshotHash = payrollHash(
      canonicalItem(row, Number(row.branchIdSnapshot), Number(run.revisionNo), breakdown),
    );
    if (snapshotHash !== row.snapshotHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تغيّرت لقطة بند الراتب #${row.id} بعد الاعتماد؛ العكس موقوف.`,
      });
    }
    return {
      row,
      branchId: Number(row.branchIdSnapshot),
      breakdown,
      snapshotHash,
    };
  });
  const expected = payrollHash(
    canonicalApproval({
      run,
      revisionNo: Number(run.revisionNo),
      accrualDate: String(run.accrualDate),
      legalPolicyHash: run.legalPolicyHash,
      items: frozen,
    }),
  );
  if (expected !== run.approvalSnapshotHash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت لقطة اعتماد المسيّر؛ العكس موقوف لحين المراجعة.",
    });
  }
  return frozen;
}

async function reverseAdvanceSettlementsTx(
  tx: Tx,
  input: {
    runId: number;
    revisionNo: number;
    actorUserId: number;
    occurredAt: Date;
  },
): Promise<void> {
  // Preview only discovers the canonical advance ids. Every producer/canceller
  // locks employeeAdvances first (ascending id), then its append-only ledger.
  const applicationPreview = await tx
    .select({ advanceId: advanceSettlements.advanceId })
    .from(advanceSettlements)
    .where(
      and(
        eq(advanceSettlements.runId, input.runId),
        eq(advanceSettlements.revisionNo, input.revisionNo),
        eq(advanceSettlements.direction, "APPLY"),
      ),
    );
  const advanceIds = Array.from(new Set(applicationPreview.map((row) => Number(row.advanceId))))
    .sort((a, b) => a - b);
  const lockedAdvances = advanceIds.length > 0
    ? await tx
        .select()
        .from(employeeAdvances)
        .where(inArray(employeeAdvances.id, advanceIds))
        .orderBy(asc(employeeAdvances.id))
        .for("update")
    : [];
  const advancesById = new Map(
    lockedAdvances.map((advance) => [Number(advance.id), advance]),
  );
  const applications = await tx
    .select()
    .from(advanceSettlements)
    .where(
      and(
        eq(advanceSettlements.runId, input.runId),
        eq(advanceSettlements.revisionNo, input.revisionNo),
        eq(advanceSettlements.direction, "APPLY"),
      ),
    )
    .orderBy(asc(advanceSettlements.advanceId), asc(advanceSettlements.id))
    .for("update");
  if (
    applications.length !== applicationPreview.length ||
    lockedAdvances.length !== advanceIds.length
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت سلف أو تسويات المسيّر أثناء العكس؛ أعد المحاولة.",
    });
  }
  for (const application of applications) {
    const [already] = await tx
      .select({ id: advanceSettlements.id })
      .from(advanceSettlements)
      .where(
        and(
          eq(advanceSettlements.direction, "REVERSE"),
          eq(advanceSettlements.reversalOfId, Number(application.id)),
        ),
      )
      .limit(1);
    if (already) continue;
    const advance = advancesById.get(Number(application.advanceId));
    if (!advance) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تعذّر العثور على السلفة المرتبطة بالعكس.",
      });
    }
    const restored = round2(
      money(advance.remaining).plus(money(application.amount)),
    );
    if (restored.gt(money(advance.amount))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عكس استقطاع السلفة يتجاوز أصل السلفة.",
      });
    }
    await tx
      .update(employeeAdvances)
      .set({ remaining: toDbMoney(restored), status: "ACTIVE" })
      .where(eq(employeeAdvances.id, Number(advance.id)));
    await tx.insert(advanceSettlements).values({
      runId: input.runId,
      advanceId: Number(application.advanceId),
      employeeId: Number(application.employeeId),
      amount: application.amount,
      revisionNo: input.revisionNo,
      direction: "REVERSE",
      reversalOfId: Number(application.id),
      sourceKey: `PAYROLL:ADV-REV:${input.runId}:${input.revisionNo}:${Number(application.id)}`,
      createdBy: input.actorUserId,
      occurredAt: input.occurredAt,
    });
  }
}

export async function reopenPayrollAccrualTx(
  tx: Tx,
  input: {
    run: PayrollRunRow;
    actorUserId: number;
    occurredAt: Date;
  },
): Promise<void> {
  const runId = Number(input.run.id);
  const revisionNo = Number(input.run.revisionNo);
  if (!input.run.accrualDate) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "تاريخ استحقاق المسيّر مفقود؛ لا يمكن إنشاء قيد العكس.",
    });
  }
  // The reversal corrects the same service period, not the day the operator clicks reopen.
  // Check the financial lock before touching obligations/advances so a closed month is atomic.
  const reversalEntryAt = new Date(`${input.run.accrualDate}T12:00:00.000Z`);
  await assertPeriodOpen(tx, reversalEntryAt);
  const obligations = await tx
    .select()
    .from(payrollObligations)
    .where(
      and(
        eq(payrollObligations.runId, runId),
        eq(payrollObligations.revisionNo, revisionNo),
      ),
    )
    .orderBy(asc(payrollObligations.id))
    .for("update");
  const applied = obligations.find(
    (obligation) =>
      obligation.status !== "REVERSED" &&
      !money(obligation.remainingAmount).eq(money(obligation.originalAmount)),
  );
  if (applied) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لا يمكن إعادة المسيّر لمسودة قبل إعادة كل راتب/تحويل قانوني فعلياً وإثباته بإيصال.",
    });
  }
  const frozen = await verifyApprovalSnapshotTx(tx, input.run);
  const accrualEvents = await tx
    .select()
    .from(payrollAccountingEvents)
    .where(
      and(
        eq(payrollAccountingEvents.runId, runId),
        eq(payrollAccountingEvents.revisionNo, revisionNo),
        eq(payrollAccountingEvents.eventKind, "ACCRUAL"),
      ),
    )
    .orderBy(asc(payrollAccountingEvents.id))
    .for("update");
  const eventsByItem = new Map(
    await Promise.all(
      accrualEvents.map(async (event) => {
        const [entry] = await tx
          .select({ dedupeKey: accountingEntries.dedupeKey })
          .from(accountingEntries)
          .where(eq(accountingEntries.id, Number(event.accountingEntryId)))
          .limit(1);
        const itemId = Number(entry?.dedupeKey?.split(":").at(-1));
        return [itemId, event] as const;
      }),
    ),
  );
  for (const item of frozen) {
    if (item.breakdown.expenseTotal.isZero()) continue;
    const originalEvent = eventsByItem.get(Number(item.row.id));
    if (!originalEvent) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `حدث استحقاق البند #${item.row.id} مفقود؛ العكس موقوف.`,
      });
    }
    const expectedEventHash = payrollHash({
      kind: "ACCRUAL",
      itemSnapshotHash: item.snapshotHash,
      legalPolicyHash: input.run.legalPolicyHash,
    });
    if (originalEvent.sourceHash !== expectedEventHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `بصمة حدث استحقاق البند #${item.row.id} لا تطابق لقطته.`,
      });
    }
    const [already] = await tx
      .select({ id: payrollAccountingEvents.id })
      .from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.reversalOfId, Number(originalEvent.id)))
      .limit(1);
    if (already) continue;
    const posting = payrollAccrualPosting(item.breakdown, true);
    await postPayrollAccountingEvent(tx, {
      runId,
      branchId: item.branchId,
      revisionNo,
      eventKind: "ACCRUAL_REVERSAL",
      reversalOfId: Number(originalEvent.id),
      sourceKey: `PAYROLL:ACCRUAL-REV:${runId}:${revisionNo}:${Number(item.row.id)}`,
      sourceHashPayload: {
        kind: "ACCRUAL_REVERSAL",
        originalEventHash: originalEvent.sourceHash,
        itemSnapshotHash: item.snapshotHash,
      },
      occurredAt: reversalEntryAt,
      actorUserId: input.actorUserId,
      entryType: "ADJUST",
      amount: posting.amount,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `عكس استحقاق راتب — مسيّر ${input.run.period} — موظف #${item.row.employeeId}`,
    });
  }
  await reverseAdvanceSettlementsTx(tx, {
    runId,
    revisionNo,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
  });
  if (obligations.length > 0) {
    await tx
      .update(payrollObligations)
      .set({ remainingAmount: "0.00", status: "REVERSED" })
      .where(
        and(
          eq(payrollObligations.runId, runId),
          eq(payrollObligations.revisionNo, revisionNo),
          inArray(payrollObligations.status, ["OPEN", "PARTIAL", "SETTLED"]),
        ),
      );
  }
  const nextRevision = revisionNo + 1;
  await tx
    .update(payrollItems)
    .set({
      revisionNo: nextRevision,
      branchIdSnapshot: null,
      snapshotHash: null,
    })
    .where(eq(payrollItems.runId, runId));
  await tx
    .update(payrollRuns)
    .set({
      status: "draft",
      revisionNo: nextRevision,
      accrualDate: null,
      approvalSnapshotHash: null,
      approvedAt: null,
      approvedBy: null,
      paidAt: null,
      paidBy: null,
    })
    .where(eq(payrollRuns.id, runId));
}
