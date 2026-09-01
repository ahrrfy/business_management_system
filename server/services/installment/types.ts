// عقود الأقساط والشيكات الآجلة — مشتركة بين ملفات حزمة server/services/installment/*.
import { TRPCError } from "@trpc/server";

export type InstallmentKind = "CASH" | "CHECK";
export type PlanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type LineStatus = "PENDING" | "PAID" | "BOUNCED" | "CANCELLED";

export interface InstallmentLineInput {
  /** تاريخ الاستحقاق YYYY-MM-DD. */
  dueDate: string;
  /** مبلغ القسط (موجب، منزلتان). */
  amount: string;
  kind: InstallmentKind;
  /** إلزامي حين kind=CHECK. */
  checkNumber?: string | null;
  bankName?: string | null;
}

export interface CreatePlanInput {
  /** UUID ثابت لإعادة إرسال إنشاء الخطة نفسها دون إنشاء خطة ثانية. */
  clientRequestId: string;
  customerId: number;
  /** مصدر الذمّة إلزامي: لا تُنشأ خطة حرة بلا فاتورة حيّة. */
  invoiceId: number;
  branchId: number;
  totalAmount: string;
  downPayment?: string | null;
  lines: InstallmentLineInput[];
  notes?: string | null;
}

export interface PayLineInput {
  lineId: number;
  /** UUID ثابت لإعادة إرسال المحاولة نفسها؛ يولَّد من الواجهة مرة واحدة لكل نقرة مقصودة. */
  clientRequestId: string;
  /** الافتراضي CASH دائماً؛ نوع الجدولة التاريخي لا يحدد وسيلة التحصيل الحالية. */
  paymentMethod?: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | null;
  note?: string | null;
  /** مرجع العملية للعرض/المطابقة؛ المصدر الحاكم هو محاولة الدفع الخارجية المؤكدة. */
  referenceNumber?: string | null;
  /** آخر ٤ أرقام للبطاقة — إلزاميّ لـCARD في `createVoucher` (مطابقة كشف المزوّد). */
  cardLastFour?: string | null;
  /** مُرفق السند (اختياريّ دائماً — لا إلزام مُرفق في النظام). */
  attachmentUrl?: string | null;
  /** محاولة SALES_COLLECTION مؤكدة تُستهلك مع السند والقيد داخل المعاملة نفسها. */
  externalPaymentAttemptId?: number | null;
  deviceId?: string | null;
}

export interface PayLineResult {
  /** PAID = سُدِّد وأثّر مالياً؛ PENDING_APPROVAL = السند بانتظار اعتماد مدير ثانٍ والقسط باقٍ PENDING. */
  status: "PAID" | "PENDING_APPROVAL";
  receiptId: number;
  voucherNumber: string;
  /** true إن اكتملت كل أقساط الخطة بعد هذا السداد. */
  planCompleted: boolean;
}

/** قيد عزل الفرع (يمرّره الراوتر): null = بلا قيد (admin/مدير عابر)، رقم = الخطة يجب أن تخصّ هذا الفرع. */
export type BranchRestriction = number | null;

export interface ListPlansFilter {
  branchId?: number | null;
  customerId?: number | null;
  status?: PlanStatus | null;
  limit?: number;
  offset?: number;
}

// YMD_RE + assertPlanBranch: تصدير داخليّ للحزمة فقط (نمط server/services/stocktake/internal.ts) —
// لا يُعاد تصديرهما من البرميل installmentService.ts، فيبقيان خارج الواجهة العامة.
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertPlanBranch(planBranchId: number, restrictToBranchId: BranchRestriction) {
  if (restrictToBranchId != null && Number(planBranchId) !== Number(restrictToBranchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه الخطة تخصّ فرعاً آخر" });
  }
}
