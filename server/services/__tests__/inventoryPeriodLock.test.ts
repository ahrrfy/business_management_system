/**
 * إقفال الفترة يحرس المخزون — لا الدفتر وحده (تدقيق ٢٧/٧، H5).
 *
 * كان `assertPeriodOpen` يُستدعى من `postEntry` فقط. فالحركة التي يرافقها قيد كانت محروسةً
 * **عرَضاً**، أمّا التحويل بين الفروع والتثبيت الافتتاحيّ وكلّ مسارٍ لا يُرحّل قيداً فكانت تمرّ.
 *
 * والفارق ليس نظرياً: أصل المخزون في الميزانية يُقرأ حيّاً (`SUM(quantity × costPrice)`) بلا
 * تاريخٍ مرجعيّ ⇒ حركةٌ واحدة بعد الإقفال تُغيّر **ميزانية الفترة المقفلة نفسها** بأثرٍ رجعيّ،
 * فتنحرف عن الأرباح المحتجزة المُرحَّلة — صامتةً بلا رفضٍ ولا تنبيه.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { readInventoryValuation } from "../inventory/valuation";
import { applyMovement, setStock, transferBetweenBranches } from "../inventoryService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "financialPeriods",
  "inventoryMovements",
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
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u-admin", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "بضاعة أمانة", isConsignment: true },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "CONS-1", costPrice: "500.00" },
  ]);
  await db().insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 4 },
    { variantId: 2, branchId: 1, quantity: 3 },
  ]);
}

/** يقفل الفترة حتى اليوم ⇒ حركةُ اليوم داخل المُقفَل. */
async function lockThroughToday() {
  const today = new Date().toISOString().slice(0, 10);
  await db().insert(s.financialPeriods).values({ cutoffDate: today, lockedBy: 1, status: "LOCKED" });
}

/** يقفل حتى أمس ⇒ اليوم مفتوح (الحالة الطبيعية بعد إقفال شهرٍ منصرم). */
async function lockThroughYesterday() {
  const y = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db().insert(s.financialPeriods).values({ cutoffDate: y, lockedBy: 1, status: "LOCKED" });
}

async function qtyOf(variantId: number, branchId: number): Promise<number> {
  const r = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = ${branchId}`);
  return Number(r[0]?.q ?? 0);
}

async function movementCount(): Promise<number> {
  const r = await db().select({ c: sql<number>`COUNT(*)` }).from(s.inventoryMovements);
  return Number(r[0]?.c ?? 0);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("حارس إقفال الفترة على المخزون", () => {
  it("يرفض خصماً بحركةٍ داخل الفترة المقفلة — ولا يترك أثراً", async () => {
    await lockThroughToday();
    await expect(
      withTx((tx) =>
        applyMovement(tx, {
          variantId: 1,
          branchId: 1,
          movementType: "OUT",
          baseQuantity: 2,
          referenceType: "SALE",
          createdBy: 1,
        }),
      ),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
    expect(await qtyOf(1, 1)).toBe(10);
    expect(await movementCount()).toBe(0);
  });

  it("يرفض الإضافة أيضاً — الحارس ليس على الخصم وحده", async () => {
    await lockThroughToday();
    await expect(
      withTx((tx) =>
        applyMovement(tx, {
          variantId: 1,
          branchId: 1,
          movementType: "IN",
          baseQuantity: 5,
          referenceType: "PURCHASE",
          createdBy: 1,
        }),
      ),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
    expect(await qtyOf(1, 1)).toBe(10);
  });

  it("يرفض `setStock` — مسارٌ يكتب حركته بنفسه فلا يرث حارس applyMovement", async () => {
    await lockThroughToday();
    await expect(
      withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 3, createdBy: 1 })),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
    expect(await qtyOf(1, 1)).toBe(10);
    expect(await movementCount()).toBe(0);
  });

  it("يرفض التحويل بين الفروع — وهو المسار الذي كان يمرّ بلا حارسٍ إطلاقاً (لا قيد يرافقه)", async () => {
    await lockThroughToday();
    await expect(
      withTx((tx) =>
        transferBetweenBranches(tx, {
          variantId: 1,
          fromBranchId: 1,
          toBranchId: 2,
          baseQuantity: 3,
          createdBy: 1,
        }),
      ),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
    // ذرّية: لا الطرف الصادر نقص ولا الوارد زاد.
    expect(await qtyOf(1, 1)).toBe(10);
    expect(await qtyOf(1, 2)).toBe(4);
    expect(await movementCount()).toBe(0);
  });

  it("اليوم المفتوح بعد فترةٍ مقفلة يمرّ طبيعياً — الحارس يقفل الماضي لا الحاضر", async () => {
    await lockThroughYesterday();
    const res = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        movementType: "OUT",
        baseQuantity: 2,
        referenceType: "SALE",
        createdBy: 1,
      }),
    );
    expect(res.newQuantity).toBe(8);
    expect(await qtyOf(1, 1)).toBe(8);
  });

  it("بلا قفلٍ نشِط: الحركات كلّها تمرّ (لا انحدار على المسار الشائع)", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 15, createdBy: 1 }));
    expect(await qtyOf(1, 1)).toBe(15);
    await withTx((tx) =>
      transferBetweenBranches(tx, {
        variantId: 1,
        fromBranchId: 1,
        toBranchId: 2,
        baseQuantity: 5,
        createdBy: 1,
      }),
    );
    expect(await qtyOf(1, 1)).toBe(10);
    expect(await qtyOf(1, 2)).toBe(9);
  });
});

describe("لقطة قيمة المخزون — أصل الميزانية المقفلة", () => {
  it("تُطابق تعريف الميزانية: المملوك فقط، مجمَّعاً لكل فرع", async () => {
    const v = await withTx((tx) => readInventoryValuation(tx));
    // 10 × 100 في الرئيسي و4 × 100 في المبيعات؛ وبضاعة الأمانة (3 × 500) مستبعَدة.
    expect(v.total).toBe("1400.00");
    expect(v.branches).toEqual([
      { branchId: 1, value: "1000.00" },
      { branchId: 2, value: "400.00" },
    ]);
  });

  it("تتحرّك بتحرّك الكمّية والتكلفة معاً — فهي الرقم الذي تحرسه الفترة المقفلة", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 2, targetQuantity: 0, createdBy: 1 }));
    await db().update(s.productVariants).set({ costPrice: "120.00" }).where(eq(s.productVariants.id, 1));
    const v = await withTx((tx) => readInventoryValuation(tx));
    expect(v.total).toBe("1200.00");
    expect(v.branches).toEqual([{ branchId: 1, value: "1200.00" }]);
  });
});
