/**
 * اختبارات حزمة CATALOG-SURGICAL-20261107:
 * 1) فصل تصنيف الاستخدام المخزني (`stockUsage`: SALE_ONLY / MATERIAL_ONLY / SALE_AND_MATERIAL / OPERATING_SUPPLY)
 *    عبر قنوات البيع (POS) والوصفات والشراء والصرف الداخلي للمصروفات.
 * 2) القيمة الافتراضية لـ `showInStore = false` وحارس الجاهزية قبل النشر في المتجر.
 * 3) تكافؤ إعادة الطلب (`clientRequestId`) في `createProduct` ومنع التكرار الصامت.
 * 4) مطابقة باركود مكونات البكج مع إرجاع `conversionFactor` وحجب المواد الخام عن البكجات البيعية.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { truncateTables } from "./__testUtils__";
import type { TrpcContext } from "../../context";
import { bundlesRouter } from "../../routers/bundlesRouter";
import { getDb } from "../../db";
import * as s from "../../../drizzle/schema";
import {
  createProduct,
  listForPos,
  listForPurchase,
  listMaterialsForRecipe,
  type CreateProductInput,
} from "../catalogService";
import { createExpense } from "../expenseService";

const TABLES = [
  "auditLogs",
  "idempotencyKeys",
  "documentCounters",
  "accountingEntries",
  "inventoryMovements",
  "branchStock",
  "expenseStockItems",
  "expenses",
  "expenseCategories",
  "receipts",
  "bundleComponents",
  "productImages",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "suppliers",
  "users",
  "branches",
] as const;

const db = () => {
  const d = getDb();
  if (!d) throw new Error("DB unavailable");
  return d;
};

async function reset() {
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    code: "MAIN",
    name: "الفرع الرئيسي",
    type: "MAIN",
    isActive: true,
  });
  await d.insert(s.categories).values({
    id: 1,
    name: "قرطاسية",
  });
  await d.insert(s.users).values({
    id: 1,
    openId: "catalog-manager-1",
    name: "مدير الكتالوج",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    isActive: true,
    isOwner: true,
  });
}

const actor = { userId: 1, branchId: 1, role: "admin", isOwner: true };

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("CATALOG-SURGICAL-20261107 — عزل قنوات stockUsage وجاهزية المتجر و clientRequestId", () => {
  it("يعزل القنوات بدقة حسب stockUsage ويبقي showInStore=false افتراضياً", async () => {
    const saleOnly = await createProduct(
      {
        name: "دفتر جامعي للبيع فقط",
        categoryId: 1,
        stockUsage: "SALE_ONLY",
        variants: [
          {
            color: "افتراضي",
            size: "A4",
            sku: "SKU-SALE-ONLY",
            costPrice: "1000.00",
            units: [
              {
                unitName: "قطعة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "BC-SALE-ONLY",
                prices: [{ priceTier: "RETAIL", price: "1500.00" }],
              },
            ],
          },
        ],
      },
      actor,
    );

    const materialOnly = await createProduct(
      {
        name: "رول فينيل خام للإنتاج",
        categoryId: 1,
        stockUsage: "MATERIAL_ONLY",
        variants: [
          {
            color: "أبيض",
            size: "1m",
            sku: "SKU-MAT-ONLY",
            costPrice: "5000.00",
            units: [
              {
                unitName: "متر",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "BC-MAT-ONLY",
                prices: [{ priceTier: "RETAIL", price: "0.00" }],
              },
            ],
          },
        ],
      },
      actor,
    );

    const dualUse = await createProduct(
      {
        name: "ورق مقوى مزدوج الاستخدام",
        categoryId: 1,
        stockUsage: "SALE_AND_MATERIAL",
        variants: [
          {
            color: "أبيض",
            size: "A3",
            sku: "SKU-DUAL-USE",
            costPrice: "2000.00",
            units: [
              {
                unitName: "رزمة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "BC-DUAL-USE",
                prices: [{ priceTier: "RETAIL", price: "3000.00" }],
              },
            ],
          },
        ],
      },
      actor,
    );

    const operatingSupply = await createProduct(
      {
        name: "أكياس تغليف داخلية",
        categoryId: 1,
        stockUsage: "OPERATING_SUPPLY",
        variants: [
          {
            color: "شفاف",
            size: "كبير",
            sku: "SKU-OP-SUPPLY",
            costPrice: "500.00",
            units: [
              {
                unitName: "ربطة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "BC-OP-SUPPLY",
                prices: [{ priceTier: "RETAIL", price: "0.00" }],
              },
            ],
          },
        ],
      },
      actor,
    );

    // 1) showInStore الافتراضي مغلق (false) لجميع المنتجات الجديدة
    const allProducts = await db().select().from(s.products);
    expect(allProducts.every((p) => p.showInStore === false)).toBe(true);

    const variants = await db().select().from(s.productVariants);
    const saleVarId = Number(
      variants.find((v) => Number(v.productId) === saleOnly.productId)!.id,
    );
    const matVarId = Number(
      variants.find((v) => Number(v.productId) === materialOnly.productId)!.id,
    );
    const dualVarId = Number(
      variants.find((v) => Number(v.productId) === dualUse.productId)!.id,
    );
    const supplyVarId = Number(
      variants.find((v) => Number(v.productId) === operatingSupply.productId)!.id,
    );

    // 2) POS يرى فقط SALE_ONLY و SALE_AND_MATERIAL
    const posRows = await listForPos(1, "RETAIL");
    const posProductIds = new Set(posRows.map((r) => Number(r.productId)));
    expect(posProductIds.has(saleOnly.productId)).toBe(true);
    expect(posProductIds.has(dualUse.productId)).toBe(true);
    expect(posProductIds.has(materialOnly.productId)).toBe(false);
    expect(posProductIds.has(operatingSupply.productId)).toBe(false);

    // 3) الوصفات وأوامر العمل ترى فقط MATERIAL_ONLY و SALE_AND_MATERIAL
    const recipeMaterials = await listMaterialsForRecipe();
    const recipeVarIds = new Set(recipeMaterials.map((r) => Number(r.variantId)));
    expect(recipeVarIds.has(matVarId)).toBe(true);
    expect(recipeVarIds.has(dualVarId)).toBe(true);
    expect(recipeVarIds.has(saleVarId)).toBe(false);
    expect(recipeVarIds.has(supplyVarId)).toBe(false);

    // 4) الشراء يرى الأصناف المملوكة الأربعة كلها
    const purchaseRows = await listForPurchase(1);
    const purchaseProductIds = new Set(
      purchaseRows.map((r) => Number(r.productId)),
    );
    expect(purchaseProductIds.has(saleOnly.productId)).toBe(true);
    expect(purchaseProductIds.has(materialOnly.productId)).toBe(true);
    expect(purchaseProductIds.has(dualUse.productId)).toBe(true);
    expect(purchaseProductIds.has(operatingSupply.productId)).toBe(true);

    // 5) الصرف الداخلي للمصروفات المخزنية يقبل OPERATING_SUPPLY ويرفض SALE_ONLY
    await db().insert(s.branchStock).values([
      { branchId: 1, variantId: saleVarId, quantity: 10 },
      { branchId: 1, variantId: supplyVarId, quantity: 10 },
    ]);

    await expect(
      createExpense(
        {
          branchId: 1,
          category: "SUPPLIES",
          amount: "0",
          paymentMethod: "CASH",
          source: "STOCK",
          stockReason: "INTERNAL_USE",
          description: "محاولة صرف سلعة بيع كمصروف داخلي",
          items: [{ variantId: saleVarId, baseQuantity: 1 }],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const supplyExp = await createExpense(
      {
        branchId: 1,
        category: "SUPPLIES",
        amount: "0",
        paymentMethod: "CASH",
        source: "STOCK",
        stockReason: "INTERNAL_USE",
        description: "صرف أكياس تغليف تشغيلية",
        items: [{ variantId: supplyVarId, baseQuantity: 2 }],
      },
      actor,
    );
    expect(supplyExp.expenseId).toBeGreaterThan(0);
  });

  it("يطبق clientRequestId في createProduct ويحمي نشر المتجر ويعيد معامل التحويل في باركود مكونات البكج", async () => {
    const payload: CreateProductInput = {
      name: "قلم حبر أزرق",
      categoryId: 1,
      stockUsage: "SALE_ONLY",
      clientRequestId: "create-prod-idem-1",
      variants: [
        {
          color: "أزرق",
          size: "0.7mm",
          sku: "SKU-PEN-BLUE",
          costPrice: "200.00",
          units: [
            {
              unitName: "قطعة",
              conversionFactor: "1",
              isBaseUnit: true,
              barcode: "BC-PEN-1",
              prices: [{ priceTier: "RETAIL", price: "350.00" }],
            },
            {
              unitName: "علبة 12",
              conversionFactor: "12",
              isBaseUnit: false,
              barcode: "BC-PEN-BOX12",
              prices: [{ priceTier: "RETAIL", price: "3900.00" }],
            },
          ],
        },
      ],
    };

    const first = await createProduct(payload, actor);
    const replay = await createProduct(payload, actor);
    expect(replay).toMatchObject({
      productId: first.productId,
      replayed: true,
    });

    await expect(
      createProduct({ ...payload, name: "اسم مختلف لنفس المفتاح" }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // حجب تفعيل showInStore للمادة الخام
    await expect(
      createProduct(
        {
          name: "حبر خام لا ينشر في المتجر",
          categoryId: 1,
          stockUsage: "MATERIAL_ONLY",
          showInStore: true,
          variants: [
            {
              color: "أسود",
              size: "1L",
              sku: "SKU-RAW-INK",
              costPrice: "12000.00",
              units: [
                {
                  unitName: "لتر",
                  conversionFactor: "1",
                  isBaseUnit: true,
                  prices: [{ priceTier: "RETAIL", price: "15000.00" }],
                },
              ],
            },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // مطابقة باركود علبة 12 في البكج تعيد conversionFactor = "12"
    const bundlesCaller = bundlesRouter.createCaller({
      req: { headers: {} },
      res: {},
      sessionId: null,
      platformAdmin: null,
      user: {
        id: 1,
        openId: "catalog-manager-1",
        name: "مدير الكتالوج",
        role: "admin",
        branchId: 1,
        isActive: true,
        isOwner: true,
      },
    } as unknown as TrpcContext);

    const lookup = await bundlesCaller.lookupComponentByBarcode({
      barcode: "BC-PEN-BOX12",
    });
    expect(lookup.item).not.toBeNull();
    expect(Number(lookup.item?.conversionFactor)).toBe(12);
  });
});
