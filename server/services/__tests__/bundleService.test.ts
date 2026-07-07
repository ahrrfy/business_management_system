// اختبارات وحدة البكج (باندل/بكج) — ٧/٧/٢٦:
// تغطّي ثوابت الأمان B1..B6 + توسيع البيع + توسيع المرتجع + قواعد الحفظ.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import {
  classifyVariants,
  computeBundleUnitCosts,
  getBundleDefinitions,
  replaceBundleComponents,
  validateBundleComponents,
} from "../bundleService";
import { createProduct } from "../catalogService";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItemBundleComponents", "invoiceItems", "invoices", "idempotencyKeys", "bundleComponents",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "shifts", "auditLogs", "customers", "suppliers", "categories",
  "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() { await truncateTables(TABLES); }

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  // ثلاثة منتجات بسيطة: قلم (تكلفة 4)، دفتر (تكلفة 10)، مسطرة (تكلفة 2)
  await d.insert(s.products).values([
    { id: 1, name: "قلم" }, { id: 2, name: "دفتر" }, { id: 3, name: "مسطرة" },
    { id: 4, name: "خدمة تصميم", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "RL-1", costPrice: "2.00" },
    { id: 4, productId: 4, sku: "SVC-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "8.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "18.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "5.00" },
  ]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId: 1, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}
async function stockOf(variantId: number, branchId: number): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return rows[0]?.q ?? 0;
}

async function createTestBundle(name: string, components: Array<{ vid: number; qty: number }>, price: string) {
  const res = await createProduct(
    {
      name,
      isBundle: true,
      variants: [{ sku: `BDL-${name}`, costPrice: "0", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: `BC-${name}`, prices: [{ priceTier: "RETAIL", price }] }] }],
      bundleComponents: components.map((c) => ({ componentVariantId: c.vid, componentBaseQuantity: c.qty })),
    } as any,
    actor,
  );
  // متغيّر البكج + وحدته الأساس — لالتقاطهما بلا تخمين لأنّ DELETE لا يعيد AUTO_INCREMENT.
  const variants = await db().select().from(s.productVariants).where(eq(s.productVariants.productId, (res as any).productId));
  const variantId = Number(variants[0].id);
  const units = await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, variantId));
  const productUnitId = Number(units[0].id);
  return { productId: (res as any).productId, variantId, productUnitId };
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("bundleService — ثوابت الأمان B1..B6", () => {
  it("B6: بكج بلا مكوّنات مرفوض عند الإنشاء", async () => {
    await expect(createTestBundle("empty", [], "20.00")).rejects.toThrow(/مكوّن/);
  });

  it("B3: كميّة مكوّن ≤0 مرفوضة", async () => {
    await expect(createTestBundle("zeroqty", [{ vid: 1, qty: 0 }], "20.00")).rejects.toThrow();
  });

  it("B4: تكرار مكوّن في نفس البكج مرفوض (زد الكميّة بدل التكرار)", async () => {
    await expect(
      createProduct(
        {
          name: "طقم مكرَّر",
          isBundle: true,
          variants: [{ sku: "BDL-DUP", costPrice: "0", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "20.00" }] }] }],
          bundleComponents: [
            { componentVariantId: 1, componentBaseQuantity: 2 },
            { componentVariantId: 1, componentBaseQuantity: 3 },
          ],
        } as any,
        actor,
      ),
    ).rejects.toThrow(/مكرّر/);
  });

  it("B1: بكج داخل بكج مرفوض (النَست ممنوع)", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-١", [{ vid: 1, qty: 2 }], "16.00");
    // محاولة تضمين بكج قائم في بكج آخر يجب أن تُرفض.
    await expect(createTestBundle("طقم-متداخل", [{ vid: bundleVid, qty: 1 }], "50.00")).rejects.toThrow(/بكج/);
  });

  it("خدمة كمكوّن مرفوضة (لا معنى لخدمة في بكج بضاعة)", async () => {
    await expect(createTestBundle("طقم-خدمة", [{ vid: 4, qty: 1 }], "20.00")).rejects.toThrow(/خدمي/);
  });

  it("مكوّن غير نشط مرفوض", async () => {
    await db().update(s.productVariants).set({ isActive: false }).where(eq(s.productVariants.id, 1));
    await expect(createTestBundle("طقم-معطّل", [{ vid: 1, qty: 2 }], "20.00")).rejects.toThrow(/معطّل/);
  });

  it("لا يُسمَح برصيد افتتاحي على البكج", async () => {
    await expect(
      createProduct(
        {
          name: "طقم-برصيد",
          isBundle: true,
          variants: [{ sku: "BDL-OP", costPrice: "0", openingStock: 5, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL", price: "20.00" }] }] }],
          bundleComponents: [{ componentVariantId: 1, componentBaseQuantity: 2 }],
        } as any,
        actor,
      ),
    ).rejects.toThrow(/رصيد/);
  });

  it("بكجٌ يحتوي على نفسه (self-ref) مرفوض في validateBundleComponents", async () => {
    await withTx(async (tx) => {
      await expect(validateBundleComponents(tx, 1, [{ componentVariantId: 1, componentBaseQuantity: 2 }])).rejects.toThrow(/نفسه/);
    });
  });
});

