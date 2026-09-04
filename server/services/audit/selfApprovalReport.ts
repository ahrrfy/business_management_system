/**
 * تقريرُ الاعتماد الذاتي — الضابطُ التعويضيّ لقرار المالك (٣/٩/٢٦، PR #962):
 * «لا اعتماد ثانٍ بعد المالك». راجع توثيق العقد الكامل في `shared/approvalPolicy.ts`:
 *
 *   «والتقريرُ يحلّ محلّ الفصل، فهو جزءٌ من السياسة لا زينةٌ بعدها: كلُّ ما اعتمده
 *    المالك على نفسه يجب أن يظهر في شاشةٍ واحدة مرتّبةٍ بالمبلغ. بلا هذه الشاشة
 *    تصير القاعدة تبسيطاً بلا رقابة.»
 *
 * هذا الملف هو تلك الشاشة من طرفها الخادميّ: يجمع كل موضعٍ صار فيه صانعُ الطلب هو
 * نفسُه من قرّره. راجع `server/services/approval/ownerGate.ts` وذاكرة
 * [[owner-decision-no-second-approval-2026-09-03]] للخريطة الكاملة.
 *
 * ⛔ **معيارُ الصفّ هو التساوي الحرفيّ بين عمودَي المُنشئ والمُقرِّر، لا `isOwner` الحاليّ**:
 * `users.isOwner` بلا سجلّ تاريخيّ (لا عمود "isOwnerAtDecisionTime")، فقد يُسحَب امتيازُ
 * المالك لاحقاً بينما يبقى القرارُ التاريخيّ ذاتيّاً — وإخفاؤه عندئذٍ يُفرغ التقرير من
 * قيمته التدقيقية. والتساوي وحده دليلٌ كافٍ: لا مسارَ تطبيقيّ ولا قيدَ قاعدةٍ (بعد الهجرة
 * 0333) يسمحان بمُنشئٍ = مُقرِّرٍ لغير مالكٍ نشطٍ وقت اتّخاذ القرار.
 *
 * ⚠️ **استبعادُ إيصالات التجسيد (مراجعة Codex #982):** بعض القرارات المُعتمَدة تُنشئ
 * إيصال `receipts` نظامياً بـ`createdBy=approvedBy=المُقرِّر` كأثرٍ تنفيذيٍّ فقط (سداد
 * مورّد، مصروف شراء، مرتجع شراء وعكسه) — هذا الإيصال **ليس** قراراً ذاتياً مستقلاً، بل
 * نتيجةٌ آليةٌ لقرارٍ نُعِدّه بالفعل من جدول حوكمته الخاص. عدُّه ثانيةً كان يُضاعف
 * المبلغ ويُنتج إيجابياتٍ كاذبة حين يكون مُنشئ الطلب الأصليّ موظّفاً لا المالك. يُستبعَد
 * أيّ إيصالٍ تشير إليه أعمدة `receiptId` في الجداول التنفيذية (supplierPayments،
 * supplierPaymentRefunds) أو `paymentReceiptId`/`reversalReceiptId` في purchaseCharges
 * أو `cashRefundReceiptId`/`cashRepaymentReceiptId` في purchaseReturns/Reversals أو
 * `receiptId` في طلبات تقسيط السلفة.
 */
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
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
  direction: "IN" | "OUT";
  actorUserId: number;
  actorName: string;
  decidedAt: Date;
  branchId: number | null;
  branchName: string | null;
  href: string;
}

export interface SelfApprovalQueryOptions {
  /** YYYY-MM-DD ضمنيّ. بلا حدّ = كامل التاريخ. */
  from?: string;
  /** YYYY-MM-DD ضمنيّ. */
  to?: string;
}

function displayName(row: { name: string | null; username: string | null; email: string | null } | undefined): string {
  return row?.name || row?.username || row?.email || "—";
}

/** يبني حدّ تاريخٍ آمناً بمقارنة `DATE()` — يطابق نمط `reportsTreasuryService.ts` المُعتمَد. */
function dateBound(column: unknown, from: string | undefined, to: string | undefined) {
  const parts = [];
  if (from) parts.push(sql`DATE(${column}) >= ${from}`);
  if (to) parts.push(sql`DATE(${column}) <= ${to}`);
  return parts;
}

