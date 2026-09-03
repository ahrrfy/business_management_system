import { and, eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import {
  completeTermination,
  listTerminations,
  reissueTerminationPayment,
  reverseTerminationPayment,
} from "../promotionService";
import { withTx } from "../tx";
import {
  approveVoucher,
  rejectVoucher,
} from "../voucher/approval";
import { parseSystemPaymentRequest } from "../voucher/create";

const MAKER = { userId: 2, branchId: 1, role: "manager" };
const APPROVER = { userId: 3, branchId: 1, role: "manager" };
const INACTIVE_OWNER = { userId: 4, branchId: 1, role: "manager" };
const REVERSER = { userId: 5, branchId: 1, role: "manager" };
const RETURNER = { userId: 6, branchId: 1, role: "manager" };

const TABLES = [
  "payrollObligationAllocations",
  "payrollAccountingEvents",
  "payrollObligations",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "idempotencyKeys",
  "receipts",
  "hrDeviceUsers",
  "employeeTerminations",
  "employees",
  "branches",
  "users",
];

function db() {
  const connection = getDb();
  if (!connection) throw new Error("DATABASE_URL not set for tests");
  return connection;
}

async function resetAndSeed() {
  const connection = db();
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await connection.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await connection.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

  await connection.insert(schema.branches).values({
    id: 1,
    name: "Main",
    code: "MAIN",
    type: "MAIN",
  });
  await connection.insert(schema.users).values([
    {
      id: 2,
      openId: "termination-maker",
      name: "Maker owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 3,
      openId: "termination-approver",
      name: "Approver owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 4,
      openId: "termination-inactive-owner",
      name: "Inactive owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: false,
    },
    {
      id: 5,
      openId: "termination-reverser",
      name: "Independent reversal owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
    {
      id: 6,
      openId: "termination-returner",
      name: "Independent return owner",
      role: "manager",
      branchId: 1,
      isOwner: true,
      isActive: true,
    },
  ]);
}

async function seedTermination(input: {
  terminationId: number;
  employeeId: number;
  settlement: string;
  paymentMethod?: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  paymentReference?: string | null;
}) {
  await db().insert(schema.employees).values({
    id: input.employeeId,
    branchId: 1,
    firstName: "Termination",
    lastName: String(input.employeeId),
    salary: "900000.00",
    employmentStatus: "active",
    isActive: true,
  });
  await db().insert(schema.employeeTerminations).values({
    id: input.terminationId,
    employeeId: input.employeeId,
    terminationType: "RESIGNATION",
    lastDay: "2026-08-15",
    settlement: input.settlement,
    otherSettlement: input.settlement,
    otherSettlementLabel: "مكافأة تعاقدية معتمدة",
    settlementEvidenceNote: "مراجعة بشرية موثقة لاختبار التسوية",
    zeroAmountsAttested: true,
    settlementPaymentMethod: input.paymentMethod ?? "CASH",
    settlementPaymentReference: input.paymentReference ?? null,
    createdBy: 3,
    reason: "Contract closed",
    status: "pending",
  });
}

async function paymentOutEntries(receiptId: number) {
  return db()
    .select()
    .from(schema.accountingEntries)
    .where(
      and(
        eq(schema.accountingEntries.receiptId, receiptId),
        eq(schema.accountingEntries.entryType, "PAYMENT_OUT"),
      ),
    );
}

beforeEach(resetAndSeed);

describe("termination settlement voucher pending lifecycle", () => {
  it("stays zero-effect until funded, and materializes exactly once under concurrent approval", async () => {
    await seedTermination({
      terminationId: 101,
      employeeId: 11,
      settlement: "750000.00",
    });

    const completed = await completeTermination(101, MAKER);
    const receiptId = completed.settlementVoucher!.receiptId;

    const [pendingReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, receiptId));
    const [termination] = await db()
      .select()
      .from(schema.employeeTerminations)
      .where(eq(schema.employeeTerminations.id, 101));
    const [employee] = await db()
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, 11));

    expect(pendingReceipt).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      direction: "OUT",
      paymentMethod: "CASH",
      shiftId: null,
      cashBucket: null,
      approvedBy: null,
      approvedAt: null,
      signatureHash: null,
      referenceNumber: "TERM-SETTLEMENT-101-A1",
    });
    expect(parseSystemPaymentRequest(pendingReceipt.internalNote)).toMatchObject({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 101,
      employeeId: 11,
      expectedAmount: "750000.00",
      attempt: 1,
      originReturnEventId: null,
      paymentEvidenceReference: null,
    });
    expect(termination.status).toBe("completed");
    expect(employee).toMatchObject({
      employmentStatus: "terminated",
      isActive: false,
    });
    expect(await paymentOutEntries(receiptId)).toHaveLength(0);
    const balanceBeforeFunding = await withTx((tx) =>
      computeTreasuryCashBalance(tx, 1),
    );
    expect(balanceBeforeFunding.toFixed(2)).toBe("0.00");

    // قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — صانع الطلب مالكٌ فلا يُرفض لهذا السبب
    // بعد اليوم؛ يبقى مرفوضاً هنا لأنّ الخزينة غير ممولة بعد (٠.٠٠ < ٧٥٠٠٠٠.٠٠)، لا لفصل المهام.
    await expect(approveVoucher(receiptId, MAKER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(
      approveVoucher(receiptId, INACTIVE_OWNER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await paymentOutEntries(receiptId)).toHaveLength(0);

    await db().insert(schema.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "1000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TERMINATION-TEST-FUNDING",
      createdBy: 3,
    });

    const approvals = await Promise.all([
      approveVoucher(receiptId, APPROVER),
      approveVoucher(receiptId, APPROVER),
    ]);
    expect(approvals.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(approvals.map((result) => result.signatureHash)).size).toBe(
      1,
    );

    const [approvedReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, receiptId));
    expect(approvedReceipt).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: 3,
      shiftId: null,
      cashBucket: "TREASURY",
    });
    expect(approvedReceipt.signatureHash).toHaveLength(64);
    expect(await paymentOutEntries(receiptId)).toHaveLength(1);

    const replay = await approveVoucher(receiptId, APPROVER);
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.signatureHash).toBe(approvedReceipt.signatureHash);
    expect(await paymentOutEntries(receiptId)).toHaveLength(1);
  });

  it("keeps rejected history and resubmits the same unpaid settlement exactly once", async () => {
    await seedTermination({
      terminationId: 102,
      employeeId: 12,
      settlement: "250000.00",
    });

    const completed = await completeTermination(102, MAKER);
    const receiptId = completed.settlementVoucher!.receiptId;
    await rejectVoucher(receiptId, APPROVER, "Settlement requires correction");

    const [rejectedReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, receiptId));
    const [termination] = await db()
      .select()
      .from(schema.employeeTerminations)
      .where(eq(schema.employeeTerminations.id, 102));
    const [employee] = await db()
      .select()
      .from(schema.employees)
      .where(eq(schema.employees.id, 12));

    expect(rejectedReceipt).toMatchObject({
      status: "FAILED",
      approvalStatus: "REJECTED",
      approvedBy: 3,
      shiftId: null,
      cashBucket: null,
      signatureHash: null,
    });
    expect(rejectedReceipt.description).toContain(
      "Settlement requires correction",
    );
    expect(parseSystemPaymentRequest(rejectedReceipt.internalNote)).toMatchObject({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 102,
      employeeId: 12,
      expectedAmount: "250000.00",
      attempt: 1,
      originReturnEventId: null,
    });
    expect(termination.status).toBe("completed");
    expect(employee).toMatchObject({
      employmentStatus: "terminated",
      isActive: false,
    });
    expect(await paymentOutEntries(receiptId)).toHaveLength(0);
    await expect(approveVoucher(receiptId, APPROVER)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      rejectVoucher(receiptId, APPROVER, "duplicate"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const replacements = await Promise.all([
      reissueTerminationPayment(102, MAKER, "Corrected settlement request"),
      reissueTerminationPayment(102, MAKER, "Corrected settlement request"),
    ]);
    expect(new Set(replacements.map((replacement) => replacement.receiptId)).size).toBe(1);
    await expect(
      reissueTerminationPayment(102, MAKER, "Different pending request reason"),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const replacementId = replacements[0].receiptId;
    const settlementReceipts = await db()
      .select()
      .from(schema.receipts)
      .where(like(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102-%"));
    expect(settlementReceipts).toHaveLength(2);
    const replacement = settlementReceipts.find((receipt) => receipt.id === replacementId)!;
    expect(replacement).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      shiftId: null,
      cashBucket: null,
      createdBy: 2,
    });
    expect(parseSystemPaymentRequest(replacement.internalNote)).toMatchObject({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 102,
      attempt: 2,
      originReturnEventId: null,
    });
    expect(await paymentOutEntries(replacementId)).toHaveLength(0);

    await rejectVoucher(
      replacementId,
      APPROVER,
      "Second request also requires correction",
    );
    const secondGeneration = await Promise.all([
      reissueTerminationPayment(102, MAKER, "Final corrected settlement request"),
      reissueTerminationPayment(102, MAKER, "Final corrected settlement request"),
    ]);
    expect(
      new Set(secondGeneration.map((replacement) => replacement.receiptId))
        .size,
    ).toBe(1);
    const finalReplacementId = secondGeneration[0].receiptId;
    expect(finalReplacementId).not.toBe(replacementId);
    const beforeApproval = await db()
      .select()
      .from(schema.receipts)
      .where(like(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102-%"));
    expect(beforeApproval).toHaveLength(3);
    expect(
      beforeApproval.filter(
        (receipt) => receipt.approvalStatus === "PENDING_APPROVAL",
      ),
    ).toHaveLength(1);

    await db().insert(schema.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "250000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TERMINATION-RESUBMIT-FUNDING",
      createdBy: 3,
    });
    await approveVoucher(finalReplacementId, APPROVER);
    expect(await paymentOutEntries(finalReplacementId)).toHaveLength(1);
    expect(await paymentOutEntries(replacementId)).toHaveLength(0);
    expect(await paymentOutEntries(receiptId)).toHaveLength(0);

    await expect(
      reissueTerminationPayment(102, MAKER, "Duplicate after approved"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const finalSettlementReceipts = await db()
      .select()
      .from(schema.receipts)
      .where(like(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102-%"));
    expect(finalSettlementReceipts).toHaveLength(3);
    expect(
      finalSettlementReceipts.filter(
        (receipt) =>
          receipt.status === "COMPLETED" &&
          receipt.approvalStatus === "APPROVED",
      ),
    ).toHaveLength(1);
    expect(await paymentOutEntries(finalReplacementId)).toHaveLength(1);
  });

  it("pays by transfer, returns, repays, and returns again with exact SOD and idempotency", async () => {
    await seedTermination({
      terminationId: 103,
      employeeId: 13,
      settlement: "325000.00",
      paymentMethod: "TRANSFER",
      paymentReference: "BANK-SETTLEMENT-103",
    });
    const completed = await completeTermination(103, MAKER);
    const firstVoucherId = completed.settlementVoucher!.receiptId;
    await approveVoucher(firstVoucherId, REVERSER);

    const firstReturnInput = {
      reason: "Returned transfer from employee",
      paymentMethod: "TRANSFER" as const,
      referenceNumber: "BANK-RETURN-103-1",
      reversalDate: baghdadToday(),
    };
    await expect(
      reverseTerminationPayment(103, REVERSER, firstReturnInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const firstReturn = await reverseTerminationPayment(
      103,
      RETURNER,
      firstReturnInput,
    );
    expect(firstReturn.replayed).toBe(false);
    expect(firstReturn.replacementVoucher).not.toBeNull();
    const firstReplay = await reverseTerminationPayment(
      103,
      RETURNER,
      firstReturnInput,
    );
    expect(firstReplay).toMatchObject({
      eventId: firstReturn.eventId,
      replayed: true,
    });
    await expect(
      reverseTerminationPayment(103, RETURNER, {
        ...firstReturnInput,
        reason: "Different replay reason",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const replacementId = firstReturn.replacementVoucher!.receiptId;
    const [replacementReceipt] = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.id, replacementId));
    expect(replacementReceipt.referenceNumber).toBe(
      `TERM-SETTLEMENT-103-REPAY-${firstReturn.eventId}-A2`,
    );
    expect(parseSystemPaymentRequest(replacementReceipt.internalNote)).toMatchObject({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 103,
      attempt: 2,
      originReturnEventId: firstReturn.eventId,
      paymentEvidenceReference: "BANK-SETTLEMENT-103",
    });
    await approveVoucher(replacementId, REVERSER);

    const secondReturnInput = {
      reason: "Second returned transfer from employee",
      paymentMethod: "TRANSFER" as const,
      referenceNumber: "BANK-RETURN-103-2",
      reversalDate: baghdadToday(),
    };
    const secondReturn = await reverseTerminationPayment(
      103,
      RETURNER,
      secondReturnInput,
    );
    expect(secondReturn.replayed).toBe(false);
    const secondReplay = await reverseTerminationPayment(
      103,
      RETURNER,
      secondReturnInput,
    );
    expect(secondReplay).toMatchObject({
      eventId: secondReturn.eventId,
      replayed: true,
    });

    const events = await db()
      .select()
      .from(schema.payrollAccountingEvents)
      .where(eq(schema.payrollAccountingEvents.terminationId, 103));
    expect(
      events.filter((event) => event.eventKind === "SALARY_PAYMENT"),
    ).toHaveLength(2);
    const returns = events.filter(
      (event) => event.eventKind === "SALARY_PAYMENT_RETURN",
    );
    expect(returns).toHaveLength(2);
    expect(new Set(returns.map((event) => event.sourceKey)).size).toBe(2);

    const allocations = await db()
      .select()
      .from(schema.payrollObligationAllocations)
      .where(like(schema.payrollObligationAllocations.sourceKey, "TERMINATION:PAYMENT%:103%"));
    expect(
      allocations.filter((allocation) => allocation.direction === "APPLY"),
    ).toHaveLength(2);
    expect(
      allocations.filter((allocation) => allocation.direction === "REVERSE"),
    ).toHaveLength(2);
    const [listed] = await listTerminations(RETURNER);
    expect(listed.latestSettlementPaymentEventKind).toBe(
      "SALARY_PAYMENT_RETURN",
    );
  });
});