describe("bundleService — التصنيف والقراءة", () => {
  it("classifyVariants يميّز STOCKED/SERVICE/BUNDLE بصورة صحيحة", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-تصنيف", [{ vid: 1, qty: 2 }, { vid: 2, qty: 1 }], "24.00");
    await withTx(async (tx) => {
      const kinds = await classifyVariants(tx, [1, 4, bundleVid]);
      expect(kinds.get(1)).toBe("STOCKED");
      expect(kinds.get(4)).toBe("SERVICE");
      expect(kinds.get(bundleVid)).toBe("BUNDLE");
    });
  });

  it("getBundleDefinitions يعيد الوصفة مرتّبة بـsortOrder", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-قراءة", [{ vid: 2, qty: 1 }, { vid: 1, qty: 3 }, { vid: 3, qty: 2 }], "30.00");
    await withTx(async (tx) => {
      const defs = await getBundleDefinitions(tx, [bundleVid]);
      const list = defs.get(bundleVid) ?? [];
      expect(list.length).toBe(3);
      // sortOrder افتراضياً 0، ثم يُعتمد ترتيب الحفظ الأصلي.
      const totalQty = list.reduce((s, c) => s + c.componentBaseQuantity, 0);
      expect(totalQty).toBe(1 + 3 + 2);
    });
  });

  it("computeBundleUnitCosts = Σ(componentCost × qty) حيّاً", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-تكلفة", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "50.00");
    await withTx(async (tx) => {
      const defs = await getBundleDefinitions(tx, [bundleVid]);
      const costs = await computeBundleUnitCosts(tx, [bundleVid], defs);
      // 3×4 + 1×10 = 22
      expect(costs.get(bundleVid)).toBe("22.00");
    });
  });

  it("تعديل تكلفة WAVG لمكوّن ينعكس على تكلفة البكج فوراً (تُحسب لحظياً)", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-تحديث-تكلفة", [{ vid: 1, qty: 2 }], "20.00");
    // ارفع تكلفة القلم من 4 إلى 6 → تكلفة البكج تصبح 12
    await db().update(s.productVariants).set({ costPrice: "6.00" }).where(eq(s.productVariants.id, 1));
    await withTx(async (tx) => {
      const defs = await getBundleDefinitions(tx, [bundleVid]);
      const costs = await computeBundleUnitCosts(tx, [bundleVid], defs);
      expect(costs.get(bundleVid)).toBe("12.00");
    });
  });
});

