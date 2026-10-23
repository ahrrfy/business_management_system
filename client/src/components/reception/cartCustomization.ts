import { D, round2 } from "@/lib/money";
import type { CartLine } from "./cartMath";

/** سعر المنتج وحده قبل خصم/كوبون السطر؛ المسودة تحفظ السعر التاريخي شاملاً إضافة التخصيص. */
function plainUnitPrice(line: CartLine): number | null {
  try {
    if (line.origPrice == null && line.row.price == null) return null;
    const price = line.origPrice == null
      ? D(line.row.price)
      : D(line.origPrice).minus(D(line.custom?.unitPrice));
    return price.isFinite() && price.gte(0) ? round2(price).toNumber() : null;
  } catch {
    return null;
  }
}

export function canAddPlainCustomizationPiece(line: CartLine): boolean {
  return Boolean(line.custom) && !line.manualService && !line.digital
    && line.row.variantId > 0 && line.row.productUnitId > 0
    && Number.isSafeInteger(line.qty) && line.qty > 0
    && plainUnitPrice(line) != null;
}

/** يفصل قطعة من مجموعة مخصصة، أو يضيف قطعة جاهزة بجانب القطعة المخصصة الوحيدة. */
export function addPlainCustomizationPiece(
  cart: CartLine[],
  sourceKey: string,
  plainKey: string,
): CartLine[] {
  const source = cart.find((line) => line.key === sourceKey);
  if (!source || !canAddPlainCustomizationPiece(source) || cart.some((line) => line.key === plainKey)) return cart;
  const price = plainUnitPrice(source)!;
  // صف مستقل ببيانات الكتالوج فقط: لا تخصيص/صور/توصيل ولا خصم أو كوبون موروث.
  const plain: CartLine = {
    key: plainKey,
    row: { ...source.row, promotionId: null, promotionName: null, promotionEffectivePrice: null },
    qty: 1,
    origPrice: price,
  };
  return [plain, ...cart.map((line) => line.key === sourceKey && line.qty > 1 ? { ...line, qty: line.qty - 1 } : line)];
}
