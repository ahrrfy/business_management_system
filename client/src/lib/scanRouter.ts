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
import { stripDocPrefix } from "@shared/documentNumber";
import { normalizeKnownSystemBarcode } from "@/lib/barcodeScannerInput";

const PIPE_PREFIX = /^(INV|WO|PO|QUO|CUST|EMP|USER)\|/;

export function parseScan(raw: string): ScanResult {
  // حارس إضافي لباركودات النظام: حتى لو وصل النص من مسار لا يستعمل useBarcodeScanner،
  // تُستعاد البادئة اللاتينية التي شوّهها تخطيط Windows العربي (÷آ{ ⇒ INV).
  const s = normalizeKnownSystemBarcode(raw).trim();
  if (!s) return { type: "unknown", raw: s };

  // QR payload موقَّعة — pipe-delimited، يستخرج رقم المستند ويُفوَّض recursive
  if (PIPE_PREFIX.test(s)) {
    const parts = s.split("|");
    const docType = parts[0];
    const number = parts[1] ?? "";
    if (docType === "CUST") return { type: "customer", id: parseInt(number, 10) };
    if (docType === "EMP") return { type: "employee", id: parseInt(number, 10) };
    if (docType === "USER") return { type: "user", id: parseInt(number, 10) };
    // ١٨/٨: النوع معلومٌ من الحمولة نفسها — نستعمله مباشرةً بدل إعادة تحليل الرقم. مع أرقام
    // العرض القصيرة (10023) كان التفويض يُعيد تصنيفها «باركود منتج» لأنّها أرقامٌ عارية.
    if (docType === "INV") return { type: "invoice", number };
    if (docType === "WO") return { type: "workOrder", number };
    if (docType === "PO") return { type: "purchaseOrder", number };
    if (docType === "QUO") return { type: "quotation", number };
    return parseScan(number);
  }

  // رمز الآلة بادئيّ دائماً؛ ونُعيد **رقم العرض** مجرَّداً من بادئته حين تكون الصيغة الجديدة
  // (`INV-10023` ⇒ `10023`)، بينما الرقم التاريخيّ يبقى كاملاً لأنّه هو رقم عرضه.
  if (s.startsWith("INV-"))  return { type: "invoice",       number: stripDocPrefix(s) };
  if (s.startsWith("WO-"))   return { type: "workOrder",     number: stripDocPrefix(s) };
  if (s.startsWith("PO-"))   return { type: "purchaseOrder", number: stripDocPrefix(s) };
  if (s.startsWith("QUO-"))  return { type: "quotation",     number: stripDocPrefix(s) };

  // CUST-NNNNN (بطاقة العميل) · EMP-N (بطاقة الموظف) · USER-N (بطاقة المستخدم)
  if (/^CUST-\d+$/i.test(s)) return { type: "customer", id: parseInt(s.slice(5), 10) };
  if (/^EMP-\d+$/i.test(s))  return { type: "employee", id: parseInt(s.slice(4), 10) };
  if (/^USER-\d+$/i.test(s)) return { type: "user",     id: parseInt(s.slice(5), 10) };

  // أي شيء آخر = باركود منتج (EAN-13، ALR0000001، باركود مصنّعي)
  return { type: "product", barcode: s };
}
