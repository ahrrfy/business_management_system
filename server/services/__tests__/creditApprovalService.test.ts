import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createApproval, consumeApproval, getActiveApprovalsForCustomer, validateApproval } from "../creditApprovalService";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  await truncateTables(["creditApprovals", "invoices", "customers", "branches", "users"]);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({ id: 1, name: "عميل ١", defaultPriceTier: "RETAIL" });
  await d.insert(s.customers).values({ id: 2, name: "عميل ٢", defaultPriceTier: "RETAIL" });
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("creditApprovalService — B5: ربط الموافقة بـ(customer, amount, expiry, single-use)", () => {
  it("createApproval ينشئ صفّاً صالحاً", async () => {
    const r = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1, ttlMinutes: 30 }));
    expect(r.id).toBeGreaterThan(0);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("createApproval يرفض maxAmount ≤ 0", async () => {
    await expect(
      withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "0", approvedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "-100", approvedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("createApproval يرفض عميلاً غير موجود (NOT_FOUND) أو معطَّلاً (BAD_REQUEST) — تدقيق ١٧/٧", async () => {
    await expect(
      withTx(async (tx) => createApproval(tx, { customerId: 999, maxAmount: "500.00", approvedBy: 1 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().update(s.customers).set({ isActive: false }).where(eq(s.customers.id, 2));
    await expect(
      withTx(async (tx) => createApproval(tx, { customerId: 2, maxAmount: "500.00", approvedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("validateApproval يقبل موافقة سليمة + ضمن السقف", async () => {
    const app = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1 }));
    const r = await withTx(async (tx) => validateApproval(tx, app.id, 1, money("400")));
    expect(r.id).toBe(app.id);
    expect(r.customerId).toBe(1);
  });

  it("validateApproval يرفض customer mismatch", async () => {
    const app = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1 }));
    await expect(
      withTx(async (tx) => validateApproval(tx, app.id, 2, money("400"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validateApproval يرفض تجاوز maxAmount", async () => {
    const app = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1 }));
    await expect(
      withTx(async (tx) => validateApproval(tx, app.id, 1, money("500.01"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validateApproval يرفض موافقة منتهية", async () => {
    // أنشئ موافقة منتهية يدوياً
    const d = db();
    const res = await d.insert(s.creditApprovals).values({
      customerId: 1, maxAmount: "500.00", approvedBy: 1,
      expiresAt: new Date(Date.now() - 60_000), // منذ دقيقة
    });
    const id = getInsertId(res);
    await expect(
      withTx(async (tx) => validateApproval(tx, id, 1, money("100"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validateApproval يرفض موافقة مُستَهلَكة (consumed)", async () => {
    const app = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1 }));
    // أنشئ فاتورة وهمية لربط الاستهلاك بها
    const d = db();
    const inv = await d.insert(s.invoices).values({
      invoiceNumber: "TEST-1", sourceType: "ORDER", branchId: 1, customerId: 1,
      subtotal: "100", taxAmount: "0", discountAmount: "0", total: "100",
      costTotal: "50", status: "PENDING", paidAmount: "0", createdBy: 1,
    });
    const invId = getInsertId(inv);
    await withTx(async (tx) => consumeApproval(tx, app.id, invId));
    await expect(
      withTx(async (tx) => validateApproval(tx, app.id, 1, money("100"))),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validateApproval يرفض id غير موجود", async () => {
    await expect(
      withTx(async (tx) => validateApproval(tx, 99999, 1, money("100"))),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getActiveApprovalsForCustomer لا يرجع المستَهلَكة/المنتهية", async () => {
    const active = await withTx(async (tx) => createApproval(tx, { customerId: 1, maxAmount: "500.00", approvedBy: 1 }));
    // منتهية
    const d = db();
    await d.insert(s.creditApprovals).values({
      customerId: 1, maxAmount: "100.00", approvedBy: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const rows = await withTx(async (tx) => getActiveApprovalsForCustomer(tx, 1));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].id)).toBe(active.id);
  });
});
