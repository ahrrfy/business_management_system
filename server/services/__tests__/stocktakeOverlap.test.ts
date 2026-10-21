import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { applyMovement, setStock } from "../inventoryService";
import {
  approveStocktake,
  approveStocktakeItems,
  cancelStocktakeSession,
  computeStocktakeReview,
  createStocktakeSession,
  firstSignStocktake,
  forceStocktakeReview,
  requestStocktakeRecount,
  resolveUnknownScan,
  syncActiveFullStocktakeScopes,
} from "../stocktakeService";

const actor = { userId: 1, role: "admin" };
const db = () => getDb()!;
async function session(
  ids = [1],
  branchId = 1,
  scopeType: "MANUAL" | "FULL" = "MANUAL",
) {
  return createStocktakeSession(
    {
      name: "اختبار منع التداخل",
      branchId,
      scopeType,
      variantIds: ids,
      thresholdPct: "100.00",
      thresholdValue: "1000000.00",
      dualThreshold: "1000000.00",
      assignments: [{ name: "العادّ", method: "PIN" }],
    },
    actor,
  );
}
async function count(
  stk: Awaited<ReturnType<typeof session>>,
  qty = 10,
  kind: "FIRST" | "RECOUNT" = "FIRST",
  age = 10_000,
) {
  await db()
    .insert(s.stocktakeCounts)
    .values({
      sessionId: stk.sessionId,
      variantId: 1,
      assignmentId: stk.assignments[0].assignmentId,
      qty,
      kind,
      countedByName: "العادّ",
      countedAt: new Date(Date.now() - age),
      clientRequestId: randomUUID(),
    });
}
async function legacySettlement(target = 10, opening = false) {
  const other = await session([2]);
  await db()
    .update(s.stocktakeItems)
    .set({ variantId: 1 })
    .where(eq(s.stocktakeItems.sessionId, other.sessionId));
  await withTx(async (tx) => {
    const r = await setStock(tx, {
      variantId: 1,
      branchId: 1,
      targetQuantity: target,
      referenceType: opening ? "OPENING" : "STOCKTAKE",
      referenceId: other.sessionId,
      createdBy: 1,
    });
    await tx
      .update(s.inventoryMovements)
      .set({ createdAt: new Date(Date.now() - 3000) })
      .where(eq(s.inventoryMovements.id, r.movementId));
    await tx
      .update(s.stocktakeSessions)
      .set({
        status: "APPROVED",
        approvedBy: 1,
        approvedAt: new Date(Date.now() - 3000),
        ...(opening ? { sessionType: "OPENING" as const } : {}),
      })
      .where(eq(s.stocktakeSessions.id, other.sessionId));
  });
  return other;
}
async function stock() {
  const [r] = await db()
    .select()
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
  return r.quantity;
}
async function approve(stk: Awaited<ReturnType<typeof session>>) {
  await approveStocktakeItems(
    { sessionId: stk.sessionId, variantIds: [1] },
    actor,
  );
  await forceStocktakeReview(stk.sessionId, actor);
  return approveStocktake(stk.sessionId, actor);
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS=0`);
  for (const table of [
    "stocktakeItemReviewEvents",
    "stocktakeDecisions",
    "stocktakeCountOperations",
    "stocktakeCounts",
    "stocktakeItems",
    "stocktakeAssignments",
    "stocktakeSessions",
    "inventoryMovements",
    "branchStock",
    "productUnits",
    "productVariants",
    "products",
    "accountingEntries",
    "users",
    "branches",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS=1`);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" },
      { id: 2, code: "OTHER", name: "الثاني", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "stocktake-overlap-admin",
      name: "المعتمد",
      role: "admin",
    });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "قلم" },
      { id: 2, name: "دفتر" },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "OVERLAP1", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "OVERLAP2", costPrice: "50.00" },
    ]);
  await db()
    .insert(s.productUnits)
    .values([
      {
        id: 1,
        variantId: 1,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
      {
        id: 2,
        variantId: 2,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
    ]);
  await withTx((tx) =>
    applyMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 100,
      movementType: "IN",
      createdBy: 1,
    }),
  );
  // Initial receipt predates the physical count; it must not be replayed by netAfter.
  await db().update(s.inventoryMovements).set({ createdAt: new Date(Date.now() - 60_000) });
});

