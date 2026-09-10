// قرار المالك (٣/٩/٢٦، PR #962): لا اعتماد ثانٍ بعد المالك — مالكٌ نشطٌ يعتمد ما أنشأه هو
// بنفسه. طبّق PR #962 هذا في طبقة التطبيق على عشرة مواضع، لكن ستّاً من الجداول التي تخصّ
// أربعةً منها ظلّت تحمل قيد CHECK على مستوى القاعدة يفرض `reviewedBy <> requestedBy`
// (أو `approvedBy <> createdBy`) **بلا استثناء** — فمالكٌ يعتمد سداد موردٍ أو مصروف شراءٍ
// أو مرتجعَ شراءٍ أو مسيّرَ استقطاعٍ أنشأه هو بنفسه كان يُقابَل بخطأ MySQL خامّ
// (ER_CHECK_CONSTRAINT_VIOLATED)، رغم أنّ طبقة التطبيق تسمح له. الهجرة 0333 أسقطت الستّة.
// راجع ذاكرة [[owner-decision-no-second-approval-2026-09-03]] للتفصيل الكامل.
//
// ⭐ توسيعُ القرار (٤/٩/٢٦): ثلاثةُ جداولٍ إضافية من مسارات حوكمة المشتريات — طلب الشراء
// الداخليّ · عكس استلام البضاعة · اعتماد/عكس فاتورة المورّد. الهجرة 0334 أسقطت قيودها.
// إثباتُها الفعليّ (لا الكتالوجيّ وحسب) عبر سلسلة الخدمة الكاملة لا إدراجٍ خامّ — راجع
// server/services/__tests__/purchaseGovernanceS1S2.test.ts («S2ب») و
// server/services/__tests__/financialHardening2.test.ts («#7»).
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const DROPPED_MAKER_CHECKER_CONSTRAINTS: ReadonlyArray<{ table: string; constraint: string }> = [
  { table: "purchaseReturnRequests", constraint: "chk_purchase_return_request_maker_checker" },
  { table: "purchaseReturnReversalRequests", constraint: "chk_purchase_return_reversal_maker_checker" },
  { table: "supplierPaymentRequests", constraint: "chk_supplier_payment_request_maker_checker" },
  { table: "supplierPaymentRefundRequests", constraint: "chk_supplier_payment_refund_maker_checker" },
  { table: "purchaseChargeControlRequests", constraint: "chk_purchase_charge_control_maker_checker" },
  { table: "payrollRemittanceRequests", constraint: "chk_payroll_remittance_maker_checker" },
  { table: "purchaseRequisitionControlRequests", constraint: "chk_purchase_req_control_maker_checker" },
  { table: "goodsReceiptReversalRequests", constraint: "chk_grn_reversal_request_maker_checker" },
  { table: "supplierInvoiceApprovalRequests", constraint: "chk_supplier_invoice_approval_maker_checker" },
  { table: "purchaseOrderControlRequests", constraint: "chk_po_control_maker_checker" },
  { table: "purchaseIntegrityCases", constraint: "chk_purchase_integrity_resolution_sod" },
  { table: "purchaseIntegrityCaseEvents", constraint: "chk_purchase_integrity_event_sod" },
  { table: "accrualCorrectionRequests", constraint: "chk_accrual_correction_maker_checker" },
  { table: "employeeTerminations", constraint: "chk_term_recognition_maker_checker" },
  { table: "workOrderControlRequests", constraint: "chk_wo_control_maker_checker" },
  { table: "yearEndReopenRequests", constraint: "chk_yerr_maker_checker" },
  { table: "salesControlRequests", constraint: "chk_sales_control_maker_checker" },
  { table: "salesExchangeCommands", constraint: "chk_sales_exchange_maker_checker" },
  { table: "deliveryCodWriteOffRequests", constraint: "chk_delivery_cod_writeoff_maker_checker" },
  { table: "commissionRunApprovalRequests", constraint: "chk_commission_run_approval_maker_checker" },
];

describe("owner self-approval — CHECK constraints (هجرات 0333 و0334 و0336)", () => {
  it("لا يبقى أي قيد فصل مهام يتعارض مع اعتماد المالك الذاتي", async () => {
    const [rows] = (await db().execute(sql`
      SELECT table_name AS tableName, constraint_name AS constraintName
      FROM information_schema.table_constraints
      WHERE table_schema = DATABASE() AND constraint_type = 'CHECK'
    `)) as unknown as [Array<{ tableName: string; constraintName: string }>, unknown];

    for (const { table, constraint } of DROPPED_MAKER_CHECKER_CONSTRAINTS) {
      const found = rows.find(
        (r) => r.tableName === table && r.constraintName === constraint,
      );
      expect(found, `${constraint} على ${table} يجب ألّا يبقى بعد هجرات اعتماد المالك`).toBeUndefined();
    }
  });

  describe("إثباتٌ فعليّ لا كتالوجيّ وحسب: نفس المالك منشئاً ومعتمِداً على payrollRemittanceRequests", () => {
    beforeEach(async () => {
      await truncateTables(["payrollRemittanceRequests", "branches", "users"]);
      await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
      await db().insert(s.users).values({
        id: 1,
        openId: "solo-owner-remittance",
        name: "المالك",
        role: "admin",
        branchId: 1,
        isOwner: true,
      });
    });

    afterEach(async () => {
      await truncateTables(["payrollRemittanceRequests", "branches", "users"]);
    });

    it("الإدراج ثم الاعتماد بنفس هويّة المالك في createdBy/approvedBy ينجح بلا انتهاك CHECK", async () => {
      const [inserted] = await db().insert(s.payrollRemittanceRequests).values({
        kind: "INCOME_TAX",
        payingBranchId: 1,
        requestedAmount: "150000.00",
        authorityName: "الهيئة العامة للضرائب",
        referenceNumber: "SELF-APPROVAL-CHECK-1",
        supportingDocumentUrl: "https://example.test/doc.pdf",
        sourceKey: "solo-owner-remittance-source-1",
        createdBy: 1,
      });
      const insertId = Number((inserted as unknown as { insertId: number }).insertId);
      expect(insertId).toBeGreaterThan(0);

      // نفس المالك (id=1) يعتمد ما أنشأه هو بنفسه — كان هذا التحديث يرمي
      // ER_CHECK_CONSTRAINT_VIOLATED قبل الهجرة 0333.
      await expect(
        db()
          .update(s.payrollRemittanceRequests)
          .set({ status: "APPROVED", approvedBy: 1, approvedAt: new Date() })
          .where(eq(s.payrollRemittanceRequests.id, insertId)),
      ).resolves.not.toThrow();

      const [row] = await db()
        .select({ status: s.payrollRemittanceRequests.status, approvedBy: s.payrollRemittanceRequests.approvedBy, createdBy: s.payrollRemittanceRequests.createdBy })
        .from(s.payrollRemittanceRequests)
        .where(eq(s.payrollRemittanceRequests.id, insertId));
      expect(row?.status).toBe("APPROVED");
      expect(row?.approvedBy).toBe(row?.createdBy);
    });
  });
});
