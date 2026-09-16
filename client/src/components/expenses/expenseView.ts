// المساعدات والثوابت والأنواع المشتركة لشاشة المصروفات — استُخرجت حرفيّاً من Expenses.tsx (ترشيق).
// القواميس ليست محلّية: المصدر المشترك في @shared/expenseLabels و@shared/terms و@/lib/labels.
import { EXPENSE_BUCKET_LABEL } from "@shared/expenseCategories";
import {
  EXPENSE_APPROVAL_AR,
  EXPENSE_AUDIT_WARNING_AR,
  EXPENSE_FUNDING_META,
  EXPENSE_FUNDING_VIEWS,
  EXPENSE_STATUS_AR,
  EXPENSE_STATUS_BADGE_CLASS,
  expenseAuditWarningLabel,
  expenseStockReasonLabel,
  type ExpenseFundingView,
} from "@shared/expenseLabels";
import {
  PAYMENT_METHOD_SOURCE_ENUMS,
  PAYMENT_METHOD_TERMS,
} from "@shared/terms";
import { SHIFT_TYPE_AR } from "@/lib/labels";
import { fmt } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

// الدلو المحاسبيّ وتسميته من المصدر المشترك (كانت نسخةً محلّية رابعة تنجرف عن الباقي).
export const CATEGORY_LABEL: Record<string, string> = EXPENSE_BUCKET_LABEL;

/** ما يُعرض للمستخدم: الفئة المُدارة إن وُجدت، وإلّا الدلو (سجلّات سبقت التصنيف). */
export function expenseCategoryText(row: {
  category: string;
  expenseCategoryName?: string | null;
}): string {
  return row.expenseCategoryName ?? CATEGORY_LABEL[row.category] ?? row.category;
}

/**
 * طرقُ الدفع مقصورةً على ما يقبله عمود `expenses.expensePaymentMethod` — وهو **الوحيد**
 * الحامل لـ`ACCRUAL` بين تعدادات النظام. تُشتقّ من التعداد لا تُكتب قائمةً ثانية.
 */
export const METHOD_LABEL: Record<string, string> = Object.fromEntries(
  PAYMENT_METHOD_SOURCE_ENUMS.expensePaymentMethod.map((method) => [
    method,
    PAYMENT_METHOD_TERMS[method].compact,
  ]),
);

// production-slice: مصدر الصرف من المخزون (نثرية/تلف) بدل طريقة الدفع.
export function sourceLabel(r: {
  source?: string | null;
  stockReason?: string | null;
  paymentMethod: string;
}) {
  if (r.source === "STOCK")
    return expenseStockReasonLabel(r.stockReason, "مخزون");
  return METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod;
}

export const STATUS_CLS: Record<string, string> = EXPENSE_STATUS_BADGE_CLASS;
export const STATUS_LABEL: Record<string, string> = EXPENSE_STATUS_AR;

/** حجم صفحة القائمة — الخادم يُرقّم (سقفه ١٠٠٠). */
export const PAGE_SIZE = 50;

export type ExpenseRowBase = RouterOutputs["expenses"]["list"]["rows"][number];

/**
 * عقد العرض الموسّع. جميع الحقول اختيارية عمداً حتى يبقى نشر الواجهة آمناً أثناء
 * ترقية خدمة المصروفات، وتظهر «—» بدلاً من كسر الشاشة عند سجل تاريخي ناقص.
 */
export type ExpenseRow = ExpenseRowBase &
  Partial<{
    cashBucket: "DRAWER" | "TREASURY" | null;
    payee: string | null;
    costCenter: string | null;
    receiptId: number | null;
    createdBy: number | null;
    createdByName: string | null;
    shiftOwnerName: string | null;
    shiftType: string | null;
    shiftStatus: string | null;
    receiptVoucherNumber: string | null;
    receiptStatus: string | null;
    approvalStatus: string | null;
    approvedByName: string | null;
    updatedAt: string | Date | null;
    fundingKind: string | null;
    integrityWarnings: string[] | null;
    accrualObligationId: number | null;
    accrualKind: string | null;
    settlementStatus: string | null;
    accrualBeneficiaryName: string | null;
    accrualEvidenceReference: string | null;
    recognitionAccountingEntryId: number | null;
    settlementAccountingEntryId: number | null;
    settlementReceiptId: number | null;
  }>;

export type ExpenseTotals = {
  active?: string | number | null;
  pendingApproval?: string | number | null;
  rejected?: string | number | null;
  count?: number | null;
  drawer?: string | number | null;
  treasury?: string | number | null;
  nonCash?: string | number | null;
  stock?: string | number | null;
  cancelled?: string | number | null;
  needsAudit?: string | number | null;
  missingDescription?: string | number | null;
  missingPayee?: string | number | null;
  sourceMismatch?: string | number | null;
  drawerMismatch?: string | number | null;
  accruedUnpaid?: string | number | null;
  accruedPaid?: string | number | null;
};

