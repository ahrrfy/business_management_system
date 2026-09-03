import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPostingIntentEvidence } from "../accounting/postingEngine";
import { withTx } from "../tx";
import {
  cancelLockedEmployeeAdvanceTx,
  lockUntouchedEmployeeAdvanceForCancellationTx,
} from "../advances";
import {
  advanceRepaymentPosting,
  approveAdvanceRepaymentRequest,
  createAdvanceRepaymentRequest,
  createAdvanceRepaymentReturnRequest,
  getAdvanceRepaymentRequest,
  listAdvanceRepaymentLedger,
} from "../payroll/advanceRepayment";

const MAKER = { userId: 1, branchId: 1, role: "manager", isOwner: false };
const ORIGINAL_REVIEWER = { userId: 2, branchId: 1, role: "manager", isOwner: true };
const INDEPENDENT_OWNER = { userId: 3, branchId: 1, role: "manager", isOwner: true };
const RETURN_MAKER = { userId: 4, branchId: 1, role: "manager", isOwner: false };

const TABLES = [
  "employeeAdvanceRepaymentAllocations",
  "employeeAdvanceRepaymentRequests",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "receipts",
  "employeeAdvances",
  "shifts",
  "financialPeriods",
  "monthCloseSequence",
  "employees",
  "branches",
  "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const runner = db();
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await runner.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await runner.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const runner = db();
  await runner.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await runner.insert(s.users).values([
    { id: 1, openId: "advance-maker", role: "manager", branchId: 1 },
    { id: 2, openId: "advance-owner-b", role: "manager", branchId: 1, isOwner: true },
    { id: 3, openId: "advance-owner-d", role: "manager", branchId: 1, isOwner: true },
    { id: 4, openId: "advance-return-maker", role: "manager", branchId: 1 },
    { id: 5, openId: "advance-branch-two", role: "manager", branchId: 2 },
  ]);
  await runner.insert(s.employees).values([
    { id: 10, branchId: 1, firstName: "موظف", lastName: "السلفة", payType: "monthly", salary: "1000.00" },
    { id: 11, branchId: 2, firstName: "موظف", lastName: "الفرع", payType: "monthly", salary: "1000.00" },
  ]);
  await runner.insert(s.shifts).values({
    id: 100,
    branchId: 1,
    userId: 1,
    openingBalance: "1000.00",
    status: "OPEN",
    openGuard: "1:1:RETAIL",
  });
  await runner.insert(s.employeeAdvances).values([
    { id: 20, employeeId: 10, branchId: 1, amount: "300.00", remaining: "300.00", status: "ACTIVE", createdBy: 1 },
    { id: 21, employeeId: 10, branchId: 1, amount: "400.00", remaining: "400.00", status: "ACTIVE", createdBy: 1 },
    { id: 22, employeeId: 11, branchId: 2, amount: "200.00", remaining: "200.00", status: "ACTIVE", createdBy: 5 },
  ]);
}

