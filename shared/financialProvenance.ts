import Decimal from "decimal.js";

/**
 * أنواع الحركات المالية الستة الأساسية لمنظومة كشف الهوية المالية
 */
export type ProvenanceMovementType =
  | "revenue"     // إيراد: مبيعات، خدمات، مقبوضات
  | "expense"     // مصروف: تشغيلي، نثريات، مخزون، رواتب
  | "collection"  // تحصيل: سند قبض عميل، تحصيل مندوب، سداد أقساط
  | "delivery"    // تسليم / سداد: دفعة مورد، توريد خزينة، تحويل بنكي
  | "balance"     // رصيد: رصيد افتتاحي، رصيد حساب، متوقع درج
  | "difference"; // فرق: عجز/فائض وردية، تسوية جرد، مردودات

export const PROVENANCE_MOVEMENT_LABELS: Record<ProvenanceMovementType, string> = {
  revenue: "إيراد",
  expense: "مصروف",
  collection: "تحصيل",
  delivery: "تسليم / سداد",
  balance: "رصيد",
  difference: "فرق / تسوية",
};

export type ProvenancePartyKind =
  | "customer"
  | "supplier"
  | "employee"
  | "beneficiary"
  | "entity"
  | "branch"
  | "system";

export const PROVENANCE_PARTY_LABELS: Record<string, string> = {
  customer: "العميل",
  supplier: "المورد",
  employee: "الموظف",
  beneficiary: "المستفيد",
  entity: "الجهة",
  branch: "الفرع",
  system: "النظام",
};

/** هوية الطرف المالي (عميل، مورد، موظف، جهة) */
export interface ProvenanceParty {
  name: string;
  type?: ProvenancePartyKind;
  kind?: ProvenancePartyKind;
  id?: number | string | null;
  phone?: string | null;
  role?: string | null;
  category?: string | null;
}

export type ProvenanceDocType =
  | "invoice"
  | "receipt"
  | "voucher"
  | "purchase_order"
  | "shift"
  | "journal_entry"
  | "work_order"
  | "expense"
  | "other";

export const PROVENANCE_DOC_LABELS: Record<string, string> = {
  invoice: "فاتورة",
  receipt: "إيصال",
  voucher: "سند",
  purchase_order: "أمر شراء",
  shift: "وردية",
  journal_entry: "قيد محاسبي",
  work_order: "أمر شغل",
  expense: "مصروف",
};

/** المستندات والوثائق المرجعية المرتبطة */
export interface ProvenanceDocumentRef {
  docType?: ProvenanceDocType;
  docNumber?: string;
  number?: string;
  docId?: number | string | null;
  id?: number | string | null;
  date?: string | Date | null;
  label?: string | null;
  href?: string | null;
}

/** البنود الفرعية ومطابقتها الرياضية */
export interface ProvenanceSubItem {
  id?: string | number;
  label: string;
  amount: string | number;
  quantity?: number | string | null;
  unitPrice?: string | number | null;
  category?: string | null;
  note?: string | null;
  type?: string | null;
}

/** ملخص المطابقة الحسابية الصارمة للخلية المالية */
export interface ProvenanceReconciliationSummary {
  expectedTotal: string;
  subItemsSum: string;
  discrepancy: string; // '0.00' if fully reconciled
  isFullyReconciled: boolean;
  subItemsCount: number;
}

/** بنية بيانات كشف الهوية المالية المتكاملة */
export interface FinancialCellProvenancePayload {
  movementType: ProvenanceMovementType;
  title: string;
  totalAmount: string | number;
  formattedAmount?: string;
  party?: ProvenanceParty | null;
  documentRef?: ProvenanceDocumentRef | null;
  docRefs?: ProvenanceDocumentRef[];
  category?: string | null;
  classification?: string | null;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  actorName?: string | null;
  actor?: {
    name: string;
    id?: number | string | null;
    role?: string | null;
  } | null;
  branchName?: string | null;
  notes?: string | null;
  note?: string | null;
  contraAccount?: {
    code: string;
    name: string;
  } | null;
  shiftInfo?: {
    shiftId: number;
    shiftType?: string | null;
    ownerName?: string | null;
  } | null;
  subItems?: ProvenanceSubItem[];
  reconciliation?: ProvenanceReconciliationSummary;
  warnings?: string[];
}

export type FinancialCellProvenanceData = FinancialCellProvenancePayload;

function toWesternDigits(str: string): string {
  return str.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
}

function cleanToDecimal(val: string | number | null | undefined): Decimal {
  if (val == null) return new Decimal(0);
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return new Decimal(0);
    return new Decimal(val);
  }
  const raw = String(val).trim();
  if (!raw) return new Decimal(0);

  const normalized = toWesternDigits(raw);
  const match = normalized.match(/[-+]?\s*[\d,]+(?:\.\d+)?/);
  if (!match) return new Decimal(0);

  const cleaned = match[0].replace(/,/g, "").replace(/\s+/g, "");
  try {
    return new Decimal(cleaned);
  } catch {
    return new Decimal(0);
  }
}

/**
 * محرك المطابقة الرياضية الصارمة (100% Mathematical Reconciliation Engine)
 * يضمن مطابقة إجمالي الخلية مع مجموع بنودها الفرعية بدقة Decimal بالدينار العراقي.
 */
export function computeProvenanceReconciliation(
  totalAmount: string | number,
  subItems?: ProvenanceSubItem[]
): ProvenanceReconciliationSummary {
  const expectedDecimal = cleanToDecimal(totalAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const items = subItems ?? [];
  const hasItems = items.length > 0;

  const sumDecimal = items
    .reduce<Decimal>((acc, item) => acc.plus(cleanToDecimal(item.amount)), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const diffDecimal = hasItems ? expectedDecimal.minus(sumDecimal).abs() : new Decimal(0);
  const isFullyReconciled = hasItems ? diffDecimal.lte(0.005) : true;
  const discrepancy = diffDecimal.lte(0.005) ? "0.00" : diffDecimal.toFixed(2);

  return {
    expectedTotal: expectedDecimal.toFixed(2),
    subItemsSum: sumDecimal.toFixed(2),
    discrepancy,
    isFullyReconciled,
    subItemsCount: items.length,
  };
}