/** مصدرُ التمويل كما تعرضه الشاشة — التعدادُ ووصفُه في `@shared/expenseLabels`. */
export type FundingKind = ExpenseFundingView;

export type AuditFocus = "DESCRIPTION" | "PAYEE" | "SOURCE" | "DRAWER";

export const FUNDING_ORDER = EXPENSE_FUNDING_VIEWS;
export const FUNDING_META = EXPENSE_FUNDING_META;

/** نوعُ الوردية مفهومٌ مشترَك تملكه `@/lib/labels` — لا نسخةَ هنا. */
export const SHIFT_TYPE_LABEL: Record<string, string> = SHIFT_TYPE_AR;
/**
 * حالةُ الوردية: لا مصدرَ مشترَكاً لها بعدُ (شاشةُ الورديات تُعرّفها محلّياً بنفس النصّ
 * حرفياً)، فتبقى هنا حتى تُوحَّد في موجةٍ تملك تلك الشاشة — نقلُها وحدَنا يُبقي نسختين.
 */
export const SHIFT_STATUS_LABEL: Record<string, string> = {
  OPEN: "مفتوحة",
  CLOSED: "مغلقة",
};
/** حالةُ اعتماد **سند الصرف** المرافق (`receipts.approvalStatus`) لا حالةُ المصروف نفسه. */
export const APPROVAL_LABEL: Record<string, string> = EXPENSE_APPROVAL_AR;

export function fundingKindOf(r: ExpenseRow): FundingKind {
  if (r.status === "PENDING_APPROVAL" || r.status === "REJECTED")
    return "PENDING";
  if (r.fundingKind && FUNDING_ORDER.includes(r.fundingKind as FundingKind))
    return r.fundingKind as FundingKind;
  if (r.source === "STOCK") return "STOCK";
  if (r.paymentMethod !== "CASH") return "NON_CASH";
  if (r.cashBucket === "TREASURY") return "TREASURY";
  if (r.cashBucket === "DRAWER" || r.shiftId != null) return "DRAWER";
  return "UNATTRIBUTED";
}

export function warningsOf(r: ExpenseRow): string[] {
  const warnings = new Set(
    (r.integrityWarnings ?? [])
      .filter(Boolean)
      .map((warning) => expenseAuditWarningLabel(warning)),
  );
  // تحذيراتٌ تشتقّها الشاشةُ من الصفّ نفسه — نصُّها من القاموس المشترك لا مكتوباً هنا.
  if (!r.description?.trim())
    warnings.add(EXPENSE_AUDIT_WARNING_AR.DESCRIPTION_MISSING);
  if (Object.prototype.hasOwnProperty.call(r, "payee") && !r.payee?.trim())
    warnings.add(EXPENSE_AUDIT_WARNING_AR.PAYEE_MISSING);
  const funding = fundingKindOf(r);
  if (funding === "UNATTRIBUTED")
    warnings.add(EXPENSE_AUDIT_WARNING_AR.CASH_FUNDING_UNKNOWN);
  if (funding === "DRAWER" && r.shiftId == null)
    warnings.add(EXPENSE_AUDIT_WARNING_AR.DRAWER_WITHOUT_SHIFT);
  return Array.from(warnings);
}

export function fundingDetail(r: ExpenseRow): string {
  const kind = fundingKindOf(r);
  if (kind === "PENDING")
    return r.paymentMethod === "CASH"
      ? "طلب اعتماد خزينة — لم يُصرف"
      : `طلب اعتماد ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod} — لم يُنفذ`;
  if (kind === "ACCRUED_UNPAID")
    return `${r.accrualBeneficiaryName ?? r.payee ?? "مستفيد غير موثق"} · اعتراف محاسبي بلا خروج نقدي`;
  if (kind === "ACCRUED_PAID")
    return `${r.accrualBeneficiaryName ?? r.payee ?? "مستفيد غير موثق"} · سُوّي بسند وقيد مستقلين`;
  if (kind === "DRAWER") {
    return (
      [r.shiftOwnerName, r.shiftId != null ? `وردية #${r.shiftId}` : null]
        .filter(Boolean)
        .join(" · ") || "درج وردية"
    );
  }
  if (kind === "TREASURY") return "الخزينة الإدارية";
  if (kind === "STOCK")
    return expenseStockReasonLabel(r.stockReason, "صرف مخزون");
  if (kind === "NON_CASH")
    return METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod;
  return "يحتاج مطابقة مع الإيصال والوردية";
}

export function metric(value: string | number | null | undefined): string {
  return value == null ? "—" : fmt(value);
}
