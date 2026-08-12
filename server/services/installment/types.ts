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
  customerId: number;
  /** ربط اختياري بفاتورة بيع — يجب أن تخصّ نفس العميل وغير ملغاة. */
  invoiceId?: number | null;
  branchId: number;
  totalAmount: string;
  downPayment?: string | null;
  lines: InstallmentLineInput[];
  notes?: string | null;
  /** حارس إنتاجي: اربط الخطة بالمصدر الفعلي للذمة، وتبقيه الاختبارات/الصيانة القديمة اختيارياً. */
  enforceFinancialIntegrity?: boolean;
}

export interface PayLineInput {
  lineId: number;
  /** الافتراضي: CHECK لقسط شيك، CASH لغيره. */
  paymentMethod?: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | null;
  note?: string | null;
  /** مُرفق السند (اختياريّ دائماً — لا إلزام مُرفق في النظام). */
  attachmentUrl?: string | null;
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
