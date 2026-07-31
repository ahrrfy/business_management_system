import type { InvoiceLine } from "@/components/invoice";

const KEY = "invoice-transfer";

type Transfer = { version: 1; items: InvoiceLine[] };

export function hasInvoiceTransfer(): boolean {
  return sessionStorage.getItem(KEY) !== null;
}

export function copyInvoiceItems(items: InvoiceLine[]): void {
  const payload: Transfer = { version: 1, items };
  sessionStorage.setItem(KEY, JSON.stringify(payload));
}

/** قراءة لمرة واحدة: لا تُحذف الحافظة إلا بعد التحقق الناجح. */
export function takeInvoiceItems(): InvoiceLine[] | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Transfer>;
    if (parsed.version !== 1 || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    const valid = parsed.items.every(
      (item) => item && Number.isInteger(item.productUnitId) && item.productUnitId > 0 && Number(item.qty) > 0,
    );
    if (!valid) return null;
    sessionStorage.removeItem(KEY);
    return parsed.items;
  } catch {
    return null;
  }
}
