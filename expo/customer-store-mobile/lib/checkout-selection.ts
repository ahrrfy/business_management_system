import {
  productOnlineOrderingIssue,
  selectionDescription,
} from "@/lib/product-selection";
import type { CartLine } from "@/shared/storefront";

export function checkoutRequestLines(lines: readonly CartLine[]) {
  return lines.flatMap((line) =>
    productOnlineOrderingIssue(line.product)
      ? []
      : [{
          productUnitId: line.selectionDetails.productUnitId,
          quantity: line.quantity,
        }],
  );
}

export function checkoutSelectionFingerprint(lines: readonly CartLine[]) {
  return lines.map((line) => ({
    lineId: line.lineId,
    quantity: line.quantity,
    selectionDetails: line.selectionDetails,
  }));
}

/**
 * قناة توافق مؤقتة مع عقد createOrder الحالي: يحفظ الموظف وصف الاختيار في ملاحظات الطلب.
 * لا تُستعمل للتسعير أبداً، وتستبدل بحقل structured selectionDetails عند إضافته خادمياً.
 */
function selectionNotesText(lines: readonly CartLine[]) {
  const body = lines
    .map((line, index) => `${index + 1}) ${line.product.title} × ${line.quantity}: ${selectionDescription(line.selectionDetails)}`.replace(/[\r\n\t]+/g, " "))
    .join("\n");
  return `[تفاصيل الاختيارات]\n${body}`;
}

export function checkoutSelectionIssue(lines: readonly CartLine[], maxLength = 500): string | null {
  const units = new Map<number, { count: number; customized: boolean }>();
  for (const line of lines) {
    const onlineOrderingIssue = productOnlineOrderingIssue(line.product);
    if (onlineOrderingIssue) return onlineOrderingIssue;
    const unitId = line.selectionDetails.productUnitId;
    const current = units.get(unitId) ?? { count: 0, customized: false };
    units.set(unitId, {
      count: current.count + 1,
      customized: current.customized || Boolean(line.selectionDetails.customization?.values.length),
    });
  }
  for (const state of units.values()) {
    if (state.count > 1 && state.customized) {
      return "توجد تخصيصات مختلفة لوحدة المنتج نفسها. أرسل كل تخصيص في طلب مستقل حتى يجهّز الخادم حفظها كسطور منفصلة.";
    }
  }
  if (selectionNotesText(lines).length > maxLength) {
    return "تفاصيل التخصيص أطول من الحد الذي يحفظه نظام الطلبات. قلّل النص أو قسّم المنتجات على طلبين.";
  }
  return null;
}

export function checkoutSelectionNotes(lines: readonly CartLine[], maxLength = 500) {
  const note = selectionNotesText(lines);
  return note.length <= maxLength ? note : `${note.slice(0, Math.max(0, maxLength - 1))}…`;
}
