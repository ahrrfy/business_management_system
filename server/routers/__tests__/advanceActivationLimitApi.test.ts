import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function context(user: typeof s.users.$inferSelect): TrpcContext {
  return {
    req: { headers: {}, id: `advance-limit-api-${user.id}` } as unknown as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user,
    sessionId: null,
    platformAdmin: null,
  };
}

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0]!;
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "accountingEntries",
    "receipts",
    "advanceSettlements",
    "employeeLoanRequests",
    "employeeAdvances",
    "employees",
    "voucherCategories",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "advance-api-maker", name: "مدير منشئ", role: "admin", branchId: 1, isOwner: false },
    { id: 2, openId: "advance-api-owner-approver", name: "مالك معتمد", role: "manager", branchId: 1, isOwner: true },
  ]);
  await db().insert(s.employees).values({
    id: 1,
    branchId: 1,
    firstName: "زينب",
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
    referenceNumber: "ADVANCE-API-FUND",
    createdBy: 2,
  });
});

describe("advance limit through payroll/voucher API", () => {
  it("يحجز الطلب المعلق من الحد الشهري بلا سند أو أثر نقدي", async () => {
    const maker = appRouter.createCaller(context(await user(1)));
    const first = await maker.payroll.advanceGrant({
      employeeId: 1,
      branchId: 1,
      amount: "600000.00",
      clientRequestId: "advance-api-limit-a",
    });
    expect(first.status).toBe("PENDING");
    await expect(
      maker.payroll.advanceGrant({
        employeeId: 1,
        branchId: 1,
        amount: "600000.00",
        clientRequestId: "advance-api-limit-b",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [requests, active, outReceipts, entries, audits] = await Promise.all([
      db().select().from(s.employeeLoanRequests),
      db()
        .select()
        .from(s.employeeAdvances)
        .where(eq(s.employeeAdvances.status, "ACTIVE")),
      db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")),
      db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
      db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "payroll.advanceGrant")),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: Number(first.id),
      status: "PENDING",
      amount: "600000.00",
    });
    expect(active).toHaveLength(0);
    expect(outReceipts).toHaveLength(0);
    expect(entries).toHaveLength(0);
    expect(audits).toHaveLength(1);
  });
});
