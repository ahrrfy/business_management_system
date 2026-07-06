// تنبيهات إعادة الطلب (بند 7): كشف (متغيّر × فرع) تحت حدّ الطلب + suggestedQty + فلترة الفرع
// + تحقّق setReorderThresholds + إنشاء مسودة أمر شراء ببنودها عبر purchaseService.createPurchaseOrder.
// نمط الإعداد منسوخ من customerDuplicate.test.ts (reset + seed).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createReorderDraft,
  listReorderAlerts,
  setReorderThresholds,
} from "../inventory/reorder";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "purchaseOrderItems",
  "purchaseOrders",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_test",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد القرطاسية" });
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values([
    // v1: تحت الحدّ في فرع ١ (3 ≤ 10)، فوقه في فرع ٢ (50 > 10).
    { id: 1, productId: 1, sku: "V1", variantName: "أبيض 80غم", minStock: 5, reorderPoint: 10, costPrice: "2500.00" },
    // v2: reorderPoint=0 ⇒ لا إنذار حتى برصيد صفر.
    { id: 2, productId: 1, sku: "V2", minStock: 0, reorderPoint: 0, costPrice: "1000.00" },
    // v3: متغيّر معطَّل ⇒ مستبعَد حتى وهو تحت الحدّ.
    { id: 3, productId: 1, sku: "V3", minStock: 2, reorderPoint: 10, costPrice: "1000.00", isActive: false },
    // v4: الأشدّ نقصاً (1/10 في ف١، 2/10 في ف٢) — لاختبار الترتيب وفلترة الفرع.
    { id: 4, productId: 1, sku: "V4", minStock: 1, reorderPoint: 10, costPrice: "750.00" },
    // v5: بلا وحدة أساس — لاختبار رفض المسودة.
    { id: 5, productId: 1, sku: "V5", minStock: 0, reorderPoint: 10, costPrice: "500.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    // v5 عمداً بلا وحدة.
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 3 },
    { variantId: 1, branchId: 2, quantity: 50 },
    { variantId: 2, branchId: 1, quantity: 0 },
    { variantId: 3, branchId: 1, quantity: 0 },
    { variantId: 4, branchId: 1, quantity: 1 },
    { variantId: 4, branchId: 2, quantity: 2 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("listReorderAlerts", () => {
  it("يكشف الصف تحت الحدّ بكل حقوله + suggestedQty = reorderPoint×2 − الرصيد", async () => {
    const rows = await listReorderAlerts({ branchId: null });
    const hit = rows.find((r) => r.variantId === 1 && r.branchId === 1);
    expect(hit).toBeTruthy();
    expect(hit).toMatchObject({
      variantId: 1,
      productId: 1,
      productName: "ورق A4",
      sku: "V1",
      variantName: "أبيض 80غم",
      branchId: 1,
      branchName: "الفرع الرئيسي",
      quantity: 3,
      minStock: 5,
      reorderPoint: 10,
      suggestedQty: 17, // 10×2 − 3
    });
  });

  it("لا يكشف: فوق الحدّ، reorderPoint=0، متغيّر معطَّل", async () => {
    const rows = await listReorderAlerts({ branchId: null });
    // v1 في فرع ٢ رصيده 50 > 10 ⇒ خارج القائمة.
    expect(rows.find((r) => r.variantId === 1 && r.branchId === 2)).toBeUndefined();
    // v2 حدّه 0 ⇒ لا إنذار حتى برصيد 0.
    expect(rows.find((r) => r.variantId === 2)).toBeUndefined();
    // v3 معطَّل ⇒ مستبعَد.
    expect(rows.find((r) => r.variantId === 3)).toBeUndefined();
  });

  it("الترتيب بالأشدّ نقصاً (نسبة الرصيد إلى الحدّ تصاعدياً)", async () => {
    const rows = await listReorderAlerts({ branchId: null });
    // v4ف١ (1/10) ثم v4ف٢ (2/10) ثم v1ف١ (3/10).
    expect(rows.map((r) => [r.variantId, r.branchId])).toEqual([
      [4, 1],
      [4, 2],
      [1, 1],
    ]);
  });

  it("فلترة الفرع: فرع ٢ يُظهر صفّه فقط، وبلا فرع = كل الفروع", async () => {
    const b2 = await listReorderAlerts({ branchId: 2 });
    expect(b2.map((r) => [r.variantId, r.branchId])).toEqual([[4, 2]]);
    const all = await listReorderAlerts({});
    expect(all).toHaveLength(3);
  });
});

describe("setReorderThresholds", () => {
  it("نجاح: يحدّث العتبتين ويعيدهما", async () => {
    const res = await setReorderThresholds({ variantId: 2, minStock: 4, reorderPoint: 8 });
    expect(res).toEqual({ variantId: 2, minStock: 4, reorderPoint: 8 });
    const row = (await db().execute(
      sql`SELECT minStock, reorderPoint FROM productVariants WHERE id = 2`,
    )) as any;
    expect(Number(row[0][0].minStock)).toBe(4);
    expect(Number(row[0][0].reorderPoint)).toBe(8);
  });

  it("رفض القيم السالبة وغير الصحيحة", async () => {
    await expect(setReorderThresholds({ variantId: 1, minStock: -1, reorderPoint: 5 })).rejects.toThrow(
      /عددين صحيحين/,
    );
    await expect(setReorderThresholds({ variantId: 1, minStock: 0, reorderPoint: -3 })).rejects.toThrow(
      /عددين صحيحين/,
    );
    await expect(setReorderThresholds({ variantId: 1, minStock: 1.5, reorderPoint: 5 })).rejects.toThrow(
      /عددين صحيحين/,
    );
  });

  it("رفض minStock > reorderPoint", async () => {
    await expect(setReorderThresholds({ variantId: 1, minStock: 11, reorderPoint: 10 })).rejects.toThrow(
      /الحد الأدنى/,
    );
  });

  it("متغيّر غير موجود ⇒ NOT_FOUND", async () => {
    await expect(setReorderThresholds({ variantId: 999, minStock: 1, reorderPoint: 2 })).rejects.toThrow(
      /غير موجود/,
    );
  });
});

describe("createReorderDraft", () => {
  it("ينشئ مسودة DRAFT ببنودها (وحدة الأساس + آخر تكلفة)", async () => {
    const res = await createReorderDraft(
      { supplierId: 1, branchId: 1, lines: [{ variantId: 1, quantity: 17 }, { variantId: 4, quantity: 19 }] },
      actor,
    );
    expect(res.purchaseOrderId).toBeGreaterThan(0);
    expect(res.poNumber).toMatch(/^PO-1-\d{8}-\d{5}$/);

    const po = (await db().execute(
      sql`SELECT supplierId, branchId, poStatus, total FROM purchaseOrders WHERE id = ${res.purchaseOrderId}`,
    )) as any;
    expect(Number(po[0][0].supplierId)).toBe(1);
    expect(Number(po[0][0].branchId)).toBe(1);
    expect(po[0][0].poStatus).toBe("DRAFT");
    // 17×2500 + 19×750 = 42500 + 14250 = 56750.00
    expect(String(po[0][0].total)).toBe("56750.00");

    const items = (await db().execute(
      sql`SELECT variantId, productUnitId, baseQuantity, unitPrice FROM purchaseOrderItems WHERE purchaseOrderId = ${res.purchaseOrderId} ORDER BY variantId`,
    )) as any;
    expect(items[0]).toHaveLength(2);
    expect(Number(items[0][0].variantId)).toBe(1);
    expect(Number(items[0][0].productUnitId)).toBe(1);
    expect(Number(items[0][0].baseQuantity)).toBe(17);
    expect(String(items[0][0].unitPrice)).toBe("2500.00");
    expect(Number(items[0][1].variantId)).toBe(4);
    expect(Number(items[0][1].baseQuantity)).toBe(19);
    expect(String(items[0][1].unitPrice)).toBe("750.00");
  });

  it("رفض: بلا أسطر / كمية غير صحيحة / صنف مكرّر", async () => {
    await expect(createReorderDraft({ supplierId: 1, branchId: 1, lines: [] }, actor)).rejects.toThrow(/لا أسطر/);
    await expect(
      createReorderDraft({ supplierId: 1, branchId: 1, lines: [{ variantId: 1, quantity: 0 }] }, actor),
    ).rejects.toThrow(/موجباً/);
    await expect(
      createReorderDraft({ supplierId: 1, branchId: 1, lines: [{ variantId: 1, quantity: 2.5 }] }, actor),
    ).rejects.toThrow(/موجباً/);
    await expect(
      createReorderDraft(
        { supplierId: 1, branchId: 1, lines: [{ variantId: 1, quantity: 3 }, { variantId: 1, quantity: 4 }] },
        actor,
      ),
    ).rejects.toThrow(/مكرّر/);
  });

  it("رفض: مورّد غير موجود / متغيّر بلا وحدة أساس", async () => {
    await expect(
      createReorderDraft({ supplierId: 999, branchId: 1, lines: [{ variantId: 1, quantity: 3 }] }, actor),
    ).rejects.toThrow(/المورّد غير موجود/);
    await expect(
      createReorderDraft({ supplierId: 1, branchId: 1, lines: [{ variantId: 5, quantity: 3 }] }, actor),
    ).rejects.toThrow(/لا وحدة أساس/);
  });

  it("لا يكتب أي أمر عند الرفض (لا مسودة يتيمة)", async () => {
    await expect(
      createReorderDraft({ supplierId: 1, branchId: 1, lines: [{ variantId: 5, quantity: 3 }] }, actor),
    ).rejects.toThrow();
    const n = (await db().execute(sql`SELECT COUNT(*) AS n FROM purchaseOrders`)) as any;
    expect(Number(n[0][0].n)).toBe(0);
  });
});
