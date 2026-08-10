import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { scopedCreditApprovalRequestId } from "../../routers/creditApprovalRouter";
import { truncateTables } from "./__testUtils__";

const TABLES = ["auditLogs", "idempotencyKeys", "creditApprovals", "invoices", "customers", "users", "branches"];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seed() {
  const database = db();
  await database.insert(schema.branches).values([
    { id: 1, name: "فرع واحد", code: "CAP-B1", type: "MAIN" },
    { id: 2, name: "فرع اثنان", code: "CAP-B2", type: "SALES" },
  ]);
  await database.insert(schema.users).values([
    { id: 10, openId: "cap-admin", name: "مالك", role: "admin", branchId: null },
    { id: 11, openId: "cap-manager-1", name: "مدير 1", role: "manager", branchId: 1 },
    { id: 12, openId: "cap-manager-2", name: "مدير 2", role: "manager", branchId: 2 },
    { id: 13, openId: "cap-manager-none", name: "مدير بلا فرع", role: "manager", branchId: null },
    { id: 14, openId: "cap-cashier", name: "كاشير", role: "cashier", branchId: 1 },
  ]);
  await database.insert(schema.customers).values([
    { id: 101, name: "عميل جديد", currentBalance: "0", isActive: true },
    { id: 102, name: "عميل فرع اثنين", currentBalance: "20", isActive: true },
  ]);
  await database.execute(sql`
    INSERT INTO invoices (invoiceNumber, sourceType, branchId, customerId, subtotal, total, costTotal, invoiceStatus)
    VALUES ('CAP-INV-B2', 'ORDER', 2, 102, 10, 10, 0, 'PAID')
  `);
}

async function caller(userId: number) {
  const [user] = await db().select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  const context = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    sessionId: null,
    platformAdmin: null,
    user,
  } as unknown as TrpcContext;
  return appRouter.createCaller(context);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("creditApproval router — idempotency and branch policy", () => {
  it("replays one scoped request and rejects a changed payload", async () => {
    const manager = await caller(11);
    const clientRequestId = "e8ca3a66-b8df-4f76-944d-1472693b1092";
    const first = await manager.creditApproval.create({
      customerId: 101,
      branchId: 1,
      maxAmount: "500.00",
      ttlMinutes: 60,
      clientRequestId,
    });
    const replay = await manager.creditApproval.create({
      customerId: 101,
      branchId: 1,
      maxAmount: "500.00",
      ttlMinutes: 60,
      clientRequestId,
    });
    expect(replay.id).toBe(first.id);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    await expect(manager.creditApproval.create({
      customerId: 101,
      branchId: 1,
      maxAmount: "501.00",
      ttlMinutes: 60,
      clientRequestId,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await db().select().from(schema.creditApprovals);
    expect(rows).toHaveLength(1);
  });

  it("scopes the same UUID by company/user/branch", async () => {
    const raw = "6b2ce5a9-b173-4daa-8730-49ce8be2f6d3";
    expect(scopedCreditApprovalRequestId({ companyId: 1, userId: 11, branchId: 1, clientRequestId: raw }))
      .not.toBe(scopedCreditApprovalRequestId({ companyId: 2, userId: 11, branchId: 1, clientRequestId: raw }));
    expect(scopedCreditApprovalRequestId({ companyId: 1, userId: 11, branchId: 1, clientRequestId: raw }))
      .not.toBe(scopedCreditApprovalRequestId({ companyId: 1, userId: 12, branchId: 1, clientRequestId: raw }));
  });

  it("pins managers to their branch and fails branchless managers closed", async () => {
    const manager1 = await caller(11);
    const manager2 = await caller(12);
    const branchless = await caller(13);
    await expect(manager1.creditApproval.create({
      customerId: 101,
      branchId: 2,
      maxAmount: "100",
      clientRequestId: "f55e2376-8d57-4c84-b14a-c31ce32568d0",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.creditApproval.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchless.creditApproval.create({
      customerId: 101,
      maxAmount: "100",
      clientRequestId: "97479437-100a-4599-b861-e34be9ae42bc",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await manager2.creditApproval.create({
      customerId: 101,
      branchId: 2,
      maxAmount: "100",
      clientRequestId: "a125decb-3200-48b4-8eae-597831359766",
    });
    expect((await manager1.creditApproval.list()).rows).toHaveLength(0);
    expect((await manager2.creditApproval.list()).rows.map((row) => row.id)).toEqual([created.id]);
    await expect(manager1.creditApproval.cancel({ id: created.id, reason: "قرار يخص فرعاً آخر" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns only new or branch-associated customers to a branch manager", async () => {
    const manager1 = await caller(11);
    const manager2 = await caller(12);
    expect((await manager1.creditApproval.customerOptions({ branchId: 1 })).rows.map((row) => row.id)).toEqual([101]);
    expect((await manager2.creditApproval.customerOptions({ branchId: 2 })).rows.map((row) => row.id).sort()).toEqual([101, 102]);
  });
});