describe("bundleService — التوسيع في البيع", () => {
  it("بيع بكج يخصم مكوّناته لا البكج نفسه", async () => {
    await setStock(1, 1, 20); // 20 قلماً
    await setStock(2, 1, 10); // 10 دفاتر
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "2" }], payment: { amount: "48.00", method: "CASH" } } as any,
      actor,
    );
    expect(await stockOf(1, 1)).toBe(20 - 6); // 2×3=6 أقلام
    expect(await stockOf(2, 1)).toBe(10 - 2); // 2×1=2 دفتر
    expect(await stockOf(bundleVid, 1)).toBe(0); // البكج بلا رصيد ذاتي
  });

  it("مكوّن ناقص يمنع بيع البكج", async () => {
    await setStock(1, 1, 4); // 4 أقلام فقط (نحتاج 6)
    await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-ناقص", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    await expect(
      createSale(
        { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "2" }], payment: { amount: "48.00", method: "CASH" } } as any,
        actor,
      ),
    ).rejects.toThrow(/المخزون/);
  });

  it("unitCost في invoiceItems للبكج = Σ(component × qty) لا 0", async () => {
    await setStock(1, 1, 20);
    await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-كلفة-بيع", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "30.00");
    const shiftId = await openShift();
    const res = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "1" }], payment: { amount: "30.00", method: "CASH" } } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    expect(items.length).toBe(1);
    // Σ = 3×4 + 1×10 = 22
    expect(items[0].unitCost).toBe("22.00");
    // Σ(profit) = 30 − 22 = 8 (الربح موجب)
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SALE"));
    expect(entries[0].profit).toBe("8.00");
  });

  it("سطر بكج + سطر مفرد لنفس المكوّن يُجمَعان في حركة OUT واحدة", async () => {
    await setStock(1, 1, 20);
    await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-تجميع", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    await createSale(
      {
        branchId: 1,
        shiftId,
        sourceType: "POS",
        priceTier: "RETAIL",
        lines: [
          { variantId: bundleVid, productUnitId: bundleUid, quantity: "1" }, // بكج ⇒ 3 أقلام + 1 دفتر
          { variantId: 1, productUnitId: 1, quantity: "5" }, // 5 أقلام مفردة
        ],
        payment: { amount: "64.00", method: "CASH" },
      } as any,
      actor,
    );
    // خصم إجمالي أقلام: 3 (بكج) + 5 (مفردة) = 8
    expect(await stockOf(1, 1)).toBe(20 - 8);
    // عدد حركات OUT للأقلام = 1 (مجمَّعة)
    const moves = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.variantId, 1), eq(s.inventoryMovements.movementType, "OUT")));
    expect(moves.length).toBe(1);
    expect(moves[0].quantity).toBe(8);
  });
});

describe("bundleService — التوسيع في المرتجع", () => {
  it("مرتجع بكج (restock=true) يعيد المكوّنات للمخزون", async () => {
    await setStock(1, 1, 20);
    await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-مرتجع", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    const sale = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "2" }], payment: { amount: "48.00", method: "CASH" } } as any,
      actor,
    );
    expect(await stockOf(1, 1)).toBe(14);
    expect(await stockOf(2, 1)).toBe(8);
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 2 }], restock: true } as any,
      actor,
    );
    expect(await stockOf(1, 1)).toBe(20);
    expect(await stockOf(2, 1)).toBe(10);
  });

  it("مرتجع بكج (restock=false) لا يمسّ المخزون", async () => {
    await setStock(1, 1, 20);
    await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-تلف", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    const sale = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "1" }], payment: { amount: "24.00", method: "CASH" } } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 1 }], restock: false } as any,
      actor,
    );
    expect(await stockOf(1, 1)).toBe(20 - 3);
    expect(await stockOf(2, 1)).toBe(10 - 1);
  });
});

