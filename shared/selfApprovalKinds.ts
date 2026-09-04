/**
 * أنواعُ سجلّات تقرير «الاعتماد الذاتي» — الضابطُ التعويضيّ لقرار المالك (٣/٩/٢٦، PR #962):
 * «لا اعتماد ثانٍ بعد المالك». مصدرٌ مشترك بين `server/services/audit/selfApprovalReport.ts`
 * (يبني السجلّات) و`client/src/pages/SelfApprovalAudit.tsx` (يعرضها ويُصفّي بنوعها) — كودٌ
 * خادميٌّ لا يجوز استيراده من العميل مباشرةً، فالنوع/التسمية وحدهما ينتقلان إلى `shared/`.
 */
export type SelfApprovalKind =
  | "voucher"
  | "expense"
  | "workOrderRefund"
  | "supplierPayment"
  | "supplierPaymentRefund"
  | "purchaseCharge"
  | "purchaseReturn"
  | "purchaseReturnReversal"
  | "payrollAccrualApproval"
  | "payrollNetPayment"
  | "advanceRepayment"
  | "payrollRemittanceApproval"
  | "payrollRemittancePayment";

export const SELF_APPROVAL_KIND_LABEL_AR: Record<SelfApprovalKind, string> = {
  voucher: "سند مالي",
  expense: "مصروف",
  workOrderRefund: "ردّ إلغاء أمر شغل",
  supplierPayment: "سداد مورّد",
  supplierPaymentRefund: "استرداد سداد مورّد",
  purchaseCharge: "مصروف شراء",
  purchaseReturn: "مرتجع شراء",
  purchaseReturnReversal: "عكس مرتجع شراء",
  payrollAccrualApproval: "اعتماد استحقاق مسيّر",
  payrollNetPayment: "صرف صافي مسيّر",
  advanceRepayment: "تقسيط سلفة موظف",
  payrollRemittanceApproval: "اعتماد تحويل استقطاعات",
  payrollRemittancePayment: "دفع تحويل استقطاعات",
};
