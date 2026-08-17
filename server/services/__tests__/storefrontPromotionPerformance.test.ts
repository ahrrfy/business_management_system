import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  loadPromotionRuleSnapshot,
  resolvePromotionForLine,
  resolvePromotionFromSnapshot,
} from "../salesPromotionService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "promotionTargets",
    "promotions",
    "productVariants",
    "products",
    "categories",
    "users",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "promo_snapshot_admin",
    name: "Admin",
    role: "admin",
    loginMethod: "local",
  });
  await db().insert(s.categories).values({ id: 7, name: "Stationery" });
  await db().insert(s.products).values({ id: 10, name: "Pen", categoryId: 7 });
  await db()
    .insert(s.productVariants)
    .values([
      { id: 101, productId: 10, sku: "PEN-BLUE", costPrice: "1.00" },
      { id: 102, productId: 10, sku: "PEN-RED", costPrice: "1.00" },
    ]);
});

describe("storefront promotion snapshot", () => {
  it("يعطي resolver النقي النتيجة نفسها للمحرّك الحاكم عبر النطاق والحد الأدنى والأسبقية", async () => {
    await db()
      .insert(s.promotions)
      .values([
        {
          id: 1,
          name: "عام 10%",
          type: "PERCENT",
          discountPercent: "10.00",
          discountAmount: "0.00",
          scope: "ALL",
          effectiveFrom: new Date("2026-01-01"),
          effectiveTo: new Date("2026-12-31"),
          branchId: 1,
          customerTier: "RETAIL",
          minLineAmount: "0.00",
          priority: 1,
          isActive: true,
          applicationMode: "AUTO",
          isStoreManaged: true,
          createdBy: 1,
        },
        {
          id: 2,
          name: "منتج 30",
          type: "AMOUNT",
          discountPercent: "0.00",
          discountAmount: "30.00",
          scope: "PRODUCTS",
          effectiveFrom: new Date("2026-01-01"),
          effectiveTo: new Date("2026-12-31"),
          branchId: 1,
          customerTier: "RETAIL",
          minLineAmount: "200.00",
          priority: 5,
          isActive: true,
          applicationMode: "AUTO",
          isStoreManaged: true,
          createdBy: 1,
        },
        {
          id: 3,
          name: "لون 30 أسبق",
          type: "AMOUNT",
          discountPercent: "0.00",
          discountAmount: "30.00",
          scope: "PRODUCTS",
          effectiveFrom: new Date("2026-01-01"),
          effectiveTo: new Date("2026-12-31"),
          branchId: 1,
          customerTier: "RETAIL",
          minLineAmount: "200.00",
          priority: 5,
          isActive: true,
          applicationMode: "AUTO",
          isStoreManaged: true,
          createdBy: 1,
        },
      ]);
    await db()
      .insert(s.promotionTargets)
      .values([
        { promotionId: 2, productId: 10 },
        { promotionId: 3, variantId: 101 },
      ]);

    await withTx(async (tx) => {
      const snapshot = await loadPromotionRuleSnapshot(tx, {
        branchId: 1,
        customerTier: "RETAIL",
        todayYmd: "2026-08-17",
        includeStoreManaged: true,
      });
      const cases = [
        {
          productId: 10,
          variantId: 101,
          categoryId: 7,
          unitPrice: "100.00",
          lineAmount: "300.00",
        },
        {
          productId: 10,
          variantId: 102,
          categoryId: 7,
          unitPrice: "100.00",
          lineAmount: "100.00",
        },
        {
          productId: 99,
          variantId: 999,
          categoryId: null,
          unitPrice: "20.00",
          lineAmount: "20.00",
        },
      ];
      for (const line of cases) {
        const input = {
          branchId: 1,
          customerTier: "RETAIL" as const,
          hasContractPrice: false,
          todayYmd: "2026-08-17",
          includeStoreManaged: true,
          ...line,
        };
        expect(resolvePromotionFromSnapshot(snapshot, input)).toEqual(
          await resolvePromotionForLine(tx, input),
        );
      }
    });
  });

  it("يحمّل snapshot في استعلامين ثابتين مهما كان عدد المنتجات", async () => {
    const promotionRows = [
      {
        id: 1,
        name: "عام",
        type: "PERCENT",
        discountPercent: "10.00",
        discountAmount: "0.00",
        scope: "ALL",
        priority: 0,
        minLineAmount: "0.00",
      },
    ];
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ orderBy: async () => promotionRows }) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ orderBy: async () => [] }) }),
      }));

    const snapshot = await loadPromotionRuleSnapshot({ select } as never, {
      branchId: 1,
      customerTier: "RETAIL",
      todayYmd: "2026-08-17",
      includeStoreManaged: true,
    });

    expect(snapshot.rules).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(2);
    for (let productId = 1; productId <= 100; productId += 1) {
      resolvePromotionFromSnapshot(snapshot, {
        branchId: 1,
        customerTier: "RETAIL",
        productId,
        variantId: productId,
        categoryId: null,
        unitPrice: "100.00",
        lineAmount: "100.00",
        hasContractPrice: false,
        todayYmd: "2026-08-17",
        includeStoreManaged: true,
      });
    }
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("يثبّت أن كتالوج المتجر يحمل snapshot مرة ولا يستدعي resolver القاعدي داخل حلقة", () => {
    const source = readFileSync(
      new URL("../storefrontService.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/loadPromotionRuleSnapshot\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/resolvePromotionForLine\(/);
  });
});
