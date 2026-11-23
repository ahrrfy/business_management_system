import { eq, like, or } from "drizzle-orm";
import { invoices } from "../../../drizzle/schema";
import { formatDocumentNumber, stripDocPrefix } from "@shared/documentNumber";
import type { Tx } from "../../db";
import { nextTransactionTrackingNumber } from "../numbering";

/**
 * يحلّ رقم الفاتورة الموحّد داخل المعاملة (مشترك بين البيع العادي `sale/create` وبيع
 * خدمات الطباعة `printSaleService` لضمان تطابق ترقيم الفواتير الشقيقة بلا انجراف).
 */
export async function resolveInvoiceNumberTx(
  tx: Tx,
  input: {
    trackingNumber?: string | null;
    siblingIndex?: number | null;
  },
): Promise<string> {
  if (input.trackingNumber?.trim()) {
    const cleanTracking = stripDocPrefix(input.trackingNumber.trim());
    const isExplicitlySuffixed =
      /^\d+-\d+$/.test(cleanTracking) ||
      /^(?:INV|WO|ORD|CNS?|PO|QUO)-\d+-\d{8}-\d+-\d+$/i.test(cleanTracking);
    const baseTrackingNumber = isExplicitlySuffixed
      ? cleanTracking.replace(/-\d+$/, "")
      : cleanTracking;
    const hasExplicitSuffix =
      isExplicitlySuffixed || input.siblingIndex != null;
    const preferred =
      isExplicitlySuffixed && input.siblingIndex == null
        ? cleanTracking
        : formatDocumentNumber(
            baseTrackingNumber,
            input.siblingIndex ?? undefined,
          );
    const existingNums = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(
        or(
          eq(invoices.invoiceNumber, baseTrackingNumber),
          like(invoices.invoiceNumber, `${baseTrackingNumber}-%`),
        ),
      )
      .for("update");
    const used = new Set(existingNums.map((r) => r.invoiceNumber));
    const needsSiblingSuffix =
      used.has(preferred) || (!hasExplicitSuffix && used.size > 0);
    if (!needsSiblingSuffix) {
      return preferred;
    }
    let k = 1;
    while (used.has(formatDocumentNumber(baseTrackingNumber, k))) {
      k += 1;
    }
    return formatDocumentNumber(baseTrackingNumber, k);
  }
  const baseTrackingNumber = await nextTransactionTrackingNumber(tx);
  return formatDocumentNumber(
    baseTrackingNumber,
    input.siblingIndex ?? undefined,
  );
}