function cardRepayment(clientRequestId = "advance-repay-001", referenceNumber = "CARD-TXN-001") {
  return {
    employeeId: 10,
    branchId: 1,
    amount: "500.00",
    paymentMethod: "CARD" as const,
    referenceNumber,
    cardLastFour: "1234",
    transactionDate: "2026-08-15",
    evidenceNote: "إثبات قبض فعلي من الموظف",
    clientRequestId,
  };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("employee advance repayment 0191", () => {
  it("keeps requests zero-effect, materializes once, and allocates FIFO", async () => {
    const requested = await createAdvanceRepaymentRequest(cardRepayment(), MAKER);
    expect(requested).toMatchObject({ status: "PENDING", replayed: false });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvanceRepaymentAllocations)).toHaveLength(0);

    await expect(approveAdvanceRepaymentRequest(Number(requested.id), MAKER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [first, second] = await Promise.all([
      approveAdvanceRepaymentRequest(Number(requested.id), ORIGINAL_REVIEWER),
      approveAdvanceRepaymentRequest(Number(requested.id), ORIGINAL_REVIEWER),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);

    const advances = await db().select().from(s.employeeAdvances).orderBy(s.employeeAdvances.id);
    expect(advances.slice(0, 2).map((row) => [row.id, row.remaining, row.status])).toEqual([
      [20, "0.00", "SETTLED"],
      [21, "200.00", "ACTIVE"],
    ]);
    const allocations = await db().select().from(s.employeeAdvanceRepaymentAllocations).orderBy(s.employeeAdvanceRepaymentAllocations.id);
    expect(allocations.map((row) => [row.advanceId, row.direction, row.amount])).toEqual([
      [20, "APPLY", "300.00"],
      [21, "APPLY", "200.00"],
    ]);
    const receiptRows = await db().select().from(s.receipts);
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]).toMatchObject({
      direction: "IN",
      paymentMethod: "CARD",
      referenceNumber: "CARD-TXN-001",
      cardLastFour: "1234",
      amount: "500.00",
      status: "COMPLETED",
      partyType: "OTHER",
    });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    await expect(createAdvanceRepaymentRequest(cardRepayment(), MAKER)).resolves.toMatchObject({ replayed: true });
  });

  it("permits the original reviewer to approve the return too (قرار المالك ٣/٩/٢٦), races it safely against a concurrent cancellation, then permits re-repayment", async () => {
    await db().insert(s.receipts).values({
      id: 900,
      branchId: 1,
      direction: "OUT",
      amount: "300.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "PV-ADV-LOCK-900",
      createdBy: 1,
    });
    await db()
      .update(s.employeeAdvances)
      .set({ receiptId: 900 })
      .where(eq(s.employeeAdvances.id, 20));
    const repayment = await createAdvanceRepaymentRequest(cardRepayment(), MAKER);
    await approveAdvanceRepaymentRequest(Number(repayment.id), ORIGINAL_REVIEWER);
    const returned = await createAdvanceRepaymentReturnRequest({
      originalRequestId: Number(repayment.id),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId: 100,
      transactionDate: "2026-08-15",
      evidenceNote: "إعادة نقدية فعلية مثبتة للموظف",
      clientRequestId: "advance-return-001",
    }, RETURN_MAKER);
    await expect(createAdvanceRepaymentReturnRequest({
      originalRequestId: Number(repayment.id),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId: 100,
      transactionDate: "2026-08-15",
      evidenceNote: "إعادة نقدية فعلية مثبتة للموظف",
      clientRequestId: "advance-return-001",
    }, RETURN_MAKER)).resolves.toMatchObject({ id: returned.id, replayed: true });
    await expect(createAdvanceRepaymentReturnRequest({
      originalRequestId: Number(repayment.id),
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId: 100,
      transactionDate: "2026-08-15",
      evidenceNote: "طلب إعادة مختلف للسداد نفسه",
      clientRequestId: "advance-return-002",
    }, RETURN_MAKER)).rejects.toMatchObject({ code: "CONFLICT" });

    const returnVsCancellation = await Promise.allSettled([
      approveAdvanceRepaymentRequest(Number(returned.id), ORIGINAL_REVIEWER),
      withTx(async (tx) => {
        const locked = await lockUntouchedEmployeeAdvanceForCancellationTx(tx, {
          originalReceiptId: 900,
          employeeId: 10,
          branchId: 1,
          expectedAmount: "300.00",
        });
        await cancelLockedEmployeeAdvanceTx(tx, locked);
      }),
    ]);
    expect(returnVsCancellation.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(returnVsCancellation.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of returnVsCancellation) {
      if (result.status === "rejected") {
        expect(String(result.reason)).not.toMatch(/ER_LOCK_DEADLOCK|deadlock/i);
      }
    }

    const advances = await db().select().from(s.employeeAdvances).where(inArrayIds([20, 21])).orderBy(s.employeeAdvances.id);
    expect(advances.map((row) => [row.id, row.remaining, row.status])).toEqual([
      [20, "300.00", "ACTIVE"],
      [21, "400.00", "ACTIVE"],
    ]);
    const requests = await db().select().from(s.employeeAdvanceRepaymentRequests).orderBy(s.employeeAdvanceRepaymentRequests.id);
    const originalReceipt = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(requests[0].receiptId))).limit(1);
    expect(originalReceipt[0].status).toBe("REVERSED");
    const reversals = await db().select().from(s.employeeAdvanceRepaymentAllocations)
      .where(eq(s.employeeAdvanceRepaymentAllocations.direction, "REVERSE"));
    expect(reversals).toHaveLength(2);
    expect(reversals.every((row) => row.reversalOfId != null)).toBe(true);
    const materializedReceipts = (await db().select().from(s.receipts)).length;
    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null }).where(eq(s.shifts.id, 100));
    await expect(
      approveAdvanceRepaymentRequest(Number(returned.id), INDEPENDENT_OWNER),
    ).resolves.toMatchObject({ replayed: true });
    expect(await db().select().from(s.receipts)).toHaveLength(materializedReceipts);

    const reRepayment = await createAdvanceRepaymentRequest(cardRepayment("advance-repay-002", "CARD-TXN-002"), MAKER);
    await expect(approveAdvanceRepaymentRequest(Number(reRepayment.id), ORIGINAL_REVIEWER)).resolves.toMatchObject({ status: "APPROVED" });
    expect(await listAdvanceRepaymentLedger({ employeeId: 10, branchId: 1 })).toHaveLength(3);
  });

  it("enforces branch scope, unique external confirmation, and approval-time open shift", async () => {
    await expect(createAdvanceRepaymentRequest({
      ...cardRepayment("advance-cross-001", "CROSS-REF-001"),
      employeeId: 11,
      branchId: 2,
      amount: "100.00",
    }, MAKER)).rejects.toMatchObject({ code: "FORBIDDEN" });

    await createAdvanceRepaymentRequest(cardRepayment(), MAKER);
    await expect(createAdvanceRepaymentRequest(cardRepayment("advance-repay-other", "CARD-TXN-001"), MAKER))
      .rejects.toMatchObject({ code: "CONFLICT" });

    const cash = await createAdvanceRepaymentRequest({
      employeeId: 10,
      branchId: 1,
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      shiftId: 100,
      transactionDate: "2026-08-15",
      evidenceNote: "قبض نقدي مثبت في وردية الموظف",
      clientRequestId: "advance-cash-001",
    }, MAKER);
    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null }).where(eq(s.shifts.id, 100));
    await expect(approveAdvanceRepaymentRequest(Number(cash.id), ORIGINAL_REVIEWER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const detail = await getAdvanceRepaymentRequest(Number(cash.id), 1);
    expect(detail).toMatchObject({ status: "PENDING", receiptId: null, accountingEntryId: null });
  });

  it("rejects a new request dated in a locked period before any pending workflow is written", async () => {
    await db().insert(s.financialPeriods).values({
      cutoffDate: "2026-08-31",
      status: "LOCKED",
      lockedBy: 2,
    });

    await expect(
      createAdvanceRepaymentRequest(cardRepayment("advance-locked-001", "LOCKED-REF-001"), MAKER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeAdvanceRepaymentRequests)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("rolls back approval completely if the request date becomes locked", async () => {
    const pending = await createAdvanceRepaymentRequest(
      cardRepayment("advance-lock-after-request", "LOCK-AFTER-REQUEST"),
      MAKER,
    );
    await db().insert(s.financialPeriods).values({
      cutoffDate: "2026-08-31",
      status: "LOCKED",
      lockedBy: 2,
    });

    await expect(
      approveAdvanceRepaymentRequest(Number(pending.id), ORIGINAL_REVIEWER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getAdvanceRepaymentRequest(Number(pending.id), 1)).toMatchObject({
      status: "PENDING",
      receiptId: null,
      accountingEntryId: null,
    });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.employeeAdvanceRepaymentAllocations)).toHaveLength(0);
  });

  it("binds both directions to the exact approved posting profiles", () => {
    const repayment = advanceRepaymentPosting({ requestKind: "REPAYMENT", paymentMethod: "CASH", amount: "250.00" });
    const returned = advanceRepaymentPosting({ requestKind: "RETURN", paymentMethod: "WALLET", amount: "250.00" });
    expect(repayment.profile).toBe("PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT");
    expect(returned.profile).toBe("PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN");
    expect(() => createPostingIntentEvidence(repayment.intent, { amount: "250.00", ...repayment.source })).not.toThrow();
    expect(() => createPostingIntentEvidence(returned.intent, { amount: "250.00", ...returned.source })).not.toThrow();
  });
});

function inArrayIds(ids: number[]) {
  return sql`${s.employeeAdvances.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`;
}
