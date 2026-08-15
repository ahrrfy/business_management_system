import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { grantAdvance } from "../advancesService";
import { approveVoucher } from "../voucher/approval";
import { truncateTables } from "./__testUtils__";

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const OWNER = { userId: 2, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function request(amount: string, key: string) {
  return grantAdvance({
    employeeId: 1,
    branchId: 1,
    amount,
    clientRequestId: key,
  }, MAKER);
}

async function moneyTrail() {
  const d = db();
  const [advances, approvedOut, pendingOut, entries] = await Promise.all([
    d.select().from(s.employeeAdvances).where(eq(s.employeeAdvances.status, "ACTIVE")),
    d.select().from(s.receipts).where(and(
      eq(s.receipts.direction, "OUT"),
      eq(s.receipts.approvalStatus, "APPROVED"),
    )),
    d.select().from(s.receipts).where(and(
      eq(s.receipts.direction, "OUT"),
      eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
    )),
    d.select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
  ]);
  return { advances, approvedOut, pendingOut, entries };
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "accountingEntries",
    "receipts",
    "advanceSettlements",
    "employeeAdvances",
    "employees",
    "voucherCategories",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "advance-limit-maker", name: "منشئ الطلب", role: "admin", branchId: 1 },
    { id: 2, openId: "advance-limit-owner", name: "المالك المعتمد", role: "manager", branchId: 1, isOwner: true },
  ]);
  await db().insert(s.employees).values({
    id: 1,
    branchId: 1,
    firstName: "علي",
    lastName: "الاختبار",
    payType: "monthly",
    salary: "1000000.00",
    allowances: "0.00",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "5000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "ADVANCE-LIMIT-FUND",
    createdBy: 2,
  });
});

describe("advance activation outstanding limit", () => {
  it("لا يحسب الطلبات المعلّقة، ثم يمنع اعتمادين متزامنين يتجاوز مجموعهما السقف ذرياً", async () => {
    const first = await request("600000.00", "advance-limit-service-a");
    const second = await request("600000.00", "advance-limit-service-b");

    const before = await moneyTrail();
    expect(before.advances).toHaveLength(0);
    expect(before.approvedOut).toHaveLength(0);
    expect(before.pendingOut).toHaveLength(2);
    expect(before.entries).toHaveLength(0);

    const results = await Promise.allSettled([
      approveVoucher(Number(first.receiptId), OWNER),
      approveVoucher(Number(second.receiptId), OWNER),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(String(rejected?.reason?.message)).toMatch(/سقف السلف غير المسدَّدة/);

    const after = await moneyTrail();
    expect(after.advances).toHaveLength(1);
    expect(after.advances[0].remaining).toBe("600000.00");
    expect(after.approvedOut).toHaveLength(1);
    expect(after.pendingOut).toHaveLength(1);
    expect(after.pendingOut[0]).toMatchObject({
      status: "PENDING",
      cashBucket: null,
      approvedBy: null,
      signatureHash: null,
    });
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].amount).toBe("600000.00");

    const approvedReceiptId = Number(after.approvedOut[0].id);
    const replay = await approveVoucher(approvedReceiptId, OWNER);
    expect(replay.replayed).toBe(true);
    const replayedTrail = await moneyTrail();
    expect(replayedTrail.advances).toHaveLength(1);
    expect(replayedTrail.entries).toHaveLength(1);
  });

  it("يسمح بالوصول إلى السقف تماماً، ويعيد فحص طلب تالٍ عند الاعتماد", async () => {
    const first = await request("500000.00", "advance-limit-exact-a");
    const second = await request("500000.00", "advance-limit-exact-b");
    await approveVoucher(Number(first.receiptId), OWNER);
    await approveVoucher(Number(second.receiptId), OWNER);

    const atLimit = await moneyTrail();
    expect(atLimit.advances).toHaveLength(2);
    expect(atLimit.advances.reduce((sum, row) => sum + Number(row.remaining), 0)).toBe(1_000_000);
    expect(atLimit.entries).toHaveLength(2);

    const third = await request("1.00", "advance-limit-over");
    await expect(approveVoucher(Number(third.receiptId), OWNER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const rejectedTrail = await moneyTrail();
    expect(rejectedTrail.advances).toHaveLength(2);
    expect(rejectedTrail.approvedOut).toHaveLength(2);
    expect(rejectedTrail.pendingOut).toHaveLength(1);
    expect(rejectedTrail.entries).toHaveLength(2);
  });
});
