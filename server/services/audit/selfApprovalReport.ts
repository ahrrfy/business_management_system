/**
 * تقريرُ الاعتماد الذاتي — الضابطُ التعويضيّ لقرار المالك (٣/٩/٢٦، PR #962):
 * «لا اعتماد ثانٍ بعد المالك». راجع توثيق العقد الكامل في `shared/approvalPolicy.ts`:
 *
 *   «والتقريرُ يحلّ محلّ الفصل، فهو جزءٌ من السياسة لا زينةٌ بعدها: كلُّ ما اعتمده
 *    المالك على نفسه يجب أن يظهر في شاشةٍ واحدة مرتّبةٍ بالمبلغ. بلا هذه الشاشة
 *    تصير القاعدة تبسيطاً بلا رقابة.»
 *
 * هذا الملف هو تلك الشاشة من طرفها الخادميّ: يجمع كل موضعٍ صار فيه صانعُ الطلب هو
 * نفسُه من قرّره — عبر تسعة جداولَ توزّعها عشرةُ مواضع الإصلاح الأصليّة (بعضها يشترك
 * في جدولٍ واحد: راجع `server/services/approval/ownerGate.ts` وذاكرة
 * [[owner-decision-no-second-approval-2026-09-03]] للخريطة الكاملة).
 *
 * ⛔ **معيارُ الصفّ هو التساوي الحرفيّ بين عمودَي المُنشئ والمُقرِّر، لا `isOwner` الحاليّ**:
 * `users.isOwner` بلا سجلّ تاريخيّ (لا عمود "isOwnerAtDecisionTime")، فقد يُسحَب امتيازُ
 * المالك لاحقاً بينما يبقى القرارُ التاريخيّ ذاتيّاً — وإخفاؤه عندئذٍ يُفرغ التقرير من
 * قيمته التدقيقية. والتساوي وحده دليلٌ كافٍ: لا مسارَ تطبيقيّ ولا قيدَ قاعدةٍ (بعد الهجرة
 * 0333) يسمحان بمُنشئٍ = مُقرِّرٍ لغير مالكٍ نشطٍ وقت اتّخاذ القرار.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { requireDb } from "../tx";
import {
  SELF_APPROVAL_KIND_LABEL_AR,
  type SelfApprovalKind,
} from "../../../shared/selfApprovalKinds";

export { SELF_APPROVAL_KIND_LABEL_AR, type SelfApprovalKind };

export interface SelfApprovalRecord {
  kind: SelfApprovalKind;
  kindLabel: string;
  id: number;
  subject: string;
  detail: string | null;
  amount: string | null;
  actorUserId: number;
  actorName: string;
  decidedAt: Date;
  branchId: number | null;
  href: string;
}

function displayName(row: { name: string | null; username: string | null; email: string | null } | undefined): string {
  return row?.name || row?.username || row?.email || "—";
}

/** يجمع كلَّ فعلٍ ماليّ نفّذه المالك على نفسه — مرتّبٌ بالمبلغ تنازلياً. */
export async function listSelfApprovalRecords(): Promise<SelfApprovalRecord[]> {
  const db = requireDb();

  const [
    receiptRows,
    supplierPaymentRows,
    supplierPaymentRefundRows,
    purchaseChargeRows,
    purchaseReturnRows,
    purchaseReturnReversalRows,
    payrollAccrualRows,
    payrollPaidRows,
    advanceRepaymentRows,
    remittanceApprovedRows,
    remittancePaidRows,
  ] = await Promise.all([
    db
      .select({
        id: s.receipts.id,
        direction: s.receipts.direction,
        amount: s.receipts.amount,
        voucherNumber: s.receipts.voucherNumber,
        description: s.receipts.description,
        counterpartyName: s.receipts.counterpartyName,
        workOrderId: s.receipts.workOrderId,
        workOrderNumber: s.workOrders.orderNumber,
        branchId: s.receipts.branchId,
        approvedBy: s.receipts.approvedBy,
        approvedAt: s.receipts.approvedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
        expenseDescription: s.expenses.description,
        expensePayee: s.expenses.payee,
      })
      .from(s.receipts)
      .leftJoin(s.workOrders, eq(s.receipts.workOrderId, s.workOrders.id))
      .leftJoin(s.expenses, eq(s.expenses.receiptId, s.receipts.id))
      .leftJoin(s.users, eq(s.users.id, s.receipts.approvedBy))
      .where(
        and(
          eq(s.receipts.approvalStatus, "APPROVED"),
          isNotNull(s.receipts.approvedBy),
          sql`${s.receipts.createdBy} = ${s.receipts.approvedBy}`,
        ),
      ),
    db
      .select({
        id: s.supplierPaymentRequests.id,
        amount: s.supplierPaymentRequests.requestedAmount,
        reason: s.supplierPaymentRequests.reason,
        supplierName: s.suppliers.name,
        branchId: s.supplierPaymentRequests.branchId,
        reviewedBy: s.supplierPaymentRequests.reviewedBy,
        reviewedAt: s.supplierPaymentRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.supplierPaymentRequests)
      .leftJoin(s.suppliers, eq(s.suppliers.id, s.supplierPaymentRequests.supplierId))
      .leftJoin(s.users, eq(s.users.id, s.supplierPaymentRequests.reviewedBy))
      .where(
        and(
          eq(s.supplierPaymentRequests.status, "APPROVED"),
          sql`${s.supplierPaymentRequests.requestedBy} = ${s.supplierPaymentRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.supplierPaymentRefundRequests.id,
        amount: s.supplierPaymentRefundRequests.requestedAmount,
        reason: s.supplierPaymentRefundRequests.reason,
        branchId: s.supplierPaymentRefundRequests.branchId,
        reviewedBy: s.supplierPaymentRefundRequests.reviewedBy,
        reviewedAt: s.supplierPaymentRefundRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.supplierPaymentRefundRequests)
      .leftJoin(s.users, eq(s.users.id, s.supplierPaymentRefundRequests.reviewedBy))
      .where(
        and(
          eq(s.supplierPaymentRefundRequests.status, "APPROVED"),
          sql`${s.supplierPaymentRefundRequests.requestedBy} = ${s.supplierPaymentRefundRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.purchaseChargeControlRequests.id,
        amount: s.purchaseCharges.amount,
        chargeNumber: s.purchaseCharges.chargeNumber,
        branchId: s.purchaseChargeControlRequests.branchId,
        reviewedBy: s.purchaseChargeControlRequests.reviewedBy,
        reviewedAt: s.purchaseChargeControlRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.purchaseChargeControlRequests)
      .leftJoin(s.purchaseCharges, eq(s.purchaseCharges.id, s.purchaseChargeControlRequests.purchaseChargeId))
      .leftJoin(s.users, eq(s.users.id, s.purchaseChargeControlRequests.reviewedBy))
      .where(
        and(
          eq(s.purchaseChargeControlRequests.status, "APPROVED"),
          sql`${s.purchaseChargeControlRequests.requestedBy} = ${s.purchaseChargeControlRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.purchaseReturnRequests.id,
        amount: s.purchaseReturnRequests.requestedTotalAmount,
        reason: s.purchaseReturnRequests.reason,
        branchId: s.purchaseReturnRequests.branchId,
        reviewedBy: s.purchaseReturnRequests.reviewedBy,
        reviewedAt: s.purchaseReturnRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.purchaseReturnRequests)
      .leftJoin(s.users, eq(s.users.id, s.purchaseReturnRequests.reviewedBy))
      .where(
        and(
          eq(s.purchaseReturnRequests.status, "APPROVED"),
          sql`${s.purchaseReturnRequests.requestedBy} = ${s.purchaseReturnRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.purchaseReturnReversalRequests.id,
        amount: s.purchaseReturns.totalAmount,
        returnNumber: s.purchaseReturns.returnNumber,
        branchId: s.purchaseReturnReversalRequests.branchId,
        reviewedBy: s.purchaseReturnReversalRequests.reviewedBy,
        reviewedAt: s.purchaseReturnReversalRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.purchaseReturnReversalRequests)
      .leftJoin(s.purchaseReturns, eq(s.purchaseReturns.id, s.purchaseReturnReversalRequests.purchaseReturnId))
      .leftJoin(s.users, eq(s.users.id, s.purchaseReturnReversalRequests.reviewedBy))
      .where(
        and(
          eq(s.purchaseReturnReversalRequests.status, "APPROVED"),
          sql`${s.purchaseReturnReversalRequests.requestedBy} = ${s.purchaseReturnReversalRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.payrollRuns.id,
        period: s.payrollRuns.period,
        amount: s.payrollRuns.totalNet,
        branchId: s.payrollRuns.branchId,
        approvedBy: s.payrollRuns.approvedBy,
        approvedAt: s.payrollRuns.approvedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollRuns)
      .leftJoin(s.users, eq(s.users.id, s.payrollRuns.approvedBy))
      .where(
        and(
          isNotNull(s.payrollRuns.approvedBy),
          sql`${s.payrollRuns.createdBy} = ${s.payrollRuns.approvedBy}`,
        ),
      ),
    db
      .select({
        id: s.payrollRuns.id,
        period: s.payrollRuns.period,
        amount: s.payrollRuns.totalNet,
        branchId: s.payrollRuns.branchId,
        paidBy: s.payrollRuns.paidBy,
        paidAt: s.payrollRuns.paidAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollRuns)
      .leftJoin(s.users, eq(s.users.id, s.payrollRuns.paidBy))
      .where(
        and(
          eq(s.payrollRuns.status, "paid"),
          isNotNull(s.payrollRuns.paidBy),
          sql`${s.payrollRuns.createdBy} = ${s.payrollRuns.paidBy}`,
        ),
      ),
    db
      .select({
        id: s.employeeAdvanceRepaymentRequests.id,
        amount: s.employeeAdvanceRepaymentRequests.amount,
        evidenceNote: s.employeeAdvanceRepaymentRequests.evidenceNote,
        branchId: s.employeeAdvanceRepaymentRequests.branchId,
        reviewedBy: s.employeeAdvanceRepaymentRequests.reviewedBy,
        reviewedAt: s.employeeAdvanceRepaymentRequests.reviewedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.employeeAdvanceRepaymentRequests)
      .leftJoin(s.users, eq(s.users.id, s.employeeAdvanceRepaymentRequests.reviewedBy))
      .where(
        and(
          eq(s.employeeAdvanceRepaymentRequests.status, "APPROVED"),
          sql`${s.employeeAdvanceRepaymentRequests.createdBy} = ${s.employeeAdvanceRepaymentRequests.reviewedBy}`,
        ),
      ),
    db
      .select({
        id: s.payrollRemittanceRequests.id,
        amount: s.payrollRemittanceRequests.requestedAmount,
        authorityName: s.payrollRemittanceRequests.authorityName,
        branchId: s.payrollRemittanceRequests.payingBranchId,
        approvedBy: s.payrollRemittanceRequests.approvedBy,
        approvedAt: s.payrollRemittanceRequests.approvedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollRemittanceRequests)
      .leftJoin(s.users, eq(s.users.id, s.payrollRemittanceRequests.approvedBy))
      .where(
        and(
          isNotNull(s.payrollRemittanceRequests.approvedBy),
          sql`${s.payrollRemittanceRequests.createdBy} = ${s.payrollRemittanceRequests.approvedBy}`,
        ),
      ),
    db
      .select({
        id: s.payrollRemittanceRequests.id,
        amount: s.payrollRemittanceRequests.requestedAmount,
        authorityName: s.payrollRemittanceRequests.authorityName,
        branchId: s.payrollRemittanceRequests.payingBranchId,
        paidBy: s.payrollRemittanceRequests.paidBy,
        paidAt: s.payrollRemittanceRequests.paidAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollRemittanceRequests)
      .leftJoin(s.users, eq(s.users.id, s.payrollRemittanceRequests.paidBy))
      .where(
        and(
          eq(s.payrollRemittanceRequests.status, "PAID"),
          isNotNull(s.payrollRemittanceRequests.paidBy),
          sql`${s.payrollRemittanceRequests.createdBy} = ${s.payrollRemittanceRequests.paidBy}`,
        ),
      ),
  ]);

  const records: SelfApprovalRecord[] = [];

  for (const row of receiptRows) {
    const isExpense = row.expenseDescription != null || row.expensePayee != null;
    const isWorkOrderRefund = row.workOrderId != null;
    const kind: SelfApprovalKind = isExpense
      ? "expense"
      : isWorkOrderRefund
        ? "workOrderRefund"
        : "voucher";
    records.push({
      kind,
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR[kind],
      id: Number(row.id),
      subject:
        (isWorkOrderRefund && row.workOrderNumber) ||
        row.voucherNumber ||
        `${row.direction === "IN" ? "قبض" : "صرف"} #${row.id}`,
      detail: isExpense
        ? [row.expenseDescription, row.expensePayee].filter(Boolean).join(" · ") || null
        : row.description || row.counterpartyName || null,
      amount: row.amount,
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: isWorkOrderRefund && row.workOrderId ? `/work-orders/${row.workOrderId}` : "/vouchers",
    });
  }

  for (const row of supplierPaymentRows) {
    records.push({
      kind: "supplierPayment",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.supplierPayment,
      id: Number(row.id),
      subject: row.supplierName ? `سداد مورّد — ${row.supplierName}` : `سداد مورّد #${row.id}`,
      detail: row.reason,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/purchases/supplier-payments",
    });
  }

  for (const row of supplierPaymentRefundRows) {
    records.push({
      kind: "supplierPaymentRefund",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.supplierPaymentRefund,
      id: Number(row.id),
      subject: `استرداد سداد مورّد #${row.id}`,
      detail: row.reason,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/purchases/supplier-payments",
    });
  }

  for (const row of purchaseChargeRows) {
    records.push({
      kind: "purchaseCharge",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.purchaseCharge,
      id: Number(row.id),
      subject: row.chargeNumber || `مصروف شراء #${row.id}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/purchases/charges",
    });
  }

  for (const row of purchaseReturnRows) {
    records.push({
      kind: "purchaseReturn",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.purchaseReturn,
      id: Number(row.id),
      subject: `مرتجع شراء #${row.id}`,
      detail: row.reason,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/purchases/returns",
    });
  }

  for (const row of purchaseReturnReversalRows) {
    records.push({
      kind: "purchaseReturnReversal",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.purchaseReturnReversal,
      id: Number(row.id),
      subject: row.returnNumber ? `عكس ${row.returnNumber}` : `عكس مرتجع شراء #${row.id}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/purchases/returns",
    });
  }

  for (const row of payrollAccrualRows) {
    records.push({
      kind: "payrollAccrualApproval",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollAccrualApproval,
      id: Number(row.id),
      subject: `مسيّر ${row.period}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/payroll",
    });
  }

  for (const row of payrollPaidRows) {
    records.push({
      kind: "payrollNetPayment",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollNetPayment,
      id: Number(row.id),
      subject: `مسيّر ${row.period}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.paidBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.paidAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/payroll",
    });
  }

  for (const row of advanceRepaymentRows) {
    records.push({
      kind: "advanceRepayment",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.advanceRepayment,
      id: Number(row.id),
      subject: `تقسيط سلفة #${row.id}`,
      detail: row.evidenceNote,
      amount: row.amount,
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/hr/advances",
    });
  }

  for (const row of remittanceApprovedRows) {
    records.push({
      kind: "payrollRemittanceApproval",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollRemittanceApproval,
      id: Number(row.id),
      subject: row.authorityName || `تحويل استقطاعات #${row.id}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/payroll",
    });
  }

  for (const row of remittancePaidRows) {
    records.push({
      kind: "payrollRemittancePayment",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollRemittancePayment,
      id: Number(row.id),
      subject: row.authorityName || `تحويل استقطاعات #${row.id}`,
      detail: null,
      amount: row.amount,
      actorUserId: Number(row.paidBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.paidAt ?? new Date(0),
      branchId: row.branchId == null ? null : Number(row.branchId),
      href: "/payroll",
    });
  }

  records.sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
  return records;
}
