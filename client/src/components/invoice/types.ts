/**
 * Shared types & constants for the invoice editor.
 *
 * Ported (TypeScript + RTL/Arabic) from `_design-bundle/project/invoice-data.jsx`.
 * Server-truth shapes (catalog/customers/suppliers) come from tRPC — these types
 * are local to the editor's reducer/state and are merged with server rows on add.
 */

export type InvoiceType = "SALE" | "PURCHASE" | "QUOTATION" | "SALE_RETURN" | "PURCHASE_RETURN";
export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type PaymentTerm = "CASH" | "CREDIT" | "INSTALLMENT";
export type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "CHECK" | "WALLET";
export type Currency = "IQD" | "USD";
export type DiscountType = "percent" | "amount";

/** One line in the invoice cart. Money fields are kept as strings (decimal-safe). */
export interface InvoiceLine {
  /** Product id (for grouping/display). */
  productId: number;
  variantId: number;
  /** Stable key for ADD_ITEM dedupe. */
  productUnitId: number;
  name: string;
  sku: string;
  barcode: string | null;
  /** Unit label (قطعة/درزن/...). */
  unit: string;
  /** Quantity in the chosen unit (not base). */
  qty: number;
  /** Conversion factor unit → base (for inventoryService.applyMovement). */
  conversionFactor: string;
  /** Stock at the active branch in base units. */
  stockBase: number;
  /** Unit price (decimal string). */
  price: string;
  /** Cost per base unit (decimal string) — hidden from cashier; required by purchases. */
  costBase: string;
  /** Per-line discount, percent (0-100) or absolute amount (in invoice currency). */
  discount: string;
  discountType: DiscountType;
  note: string;
}

export interface InvoiceState {
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  entityId: number | null;
  branchId: number;
  tier: PriceTier;
  paymentTerms: PaymentTerm;
  paymentMethod: PaymentMethod;
  dueDate: string;
  currency: Currency;
  /** usd-po-reconcile: مبلغ فاتورة المورد الفعلية بالدولار (PURCHASE فقط، حين currency=USD). */
  usdTotal: string;
  salesRepId: number | "";
  refInvoice: string;
  poReference: string;
  validUntil: string;
  notes: string;
  terms: string;
  /** Decimal string. */
  globalDiscount: string;
  globalDiscountType: DiscountType;
  shipping: string;
  otherExpenses: string;
  paidAmount: string;
  /** تفعيل ضريبة على مستوى الفاتورة (اختياري — العراق VAT=0% افتراضياً). */
  taxEnabled: boolean;
  /** نسبة الضريبة% تُطبَّق على (المجموع الفرعي − الخصومات) عند تفعيل taxEnabled. */
  taxRatePercent: string;
  items: InvoiceLine[];
}

export type InvoiceAction =
  | { type: "SET_FIELD"; field: keyof Omit<InvoiceState, "items">; value: InvoiceState[keyof Omit<InvoiceState, "items">] }
  | { type: "SET_ENTITY"; id: number | null }
  | { type: "ADD_ITEM"; item: InvoiceLine }
  | { type: "ADD_ITEMS"; items: InvoiceLine[] }
  | { type: "UPDATE_ITEM"; idx: number; field: keyof InvoiceLine; value: InvoiceLine[keyof InvoiceLine] }
  | { type: "REMOVE_ITEM"; idx: number }
  | { type: "CLEAR_ITEMS" }
  | { type: "RESET"; invoiceType: InvoiceType };

/* ─── Static option lists (Arabic) ──────────────────────────────────────────── */
import { Upload, Download, ClipboardList, Undo2, Redo2, Banknote, CreditCard, Building2, Wallet, type LucideIcon } from "lucide-react";

export interface InvoiceTypeMeta {
  key: InvoiceType;
  label: string;
  prefix: string;
  icon: LucideIcon;
  /** Tailwind classes for the active tab/button background + ring color. */
  colorBg: string;
  colorRing: string;
  /** raw hex for boxShadow fallback. */
  colorHex: string;
}

export const INVOICE_TYPES: Record<InvoiceType, InvoiceTypeMeta> = {
  SALE:            { key: "SALE",            label: "فاتورة بيع",  prefix: "INV", icon: Upload,         colorBg: "bg-indigo-600",  colorRing: "ring-indigo-300",  colorHex: "#4f46e5" },
  PURCHASE:        { key: "PURCHASE",        label: "فاتورة شراء", prefix: "PO",  icon: Download,       colorBg: "bg-emerald-600", colorRing: "ring-emerald-300", colorHex: "#059669" },
  QUOTATION:       { key: "QUOTATION",       label: "عرض سعر",     prefix: "QT",  icon: ClipboardList,  colorBg: "bg-amber-500",   colorRing: "ring-amber-300",   colorHex: "#d97706" },
  SALE_RETURN:     { key: "SALE_RETURN",     label: "مرتجع بيع",   prefix: "SR",  icon: Undo2,          colorBg: "bg-rose-600",    colorRing: "ring-rose-300",    colorHex: "#e11d48" },
  PURCHASE_RETURN: { key: "PURCHASE_RETURN", label: "مرتجع شراء",  prefix: "PR",  icon: Redo2,          colorBg: "bg-fuchsia-600", colorRing: "ring-fuchsia-300", colorHex: "#c026d3" },
};

export const TIER_OPTIONS: Array<{ value: PriceTier; label: string }> = [
  { value: "RETAIL",     label: "مفرد" },
  { value: "WHOLESALE",  label: "جملة" },
  { value: "GOVERNMENT", label: "حكومي" },
];

export const PAYMENT_TERMS: Array<{ value: PaymentTerm; label: string }> = [
  { value: "CASH",        label: "نقداً" },
  { value: "CREDIT",      label: "آجل (ذمة)" },
  { value: "INSTALLMENT", label: "أقساط" },
];

export const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string; icon: LucideIcon }> = [
  { value: "CASH",     label: "نقدي",   icon: Banknote },
  { value: "CARD",     label: "بطاقة",  icon: CreditCard },
  { value: "TRANSFER", label: "تحويل",  icon: Building2 },
  { value: "WALLET",   label: "محفظة",  icon: Wallet },
];

export const CURRENCIES: Array<{ value: Currency; label: string; symbol: string }> = [
  { value: "IQD", label: "دينار عراقي (د.ع)", symbol: "د.ع" },
  { value: "USD", label: "دولار أمريكي ($)",  symbol: "$" },
];

/** Server-truth entity row shape (compatible with `trpc.customers.list` & `suppliers.list`). */
export interface EntityRow {
  id: number;
  name: string;
  phone?: string | null;
  /** AR/AP balance (decimal string). Positive = they owe us. */
  currentBalance?: string | null;
  defaultPriceTier?: PriceTier | null;
}
