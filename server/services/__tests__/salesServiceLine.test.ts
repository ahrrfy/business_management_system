/**
 * salesServiceLine — createSale يقبل الخدمة كسطر فاتورة (بيع متقدّم) ويطبّق نفس ذرّية
 * printSaleService: unitCost يُحسب من الوصفة، خصم المواد بحركة OUT، allowNegative دائماً
 * لمواد الخدمة، السلة المختلطة (سلعة+خدمة) تنجح بمعاملة واحدة، وقيد SALE يعكس COGS الكامل.
 * الغرض: تغطية معمارية «الخدمات في الفاتورة المتقدّمة» — شريحة ١٢/٨/٢٦.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { returnSale } from "../returnService";
import { withTx } from "../tx";

const TABLES = [
  "accountingEntries", "receipts", "invoiceItemBundleComponents", "invoiceItems", "invoices",
  "productionRecipeLines", "productionRecipes", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "customers", "shifts", "branches", "users",
];

const actor = { userId: 1, branchId: 1, role: "manager" as const };

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await withTx(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true });
  await d.insert(s.users).values({ id: 1, openId: "u1", name: "manager", role: "manager", loginMethod: "local" });
  // مواد خام: ورق A4 (٣٥) + حبر (٢٠).
  await d.insert(s.products).values([
    { id: 1, name: "ورق A4" },
    { id: 2, name: "حبر أسود" },
    // سلعة عادية للسلّة المختلطة.
    { id: 3, name: "قلم جاف" },
    // خدمتان (PRINT_SERVICE، isService=true).
    { id: 10, name: "تصوير A4 ب/أ", productType: "PRINT_SERVICE", isService: true },
    { id: 11, name: "تجليد بسيط", productType: "PRINT_SERVICE", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT-A4", costPrice: "35.00" },
    { id: 2, productId: 2, sku: "MAT-INK", costPrice: "20.00" },
    { id: 3, productId: 3, sku: "PEN-1", costPrice: "500.00" },
    { id: 10, productId: 10, sku: "SVC-COPY", costPrice: "0.00" },
    { id: 11, productId: 11, sku: "SVC-BIND", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "وحدة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 10, variantId: 10, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 11, variantId: 11, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 3, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 10, priceTier: "RETAIL", price: "250.00" },
    { productUnitId: 11, priceTier: "RETAIL", price: "3000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 3, branchId: 1, quantity: 50 },
  ]);
  // وصفة الخدمة ١٠ (تصوير): ورقة + حبر لكل وحدة خدمة.
  await d.insert(s.productionRecipes).values({
    id: 1, name: "[تصوير A4]", outputVariantId: 10, outputProductUnitId: 10,
    laborPerOutputBase: "0", wasteStdPct: "0", isActive: true,
  });
  await d.insert(s.productionRecipeLines).values([
    { recipeId: 1, inputVariantId: 1, qtyPerOutputBase: "1.0000" },
    { recipeId: 1, inputVariantId: 2, qtyPerOutputBase: "1.0000" },
  ]);
  await d.insert(s.shifts).values({
    id: 1, branchId: 1, userId: 1, openingBalance: "0",
    status: "OPEN", shiftType: "RETAIL", openGuard: "1:1:RETAIL",
  });
}

beforeEach(async () => { await reset(); await seed(); });

async function stock(vid: number): Promise<number> {
  const r = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${vid} AND ${s.branchStock.branchId} = 1`))[0];
  return r ? Number(r.q) : 0;
}

async function movements() { return db().select().from(s.inventoryMovements).orderBy(s.inventoryMovements.variantId); }

describe("createSale — خدمة كسطر فاتورة متقدّمة", () => {
  it("بيع خدمة نقدي كامل: يخصم موادها بحركة OUT ويحتسب COGS من الوصفة", async () => {
    const r = await createSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      payment: { amount: "1250", method: "CASH" },
    }, actor);
    expect(r.status).toBe("PAID");
    // الفاتورة: total=1250، costTotal=(35+20)×5=275 (COGS من الوصفة لا من variants.costPrice).
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId)))[0]!;
    expect(inv.total).toBe("1250.00");
    expect(inv.costTotal).toBe("275.00");
    // مخزون المواد: ٥ ورقات + ٥ وحدات حبر مخصومة.
    expect(await stock(1)).toBe(95);
    expect(await stock(2)).toBe(95);
    // حركات المخزون: مادّتان بـOUT (الخدمة نفسها لا branchStock ⇒ لا حركة).
    const mv = await movements();
    const outMoves = mv.filter((m) => m.movementType === "OUT");
    expect(outMoves.map((m) => Number(m.variantId)).sort()).toEqual([1, 2]);
    expect(outMoves.every((m) => m.referenceType === "INVOICE")).toBe(true);
    // قيد SALE: revenue=1250، cost=275، profit=975.
    const sale = (await db().select().from(s.accountingEntries)
      .where(sql`${s.accountingEntries.entryType} = 'SALE'`))[0]!;
    expect(sale.revenue).toBe("1250.00");
    expect(sale.cost).toBe("275.00");
    expect(sale.profit).toBe("975.00");
  });

  it("سلّة مختلطة (سلعة + خدمة): معاملة واحدة، خصم دقيق لكل نوع، قيد SALE موحّد", async () => {
    const r = await createSale({
      branchId: 1, shiftId: 1,
      lines: [
        { variantId: 3, productUnitId: 3, quantity: "2" },  // قلم جاف ×٢ = ٢٠٠٠، تكلفة ٥٠٠×٢=١٠٠٠
        { variantId: 10, productUnitId: 10, quantity: "3" }, // تصوير ×٣ = ٧٥٠، تكلفة (٣٥+٢٠)×٣=١٦٥
      ],
      payment: { amount: "2750", method: "CASH" },
    }, actor);
    expect(r.status).toBe("PAID");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId)))[0]!;
    expect(inv.total).toBe("2750.00");
    expect(inv.costTotal).toBe("1165.00"); // ١٠٠٠ (قلم) + ١٦٥ (مواد التصوير)
    // مخزون: قلم ٥٠→٤٨، ورق ١٠٠→٩٧، حبر ١٠٠→٩٧.
    expect(await stock(3)).toBe(48);
    expect(await stock(1)).toBe(97);
    expect(await stock(2)).toBe(97);
    // حركات OUT: قلم + ورق + حبر (٣ حركات).
    const outs = (await movements()).filter((m) => m.movementType === "OUT");
    expect(outs.map((m) => Number(m.variantId)).sort()).toEqual([1, 2, 3]);
    // قيد SALE موحّد يعكس التكلفة الكاملة.
    const sale = (await db().select().from(s.accountingEntries)
      .where(sql`${s.accountingEntries.entryType} = 'SALE'`))[0]!;
    expect(sale.cost).toBe("1165.00");
    expect(sale.profit).toBe("1585.00");
  });

  it("مرتجع سلّة مختلطة يعكس COGS المخزون المملوك فقط ولا يعيد مواد الخدمة المستهلكة", async () => {
    const created = await createSale({
      branchId: 1,
      shiftId: 1,
      lines: [
        { variantId: 3, productUnitId: 3, quantity: "2" },
        { variantId: 10, productUnitId: 10, quantity: "3" },
      ],
      payment: { amount: "2750", method: "CASH" },
    }, actor);
    const items = await db().select().from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, created.invoiceId));

    await returnSale({
      invoiceId: created.invoiceId,
      lines: items.map((item) => ({
        invoiceItemId: Number(item.id),
        baseQuantity: Number(item.baseQuantity),
      })),
      restock: true,
    }, actor);

    // القلم أصل مملوك عاد للرف؛ مواد وصفة الخدمة استُهلكت فعلاً ولا تنشأ من المرتجع.
    expect(await stock(3)).toBe(50);
    expect(await stock(1)).toBe(97);
    expect(await stock(2)).toBe(97);
    const returned = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "RETURN")))[0]!;
    expect(returned.cost).toBe("-1000.00");
    expect(returned.profit).toBe("-1750.00");
    expect(returned.notes).toContain("خدمة غير معادة=165.00");
  });

  it("مواد الخدمة تُخصَم حتى بنفاد المخزون (allowNegative دائماً لموادّ الوصفة)", async () => {
    // نُصفّر مخزون الحبر — الخدمة يجب أن تنجح مع رصيد سالب موسوم.
    await db().update(s.branchStock).set({ quantity: 0 })
      .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);
    const r = await createSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "3" }],
      payment: { amount: "750", method: "CASH" },
    }, actor);
    expect(r.status).toBe("PAID");
    expect(await stock(2)).toBe(-3); // سالب موسوم = علامة تزويد
    expect(await stock(1)).toBe(97);
  });

  it("خدمة بلا وصفة ⇒ COGS=0 ولا حركة مخزون (رمزية بحتة، سعرها صافي ربح)", async () => {
    const r = await createSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 11, productUnitId: 11, quantity: "1", unitPriceOverride: "3000" }],
      payment: { amount: "3000", method: "CASH" },
    }, actor);
    expect(r.status).toBe("PAID");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId)))[0]!;
    expect(inv.costTotal).toBe("0.00");
    const outs = (await movements()).filter((m) => m.movementType === "OUT");
    expect(outs.length).toBe(0); // لا وصفة ⇒ لا مواد ⇒ لا حركات.
    const sale = (await db().select().from(s.accountingEntries)
      .where(sql`${s.accountingEntries.entryType} = 'SALE'`))[0]!;
    expect(sale.profit).toBe("3000.00");
  });
});
