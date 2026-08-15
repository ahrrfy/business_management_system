import { and, eq } from "drizzle-orm";
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
    "employeeAdvances",
    "employees",
    "voucherCategories",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "advance-api-owner-maker", name: "مالك منشئ", role: "admin", branchId: 1, isOwner: true },
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
  it("يحفظ SOD ويمنع سباق اعتماد طلبين من تجاوز السقف عبر الحد العام", async () => {
    const maker = appRouter.createCaller(context(await user(1)));
    const approver = appRouter.createCaller(context(await user(2)));
    const first = await maker.payroll.advanceGrant({
      employeeId: 1,
      branchId: 1,
      amount: "600000.00",
      clientRequestId: "advance-api-limit-a",
    });
    const second = await maker.payroll.advanceGrant({
      employeeId: 1,
      branchId: 1,
      amount: "600000.00",
      clientRequestId: "advance-api-limit-b",
    });
    expect(first.status).toBe("PENDING_APPROVAL");
    expect(second.status).toBe("PENDING_APPROVAL");

    await expect(maker.vouchers.approve({ receiptId: Number(first.receiptId) })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const results = await Promise.allSettled([
      approver.vouchers.approve({ receiptId: Number(first.receiptId) }),
      approver.vouchers.approve({ receiptId: Number(second.receiptId) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [active, approved, pending, entries, audits] = await Promise.all([
      db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.status, "ACTIVE")),
      db().select().from(s.receipts).where(and(
        eq(s.receipts.direction, "OUT"),
        eq(s.receipts.approvalStatus, "APPROVED"),
      )),
      db().select().from(s.receipts).where(and(
        eq(s.receipts.direction, "OUT"),
        eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
      )),
      db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
      db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "voucher.approve")),
    ]);
    expect(active).toHaveLength(1);
    expect(active[0].remaining).toBe("600000.00");
    expect(approved).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});
