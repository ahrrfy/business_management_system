import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { setBranchActive } from "../branchService";

const actor = { userId: 1, branchId: 1, role: "admin" };
function db() {
  const value = getDb();
  if (!value) throw new Error("Test DB required");
  return value;
}
beforeEach(async () => {
  await db().insert(s.branches).values([
    { id: 1, code: "MAIN", name: "Main", type: "MAIN" },
    { id: 2, code: "SALES", name: "Sales", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "audit-branch-admin", role: "admin", branchId: 1, isOwner: true });
  await db().insert(s.products).values([
    { id: 1, name: "Physical stock" },
    { id: 2, name: "Backorder stock", allowBackorder: true },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "AUDIT-BRANCH-A", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "AUDIT-BRANCH-B", costPrice: "100.00" },
  ]);
});
describe("branch deactivation stock contract", () => {
  it("rejects unlike SKU balances that offset numerically without changing branch or quantities", async () => {
    await db().insert(s.branchStock).values([
      { branchId: 2, variantId: 1, quantity: 10 },
      { branchId: 2, variantId: 2, quantity: -10 },
    ]);
    await expect(setBranchActive(2, false, actor)).rejects.toThrow(/مخزون/);
    const [branch] = await db().select().from(s.branches).where(eq(s.branches.id, 2));
    expect(branch.isActive).toBe(true);
    expect((await db().select().from(s.branchStock)).map(row => Number(row.quantity)).sort((a, b) => a - b)).toEqual([-10, 10]);
  });
  it("rejects an outstanding negative backorder as well as physical positive stock", async () => {
    await db().insert(s.branchStock).values({ branchId: 2, variantId: 2, quantity: -10 });
    await expect(setBranchActive(2, false, actor)).rejects.toThrow(/مخزون/);
    expect((await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0].isActive).toBe(true);
  });
  it("allows a branch whose individual SKU balances are all zero", async () => {
    await db().insert(s.branchStock).values([
      { branchId: 2, variantId: 1, quantity: 0 },
      { branchId: 2, variantId: 2, quantity: 0 },
    ]);
    await expect(setBranchActive(2, false, actor)).resolves.toEqual({ id: 2, isActive: false });
    expect((await db().select().from(s.branches).where(eq(s.branches.id, 2)))[0].isActive).toBe(false);
  });
});
