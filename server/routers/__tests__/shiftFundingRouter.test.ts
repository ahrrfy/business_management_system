import { eq, like, sql } from "drizzle-orm";
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

function context(
  userId: number,
  role: "admin" | "manager" | "cashier",
  isOwner = false,
): TrpcContext {
  return {
    req: { headers: {}, ip: "127.0.0.1" } as unknown as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: {
      id: userId,
      role,
      branchId: 1,
      name: `user-${userId}`,
      isActive: true,
      isOwner,
    } as TrpcContext["user"],
    sessionId: null,
    platformAdmin: null,
  };
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of ["auditLogs", "idempotencyKeys", "accountingEntries", "shiftFundingSourceLinks", "receipts", "shifts", "branches", "users"]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "fund-router-owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "fund-router-cashier", name: "الكاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "fund-router-manager", name: "المدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "fund-router-other", name: "كاشير آخر", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.shifts).values([
    {
      id: 201,
      branchId: 1,
      userId: 2,
      openingBalance: "100.00",
      status: "OPEN",
      openGuard: "2:1:RETAIL",
    },
    {
      id: 202,
      branchId: 1,
      userId: 4,
      openingBalance: "300.00",
      status: "OPEN",
      openGuard: "4:1:RETAIL",
    },
  ]);
  await db().insert(s.receipts).values([{
    branchId: 1,
    direction: "IN",
    amount: "500.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    approvedBy: 1,
    approvedAt: new Date("2026-08-15T10:00:00.000Z"),
    createdBy: 1,
  }, {
    id: 901,
    branchId: 1,
    shiftId: 202,
    direction: "OUT",
    amount: "200.00",
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: "CD-ROUTER-200",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 4,
  }, {
    id: 902,
    branchId: 1,
    direction: "IN",
    amount: "200.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: "CD-ROUTER-200",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    approvedBy: 1,
    approvedAt: new Date("2026-08-15T10:05:00.000Z"),
    createdBy: 1,
  }, {
    id: 903,
    branchId: 1,
    shiftId: 202,
    direction: "OUT",
    amount: "50.00",
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: "CD-ROUTER-50",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 4,
  }, {
    id: 904,
    branchId: 1,
    direction: "IN",
    amount: "50.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: "CD-ROUTER-50",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    approvedBy: 1,
    approvedAt: new Date("2026-08-15T10:10:00.000Z"),
    createdBy: 1,
  }]);
  await db().insert(s.accountingEntries).values([{
    entryType: "CASH_HANDOVER",
    branchId: 1,
    receiptId: 901,
    amount: "200.00",
    entryDate: "2026-08-15",
    dedupeKey: "CASH_DROP:router-source-200",
    createdBy: 4,
  }, {
    entryType: "CASH_HANDOVER",
    branchId: 1,
    receiptId: 903,
    amount: "50.00",
    entryDate: "2026-08-15",
    dedupeKey: "CASH_DROP:router-source-50",
    createdBy: 4,
  }]);
});

