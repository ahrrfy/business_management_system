import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { loadMovementStocktakeSources } from "../inventory/movementSources";

const db = () => {
  const value = getDb();
  if (!value) throw new Error("Test database unavailable");
  return value;
};

async function caller(userId = 1) {
  const [user] = await db()
    .select()
    .from(s.users)
    .where(eq(s.users.id, userId));
  return appRouter.createCaller({
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any);
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "source-approver",
        name: "المعتمد النهائي",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "source-decider",
        name: "صاحب قرار الفرق",
        role: "manager",
        branchId: 1,
      },
      {
        id: 3,
        openId: "source-counter",
        name: "العاد الأول",
        role: "warehouse",
        branchId: 1,
      },
      {
        id: 4,
        openId: "source-cashier",
        name: "الكاشير",
        role: "cashier",
        branchId: 1,
      },
    ]);
  await db().insert(s.products).values({ id: 1, name: "ممحاة" });
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "SOURCE-1", costPrice: "100.00" },
      { id: 2, productId: 1, sku: "SOURCE-2", costPrice: "100.00" },
    ]);
  await db()
    .insert(s.stocktakeSessions)
    .values([
      {
        id: 1,
        code: "ST-SOURCE-1",
        name: "دوري",
        branchId: 1,
        scopeType: "MANUAL",
        status: "APPROVED",
        approvedBy: 1,
      },
      {
        id: 2,
        code: "ST-SOURCE-2",
        name: "افتتاحي",
        branchId: 1,
        scopeType: "MANUAL",
        sessionType: "OPENING",
        status: "APPROVED",
        approvedBy: 1,
      },
      {
        id: 3,
        code: "ST-SOURCE-3",
        name: "الفرع الثاني",
        branchId: 2,
        scopeType: "MANUAL",
        status: "APPROVED",
        approvedBy: 1,
      },
      {
        id: 4,
        code: "ST-SOURCE-4",
        name: "غير معتمد",
        branchId: 1,
        scopeType: "MANUAL",
        sessionType: "OPENING",
        status: "REVIEW",
      },
    ]);
  await db()
    .insert(s.stocktakeAssignments)
    .values(
      [1, 2, 3, 4].map((id) => ({
        id,
        sessionId: id,
        name: "المجموعة",
        method: "USER" as const,
        userId: 3,
      })),
    );
  await db()
    .insert(s.stocktakeItems)
    .values(
      [1, 2, 3, 4].map((sessionId) => ({
        sessionId,
        assignmentId: sessionId,
        variantId: 1,
        branchId: sessionId === 3 ? 2 : 1,
        expectedQty: 10,
        unitCost: "100.00",
      })),
    );
  await db()
    .insert(s.stocktakeCounts)
    .values({
      sessionId: 1,
      assignmentId: 1,
      variantId: 1,
      kind: "FIRST",
      qty: 9,
      countedByName: "العاد الأول",
      countedByUserId: 3,
      countedAt: new Date("2026-10-20T09:00:00Z"),
    });
  await db().insert(s.stocktakeDecisions).values({
    sessionId: 1,
    variantId: 1,
    action: "ADJUST",
    decidedBy: 2,
    autoApplied: false,
  });
});

afterEach(() => vi.restoreAllMocks());

async function movement(
  values: Partial<typeof s.inventoryMovements.$inferInsert> = {},
) {
  await db()
    .insert(s.inventoryMovements)
    .values({
      variantId: 1,
      branchId: 1,
      movementType: "ADJUST",
      quantity: 1,
      signedDelta: -1,
      referenceType: "STOCKTAKE",
      referenceId: 1,
      documentNumber: "ST-SOURCE-1",
      createdBy: 1,
      ...values,
    });
}

