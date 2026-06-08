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
export { calcTotals, calcLineTotal, calcMargin, fmtMoney, fmtNum, type InvoiceTotals } from "./totals";

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