describe("shift funding router — owner request and target-only response", () => {
  it("يرفض غير المالك قبل الكتابة، ويعرض الطلب لصاحب الوردية وحده ثم يقبله", async () => {
    const payload = {
      shiftId: 201,
      amount: "200.00",
      evidenceNote: "عهدة إضافية لتغطية مصروفات الوردية",
      sourceTreasuryReceiptId: 902,
      clientRequestId: "router-funding-201",
    };
    await expect(
      appRouter.createCaller(context(3, "manager", false)).shifts.requestFunding(payload),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      appRouter.createCaller(context(3, "manager", false)).shifts.fundingSources({ targetShiftId: 201 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await appRouter.createCaller(context(1, "admin", true)).shifts.fundingSources({ targetShiftId: 201 }),
    ).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ receiptId: 902, sourceShiftId: 202, amount: "200.00" }),
        ]),
      }),
    );
    expect(await db().select().from(s.receipts).where(like(s.receipts.referenceNumber, "STF-%"))).toHaveLength(0);

    const request = await appRouter
      .createCaller(context(1, "admin", true))
      .shifts.requestFunding(payload);
    expect(request.status).toBe("PENDING");
    expect(
      await appRouter.createCaller(context(1, "admin", true)).shifts.fundingOutgoing(),
    ).toEqual([expect.objectContaining({ requestReceiptId: request.requestReceiptId })]);
    expect(await appRouter.createCaller(context(2, "cashier")).shifts.fundingRequests()).toHaveLength(1);
    expect(await appRouter.createCaller(context(4, "cashier")).shifts.fundingRequests()).toHaveLength(0);
    await expect(
      appRouter.createCaller(context(4, "cashier")).shifts.respondFunding({
        requestReceiptId: request.requestReceiptId,
        decision: "ACCEPT",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const accepted = await appRouter.createCaller(context(2, "cashier")).shifts.respondFunding({
      requestReceiptId: request.requestReceiptId,
      decision: "ACCEPT",
    });
    expect(accepted).toMatchObject({ status: "COMPLETED", drawerBalanceAfter: "300.00" });
    expect(
      await appRouter.createCaller(context(1, "admin", true)).shifts.fundingOutgoing(),
    ).toHaveLength(0);
    expect(await appRouter.createCaller(context(2, "cashier")).shifts.fundingRequests()).toHaveLength(0);
    const [requestRow] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.requestReceiptId));
    expect(requestRow).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED", approvedBy: 2 });
  });

  it("يلزم سبباً عند رفض النقد ولا يحوّل طريقة أو مبلغ الطلب", async () => {
    const request = await appRouter.createCaller(context(1, "admin", true)).shifts.requestFunding({
      shiftId: 201,
      amount: "50.00",
      evidenceNote: "عهدة سيجري رفضها لعدم التسليم",
      sourceTreasuryReceiptId: 904,
      clientRequestId: "router-funding-reject",
    });
    await expect(
      appRouter.createCaller(context(2, "cashier")).shifts.respondFunding({
        requestReceiptId: request.requestReceiptId,
        decision: "REJECT",
        rejectionReason: "لا",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const rejected = await appRouter.createCaller(context(2, "cashier")).shifts.respondFunding({
      requestReceiptId: request.requestReceiptId,
      decision: "REJECT",
      rejectionReason: "لم أستلم النقد",
    });
    expect(rejected.status).toBe("FAILED");
    const [row] = await db().select().from(s.receipts).where(eq(s.receipts.id, request.requestReceiptId));
    expect(row).toMatchObject({ amount: "50.00", paymentMethod: "CASH", cashBucket: null, status: "FAILED", approvalStatus: "REJECTED" });
    expect(
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SHIFT_FLOAT_OUT")),
    ).toHaveLength(0);

    const reissued = await appRouter.createCaller(context(1, "admin", true)).shifts.requestFunding({
      shiftId: 201,
      amount: "50.00",
      evidenceNote: "طلب بديل سيُلغيه المالك قبل التسليم",
      sourceTreasuryReceiptId: 904,
      clientRequestId: "router-funding-owner-cancel",
    });
    await expect(
      appRouter.createCaller(context(1, "admin", true)).shifts.cancelFunding({
        requestReceiptId: reissued.requestReceiptId,
        cancellationReason: "لا",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const cancelled = await appRouter.createCaller(context(1, "admin", true)).shifts.cancelFunding({
      requestReceiptId: reissued.requestReceiptId,
      cancellationReason: "تعذر تسليم النقد فعلياً",
    });
    expect(cancelled.status).toBe("FAILED");
    expect(
      await appRouter.createCaller(context(1, "admin", true)).shifts.fundingSources({ targetShiftId: 201 }),
    ).toEqual(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ receiptId: 904 })]),
    }));
  });
});
