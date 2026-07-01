// عقد البحث الشامل: تصنيف الاستعلام (BARCODE/DOC_NUMBER/PHONE/TEXT) وأنواع النتائج.
import type { AccessLevel } from "@shared/permissions";

export type SearchEntityType =
  | "PRODUCT"
  | "INVOICE"
  | "QUOTATION"
  | "PURCHASE_ORDER"
  | "WORK_ORDER"
  | "CUSTOMER"
  | "SUPPLIER"
  | "EXPENSE"
  | "EMPLOYEE"
  | "USER";

export type SearchKind = "BARCODE" | "DOC_NUMBER" | "PHONE" | "TEXT";

export type SearchResult = {
  type: SearchEntityType;
  id: number;
  title: string;
  subtitle: string | null;
  meta: string | null;
  route: string;
  /** 0 = تطابق تامّ (باركود/رقم وثيقة)، 1+ = جزئي. أصغر = أقرب للبداية. */
  rank: number;
};

const DOC_PREFIX_RX = /^(INV|QT|PO|WO|SR|PR)[-\s]?/i;
const NUM_ONLY_RX = /^\d+$/;
const PHONE_PREFIX_RX = /^\+/;

export function classifyQuery(raw: string): { kind: SearchKind; query: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "TEXT", query: "" };

  // باركود ماسح ضوئي: أرقام صرفة + طول قياسي.
  if (NUM_ONLY_RX.test(trimmed) && trimmed.length >= 8 && trimmed.length <= 14) {
    return { kind: "BARCODE", query: trimmed };
  }
  // مُعرّف وثيقة بصيغة المشروع: INV-2606-1234 / QT-... / PO-... / WO-... / SR-... / PR-...
  if (DOC_PREFIX_RX.test(trimmed)) {
    return { kind: "DOC_NUMBER", query: trimmed };
  }
  // رقم وثيقة قصير (المالك يكتب أحياناً «9164» قاصداً QT-2606-9164).
  if (NUM_ONLY_RX.test(trimmed) && trimmed.length <= 7) {
    return { kind: "DOC_NUMBER", query: trimmed };
  }
  // هاتف بصيغة E.164 (+9647...). نمرّر بقية الأنماط لـTEXT (البحث في الهاتف يظل يعمل عبر LIKE).
  if (PHONE_PREFIX_RX.test(trimmed)) {
    return { kind: "PHONE", query: trimmed };
  }
  return { kind: "TEXT", query: trimmed };
}

export type GlobalSearchInput = {
  query: string;
  /** فرع المستخدم؛ null = elevated (admin/manager) يبحث عبر الفروع. */
  branchId: number | null;
  role: string;
  /** فروق صلاحيات الدور المخصّص (يُحلّ إلى خريطة وحدات؛ يُحكم وصول الموظفين به). */
  permissionsOverride?: Record<string, AccessLevel> | null;
  /** الحد لكل كيان (افتراضي ٦). */
  perEntityLimit?: number;
  /** قصر البحث على أنواع محدّدة (اختياري). */
  scopes?: SearchEntityType[];
};
