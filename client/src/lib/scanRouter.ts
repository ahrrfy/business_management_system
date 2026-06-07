/**
 * scanRouter — Strategy Pattern لتوجيه مدخل الماسح الضوئي.
 *
 * يُحلِّل أي نص خام (من ماسح HID أو QR) ويُعيد ScanResult محدَّد النوع.
 * كل type يُعالَج باستراتيجية مستقلة في موقع الاستدعاء (POS, receive, returns…).
 *
 * أولوية التحليل:
 *  1. QR payload موقَّعة (pipe-delimited: TYPE|number|…|sig)
 *  2. رقم فاتورة مباشر (INV-*)
 *  3. رقم أمر شغل (WO-*)
 *  4. رقم طلب شراء (PO-*)
 *  5. رقم عرض سعر (QUO-*)
 *  6. معرّف عميل (CUST-NNNNN)
 *  7. باركود منتج (EAN-13 / ALR* / أي نص آخر)
 */
import type { ScanResult } from "@shared/barcodeTypes";

const PIPE_PREFIX = /^(INV|WO|PO|QUO|CUST)\|/;

export function parseScan(raw: string): ScanResult {
  const s = raw.trim();
  if (!s) return { type: "unknown", raw: s };

  // QR payload موقَّعة — pipe-delimited، يستخرج رقم المستند ويُفوَّض recursive
  if (PIPE_PREFIX.test(s)) {
    const parts = s.split("|");
    const docType = parts[0];
    const number = parts[1] ?? "";
    if (docType === "CUST") return { type: "customer", id: parseInt(number, 10) };
    return parseScan(number); // تفويض: "INV-1-…" → invoice
  }

  if (s.startsWith("INV-"))  return { type: "invoice",       number: s };
  if (s.startsWith("WO-"))   return { type: "workOrder",     number: s };
  if (s.startsWith("PO-"))   return { type: "purchaseOrder", number: s };
  if (s.startsWith("QUO-"))  return { type: "quotation",     number: s };

  // CUST-NNNNN (من بطاقة QR العميل)
  if (/^CUST-\d+$/.test(s)) {
    return { type: "customer", id: parseInt(s.slice(5), 10) };
  }

  // أي شيء آخر = باركود منتج (EAN-13، ALR0000001، باركود مصنّعي)
  return { type: "product", barcode: s };
}
