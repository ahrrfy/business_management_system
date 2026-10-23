import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { inArray } from "drizzle-orm";
import { products } from "../../../drizzle/schema";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  hydratedIds: [] as number[][],
  sold: new Map<number, number>(),
  discounts: new Map<number, string>(),
  stock: new Map<number, number>(),
  barcode: null as number | null,
}));
vi.mock("../../db", () => ({ getDb: () => ({ select: selectRows }) }));
vi.mock("../storefrontContextService", () => ({
  requireActiveBranch: async (id: number) => id,
  requireStorefrontContext: async () => ({ branchId: 7 }),
}));
vi.mock("../catalog/variantAvailability", () => ({
  loadVariantAvailability: async (
    _db: unknown,
    _branch: number,
    ids: number[],
  ) =>
    new Map(
      ids.map((id) => [
        id,
        {
          availableBase: state.stock.get(id) ?? 100,
          onHandBase: 100,
          reservedBase: 0,
          hasStockRow: true,
        },
      ]),
    ),
}));
vi.mock("../catalog/barcodeAliases", () => ({
  resolveBarcodeOwnerResult: async () =>
    state.barcode == null
      ? { status: "NOT_FOUND" }
      : { status: "FOUND", owner: { productUnitId: state.barcode } },
}));
vi.mock("../tx", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("../salesPromotionService", () => ({
  loadPromotionRuleSnapshot: async () => ({}),
  resolvePromotionFromSnapshot: (
    _snapshot: unknown,
    input: { productId: number },
  ) =>
    state.discounts.has(input.productId)
      ? {
          discountForUnit: state.discounts.get(input.productId),
          promotionName: "عرض",
        }
      : null,
}));

import { storefrontCatalog } from "../storefrontService";

const dialect = new MySqlDialect();
function selectRows(fields: Record<string, unknown>) {
  const isCandidates = "hasImage" in fields;
  const isCards = "productName" in fields && !isCandidates;
  let result: any[] =
    isCandidates || isCards
      ? state.rows
      : "n" in fields
        ? Array.from(state.sold, ([productId, n]) => ({ productId, n }))
        : [];
  const query: any = {
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: (condition: any) => {
      const sql = dialect.sqlToQuery(condition);
      // Model the two SQL identity restrictions; all publication/retail predicates are fixed by the fixture.
      const idsSql = dialect.sqlToQuery(inArray(products.id, [901]));
      const idPrefix = idsSql.sql.slice(0, idsSql.sql.indexOf("("));
      if (sql.sql.includes(idPrefix)) {
        const last = sql.sql.lastIndexOf(idPrefix);
        const countBefore = (sql.sql.slice(0, last).match(/\?/g) ?? []).length;
        const idCount = (sql.sql.slice(last).split(")")[0].match(/\?/g) ?? [])
          .length;
        const ids = sql.params.slice(countBefore, countBefore + idCount);
        if (isCandidates || isCards)
          result = result.filter((row) => ids.includes(row.productId));
      }
      if (state.barcode != null && (isCandidates || isCards))
        result = result.filter((row) => row.productUnitId === state.barcode);
      if (isCards) state.hydratedIds.push(result.map((row) => row.productId));
      return query;
    },
    orderBy: () => query,
    groupBy: () => query,
    then: (resolve: (rows: any[]) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  return query;
}

beforeEach(() => {
  state.rows = Array.from({ length: 65 }, (_, index) => {
    const id = index + 1;
    return {
      productId: id,
      productUnitId: id,
      variantId: id,
      categoryId: 2,
      productName: `منتج ${String(id).padStart(3, "0")}`,
      storeTitle: null,
      brand: id === 65 ? "بعيد" : "عام",
      price: String(20_000 + id),
      conversionFactor: "1",
      isFeatured: false,
      hasImage: 0,
      variantKind: "STANDARD",
      unitName: "قطعة",
      imageUrl: null,
      productType: "STANDARD",
      isCustomizable: false,
      isBundle: false,
    };
  });
  state.hydratedIds = [];
  state.sold.clear();
  state.discounts.clear();
  state.stock.clear();
  state.barcode = null;
});

describe("catalog refinements before cursor pagination", () => {
  it("finds a matching brand beyond the former first 48 cards and hydrates only the match", async () => {
    const page = await storefrontCatalog({
      branchId: 7,
      brand: "بعيد",
      limit: 48,
    });
    expect(page.items.map((item) => item.productId)).toEqual([65]);
    expect(page.brands).toEqual(["بعيد", "عام"]);
    expect(state.hydratedIds).toEqual([[65]]);
  });

  it("filters on the displayed promotional price before limiting, including thresholds", async () => {
    state.discounts.set(65, "20000");
    const page = await storefrontCatalog({
      branchId: 7,
      priceFilter: "UNDER_5000",
      limit: 2,
    });
    expect(page.items.map((item) => [item.productId, item.salePrice])).toEqual([
      [65, "65.00"],
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("sorts the entire catalog by price and advances without duplicates", async () => {
    const first = await storefrontCatalog({
      branchId: 7,
      sort: "PRICE_DESC",
      limit: 2,
    });
    const second = await storefrontCatalog({
      branchId: 7,
      sort: "PRICE_DESC",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(first.items.map((item) => item.productId)).toEqual([65, 64]);
    expect(second.items.map((item) => item.productId)).toEqual([63, 62]);
    expect(state.hydratedIds).toEqual([
      [64, 65],
      [62, 63],
    ]);
  });

  it("uses full-catalog sold counts, while keeping available products before unavailable ones", async () => {
    state.sold.set(65, 100);
    state.sold.set(64, 20);
    state.stock.set(65, 0);
    const page = await storefrontCatalog({
      branchId: 7,
      sort: "BEST_SELLERS",
      availability: "ALL",
      limit: 2,
    });
    expect(page.items.map((item) => item.productId)).toEqual([64, 1]);
  });

  it("preserves barcode unit identity and price instead of selecting a cheaper sibling unit", async () => {
    state.rows = [
      state.rows[0],
      {
        ...state.rows[0],
        productUnitId: 101,
        conversionFactor: "12",
        price: "50000",
      },
    ];
    state.barcode = 101;
    const page = await storefrontCatalog({
      branchId: 7,
      search: "barcode",
      sort: "PRICE_ASC",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ productUnitId: 101, price: "50000" });
  });

  it("applies product scopes before pagination and rejects an obsolete cursor safely", async () => {
    const scoped = await storefrontCatalog({
      branchId: 7,
      productIds: [65],
      limit: 1,
    });
    expect(scoped.items.map((item) => item.productId)).toEqual([65]);
    const stale = await storefrontCatalog({
      branchId: 7,
      productIds: [65],
      cursor: 1,
      limit: 1,
    });
    expect(stale).toMatchObject({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
