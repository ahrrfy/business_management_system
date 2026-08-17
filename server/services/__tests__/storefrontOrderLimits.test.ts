import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createOnlineOrder,
  normalizeOnlineOrderLines,
  quoteOnlineOrder,
} from "../onlineOrderService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const baseOrder = {
  customerName: "Test customer",
  customerPhone: "07701234567",
  governorate: "baghdad",
  addressText: "Test address",
};

beforeEach(async () => {
  await truncateAllTables();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.products)
    .values({ id: 1, name: "Colored pen", showInStore: true });
  await db()
    .insert(s.productVariants)
    .values([
      {
        id: 1,
        productId: 1,
        sku: "PEN-BLUE",
        color: "أزرق",
        costPrice: "100.00",
      },
      {
        id: 2,
        productId: 1,
        sku: "PEN-RED",
        color: "أحمر",
        costPrice: "100.00",
      },
    ]);
  await db()
    .insert(s.productUnits)
    .values([
      {
        id: 1,
        variantId: 1,
        unitName: "piece",
        isBaseUnit: true,
        isStoreSaleUnit: true,
      },
      {
        id: 2,
        variantId: 2,
        unitName: "piece",
        isBaseUnit: true,
        isStoreSaleUnit: true,
      },
    ]);
  await db()
    .insert(s.productPrices)
    .values([
      { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
      { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 20 },
      { variantId: 2, branchId: 1, quantity: 20 },
    ]);
  await db()
    .insert(s.storeSettings)
    .values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
});

describe("online storefront cart normalization and bounds", () => {
  it("يدمج تكرار الوحدة ويحافظ على لونين مستقلين في quote والطلب", async () => {
    const quote = await quoteOnlineOrder({
      governorate: "baghdad",
      lines: [
        { productUnitId: 1, quantity: 1 },
        { productUnitId: 2, quantity: 2 },
        { productUnitId: 1, quantity: 3 },
      ],
    });
    expect(
      quote.lines.map((line) => [line.productUnitId, line.quantity]),
    ).toEqual([
      [1, 4],
      [2, 2],
    ]);

    const created = await createOnlineOrder({
      ...baseOrder,
      clientRequestId: "duplicate-colors-normalized",
      lines: [
        { productUnitId: 1, quantity: 1, expectedUnitPrice: "1000" },
        { productUnitId: 2, quantity: 2, expectedUnitPrice: "1000.00" },
        { productUnitId: 1, quantity: 3, expectedUnitPrice: "1000.00" },
      ],
      expectedGrandTotal: quote.total,
    });
    const stored = await db().select().from(s.onlineOrderItems);
    expect(created.itemCount).toBe(2);
    expect(
      stored.map((line) => [Number(line.productUnitId), Number(line.quantity)]),
    ).toEqual([
      [1, 4],
      [2, 2],
    ]);
  });

  it("يرفض السعر المتوقع المتضارب لنفس الوحدة قبل أي كتابة", async () => {
    await expect(
      createOnlineOrder({
        ...baseOrder,
        lines: [
          { productUnitId: 1, quantity: 1, expectedUnitPrice: "1000.00" },
          { productUnitId: 1, quantity: 1, expectedUnitPrice: "900.00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
  });

  it("يرفض أكثر من 30 وحدة مختلفة في quote والإنشاء قبل مسح الكتالوج", async () => {
    const lines = Array.from({ length: 31 }, (_, index) => ({
      productUnitId: index + 1,
      quantity: 1,
    }));
    await expect(
      quoteOnlineOrder({ governorate: "baghdad", lines }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createOnlineOrder({ ...baseOrder, lines }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض تجاوز 999 للوحدة أو 10000 قطعة للسلة بعد دمج التكرار", () => {
    expect(() =>
      normalizeOnlineOrderLines([
        { productUnitId: 1, quantity: 600 },
        { productUnitId: 1, quantity: 400 },
      ]),
    ).toThrow(/999/);

    expect(() =>
      normalizeOnlineOrderLines(
        Array.from({ length: 11 }, (_, index) => ({
          productUnitId: index + 1,
          quantity: 999,
        })),
      ),
    ).toThrow(/10000/);
  });
});
