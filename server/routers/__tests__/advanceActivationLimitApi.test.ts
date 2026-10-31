import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // Exercise reservation against a known earned balance, independently of the
  // real calendar day. Keep real I/O timers for database and background work.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T09:00:00.000Z"));
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
    hireDate: "2026-10-01",
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

afterEach(() => vi.useRealTimers());

describe("advance limit through payroll/voucher API", () => {
  it("يحجز الطلب المعلق من الحد الشهري بلا سند أو أثر نقدي", async () => {
    const maker = appRouter.createCaller(context(await user(1)));
    const first = await maker.payroll.advanceGrant({
      employeeId: 1,
      branchId: 1,
      amount: "600000.00",
      clientRequestId: "advance-api-limit-a",
    });
    expect(first).toMatchObject({ status: "PENDING", payrollPeriod: "2026-10" });
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
