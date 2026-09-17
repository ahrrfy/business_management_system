/**
 * تعميم الأوفلاين على أنواع الكاشير — ثوابت مسارَي الترحيل الجديدين.
 *
 * الخلفية: الالتقاط دون اتصال كان محصوراً بكاشير التجزئة (`offline.replaySale`)، وعقدُه يقبل
 * `lines[] + payment{CASH}` فقط ويُثبِّت `sourceType:"POS"`. فكاشير الطباعة (مواد تُستهلك بصمت)
 * وكاشير خدمات الزبائن (سلّة مركّبة في معاملةٍ واحدة) لا يمكن تمريرهما عبره.
 *
 * الثوابت المُثبَّتة هنا:
 *  O1 — سلّة استقبالٍ نقديّةٍ كاملة (بضاعة + خدمة طباعة) تُرحَّل فتُنتج فاتورتين موسومتين
 *       بالمنشأ الأوفلاينيّ والرقم المؤقّت.
 *  O2 — **أوامر الشغل مرفوضة** حتى لو حُقنت في الحمولة (حارس دفاعٍ متعمّق).
 *  O3 — الترحيل idempotent: إعادة الإرسال بنفس المفتاح لا تُنتج فاتورةً ثانية ولا نقداً ثانياً.
 *  O4 — نافذة الالتقاط مشتركة: ما تجاوز ٧٢ ساعة يُرفض PRECONDITION_FAILED (يُعلَّق للمراجعة).
 *  O5 — نقديّ فقط: غير النقد يُرفض في كلّ الأنواع.
 *  O6 — بيع طباعةٍ أوفلاينيّ يُرحَّل ويُوسَم، ويسجّل عجز مواده بالسالب لأن الواقعة حدثت فعلاً.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { replayOfflineReception } from "../offline/replayReception";
import { replayOfflinePrintSale } from "../offline/replayPrintSale";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "invoiceItemServiceMaterials", "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productionRecipeLines", "productionRecipes",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "دفتر" },
    // productType على **المنتج** لا المتغيّر (createPrintSale ينضمّ إلى products).
    { id: 2, name: "طباعة ملوّنة", isService: true, productType: "PRINT_SERVICE" },
    { id: 3, name: "ورق طباعة", allowBackorder: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" },
    { id: 2, productId: 2, sku: "PR-1", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "PAPER-1", costPrice: "30.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "صفحة", conversionFactor: 1, isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "250.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 3, branchId: 1, quantity: 10 },
  ]);
  await d.insert(s.productionRecipes).values({
    id: 1,
    name: "[طباعة] ورق ملوّن",
    outputVariantId: 2,
    outputProductUnitId: 2,
    laborPerOutputBase: "0",
    wasteStdPct: "0",
    isActive: true,
  });
  await d.insert(s.productionRecipeLines).values({
    recipeId: 1,
    inputVariantId: 3,
    qtyPerOutputBase: "1.0000",
  });
}

const nowIso = () => new Date().toISOString();

async function openReceptionShift() {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
}

function receptionInput(over: Partial<Parameters<typeof replayOfflineReception>[0]> = {}) {
  return {
    branchId: 1,
    shiftId: 0,
    priceTier: "RETAIL" as const,
    paymentMethod: "CASH" as const,
    paidAmount: "1250.00",
    regularSale: {
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "1000.00" }],
      amount: "1000.00",
    },
    printSale: {
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "250.00" }],
      amount: "250.00",
    },
    clientRequestId: "off-rec-0001",
    capturedAt: nowIso(),
    offlineReceiptNumber: "OFF-1-ab-1",
    deviceId: "ab",
    ...over,
  };
}

describe("تعميم الأوفلاين على أنواع الكاشير", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("O1 — سلّة استقبال نقديّة كاملة تُرحَّل فتُنتج فاتورتين موسومتين بالمنشأ الأوفلاينيّ", async () => {
    const shift = await openReceptionShift();
    const res = await replayOfflineReception(receptionInput({ shiftId: shift.shiftId }), CASHIER);

    expect(res.invoices.regularSale).not.toBeNull();
    expect(res.invoices.printSale).not.toBeNull();

    const rows = await db().select().from(s.invoices);
    expect(rows).toHaveLength(2);
    for (const inv of rows) {
      expect(inv.originatedOffline).toBe(true);
      expect(inv.offlineReceiptNumber).toBe("OFF-1-ab-1");
      expect(inv.capturedAt).not.toBeNull();
    }
    // النقد دخل الدرج فعلاً (وإلا ظهر عجزٌ عند إغلاق الوردية).
    const [cash] = await db()
      .select({ net: sql<string>`COALESCE(SUM(${s.receipts.amount}),0)` })
      .from(s.receipts)
      .where(eq(s.receipts.shiftId, shift.shiftId));
    expect(Number(cash.net)).toBe(1250);
  });

  it("O2 — أوامر الشغل مرفوضة حتى لو حُقنت في الحمولة", async () => {
    const shift = await openReceptionShift();
    const withWorkOrders = {
      ...receptionInput({ shiftId: shift.shiftId }),
      workOrders: [{ title: "طباعة لوحة", salePrice: "5000" }],
    } as unknown as Parameters<typeof replayOfflineReception>[0];
    await expect(replayOfflineReception(withWorkOrders, CASHIER)).rejects.toThrow(/أوامر الشغل/);
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("O3 — الترحيل idempotent: نفس المفتاح لا يُنتج فاتورةً ثانية ولا نقداً ثانياً", async () => {
    const shift = await openReceptionShift();
    const input = receptionInput({ shiftId: shift.shiftId });
    await replayOfflineReception(input, CASHIER);
    await replayOfflineReception(input, CASHIER);

    expect(await db().select().from(s.invoices)).toHaveLength(2); // لا ٤
    const [cash] = await db()
      .select({ net: sql<string>`COALESCE(SUM(${s.receipts.amount}),0)` })
      .from(s.receipts)
      .where(eq(s.receipts.shiftId, shift.shiftId));
    expect(Number(cash.net)).toBe(1250); // لا ٢٥٠٠
  });

  it("O4 — ما تجاوز نافذة ٧٢ ساعة يُرفض (يُعلَّق لمراجعة المدير لا يُرحَّل أعمى)", async () => {
    const shift = await openReceptionShift();
    const stale = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();
    await expect(
      replayOfflineReception(receptionInput({ shiftId: shift.shiftId, capturedAt: stale }), CASHIER),
    ).rejects.toThrow(/٧٢ ساعة/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("O5 — نقديّ فقط في كلّ الأنواع", async () => {
    const shift = await openReceptionShift();
    const nonCash = {
      ...receptionInput({ shiftId: shift.shiftId }),
      paymentMethod: "CARD",
    } as unknown as Parameters<typeof replayOfflineReception>[0];
    await expect(replayOfflineReception(nonCash, CASHIER)).rejects.toThrow(/نقدي فقط/);

    const printNonCash = {
      branchId: 1,
      shiftId: shift.shiftId,
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: "250.00" }],
      payment: { amount: "250.00", method: "CARD" },
      clientRequestId: "off-print-x",
      capturedAt: nowIso(),
      offlineReceiptNumber: "OFF-1-ab-9",
    } as unknown as Parameters<typeof replayOfflinePrintSale>[0];
    await expect(replayOfflinePrintSale(printNonCash, CASHIER)).rejects.toThrow(/نقدي فقط/);
  });

  it("O6 — replay الطباعة وحده يسجّل استهلاك المادة بالسالب ويُوسَم بالمنشأ", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "0", shiftType: "PRINT_SERVICES" },
      { userId: 2, branchId: 1 },
    );
    await db().update(s.branchStock).set({ quantity: 0 }).where(eq(s.branchStock.variantId, 3));
    const res = await replayOfflinePrintSale(
      {
        branchId: 1,
        shiftId: shift.shiftId,
        priceTier: "RETAIL",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "2", unitPriceOverride: "250.00" }],
        payment: { amount: "500.00", method: "CASH" },
        clientRequestId: "off-print-0001",
        capturedAt: nowIso(),
        offlineReceiptNumber: "OFF-1-ab-2",
        deviceId: "ab",
      },
      CASHIER,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId));
    expect(inv.originatedOffline).toBe(true);
    expect(inv.offlineReceiptNumber).toBe("OFF-1-ab-2");
    expect(inv.total).toBe("500.00");
    expect(inv.costTotal).toBe("60.00");
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    expect(item.lineCost).toBe("60.00");
    expect(item.serviceMaterialsSnapshotted).toBe(true);
    const [snapshot] = await db().select().from(s.invoiceItemServiceMaterials)
      .where(eq(s.invoiceItemServiceMaterials.invoiceItemId, item.id));
    expect(Number(snapshot.materialVariantId)).toBe(3);
    expect(Number(snapshot.baseQuantity)).toBe(2);
    expect(snapshot.lineCost).toBe("60.00");
    const [materialStock] = await db().select().from(s.branchStock)
      .where(sql`${s.branchStock.variantId} = 3 AND ${s.branchStock.branchId} = 1`);
    expect(Number(materialStock.quantity)).toBe(-2);
    const materialMoves = await db().select().from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceId, res.invoiceId));
    expect(materialMoves.map((movement) => [
      Number(movement.variantId),
      movement.movementType,
      Number(movement.quantity),
      movement.notes,
    ])).toEqual([[3, "OUT", 2, "استهلاك مادة خدمة"]]);
  });
});
