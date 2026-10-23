import { customizationBasePrice, type CartLine } from "./cartMath";

export function canAddPlainCustomizationPiece(line: CartLine): boolean {
  return Boolean(line.custom) && !line.manualService && !line.digital
    && line.row.variantId > 0 && line.row.productUnitId > 0
    && Number.isSafeInteger(line.qty) && line.qty > 0
    && customizationBasePrice(line) != null;
}

/** يفصل قطعة من مجموعة مخصصة، أو يضيف قطعة جاهزة بجانب القطعة المخصصة الوحيدة. */
export function addPlainCustomizationPiece(
  cart: CartLine[],
  sourceKey: string,
  plainKey: string,
): CartLine[] {
  const source = cart.find((line) => line.key === sourceKey);
  if (!source || !canAddPlainCustomizationPiece(source) || cart.some((line) => line.key === plainKey)) return cart;
  const price = customizationBasePrice(source)!;
  // صف مستقل ببيانات الكتالوج فقط: لا تخصيص/صور/توصيل ولا خصم أو كوبون موروث.
  const plain: CartLine = {
    key: plainKey,
    row: { ...source.row, promotionId: null, promotionName: null, promotionEffectivePrice: null },
    qty: 1,
    origPrice: price,
  };
  return [plain, ...cart.map((line) => line.key === sourceKey && line.qty > 1 ? { ...line, qty: line.qty - 1 } : line)];
}