describe("bundleService — replaceBundleComponents (تعديل الوصفة)", () => {
  it("استبدال ذرّي: القديم يُحذف، الجديد يُدرَج، بلا صفوف يتيمة", async () => {
    const { variantId: bundleVid } = await createTestBundle("طقم-يُعدَّل", [{ vid: 1, qty: 2 }, { vid: 2, qty: 1 }], "20.00");
    await withTx(async (tx) => {
      await replaceBundleComponents(tx, bundleVid, [
        { componentVariantId: 3, componentBaseQuantity: 5 },
        { componentVariantId: 1, componentBaseQuantity: 4 },
      ]);
    });
    const rows = await db().select().from(s.bundleComponents).where(eq(s.bundleComponents.bundleVariantId, bundleVid));
    expect(rows.length).toBe(2);
    const byVid = new Map(rows.map((r) => [Number(r.componentVariantId), Number(r.componentBaseQuantity)]));
    expect(byVid.get(1)).toBe(4);
    expect(byVid.get(3)).toBe(5);
    expect(byVid.has(2)).toBe(false); // المكوّن القديم اختفى
  });

  it("رفض استبدال على متغيّر ليس بكجاً", async () => {
    await withTx(async (tx) => {
      await expect(replaceBundleComponents(tx, 1, [{ componentVariantId: 2, componentBaseQuantity: 1 }])).rejects.toThrow(/بكج/);
    });
  });
});

describe("bundleService — gstack B6 (لقطة المرتجع) + M9 (ثابت Σ=0)", () => {
  it("B6: تعديل الوصفة بعد البيع لا يمسّ المرتجع — يعيد المكوّنات المحفوظة لحظة البيع", async () => {
    await setStock(1, 1, 20); await setStock(2, 1, 10); await setStock(3, 1, 20);
    // بكج {3×قلم(1) + 1×دفتر(2)}
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-b6", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "24.00");
    const shiftId = await openShift();
    const sale = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "2" }], payment: { amount: "48.00", method: "CASH" } } as any,
      actor,
    );
    // بعد البيع: 14 قلم، 8 دفتر.
    expect(await stockOf(1, 1)).toBe(14);
    expect(await stockOf(2, 1)).toBe(8);

    // نُغيّر الوصفة بعد البيع إلى {2×مسطرة(3)} — وصفة مختلفة تماماً.
    await withTx(async (tx) => {
      await replaceBundleComponents(tx, bundleVid, [{ componentVariantId: 3, componentBaseQuantity: 2 }]);
    });

    // إرجاع البكج — يجب أن يعيد **الوصفة الأصلية (قلم/دفتر)** لا الجديدة (مسطرة).
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 2 }], restock: true } as any,
      actor,
    );
    expect(await stockOf(1, 1)).toBe(20);  // القلم: عاد للأصل ✅
    expect(await stockOf(2, 1)).toBe(10);  // الدفتر: عاد للأصل ✅
    expect(await stockOf(3, 1)).toBe(20);  // المسطرة: لم تُمَسّ (لم تكن في وصفة البيع) ✅
  });

  it("M9: مرتجع كامل لبيع بكج ⇒ Σ(revenue)=0 و Σ(profit)=0 عبر SALE + RETURN", async () => {
    await setStock(1, 1, 20); await setStock(2, 1, 10);
    const { variantId: bundleVid, productUnitId: bundleUid } = await createTestBundle("طقم-m9", [{ vid: 1, qty: 3 }, { vid: 2, qty: 1 }], "30.00");
    const shiftId = await openShift();
    const sale = await createSale(
      { branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL", lines: [{ variantId: bundleVid, productUnitId: bundleUid, quantity: "1" }], payment: { amount: "30.00", method: "CASH" } } as any,
      actor,
    );
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 1 }], restock: true, refund: { amount: "30.00", method: "CASH" } } as any,
      actor,
    );

    // Σ عبر SALE + RETURN لهذه الفاتورة.
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.invoiceId, sale.invoiceId), sql`entryType IN ('SALE','RETURN')`));
    const sumRev = entries.reduce((a, e) => a + Number(e.revenue ?? 0), 0);
    const sumProfit = entries.reduce((a, e) => a + Number(e.profit ?? 0), 0);
    expect(sumRev).toBeCloseTo(0, 2);
    expect(sumProfit).toBeCloseTo(0, 2);
  });
});
