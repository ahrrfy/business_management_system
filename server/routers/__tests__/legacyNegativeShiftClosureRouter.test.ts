import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function context(userId: number, isOwner: boolean): TrpcContext {
  return {
    req: { headers: {}, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: {
      id: userId,
      role: isOwner ? "admin" : "manager",
      branchId: 1,
      name: isOwner ? "المالك" : "المدير",
      isActive: true,
      isOwner,
    } as TrpcContext["user"],
    sessionId: null,
    platformAdmin: null,
  };
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["auditLogs", "accountingEntries", "receipts", "shifts", "branches", "users"]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "router-owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "router-cashier", name: "الكاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "router-manager", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.shifts).values({
    id: 151, branchId: 1, userId: 2, openingBalance: "0.00", status: "OPEN",
    openGuard: "2:1:RETAIL", openedAt: new Date("2026-08-10T08:00:00.000Z"),
  });
  await db().insert(s.receipts).values([
    { branchId: 1, shiftId: 151, direction: "OUT", amount: "324000.00", paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 2 },
    { branchId: 1, shiftId: null, direction: "IN", amount: "500000.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 1 },
  ]);
});

describe("shifts.close legacyNegativeRemediation", () => {
  it("يمر عبر endpoint الإغلاق القائم ويظل محصوراً بالمالك", async () => {
    const payload = {
      shiftId: 151,
      countedCash: "0",
      legacyNegativeRemediation: {
        expectedCash: "-324000.00",
        evidenceNote: "توجيه المالك بتحميل العجز الموروث على الخزنة بعد عد الدرج صفراً.",
        confirmDrawerCountedZero: true as const,
        clientRequestId: "router-legacy-151",
      },
    };
    await expect(appRouter.createCaller(context(3, false)).shifts.close(payload)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().select().from(s.shifts).where(eq(s.shifts.id, 151)).limit(1))[0]?.status).toBe("OPEN");

    const closed = await appRouter.createCaller(context(1, true)).shifts.close(payload);
    expect(closed.expectedCash).toBe("0.00");
    expect(closed.countedCash).toBe("0.00");
    expect(closed.legacyNegativeRemediation.totalFunding).toBe("324000.00");
  });
});

