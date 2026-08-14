export interface LivePosStockRow {
  branchId: number;
  productUnitId: number;
  stockBase: number;
  reservedBase: number;
  availableBase: number;
  openedAt: Date | string | null;
  isService: boolean;
}

type StockAwareRow = {
  branchId?: number;
  productUnitId: number;
  stockBase: number;
  reservedBase?: number;
  availableBase?: number;
  openedAt?: Date | string | null;
  isService: boolean;
};

type StockAwareCartItem<R extends StockAwareRow> = {
  row: R;
  preCouponRow?: R;
};

/** المسودة تحفظ تفاصيل البيع لا حقيقة المخزون؛ تُوسَم مجهولة حتى تصل أول لقطة حيّة. */
export function markPosTabsStockStale<
  R extends StockAwareRow,
  I extends StockAwareCartItem<R>,
  T extends { cart: I[] },
>(tabs: T[]): T[] {
  const markRow = (row: R): R => ({
    ...row,
    branchId: undefined,
    reservedBase: undefined,
    availableBase: undefined,
  });
  return tabs.map((tab) => ({
    ...tab,
    cart: tab.cart.map((item) => ({
      ...item,
      row: markRow(item.row),
      ...(item.preCouponRow ? { preCouponRow: markRow(item.preCouponRow) } : {}),
    })),
  })) as T[];
}

/** يحدّث كل تبويبات الكاشير، بما فيها لقطة ما قبل الكوبون، من قراءة مخزون خادمية واحدة. */
export function reconcilePosTabsStock<
  R extends StockAwareRow,
  I extends StockAwareCartItem<R>,
  T extends { cart: I[] },
>(tabs: T[], snapshotRows: LivePosStockRow[], effectiveBranchId: number): T[] {
  const byUnitId = new Map(snapshotRows.map((row) => [row.productUnitId, row]));

  const refreshRow = (row: R): R => {
    const snapshot = byUnitId.get(row.productUnitId);
    if (!snapshot) {
      return {
        ...row,
        branchId: effectiveBranchId,
        stockBase: 0,
        reservedBase: 0,
        availableBase: 0,
      };
    }
    return {
      ...row,
      branchId: snapshot.branchId,
      stockBase: snapshot.stockBase,
      reservedBase: snapshot.reservedBase,
      availableBase: snapshot.availableBase,
      openedAt: snapshot.openedAt,
      isService: snapshot.isService,
    };
  };

  return tabs.map((tab) => ({
    ...tab,
    cart: tab.cart.map((item) => ({
      ...item,
      row: refreshRow(item.row),
      ...(item.preCouponRow ? { preCouponRow: refreshRow(item.preCouponRow) } : {}),
    })),
  })) as T[];
}
