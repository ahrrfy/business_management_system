/**
 * برميلُ المسندات المشتركة — **استخراج D2** من مقياس الاحتكاك (§٤ في خطة v2).
 *
 * الاستهلاك في هذه الشريحة: **صفر**. الوصلُ يحصل تحت `check:vocabulary` في شرائح لاحقة (م٥ ذيل).
 * الغرضُ من البرميل الآن أن يكون نقطةَ استيرادٍ واحدة لكلّ الشرائح القادمة:
 *   `import { hasOpenBalance, isDeadInvoice, ... } from "@shared/predicates";`
 *
 * ⛔ لا تستوردَ مسنداً من ملفّه المباشر — يمرّ بالبرميل كي يبقى نقطةً واحدة للانحراف.
 */

export { hasOpenBalance, balanceDirection } from "./hasOpenBalance";
export type { EntityWithBalance, BalanceInput } from "./hasOpenBalance";

export { isDeadInvoice, DEAD_INVOICE_STATUSES } from "./isDeadInvoice";
export { isVoidedSale, VOIDED_INVOICE_STATUSES } from "./isVoidedSale";

export { canCrossBranches } from "./canCrossBranches";
export type { BranchActor } from "./canCrossBranches";

export { invoiceRemaining, isFullyPaid } from "./invoiceRemaining";
export type { InvoiceRemainingInput } from "./invoiceRemaining";
