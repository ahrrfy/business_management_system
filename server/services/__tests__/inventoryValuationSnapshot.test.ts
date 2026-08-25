/**
 * P1-#2: لقطاتُ تقييم المخزون عند إقفال الفترة (تقرير المراجعة ٢٥/٨).
 *
 * الثابتُ المُتحقَّق: بعد إقفال الشهر يبقى تقييم أصل المخزون كما كان في تلك اللحظة، حتى لو
 * تغيّرت الأرصدة/التكاليف لاحقاً. المسار الحيّ (`readInventoryValuation`) يبقى للأصول الحاليّة؛
 * `readValuationAt(cutoffDate)` يفضّل اللقطة إن وُجدت، وإلّا يُوسَم LIVE (fallback شفّاف).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { applyMovement } from "../inventoryService";
import { captureCompanyValuationSnapshot, readValuationAt } from "../inventory/valuationSnapshot";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "inventoryValuationSnapshots",
  "financialPeriods",
  "inventoryMovements",
  "stockTransferLines",
  "stockTransfers",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" });
  await db().insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 4 },
  ]);
}

async function makePeriod(cutoffDate: string): Promise<number> {
  await db().insert(s.financialPeriods).values({
    cutoffDate,
    lockedBy: 1,
    status: "LOCKED",
  });
  // mysql2 returns insertId inconsistently across Drizzle versions — نقرأ الصفَّ المُدرَج مباشرةً.
  const [row] = await db()
    .select({ id: s.financialPeriods.id })
    .from(s.financialPeriods)
    .where(eq(s.financialPeriods.cutoffDate, cutoffDate))
    .limit(1);
  if (!row) throw new Error(`financialPeriod ${cutoffDate} did not persist`);
  return Number(row.id);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("captureCompanyValuationSnapshot", () => {
  it("يلتقط totalValue = stockValue + inTransitValue بلا حمل ⇒ ١٤٠٠", async () => {
    const periodId = await makePeriod("2020-08-31");
    const res = await withTx((tx) => captureCompanyValuationSnapshot(tx, {
      periodLockId: periodId,
      cutoffDate: "2020-08-31",
      capturedBy: 1,
    }));
    expect(res.totalValue).toBe("1400.00");
    expect(res.stockValue).toBe("1400.00");
    expect(res.inTransitValue).toBe("0.00");

    const row = (await db().select().from(s.inventoryValuationSnapshots).where(eq(s.inventoryValuationSnapshots.id, res.snapshotId)).limit(1))[0];
    expect(row.scopeKey).toBe("COMPANY");
    expect(row.branchId).toBeNull();
    expect(row.totalValue).toBe("1400.00");
    expect(row.branchesJson).toContain('"branchId":1');
    expect(row.branchesJson).toContain('"branchId":2');
  });

  it("قيدُ التفرّد يمنع لقطتَين للنطاق نفسه على نفس الفترة", async () => {
    const periodId = await makePeriod("2020-07-31");
    await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-07-31", capturedBy: 1 }));
    await expect(
      withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-07-31", capturedBy: 1 })),
    ).rejects.toThrow();
  });

  it("يشمل الحمل بالطريق (P1-#1) — stockValue vs inTransitValue متمايزَين", async () => {
    const d = db();
    await d.insert(s.stockTransfers).values({
      id: 1, transferNumber: "T-1", fromBranchId: 1, toBranchId: 2, status: "IN_TRANSIT", totalSentBase: 4, createdBy: 1,
    });
    await d.insert(s.stockTransferLines).values({ transferId: 1, variantId: 1, quantitySent: 4 });
    await d.execute(sql`UPDATE branchStock SET quantity = quantity - 4 WHERE variantId = 1 AND branchId = 1`);
    const periodId = await makePeriod("2020-08-31");
    const res = await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-08-31", capturedBy: 1 }));
    expect(res.stockValue).toBe("1000.00");
    expect(res.inTransitValue).toBe("400.00");
    expect(res.totalValue).toBe("1400.00");
  });
});

describe("readValuationAt", () => {
  it("SNAPSHOT بعد الالتقاط — لا يتأثّر بحركاتٍ لاحقة", async () => {
    const periodId = await makePeriod("2020-08-31");
    await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-08-31", capturedBy: 1 }));

    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "OUT", baseQuantity: 5, referenceType: "TEST", createdBy: 1,
    }));

    const historical = await withTx((tx) => readValuationAt(tx, "2020-08-31"));
    expect(historical.source).toBe("SNAPSHOT");
    expect(historical.totalValue).toBe("1400.00");
    expect(historical.capturedAt).toBeInstanceOf(Date);
  });

  it("LIVE عند غياب لقطة — الحالة الحيّة موسومةً بصراحة", async () => {
    const historical = await withTx((tx) => readValuationAt(tx, "2020-08-31"));
    expect(historical.source).toBe("LIVE");
    expect(historical.totalValue).toBe("1400.00");
    expect(historical.capturedAt).toBeUndefined();
  });

  it("SNAPSHOT قديم لا يتأثّر بتغيّر التكلفة", async () => {
    const periodId = await makePeriod("2020-06-30");
    await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-06-30", capturedBy: 1 }));
    await db().update(s.productVariants).set({ costPrice: "500.00" }).where(eq(s.productVariants.id, 1));
    const historical = await withTx((tx) => readValuationAt(tx, "2020-06-30"));
    expect(historical.source).toBe("SNAPSHOT");
    expect(historical.totalValue).toBe("1400.00");
  });
});

describe("تنسيقُ لقطة الشركة", () => {
  it("stockValue + inTransitValue = totalValue دائماً", async () => {
    const periodId = await makePeriod("2020-09-30");
    const res = await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-09-30", capturedBy: 1 }));
    const sum = Number(res.stockValue) + Number(res.inTransitValue);
    expect(sum.toFixed(2)).toBe(res.totalValue);
  });

  it("branchesJson JSON صالحٌ", async () => {
    const periodId = await makePeriod("2020-10-31");
    await withTx((tx) => captureCompanyValuationSnapshot(tx, { periodLockId: periodId, cutoffDate: "2020-10-31", capturedBy: 1 }));
    const row = (await db().select().from(s.inventoryValuationSnapshots).where(and(eq(s.inventoryValuationSnapshots.cutoffDate, "2020-10-31"))).limit(1))[0];
    expect(row.branchesJson).toBeTruthy();
    const parsed = JSON.parse(String(row.branchesJson));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("branchId");
    expect(parsed[0]).toHaveProperty("value");
  });
});
