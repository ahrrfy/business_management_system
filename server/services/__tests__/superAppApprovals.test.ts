import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "giftVoucherLines",
  "giftVouchers",
  "leaveRequests",
  "employees",
  "receipts",
  "stockAdjustmentRequests",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES)
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "approvals-admin",
        name: "منشئ الطلب",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "approvals-manager-1",
        name: "مدير الفرع الأول",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "approvals-manager-2",
        name: "مدير الفرع الثاني",
        role: "manager",
        loginMethod: "local",
        branchId: 2,
      },
      {
        id: 4,
        openId: "approvals-cashier",
        name: "كاشير",
        role: "cashier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db().insert(s.products).values({ id: 1, name: "منتج اختبار" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "APPROVAL-SKU",
    variantName: "افتراضي",
    costPrice: "10.00",
  });
  await db()
    .insert(s.branchStock)
    .values([
      { branchId: 1, variantId: 1, quantity: 5 },
      { branchId: 2, variantId: 1, quantity: 5 },
    ]);
  await db()
    .insert(s.stockAdjustmentRequests)
    .values([
      {
        id: 1,
        variantId: 1,
        branchId: 1,
        targetQuantity: 6,
        expectedQuantity: 5,
        notes: "[COST_SNAPSHOT:10.00]\nالأول",
        status: "PENDING_APPROVAL",
        createdBy: 1,
        createdAt: new Date("2026-08-06T09:00:00.000Z"),
      },
      {
        id: 2,
        variantId: 1,
        branchId: 1,
        targetQuantity: 7,
        expectedQuantity: 5,
        notes: "[COST_SNAPSHOT:10.00]\nالثاني",
        status: "PENDING_APPROVAL",
        createdBy: 1,
        createdAt: new Date("2026-08-06T10:00:00.000Z"),
      },
      {
        id: 3,
        variantId: 1,
        branchId: 1,
        targetQuantity: 8,
        expectedQuantity: 5,
        notes: "[COST_SNAPSHOT:10.00]\nالثالث",
        status: "PENDING_APPROVAL",
        createdBy: 1,
        createdAt: new Date("2026-08-06T11:00:00.000Z"),
      },
      {
        id: 4,
        variantId: 1,
        branchId: 2,
        targetQuantity: 9,
        expectedQuantity: 5,
        notes: "[COST_SNAPSHOT:10.00]\nفرع آخر",
        status: "PENDING_APPROVAL",
        createdBy: 1,
        createdAt: new Date("2026-08-06T12:00:00.000Z"),
      },
    ]);
  await db()
    .insert(s.giftVouchers)
    .values({
      id: 1,
      giftNumber: "GIFT-PENDING-1",
      direction: "OUT",
      branchId: 1,
      status: "PENDING_APPROVAL",
      totalCost: "25.00",
      reason: "عينة ترويجية",
      createdBy: 1,
      createdAt: new Date("2026-08-06T08:00:00.000Z"),
    });
}

function makeCtx(user: typeof s.users.$inferSelect) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as never;
}

async function caller(userId: number) {
  const [user] = await db()
    .select()
    .from(s.users)
    .where(eq(s.users.id, userId))
    .limit(1);
  return appRouter.createCaller(makeCtx(user));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe.sequential("superApp approvals contract", () => {
  it("paginates a stable branch-scoped stream without overlap", async () => {
    const manager = await caller(2);
    const first = await manager.superApp.approvalInbox({ limit: 2, offset: 0 });
    const second = await manager.superApp.approvalInbox({
      limit: 2,
      offset: 2,
    });

    expect(first.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "inventory:3",
      "inventory:2",
    ]);
    expect(second.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "inventory:1",
      "gift:1",
    ]);
    expect(
      new Set([...first, ...second].map((item) => `${item.kind}:${item.id}`))
        .size,
    ).toBe(4);

    const otherBranch = await (
      await caller(3)
    ).superApp.approvalInbox({ limit: 10, offset: 0 });
    expect(otherBranch.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "inventory:4",
    ]);
  });

  it("does not expose approvals to a role without full domain permission", async () => {
    const cashier = await caller(4);
    await expect(cashier.superApp.approvalInbox()).resolves.toEqual([]);
    await expect(
      cashier.superApp.approvalDetail({ kind: "inventory", id: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns a scoped detail and explicit truthful action capabilities", async () => {
    const manager = await caller(2);
    const inventory = await manager.superApp.approvalDetail({
      kind: "inventory",
      id: 1,
    });
    expect(inventory.kind).toBe("inventory");
    expect(inventory.capabilities).toMatchObject({
      canApprove: true,
      canReject: true,
      rejectionReason: "required",
      supportsClientRequestId: false,
      duplicatePolicy: "state_transition_guard",
    });

    const gift = await manager.superApp.approvalDetail({ kind: "gift", id: 1 });
    expect(gift.capabilities).toMatchObject({
      canApprove: true,
      canReject: false,
      rejectionReason: "not_supported",
    });

    await expect(
      manager.superApp.approvalDetail({ kind: "inventory", id: 4 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("domain state guard makes a double approval apply only once", async () => {
    const manager = await caller(2);
    await expect(
      manager.inventory.approveAdjustment({ id: 1 }),
    ).resolves.toBeTruthy();
    await expect(
      manager.inventory.approveAdjustment({ id: 1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const movements = await db()
      .select({ id: s.inventoryMovements.id })
      .from(s.inventoryMovements)
      .where(
        and(
          eq(s.inventoryMovements.variantId, 1),
          eq(s.inventoryMovements.movementType, "ADJUST"),
        ),
      );
    expect(movements).toHaveLength(1);
    await expect(
      manager.superApp.approvalDetail({ kind: "inventory", id: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects pagination outside the documented 500-item window", async () => {
    const manager = await caller(2);
    await expect(
      manager.superApp.approvalInbox({ limit: 50, offset: 451 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