/** يجمع كلَّ فعلٍ ماليّ نفّذه المالك على نفسه — مرتّبٌ بالمبلغ تنازلياً. */
export async function listSelfApprovalRecords(
  opts: SelfApprovalQueryOptions = {},
): Promise<SelfApprovalRecord[]> {
  const db = requireDb();
  const { from, to } = opts;

  const branchRows = await db.select({ id: s.branches.id, name: s.branches.name }).from(s.branches);
  const branchName = new Map(branchRows.map((b) => [Number(b.id), b.name]));

  const [
    receiptRows,
    supplierPaymentRows,
    supplierPaymentRefundRows,
    purchaseChargeRows,
    purchaseReturnRows,
    purchaseReturnReversalRows,
    goodsReceiptReversalRows,
    supplierInvoiceReversalRows,
    payrollAccrualRows,
    payrollAccrualZeroCompRows,
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
        createdAt: s.receipts.createdAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
        expenseId: s.expenses.id,
        expenseDescription: s.expenses.description,
        expensePayee: s.expenses.payee,
      })
      .from(s.receipts)
      .leftJoin(s.workOrders, eq(s.receipts.workOrderId, s.workOrders.id))
      .leftJoin(s.expenses, eq(s.expenses.receiptId, s.receipts.id))
      .leftJoin(s.users, eq(s.users.id, s.receipts.approvedBy))
      // استبعادُ إيصالات التجسيد — راجع رأس الملفّ.
      .leftJoin(s.supplierPayments, eq(s.supplierPayments.receiptId, s.receipts.id))
      .leftJoin(s.supplierPaymentRefunds, eq(s.supplierPaymentRefunds.receiptId, s.receipts.id))
      .leftJoin(
        s.purchaseCharges,
        sql`${s.purchaseCharges.paymentReceiptId} = ${s.receipts.id} OR ${s.purchaseCharges.reversalReceiptId} = ${s.receipts.id}`,
      )
      .leftJoin(s.purchaseReturns, eq(s.purchaseReturns.cashRefundReceiptId, s.receipts.id))
      .leftJoin(s.purchaseReturnReversals, eq(s.purchaseReturnReversals.cashRepaymentReceiptId, s.receipts.id))
      .leftJoin(s.employeeAdvanceRepaymentRequests, eq(s.employeeAdvanceRepaymentRequests.receiptId, s.receipts.id))
      .where(
        and(
          eq(s.receipts.approvalStatus, "APPROVED"),
          isNotNull(s.receipts.approvedBy),
          sql`${s.receipts.createdBy} = ${s.receipts.approvedBy}`,
          isNull(s.supplierPayments.id),
          isNull(s.supplierPaymentRefunds.id),
          isNull(s.purchaseCharges.id),
          isNull(s.purchaseReturns.id),
          isNull(s.purchaseReturnReversals.id),
          isNull(s.employeeAdvanceRepaymentRequests.id),
          ...dateBound(sql`COALESCE(${s.receipts.approvedAt}, ${s.receipts.createdAt})`, from, to),
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
        requestedAt: s.supplierPaymentRequests.requestedAt,
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
          ...dateBound(
            sql`COALESCE(${s.supplierPaymentRequests.reviewedAt}, ${s.supplierPaymentRequests.requestedAt})`,
            from,
            to,
          ),
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
        requestedAt: s.supplierPaymentRefundRequests.requestedAt,
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
          ...dateBound(
            sql`COALESCE(${s.supplierPaymentRefundRequests.reviewedAt}, ${s.supplierPaymentRefundRequests.requestedAt})`,
            from,
            to,
          ),
        ),
      ),
    db
      .select({
        id: s.purchaseChargeControlRequests.id,
        kind: s.purchaseChargeControlRequests.kind,
        amount: s.purchaseCharges.amount,
        chargeNumber: s.purchaseCharges.chargeNumber,
        branchId: s.purchaseChargeControlRequests.branchId,
        reviewedBy: s.purchaseChargeControlRequests.reviewedBy,
        reviewedAt: s.purchaseChargeControlRequests.reviewedAt,
        requestedAt: s.purchaseChargeControlRequests.requestedAt,
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
          ...dateBound(
            sql`COALESCE(${s.purchaseChargeControlRequests.reviewedAt}, ${s.purchaseChargeControlRequests.requestedAt})`,
            from,
            to,
          ),
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
        requestedAt: s.purchaseReturnRequests.requestedAt,
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
          ...dateBound(
            sql`COALESCE(${s.purchaseReturnRequests.reviewedAt}, ${s.purchaseReturnRequests.requestedAt})`,
            from,
            to,
          ),
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
        requestedAt: s.purchaseReturnReversalRequests.requestedAt,
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
          ...dateBound(
            sql`COALESCE(${s.purchaseReturnReversalRequests.reviewedAt}, ${s.purchaseReturnReversalRequests.requestedAt})`,
            from,
            to,
          ),
        ),
      ),
    // ⭐ توسيعُ قرار المالك (٤/٩/٢٦) على المشتريات: عكسُ استلام البضاعة — الاعتمادُ فقط
    // (goodsReceiptReversalTrigger: APPROVE ⇒ ERASE_EFFECT، وREJECT بلا بوّابة أصلاً فلا
    // يُقاس عليه اعتمادٌ ذاتيّ). `goodsReceipts.totalAmount` عمودٌ محسوبٌ على الرأس
    // (netAmount+taxAmount) فلا حاجة لتجميع بنودٍ.
    db
      .select({
        id: s.goodsReceiptReversalRequests.id,
        amount: s.goodsReceipts.totalAmount,
        receiptNumber: s.goodsReceipts.receiptNumber,
        branchId: s.goodsReceiptReversalRequests.branchId,
        reviewedBy: s.goodsReceiptReversalRequests.reviewedBy,
        reviewedAt: s.goodsReceiptReversalRequests.reviewedAt,
        requestedAt: s.goodsReceiptReversalRequests.requestedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.goodsReceiptReversalRequests)
      .leftJoin(s.goodsReceipts, eq(s.goodsReceipts.id, s.goodsReceiptReversalRequests.goodsReceiptId))
      .leftJoin(s.users, eq(s.users.id, s.goodsReceiptReversalRequests.reviewedBy))
      .where(
        and(
          eq(s.goodsReceiptReversalRequests.status, "APPROVED"),
          sql`${s.goodsReceiptReversalRequests.requestedBy} = ${s.goodsReceiptReversalRequests.reviewedBy}`,
          ...dateBound(
            sql`COALESCE(${s.goodsReceiptReversalRequests.reviewedAt}, ${s.goodsReceiptReversalRequests.requestedAt})`,
            from,
            to,
          ),
        ),
      ),
    // ⭐ توسيعُ قرار المالك (٤/٩/٢٦): عكسُ فاتورة المورّد — `kind='REVERSE_INVOICE'` فقط
    // (supplierInvoiceApprovalTrigger: POST_INVOICE ⇒ null دائماً — ينشئ ذمّةً لا يمحو
    // أثراً ⇒ لا بوّابة أصلاً فلا معنى لـ«اعتمادٍ ذاتيّ» عليه؛ REVERSE_INVOICE+اعتماد فقط
    // ⇒ ERASE_EFFECT الحقيقيّ الوحيد هنا).
    db
      .select({
        id: s.supplierInvoiceApprovalRequests.id,
        amount: s.supplierInvoices.totalAmount,
        invoiceNumber: s.supplierInvoices.invoiceNumber,
        branchId: s.supplierInvoiceApprovalRequests.branchId,
        reviewedBy: s.supplierInvoiceApprovalRequests.reviewedBy,
        reviewedAt: s.supplierInvoiceApprovalRequests.reviewedAt,
        requestedAt: s.supplierInvoiceApprovalRequests.requestedAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.supplierInvoiceApprovalRequests)
      .leftJoin(s.supplierInvoices, eq(s.supplierInvoices.id, s.supplierInvoiceApprovalRequests.supplierInvoiceId))
      .leftJoin(s.users, eq(s.users.id, s.supplierInvoiceApprovalRequests.reviewedBy))
      .where(
        and(
          eq(s.supplierInvoiceApprovalRequests.kind, "REVERSE_INVOICE"),
          eq(s.supplierInvoiceApprovalRequests.status, "APPROVED"),
          sql`${s.supplierInvoiceApprovalRequests.requestedBy} = ${s.supplierInvoiceApprovalRequests.reviewedBy}`,
          ...dateBound(
            sql`COALESCE(${s.supplierInvoiceApprovalRequests.reviewedAt}, ${s.supplierInvoiceApprovalRequests.requestedAt})`,
            from,
            to,
          ),
        ),
      ),
    // اعتمادُ استحقاق مسيّر — دفتر الأحداث الإلحاقيّ (payrollAccountingEvents) بشرطِ تطابق
    // revisionNo مع payrollRuns **الحاليّ** (مراجعة Codex الثانية على #984، تصحيحٌ لمحاولةٍ
    // أولى كانت تقارن كل حدثٍ تاريخيّ بعمودَي payrollRuns.createdBy/totalNet المتقلّبَين
    // بلا قيدٍ زمنيّ — فكانت تُسيء نسبة/تسعير مراجعاتٍ سابقة عدّلها معدٌّ لاحق):
    //   - `server/services/payroll/update.ts` يعيد كتابة `payrollRuns.createdBy` لآخر معدّلٍ
    //     ماليّ، فمقارنةُ حدثٍ قديم بهذا العمود الحاليّ قد تُسقط اعتماداً ذاتياً حقيقياً أو
    //     تنسبه خطأً لشخصٍ لم يعتمده.
    //   - `totalNet` الحاليّ قد يخصّ مراجعةً لاحقة، لا المراجعة التي وقع فيها ذلك الاعتماد.
    // تطابقُ revisionNo يحسم الالتباس: `reopenPayrollAccrualTx` يرفع revisionNo عند كل
    // إعادة فتحٍ، فطالما لم يتغيّر منذ الحدث، تبقى أعمدة payrollRuns الحالية مرآةً دقيقة
    // لتلك المراجعة بالذات — بلا حاجة للقطةٍ إضافية. **الأثر الجانبي المقصود**: مراجعةٌ
    // أُعيد فتحها ولم تُعتمَد مجدداً بعد (لا تزال مسودّة) لا تظهر مؤقتاً — وهذا صحيحٌ دلالياً
    // (لا اعتماد ذاتيّ "حاليّ" أثناء المسودّة)، وأدقّ من عرض بياناتٍ خاطئة.
    // ⚠️ الفجوة المتبقّية المقصودة: اعتمادٌ ذاتيٌّ من مراجعةٍ سابقةٍ استُبدلت بمراجعةٍ
    // أحدث (سواءٌ آلت الأحدث لاعتمادٍ ذاتيٍّ آخر أو لا تزال مسودّة) لا سبيل لعرضه بدقّة
    // بلا عمودَي لقطةٍ جديدين (maker/amount وقت الاعتماد) — تغييرٌ مخطّطيّ خارج نطاق هذا الـPR.
    // ⚠️ `createdAt` لا `occurredAt` للتاريخ (Codex): `occurredAt` هو تاريخ استحقاق الفترة
    // المحاسبية (accrualDate)، لا لحظة الاعتماد الفعلية — فلترة/عرضٌ به يُصنّف مسيّر آب
    // المُعتمَد في ٥ أيلول كأنه قرارُ آب، ويختفي من تدقيق أيلول.
    db
      .select({
        id: s.payrollRuns.id,
        period: s.payrollRuns.period,
        amount: s.payrollRuns.totalNet,
        branchId: s.payrollRuns.branchId,
        approvedBy: s.payrollAccountingEvents.createdBy,
        approvedAt: s.payrollAccountingEvents.createdAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollAccountingEvents)
      .innerJoin(
        s.payrollRuns,
        and(
          eq(s.payrollRuns.id, s.payrollAccountingEvents.runId),
          eq(s.payrollRuns.revisionNo, s.payrollAccountingEvents.revisionNo),
        ),
      )
      .leftJoin(s.users, eq(s.users.id, s.payrollAccountingEvents.createdBy))
      .where(
        and(
          eq(s.payrollAccountingEvents.eventKind, "ACCRUAL"),
          sql`${s.payrollAccountingEvents.createdBy} = ${s.payrollRuns.createdBy}`,
          ...dateBound(s.payrollAccountingEvents.createdAt, from, to),
        ),
      ),
    // مسيّرٌ ذاتيّ الاعتماد **بلا** أيّ حدث ACCRUAL — حالةٌ حقيقية لا عطب (مراجعة Codex):
    // `approvePayrollAccrualTx` لا يكتب حدثاً إلا لبندٍ بمصروفٍ غير صفري
    // (`item.breakdown.expenseTotal.gt(0)`)، فمسيّرٌ كل موظّفيه بتعويضٍ صفريّ (فترة تطوّعية/
    // مجمَّدة) يبقى بلا أثرٍ في الدفتر الإلحاقيّ رغم أنّ عمودَي payrollRuns الحاليّين يثبتان
    // اعتماداً ذاتياً حقيقياً. الاستعلام أعلاه لا يلتقطه فيسقط من التقرير صامتاً؛ هذا يلتقط
    // تلك الحالة النادرة وحدها (LEFT JOIN + IS NULL على أيّ حدث للمراجعة الحالية).
    db
      .select({
        id: s.payrollRuns.id,
        period: s.payrollRuns.period,
        amount: s.payrollRuns.totalNet,
        branchId: s.payrollRuns.branchId,
        approvedBy: s.payrollRuns.approvedBy,
        approvedAt: s.payrollRuns.approvedAt,
        createdAt: s.payrollRuns.createdAt,
        approverName: s.users.name,
        approverUsername: s.users.username,
        approverEmail: s.users.email,
      })
      .from(s.payrollRuns)
      .leftJoin(
        s.payrollAccountingEvents,
        and(
          eq(s.payrollAccountingEvents.runId, s.payrollRuns.id),
          eq(s.payrollAccountingEvents.revisionNo, s.payrollRuns.revisionNo),
          eq(s.payrollAccountingEvents.eventKind, "ACCRUAL"),
        ),
      )
      .leftJoin(s.users, eq(s.users.id, s.payrollRuns.approvedBy))
      .where(
        and(
          isNotNull(s.payrollRuns.approvedBy),
          sql`${s.payrollRuns.createdBy} = ${s.payrollRuns.approvedBy}`,
          isNull(s.payrollAccountingEvents.id),
          ...dateBound(sql`COALESCE(${s.payrollRuns.approvedAt}, ${s.payrollRuns.createdAt})`, from, to),
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
        createdAt: s.payrollRuns.createdAt,
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
          ...dateBound(sql`COALESCE(${s.payrollRuns.paidAt}, ${s.payrollRuns.createdAt})`, from, to),
        ),
      ),
    db
      .select({
        id: s.employeeAdvanceRepaymentRequests.id,
        requestKind: s.employeeAdvanceRepaymentRequests.requestKind,
        amount: s.employeeAdvanceRepaymentRequests.amount,
        evidenceNote: s.employeeAdvanceRepaymentRequests.evidenceNote,
        branchId: s.employeeAdvanceRepaymentRequests.branchId,
        reviewedBy: s.employeeAdvanceRepaymentRequests.reviewedBy,
        reviewedAt: s.employeeAdvanceRepaymentRequests.reviewedAt,
        createdAt: s.employeeAdvanceRepaymentRequests.createdAt,
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
          ...dateBound(
            sql`COALESCE(${s.employeeAdvanceRepaymentRequests.reviewedAt}, ${s.employeeAdvanceRepaymentRequests.createdAt})`,
            from,
            to,
          ),
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
        createdAt: s.payrollRemittanceRequests.createdAt,
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
          ...dateBound(
            sql`COALESCE(${s.payrollRemittanceRequests.approvedAt}, ${s.payrollRemittanceRequests.createdAt})`,
            from,
            to,
          ),
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
        createdAt: s.payrollRemittanceRequests.createdAt,
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
          ...dateBound(
            sql`COALESCE(${s.payrollRemittanceRequests.paidAt}, ${s.payrollRemittanceRequests.createdAt})`,
            from,
            to,
          ),
        ),
      ),
  ]);

  const records: SelfApprovalRecord[] = [];
  const DIR_LABEL: Record<"IN" | "OUT", string> = { IN: "سند قبض", OUT: "سند صرف" };

  for (const row of receiptRows) {
    const isExpense = row.expenseId != null;
    const isWorkOrderRefund = row.workOrderId != null;
    const kind: SelfApprovalKind = isExpense
      ? "expense"
      : isWorkOrderRefund
        ? "workOrderRefund"
        : "voucher";
    records.push({
      kind,
      kindLabel: isExpense || isWorkOrderRefund ? SELF_APPROVAL_KIND_LABEL_AR[kind] : DIR_LABEL[row.direction as "IN" | "OUT"],
      id: Number(row.id),
      subject:
        (isWorkOrderRefund && row.workOrderNumber) ||
        row.voucherNumber ||
        `${row.direction === "IN" ? "قبض" : "صرف"} #${row.id}`,
      detail: isExpense
        ? [row.expenseDescription, row.expensePayee].filter(Boolean).join(" · ") || null
        : row.description || row.counterpartyName || null,
      amount: row.amount,
      direction: row.direction as "IN" | "OUT",
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
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
      direction: "OUT",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
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
      direction: "IN",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/purchases/supplier-payments",
    });
  }

  for (const row of purchaseChargeRows) {
    const isReversal = row.kind === "REVERSE";
    const kind: SelfApprovalKind = isReversal ? "purchaseChargeReversal" : "purchaseCharge";
    records.push({
      kind,
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR[kind],
      id: Number(row.id),
      subject: row.chargeNumber || `مصروف شراء #${row.id}`,
      detail: null,
      amount: row.amount,
      direction: isReversal ? "IN" : "OUT",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
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
      direction: "IN",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/purchases/returns-governance",
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
      direction: "OUT",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/purchases/returns-governance",
    });
  }

  // ⚠️ `href: "/purchases"` لكلا الحلقتين التاليتين — لا شاشةً مُخصَّصة بعد: اكتشافٌ عرضيّ
  // (٤/٩/٢٦) أنّ `decideGoodsReceiptReversal`/`decideSupplierInvoiceApproval` غيرُ
  // مُوصَّلتين بأيّ إجراء tRPC (لا مستدعيَ في server/routers/** سوى الاختبارات)، فلا مسار
  // UI يُنشئ صفّاً هنا اليوم. الاستعلامان أعلاه صحيحان ومُختبَران فعلياً (إدراجٌ مباشر)
  // تحسّباً ليوم تُوصَّل فيه الشاشة — لا تُصلح الفجوة هنا، خارج نطاق هذه الشريحة.
  for (const row of goodsReceiptReversalRows) {
    records.push({
      kind: "goodsReceiptReversal",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.goodsReceiptReversal,
      id: Number(row.id),
      subject: row.receiptNumber ? `عكس ${row.receiptNumber}` : `عكس استلام #${row.id}`,
      detail: null,
      amount: row.amount,
      direction: "OUT",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/purchases",
    });
  }

  for (const row of supplierInvoiceReversalRows) {
    records.push({
      kind: "supplierInvoiceReversal",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.supplierInvoiceReversal,
      id: Number(row.id),
      subject: row.invoiceNumber ? `عكس فاتورة ${row.invoiceNumber}` : `عكس فاتورة مورّد #${row.id}`,
      detail: null,
      amount: row.amount,
      direction: "OUT",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.requestedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/purchases",
    });
  }

  // حدثٌ واحدٌ لكل مسيّر — الأحداث بند-موظّفٍ فرديّة (JOIN على revisionNo الحاليّ يضمن أنها
  // كلّها لنفس المراجعة)، فتُطوى هنا بأوّل حدثٍ فقط. seenAccrual تُشارَك مع مصدر الاستثناء
  // الصفريّ التالي كي لا يظهر نفس المسيّر مرّتين لو تغيّرت الحالة أثناء القراءتين.
  const seenAccrual = new Set<number>();
  for (const row of payrollAccrualRows) {
    if (seenAccrual.has(Number(row.id))) continue;
    seenAccrual.add(Number(row.id));
    records.push({
      kind: "payrollAccrualApproval",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollAccrualApproval,
      id: Number(row.id),
      subject: `مسيّر ${row.period}`,
      detail: null,
      amount: row.amount,
      direction: "OUT",
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=payroll",
    });
  }

  for (const row of payrollAccrualZeroCompRows) {
    if (seenAccrual.has(Number(row.id))) continue;
    seenAccrual.add(Number(row.id));
    records.push({
      kind: "payrollAccrualApproval",
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR.payrollAccrualApproval,
      id: Number(row.id),
      subject: `مسيّر ${row.period}`,
      detail: null,
      amount: row.amount,
      direction: "OUT",
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=payroll",
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
      direction: "OUT",
      actorUserId: Number(row.paidBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.paidAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=payroll",
    });
  }

  for (const row of advanceRepaymentRows) {
    const isReturn = row.requestKind === "RETURN";
    const kind: SelfApprovalKind = isReturn ? "advanceRepaymentReturn" : "advanceRepayment";
    records.push({
      kind,
      kindLabel: SELF_APPROVAL_KIND_LABEL_AR[kind],
      id: Number(row.id),
      subject: isReturn ? `إرجاع تقسيط سلفة #${row.id}` : `تقسيط سلفة #${row.id}`,
      detail: row.evidenceNote,
      amount: row.amount,
      direction: isReturn ? "OUT" : "IN",
      actorUserId: Number(row.reviewedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.reviewedAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=advances",
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
      direction: "OUT",
      actorUserId: Number(row.approvedBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.approvedAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=payroll",
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
      direction: "OUT",
      actorUserId: Number(row.paidBy),
      actorName: displayName({ name: row.approverName, username: row.approverUsername, email: row.approverEmail }),
      decidedAt: row.paidAt ?? row.createdAt,
      branchId: row.branchId == null ? null : Number(row.branchId),
      branchName: row.branchId == null ? null : (branchName.get(Number(row.branchId)) ?? null),
      href: "/hr?tab=payroll",
    });
  }

  records.sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
  return records;
}
