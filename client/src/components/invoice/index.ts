/**
 * Invoice editor — shared component library.
 *
 * Page-level wiring (state, mutations, RBAC `showCost`, keyboard shortcuts)
 * is the responsibility of the route page (e.g. `/sales/new`, `/purchases/new`).
 * All components here are presentational + dispatcher-driven (no internal app state).
 */
export type {
  InvoiceType,
  PriceTier,
  PaymentTerm,
  PaymentMethod,
  Currency,
  DiscountType,
  InvoiceLine,
  InvoiceState,
  InvoiceAction,
  InvoiceTypeMeta,
  EntityRow,
} from "./types";

export {
  INVOICE_TYPES,
  TIER_OPTIONS,
  PAYMENT_TERMS,
  PAYMENT_METHODS,
  CURRENCIES,
} from "./types";

export { invoiceReducer, createInitialState } from "./reducer";
export { derivePaymentTerms } from "./paymentTerms";
export { calcTotals, calcLineTotal, calcMargin, allocateLineTax, fmtMoney, fmtNum, type InvoiceTotals } from "./totals";

export { InvoiceTypeTabs, type InvoiceTypeTabsProps } from "./InvoiceTypeTabs";
export { InvoiceHeader, type InvoiceHeaderProps } from "./InvoiceHeader";
export { EntityPicker, type EntityPickerProps } from "./EntityPicker";
export { ProductSearchBar, type ProductSearchBarProps } from "./ProductSearchBar";
export { ProductTable, type ProductTableProps } from "./ProductTable";
export { BulkPicker, type BulkPickerProps } from "./BulkPicker";
export { TotalsPanel, type TotalsPanelProps } from "./TotalsPanel";
export { ActionButtons, type ActionButtonsProps, type InvoiceActionKind } from "./ActionButtons";
export { TermsAndNotes, type TermsAndNotesProps } from "./TermsAndNotes";
export { ShortcutsBar, type ShortcutsBarProps } from "./ShortcutsBar";
// ⚠️ اسم ملف المنطق `supplierInvoiceMatching.ts` يتعمّد الاختلاف عن مكوّن
// `SupplierInvoiceMatch.tsx` بأكثر من حالة الأحرف: كانا `supplierInvoiceMatch.ts` و
// `SupplierInvoiceMatch.tsx`، فعلى ويندوز/ماك (نظام ملفات غير حسّاس للحالة) يراهما TypeScript
// ملفاً واحداً ⇒ TS1261/TS1149، ويُحلّ `./SupplierInvoiceMatch` إلى ملف المنطق فيسقط تصدير
// المكوّن (TS2305) وتفقد صفحات الشراء أنواع خصائصه (TS7006). و**CI على لينكس أخضر** لأنّ
// نظام ملفاته حسّاس للحالة ⇒ عطلٌ يراه كل مطوّر ويندوز ولا يراه الفحص. لا تُعِد التصادم.
export { SupplierInvoiceMatch, type SupplierInvoiceMatchProps } from "./SupplierInvoiceMatch";
export {
  matchSupplierInvoice,
  deriveDocumentTotal,
  distributeToSubtotal,
  subtotalForInvoiceTotal,
  type MatchLine,
  type MatchResult,
  type MatchVerdict,
  type DistributeResult,
} from "./supplierInvoiceMatching";
