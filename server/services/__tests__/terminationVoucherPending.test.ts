import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { completeTermination } from "../promotionService";
import { withTx } from "../tx";
import {
  approveVoucher,
  rejectVoucher,
  resubmitRejectedExpensePayment,
} from "../voucher/approval";
import { parseSystemPaymentRequest } from "../voucher/create";

const MAKER = { userId: 2, branchId: 1, role: "manager" };
const APPROVER = { userId: 3, branchId: 1, role: "manager" };
const INACTIVE_OWNER = { userId: 4, branchId: 1, role: "manager" };

const TABLES = [
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
  ]);
}

async function seedTermination(input: {
  terminationId: number;
  employeeId: number;
  settlement: string;
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
  it("stays zero-effect, enforces SOD, and materializes exactly once under concurrent approval", async () => {
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
      referenceNumber: "TERM-SETTLEMENT-101",
    });
    expect(parseSystemPaymentRequest(pendingReceipt.internalNote)).toEqual({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 101,
      employeeId: 11,
      expectedAmount: "750000.00",
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

    await expect(approveVoucher(receiptId, MAKER)).rejects.toMatchObject({
      code: "FORBIDDEN",
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
    expect(parseSystemPaymentRequest(rejectedReceipt.internalNote)).toEqual({
      kind: "TERMINATION_SETTLEMENT",
      terminationId: 102,
      employeeId: 12,
      expectedAmount: "250000.00",
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
      resubmitRejectedExpensePayment(receiptId, MAKER, {
        note: "Corrected settlement request",
      }),
      resubmitRejectedExpensePayment(receiptId, MAKER, {
        note: "Corrected settlement request",
      }),
    ]);
    expect(new Set(replacements.map((replacement) => replacement.receiptId)).size).toBe(1);
    expect(replacements.every((replacement) => replacement.approvalStatus === "PENDING_APPROVAL")).toBe(true);

    const replacementId = replacements[0].receiptId;
    const settlementReceipts = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102"));
    expect(settlementReceipts).toHaveLength(2);
    const replacement = settlementReceipts.find((receipt) => receipt.id === replacementId)!;
    expect(replacement).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      shiftId: null,
      cashBucket: null,
      createdBy: 2,
    });
    expect(parseSystemPaymentRequest(replacement.internalNote)).toEqual(
      parseSystemPaymentRequest(rejectedReceipt.internalNote),
    );
    expect(await paymentOutEntries(replacementId)).toHaveLength(0);

    await rejectVoucher(
      replacementId,
      APPROVER,
      "Second request also requires correction",
    );
    const secondGeneration = await Promise.all([
      resubmitRejectedExpensePayment(receiptId, MAKER, {
        note: "Final corrected settlement request",
      }),
      resubmitRejectedExpensePayment(replacementId, MAKER, {
        note: "Final corrected settlement request",
      }),
    ]);
    expect(
      new Set(secondGeneration.map((replacement) => replacement.receiptId))
        .size,
    ).toBe(1);
    expect(
      secondGeneration.every(
        (replacement) => replacement.approvalStatus === "PENDING_APPROVAL",
      ),
    ).toBe(true);
    const finalReplacementId = secondGeneration[0].receiptId;
    expect(finalReplacementId).not.toBe(replacementId);
    const beforeApproval = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102"));
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

    const replayFromAncestors = await Promise.all([
      resubmitRejectedExpensePayment(receiptId, MAKER),
      resubmitRejectedExpensePayment(replacementId, MAKER),
    ]);
    expect(
      replayFromAncestors.every(
        (replay) =>
          replay.receiptId === finalReplacementId &&
          replay.approvalStatus === "APPROVED",
      ),
    ).toBe(true);
    const finalSettlementReceipts = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.referenceNumber, "TERM-SETTLEMENT-102"));
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
});