describe("stocktake overlap integrity", () => {
  it("blocks unknown-scan scope growth into another active stocktake atomically", async () => {
    const a = await session(); await session([2]);
    await db().update(s.productUnits).set({ barcode: "OVERLAP-SCOPE-2" }).where(eq(s.productUnits.id, 2));
    await db().insert(s.stocktakeUnknownScans).values({ sessionId: a.sessionId, assignmentId: a.assignments[0].assignmentId, barcode: "OVERLAP-SCOPE-2", scannedByName: "العادّ" });
    await expect(resolveUnknownScan({ sessionId: a.sessionId, barcode: "OVERLAP-SCOPE-2", action: "ADD_TO_SCOPE" }, actor)).rejects.toThrow(/تداخل/);
    expect(await db().select().from(s.stocktakeItems).where(and(eq(s.stocktakeItems.sessionId, a.sessionId), eq(s.stocktakeItems.variantId, 2)))).toHaveLength(0);
    const [scan] = await db().select().from(s.stocktakeUnknownScans).where(eq(s.stocktakeUnknownScans.sessionId, a.sessionId));
    expect(scan.status).toBe("PENDING");
  });
  it.each(["KEEP", "ADJUST"] as const)("blocks a newer matching/KEEP approval without any movement (%s)", async action => {
    const a = await session(); await count(a);
    await approveStocktakeItems({ sessionId: a.sessionId, variantIds: [1] }, actor);
    await forceStocktakeReview(a.sessionId, actor);
    const b = await session([2]);
    await db().update(s.stocktakeItems).set({ variantId: 1 }).where(eq(s.stocktakeItems.sessionId, b.sessionId));
    await db().insert(s.stocktakeDecisions).values({ sessionId: b.sessionId, variantId: 1, action, finalQty: 100, diffQty: 0, value: "0.00", decidedBy: 1 });
    await db().update(s.stocktakeSessions).set({ status: "APPROVED", approvedBy: 1, approvedAt: new Date(Date.now() - 3000) }).where(eq(s.stocktakeSessions.id, b.sessionId));
    const review = await computeStocktakeReview(a.sessionId);
    expect(review.rows[0].interveningStocktake?.sessionId).toBe(b.sessionId);
    expect(review.rows[0].reviewApproved?.isCurrent).toBe(false);
    await expect(approveStocktake(a.sessionId, actor)).rejects.toThrow(/جرد أحدث/);
    expect(await stock()).toBe(100);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });
  it("rejects same variant/branch in COUNTING and REVIEW without inserting a session", async () => {
    const a = await session();
    await expect(session()).rejects.toThrow(/تداخل/);
    await count(a);
    await forceStocktakeReview(a.sessionId, actor);
    await expect(session()).rejects.toThrow(/تداخل/);
    expect(await db().select().from(s.stocktakeSessions)).toHaveLength(1);
  });
  it("allows separate variants and branches, and reusing a cancelled scope", async () => {
    const a = await session();
    await session([2]);
    await session([1], 2);
    await cancelStocktakeSession({ sessionId: a.sessionId }, actor);
    await expect(session()).resolves.toBeDefined();
  });
  it("serializes simultaneous creation so only one overlapping scope commits", async () => {
    const r = await Promise.allSettled([session(), session()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
  });
  it("rejects active legacy overlapping scopes at final approval atomically", async () => {
    const a = await session();
    await count(a);
    await approveStocktakeItems(
      { sessionId: a.sessionId, variantIds: [1] },
      actor,
    );
    await forceStocktakeReview(a.sessionId, actor);
    const b = await session([2]);
    await db()
      .update(s.stocktakeItems)
      .set({ variantId: 1 })
      .where(eq(s.stocktakeItems.sessionId, b.sessionId));
    await expect(approveStocktake(a.sessionId, actor)).rejects.toThrow(/تداخل/);
    expect(await stock()).toBe(100);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });
  it.each([false, true])(
    "invalidates old review and blocks even a stored first signature after another settlement (opening=%s)",
    async (opening) => {
      const a = await session();
      await count(a);
      await approveStocktakeItems(
        { sessionId: a.sessionId, variantIds: [1] },
        actor,
      );
      await forceStocktakeReview(a.sessionId, actor);
      await legacySettlement(10, opening);
      await db()
        .update(s.stocktakeSessions)
        .set({ firstSignBy: 1, firstSignAt: new Date() })
        .where(eq(s.stocktakeSessions.id, a.sessionId));
      const review = await computeStocktakeReview(a.sessionId);
      expect(review.rows[0].interveningStocktake).not.toBeNull();
      expect(review.rows[0].reviewApproved?.isCurrent).toBe(false);
      expect(review.rows[0].readyForReviewApproval).toBe(false);
      expect(review.barriers.canApprove).toBe(false);
      await expect(firstSignStocktake(a.sessionId, actor)).rejects.toThrow(
        /تداخل/,
      );
      await expect(approveStocktake(a.sessionId, actor)).rejects.toThrow(
        /جرد أحدث/,
      );
      expect(await stock()).toBe(10);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    },
  );
  it("recovers through explicit recount/review and commits one real delta with idempotent replay", async () => {
    const a = await session();
    await count(a);
    await legacySettlement();
    await requestStocktakeRecount(
      { sessionId: a.sessionId, variantId: 1, reason: "جرد أحدث غيّر الأساس" },
      actor,
    );
    await count(a, 12, "RECOUNT", 1000);
    await db()
      .update(s.stocktakeItems)
      .set({ recountStatus: "DONE" })
      .where(eq(s.stocktakeItems.sessionId, a.sessionId));
    await approve(a);
    expect(await stock()).toBe(12);
    const before = await db().select().from(s.accountingEntries);
    await approveStocktake(a.sessionId, actor);
    expect(await stock()).toBe(12);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      before.length,
    );
    expect(before).toHaveLength(1);
    expect(before[0].dedupeKey).toBe(`STOCKTAKE:${a.sessionId}:OVER`);
    expect(before[0].profit).toBe("200.00");
  });
  it("preserves operational purchase/sale movements after count and accounting loss", async () => {
    const a = await session();
    await count(a);
    await withTx(async (tx) => {
      await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 20,
        movementType: "IN",
        referenceType: "GOODS_RECEIPT",
        createdBy: 1,
      });
      await applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 3,
        movementType: "OUT",
        referenceType: "INVOICE",
        createdBy: 1,
      });
    });
    await approve(a);
    expect(await stock()).toBe(27);
    const [entry] = await db().select().from(s.accountingEntries);
    expect(entry.cost).toBe("9000.00");
    expect(entry.profit).toBe("-9000.00");
  });
  it("does not extend a legacy FULL scope into another session's active variant", async () => {
    await session([1], 1, "FULL");
    const owner = await session([1], 2);
    await db()
      .update(s.stocktakeSessions)
      .set({ branchId: 1 })
      .where(eq(s.stocktakeSessions.id, owner.sessionId));
    await db()
      .update(s.stocktakeItems)
      .set({ variantId: 2, branchId: 1 })
      .where(eq(s.stocktakeItems.sessionId, owner.sessionId));
    const full = (
      await db()
        .select()
        .from(s.stocktakeSessions)
        .where(eq(s.stocktakeSessions.scopeType, "FULL"))
    )[0];
    await db()
      .delete(s.stocktakeItems)
      .where(
        and(
          eq(s.stocktakeItems.sessionId, full.id),
          eq(s.stocktakeItems.variantId, 2),
        ),
      );
    await syncActiveFullStocktakeScopes();
    expect(
      await db()
        .select()
        .from(s.stocktakeItems)
        .where(
          and(
            eq(s.stocktakeItems.sessionId, full.id),
            eq(s.stocktakeItems.variantId, 2),
          ),
        ),
    ).toHaveLength(0);
  });
});