describe("inventory movement stocktake provenance", () => {
  it("distinguishes final approver, counter and row decision maker for inventory readers", async () => {
    await movement();
    const expected = {
      sessionId: 1,
      code: "ST-SOURCE-1",
      sessionType: "NORMAL",
      approvedByName: "المعتمد النهائي",
      countedByName: "العاد الأول",
      decidedByName: "صاحب قرار الفرق",
      autoApplied: false,
    };
    for (const userId of [1, 2, 3, 4]) {
      const result = await (await caller(userId)).inventory.movementsRich({});
      expect(result.rows[0].createdByName).toBe("المعتمد النهائي");
      expect(result.rows[0].stocktakeSource).toEqual(expected);
    }
  });

  it("uses the selected conflicting VERIFY and then the latest RECOUNT, matching reviewCore", async () => {
    await movement();
    await db()
      .insert(s.stocktakeCounts)
      .values({
        sessionId: 1,
        assignmentId: 1,
        variantId: 1,
        kind: "VERIFY",
        qty: 8,
        countedByName: "العد التحققي المختار",
        isConflict: true,
        resolvedPick: "VERIFY",
        countedAt: new Date("2026-10-20T10:00:00Z"),
      });
    const admin = await caller();
    expect(
      (await admin.inventory.movementsRich({})).rows[0].stocktakeSource
        ?.countedByName,
    ).toBe("العد التحققي المختار");
    await db()
      .insert(s.stocktakeCounts)
      .values([
        {
          sessionId: 1,
          assignmentId: 1,
          variantId: 1,
          kind: "RECOUNT",
          qty: 7,
          countedByName: "إعادة أقدم",
          countedAt: new Date("2026-10-20T11:00:00Z"),
        },
        {
          sessionId: 1,
          assignmentId: 1,
          variantId: 1,
          kind: "RECOUNT",
          qty: 6,
          countedByName: "إعادة نهائية",
          countedAt: new Date("2026-10-20T11:00:00Z"),
        },
        {
          sessionId: 1,
          assignmentId: 1,
          variantId: 1,
          kind: "VERIFY",
          qty: 5,
          countedByName: "تحقق لاحق",
          countedAt: new Date("2026-10-20T12:00:00Z"),
        },
      ]);
    expect(
      (await admin.inventory.movementsRich({})).rows[0].stocktakeSource
        ?.countedByName,
    ).toBe("إعادة نهائية");
  });

  it("reports automatic decisions without attributing them to the final approver", async () => {
    await movement();
    await db()
      .update(s.stocktakeDecisions)
      .set({ autoApplied: true, decidedBy: null })
      .where(eq(s.stocktakeDecisions.sessionId, 1));
    const { rows } = await (await caller()).inventory.movementsRich({});
    expect(rows[0].stocktakeSource).toMatchObject({
      autoApplied: true,
      decidedByName: null,
      approvedByName: "المعتمد النهائي",
    });
  });

  it("recognizes opening stocktakes only with an approved matching session, branch and item", async () => {
    await movement({
      referenceType: "OPENING",
      referenceId: 2,
      documentNumber: "ST-SOURCE-2",
    });
    await movement({ referenceType: "OPENING", referenceId: 1 }); // Normal session ID collision.
    await movement({ referenceType: "OPENING", referenceId: null }); // Product/import opening.
    await movement({ referenceType: "OPENING", referenceId: 999999 });
    await movement({ referenceType: "OPENING", referenceId: 2, branchId: 2 });
    await movement({ referenceType: "OPENING", referenceId: 2, variantId: 2 });
    await movement({ referenceType: "OPENING", referenceId: 4 }); // Unapproved session.
    await movement({ referenceType: "ADJUST", referenceId: 1 }); // Manual approved adjustment.
    const { rows } = await (await caller()).inventory.movementsRich({});
    expect(rows.filter((r) => r.stocktakeSource)).toHaveLength(1);
    expect(rows.find((r) => r.stocktakeSource)?.stocktakeSource).toMatchObject({
      sessionId: 2,
      sessionType: "OPENING",
      countedByName: null,
      autoApplied: null,
    });
  });

  it("preserves branch isolation and offset/cursor pagination for source metadata", async () => {
    await movement();
    await movement({
      branchId: 2,
      referenceId: 3,
      documentNumber: "ST-SOURCE-3",
    });
    const admin = await caller();
    const first = await admin.inventory.movementsRich({ limit: 1 });
    expect(first.rows[0].stocktakeSource?.sessionId).toBe(3);
    expect(first.hasMore).toBe(true);
    const next = await admin.inventory.movementsRich({
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(next.rows[0].stocktakeSource?.sessionId).toBe(1);
    const offset = await admin.inventory.movementsRich({ limit: 1, offset: 1 });
    expect(offset.rows[0].stocktakeSource).toEqual(
      next.rows[0].stocktakeSource,
    );
    const warehouse = await (
      await caller(3)
    ).inventory.movementsRich({ branchId: 2 });
    expect(warehouse.rows).toHaveLength(1);
    expect(warehouse.rows[0].stocktakeSource?.sessionId).toBe(1);
  });

  it("loads only supplied page rows with two batched queries and skips metadata queries for manual rows", async () => {
    await db()
      .insert(s.inventoryMovements)
      .values(
        Array.from({ length: 20 }, () => ({
          variantId: 1,
          branchId: 1,
          movementType: "ADJUST" as const,
          quantity: 1,
          referenceType: "STOCKTAKE",
          referenceId: 1,
        })),
      );
    await movement({ referenceId: 2, referenceType: "OPENING" });
    const pageRows = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceId, 1));
    const d = db();
    const select = vi.spyOn(d, "select");
    const selectDistinct = vi.spyOn(d, "selectDistinct");
    const source = await loadMovementStocktakeSources(d, pageRows);
    expect(source.size).toBe(20);
    expect([...source.values()].every((r) => r.sessionId === 1)).toBe(true);
    // One ranked subquery builder + one executable outer count query, regardless of row count.
    expect(select).toHaveBeenCalledTimes(2);
    expect(selectDistinct).toHaveBeenCalledTimes(1);
    select.mockClear();
    selectDistinct.mockClear();
    expect(
      await loadMovementStocktakeSources(d, [
        { id: 1, referenceType: "ADJUST", referenceId: 1 },
      ]),
    ).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
    expect(selectDistinct).not.toHaveBeenCalled();
  });
});
