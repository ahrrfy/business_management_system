import {
  productOnlineOrderingIssue,
} from "@/lib/product-selection";
import type { CartLine } from "@/shared/storefront";

export function checkoutRequestLines(lines: readonly CartLine[]) {
  const merged = new Map<string, {
    productUnitId: number;
    quantity: number;
    customization?: { templateId: number; values: Record<string, string> };
  }>();
  for (const line of lines) {
    if (productOnlineOrderingIssue(line.product)) continue;
    const customization = line.selectionDetails.customization ? {
      templateId: line.selectionDetails.customization.templateId,
      values: Object.fromEntries(line.selectionDetails.customization.values
        .map((value) => [value.fieldKey, value.value] as const)
        .sort(([left], [right]) => left.localeCompare(right))),
    } : undefined;
    const identity = `${line.selectionDetails.productUnitId}:${JSON.stringify(customization ?? null)}`;
    const existing = merged.get(identity);
    if (existing) existing.quantity += line.quantity;
    else merged.set(identity, {
      productUnitId: line.selectionDetails.productUnitId,
      quantity: line.quantity,
      customization,
    });
  }
  return Array.from(merged.values());
}

export function checkoutSelectionFingerprint(lines: readonly CartLine[]) {
  return lines.map((line) => ({
    lineId: line.lineId,
    quantity: line.quantity,
    selectionDetails: line.selectionDetails,
  }));
}

/**
 * يربط عرض السعر بالسلة التي حُسب لها تحديداً. لا نعيد استعمال عرضٍ قديم بعد
 * تغيير الكمية أو البديل أو التخصيص عند الرجوع من السلة إلى صفحة الدفع.
 */
export function checkoutQuoteFingerprint(lines: readonly CartLine[]) {
  return JSON.stringify({
    lines: checkoutRequestLines(lines),
    selections: checkoutSelectionFingerprint(lines),
  });
}

export function checkoutSelectionIssue(lines: readonly CartLine[], _maxLength = 500): string | null {
  for (const line of lines) {
    const onlineOrderingIssue = productOnlineOrderingIssue(line.product);
    if (onlineOrderingIssue) return onlineOrderingIssue;
  }
  return null;
}
