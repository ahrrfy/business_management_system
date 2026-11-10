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
import { updateProductWithVariants } from "../productEditService";
import { createPrintSale } from "../printSaleService";

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
  "invoiceItems",
  "invoices",
  "receipts",
  "shifts",
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

  it("يصون المتغيرات الإرثية المتطابقة عند التعديل عبر updateProductWithVariants ويبيع الناتج المخزني المفعّل للطباعة", async () => {
    // 1) Codex #1: منتج تاريخي فيه متغيّران عاديّان تتطابق أبعادهما بعد التطبيع يظل قابلاً للتعديل دون كسر
    await db().insert(s.products).values({
      id: 50,
      name: "ملف تعليق إرثي",
      categoryId: 1,
      stockUsage: "SALE_ONLY",
      showInStore: false,
      isActive: true,
    });
    await db().insert(s.productVariants).values([
      { id: 501, productId: 50, sku: "LEG-501", color: "أحمر", size: "A4", costPrice: "500.00", isActive: true },
      { id: 502, productId: 50, sku: "LEG-502", color: "احمر", size: "a4", costPrice: "500.00", isActive: true },
    ]);
    await db().insert(s.productUnits).values([
      { id: 5001, variantId: 501, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-LEG-501" },
      { id: 5002, variantId: 502, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-LEG-502" },
    ]);
    await db().insert(s.productPrices).values([
      { productUnitId: 5001, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 5002, priceTier: "RETAIL", price: "1000.00" },
    ]);

    await updateProductWithVariants(
      {
        productId: 50,
        name: "ملف تعليق إرثي — محدّث",
        unitTemplate: [
          {
            unitName: "قطعة",
            conversionFactor: "1",
            isBaseUnit: true,
            prices: [{ priceTier: "RETAIL", price: "1250.00" }],
          },
        ],
        variants: [
          { id: 501, sku: "LEG-501", color: "أحمر", size: "A4", costPrice: "500.00", unitBarcodes: { قطعة: "BC-LEG-501" } },
          { id: 502, sku: "LEG-502", color: "احمر", size: "a4", costPrice: "500.00", unitBarcodes: { قطعة: "BC-LEG-502" } },
        ],
      },
      actor,
    );

    await expect(
      updateProductWithVariants(
        {
          productId: 50,
          unitTemplate: [
            {
              unitName: "قطعة",
              conversionFactor: "1",
              isBaseUnit: true,
              prices: [{ priceTier: "RETAIL", price: "1250.00" }],
            },
          ],
          variants: [
            { id: 501, sku: "LEG-501", color: "أحمر", size: "A4", costPrice: "500.00", unitBarcodes: { قطعة: "BC-LEG-501" } },
            { id: 502, sku: "LEG-502", color: "احمر", size: "a4", costPrice: "500.00", unitBarcodes: { قطعة: "BC-LEG-502" } },
            { sku: "LEG-503", color: "أحمر", size: "A4", costPrice: "500.00", unitBarcodes: { قطعة: "BC-LEG-503" } },
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 2) Codex #3: ناتج مخزني مفعّل في شاشة الطباعة (isService=false, productType=null, showInPrintPos=true) يمرّ في createPrintSale
    const stockedPrint = await createProduct(
      {
        name: "ملزمة مطبوعة جاهزة",
        categoryId: 1,
        isService: false,
        showInPrintPos: true,
        variants: [
          {
            sku: "SVC-STOCKED-PRINT",
            costPrice: "1000.00",
            units: [
              {
                unitName: "نسخة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "BC-STOCKED-PRINT",
                prices: [{ priceTier: "RETAIL", price: "2500.00" }],
              },
            ],
          },
        ],
      },
      actor,
    );
    const allVars = await db().select().from(s.productVariants);
    const stockedPrintVar = allVars.find((v) => Number(v.productId) === stockedPrint.productId)!;
    const allUnits = await db().select().from(s.productUnits);
    const stockedPrintUnit = allUnits.find((u) => Number(u.variantId) === Number(stockedPrintVar.id))!;

    await db().insert(s.branchStock).values({
      branchId: 1,
      variantId: Number(stockedPrintVar.id),
      quantity: 20,
    });
    await db().insert(s.shifts).values({
      id: 901,
      branchId: 1,
      userId: 1,
      shiftType: "PRINT_SERVICES",
      openingBalance: "0.00",
      status: "OPEN",
      openGuard: "1:1:PRINT_SERVICES",
    });

    const saleRes = await createPrintSale(
      {
        branchId: 1,
        shiftId: 901,
        payment: { method: "CASH", amount: "5000.00" },
        lines: [
          {
            variantId: Number(stockedPrintVar.id),
            productUnitId: Number(stockedPrintUnit.id),
            quantity: "2",
          },
        ],
      },
      actor,
    );
    expect(saleRes.invoiceId).toBeGreaterThan(0);
    expect(saleRes.total).toBe("5000.00");
  });
});
