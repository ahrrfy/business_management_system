/** Display vocabulary for inventory quantities, movement kinds and stocktake scope. */
export type InventoryStockStatus = "out" | "low" | "ok";
export const INVENTORY_STOCK_STATUS_LABEL: Readonly<
  Record<InventoryStockStatus, string> & Partial<Record<string, string>>
> = {
  out: "نفد",
  low: "منخفض",
  ok: "طبيعي",
};

export type InventoryMovementType =
  | "IN"
  | "OUT"
  | "RETURN"
  | "ADJUST"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";
export const INVENTORY_MOVEMENT_LABEL: Readonly<
  Record<InventoryMovementType, string> & Partial<Record<string, string>>
> = {
  IN: "وارد",
  OUT: "صادر",
  RETURN: "مرتجع",
  ADJUST: "تسوية",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

export type StocktakeScope = "FULL" | "MOVING" | "MANUAL" | "CATEGORY";
export const STOCKTAKE_SCOPE_LABEL: Readonly<
  Record<StocktakeScope, string> & Partial<Record<string, string>>
> = {
  FULL: "جرد شامل للفرع",
  MOVING: "المنتجات المتحركة",
  MANUAL: "منتجات مختارة",
  CATEGORY: "حسب الفئة",
};
