import { describe, expect, it } from "vitest";
import { markPosTabsStockStale, reconcilePosTabsStock } from "./posStockRefresh";

describe("تحديث مخزون سلال الكاشير", () => {
  it("يعتبر مخزون المسودة مجهولاً حتى تصل أول لقطة حيّة", () => {
    const tabs = [{ id: 1, cart: [{ row: { branchId: 1, productUnitId: 3, stockBase: 90, reservedBase: 5, availableBase: 85, isService: false }, qty: 1 }] }];
    const [stale] = markPosTabsStockStale(tabs);

    expect(stale.cart[0].row).toMatchObject({ stockBase: 90 });
    expect(stale.cart[0].row.branchId).toBeUndefined();
    expect(stale.cart[0].row.availableBase).toBeUndefined();
    expect(tabs[0].cart[0].row.availableBase).toBe(85);
  });

  it("يستبدل لقطة المسودة القديمة في كل التبويبات ولقطة ما قبل الكوبون", () => {
    const staleRow = { branchId: 1, productUnitId: 7, stockBase: 0, reservedBase: 0, availableBase: 0, openedAt: null, isService: false };
    const tabs = [
      { id: 1, cart: [{ row: staleRow, preCouponRow: staleRow, qty: 1 }] },
      { id: 2, cart: [{ row: { ...staleRow, stockBase: 4 }, qty: 2 }] },
    ];

    const refreshed = reconcilePosTabsStock(
      tabs,
      [{ branchId: 1, productUnitId: 7, stockBase: 80, reservedBase: 0, availableBase: 80, openedAt: "2026-08-15", isService: false }],
      1,
    );

    expect(refreshed[0].cart[0].row.stockBase).toBe(80);
    expect(refreshed[0].cart[0].preCouponRow?.stockBase).toBe(80);
    expect(refreshed[1].cart[0].row.stockBase).toBe(80);
    expect(tabs[0].cart[0].row.stockBase).toBe(0);
  });

  it("يربط الرصيد بالفرع الفعلي ويصفّر وحدة حُذفت بدلاً من إبقاء رقم كاذب", () => {
    const tabs = [{ id: 1, cart: [{ row: { branchId: 1, productUnitId: 9, stockBase: 25, isService: false }, qty: 1 }] }];
    const refreshed = reconcilePosTabsStock(tabs, [], 2);

    expect(refreshed[0].cart[0].row).toMatchObject({
      branchId: 2,
      stockBase: 0,
      reservedBase: 0,
      availableBase: 0,
    });
  });

  it("تجعل اللقطة الأحدث هي الظاهرة بلا تعديل المدخل عند تحديثين متعاقبين", () => {
    const tabs = [{ id: 1, cart: [{ row: { branchId: 1, productUnitId: 5, stockBase: 10, isService: false }, qty: 1 }] }];
    const first = reconcilePosTabsStock(
      tabs,
      [{ branchId: 1, productUnitId: 5, stockBase: 9, reservedBase: 2, availableBase: 7, openedAt: null, isService: false }],
      1,
    );
    const latest = reconcilePosTabsStock(
      first,
      [{ branchId: 1, productUnitId: 5, stockBase: -1, reservedBase: 0, availableBase: 0, openedAt: null, isService: false }],
      1,
    );

    expect(latest[0].cart[0].row).toMatchObject({ stockBase: -1, reservedBase: 0, availableBase: 0 });
    expect(first[0].cart[0].row).toMatchObject({ stockBase: 9, reservedBase: 2, availableBase: 7 });
  });
});
