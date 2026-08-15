import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = ["auditLogs", "idempotencyKeys", "accountingEntries", "receipts", "suppliers", "branches", "users"];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

function context(user: typeof s.users.$inferSelect) {
  return {
    req: { headers: {}, id: `cash-out-s2-${user.id}` },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

async function user(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0]!;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "api-maker-manager", name: "منشئ", role: "manager", branchId: 1, isOwner: false },
    { id: 2, openId: "api-maker-owner", name: "مالك منشئ", role: "admin", branchId: 1, isOwner: true },
    { id: 3, openId: "api-owner-approver", name: "مالك معتمد", role: "manager", branchId: 1, isOwner: true },
  ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "5000000.00" });
  await db().insert(s.receipts).values({
    branchId: 1, direction: "IN", amount: "3000000.00", paymentMethod: "CASH",
    cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
    referenceNumber: "S2-API-FUND", createdBy: 3,
  });
});

describe("voucher router — عقد PAYMENT/OUT", () => {
  it("كل مبلغ ومنشئ مخوّل يرجع PENDING، ومالك مختلف ينفذ TREASURY مرة واحدة", async () => {
    const maker = appRouter.createCaller(context(await user(1)));
    const ownerMaker = appRouter.createCaller(context(await user(2)));
    const approver = appRouter.createCaller(context(await user(3)));

    const small = await maker.vouchers.create({
      voucherType: "PAYMENT", branchId: 1, amount: "1.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "دفعة صغيرة",
      clientRequestId: "api-out-small",
    });
    const largeByOwner = await ownerMaker.vouchers.create({
      voucherType: "PAYMENT", branchId: 1, amount: "2000000.00", paymentMethod: "CASH",
      partyType: "SUPPLIER", partyId: 1, description: "دفعة كبيرة أنشأها مالك",
      clientRequestId: "api-out-owner-large",
    });

    expect(small.approvalStatus).toBe("PENDING_APPROVAL");
    expect(largeByOwner.approvalStatus).toBe("PENDING_APPROVAL");
    const pendingRows = await db().select().from(s.receipts).where(eq(s.receipts.approvalStatus, "PENDING_APPROVAL"));
    expect(pendingRows).toHaveLength(2);
    expect(pendingRows.every((row) => row.cashBucket == null && row.shiftId == null)).toBe(true);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]!.currentBalance).toBe("5000000.00");

    const first = await approver.vouchers.approve({ receiptId: small.receiptId });
    const second = await approver.vouchers.approve({ receiptId: largeByOwner.receiptId });
    const replay = await approver.vouchers.approve({ receiptId: largeByOwner.receiptId });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(replay.replayed).toBe(true);

    const approved = await db().select().from(s.receipts).where(and(
      eq(s.receipts.direction, "OUT"), eq(s.receipts.approvalStatus, "APPROVED"),
    ));
    expect(approved).toHaveLength(2);
    expect(approved.every((row) => row.cashBucket === "TREASURY" && row.shiftId == null)).toBe(true);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"))).toHaveLength(2);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]!.currentBalance).toBe("2999999.00");
    expect(await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "voucher.approve"))).toHaveLength(2);
  });
});
