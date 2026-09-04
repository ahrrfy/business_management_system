// تقرير الاعتماد الذاتي — الضابط التعويضي لقرار المالك (٣/٩/٢٦، PR #962). يثبت هذا
// الاختبار السلوك المشترك عبر مصدرين ممثِّلين (receipts/vouchers و payrollRemittanceRequests):
// يظهر فقط ما تساوى فيه المُنشئ والمُقرِّر، يُستبعَد ما اختلف فيه حتى لو كان مبلغه أكبر،
// ويُرتَّب الناتج بالمبلغ تنازلياً. بقيّة المصادر (السبعة الأخرى) تشترك في نفس نمط
// الاستعلام (تساوي عمودَي المُنشئ/المُقرِّر) فتغطيتها هنا تمثيلية لا شاملة — راجع
// server/services/audit/selfApprovalReport.ts لخريطة المصادر كاملةً.
//
// اختباران إضافيّان (مراجعة Codex #982): استبعاد إيصال التجسيد (P1) وبقاء اعتماد
// الاستحقاق بعد إعادة فتح المسيّر (P1) — كلاهما كان يُسقط الضابط التعويضيّ صامتاً.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { truncateTables } from "../../__tests__/__testUtils__";
import { listSelfApprovalRecords } from "../selfApprovalReport";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables([
    "payrollAccountingEvents",
    "payrollRuns",
    "supplierPayments",
    "payrollRemittanceRequests",
    "expenses",
    "receipts",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "self-approval-owner-1", name: "المالك الأول", role: "admin", branchId: 1, isOwner: true },
    { id: 2, openId: "self-approval-owner-2", name: "المالك الثاني", role: "manager", branchId: 1, isOwner: true },
    { id: 3, openId: "self-approval-staff", name: "موظّف", role: "accountant", branchId: 1, isOwner: false },
  ]);
});

describe("تقرير الاعتماد الذاتي (listSelfApprovalRecords)", () => {
  it("يعرض ما تساوى فيه المُنشئ والمُقرِّر فقط، ويرتّبه بالمبلغ تنازلياً", async () => {
    // سندٌ اعتمده مالكٌ على نفسه — يجب أن يظهر.
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "500000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "SELF-APPROVAL-TEST-1",
      createdBy: 1,
      approvedBy: 1,
    });
    // سندٌ أكبر مبلغاً لكن مُنشئه غير مُعتمِده — يجب ألّا يظهر رغم أنّ مبلغه أكبر.
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "9000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "SELF-APPROVAL-TEST-2",
      createdBy: 3,
      approvedBy: 1,
    });
    // سندٌ معلّق بلا اعتماد بعد — يجب ألّا يظهر (approvedBy فارغ).
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "7000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      voucherNumber: "SELF-APPROVAL-TEST-3",
      createdBy: 1,
    });

    // تحويل استقطاعات اعتمده مالكٌ آخر على نفسه — يجب أن يظهر.
    await db().insert(s.payrollRemittanceRequests).values({
      kind: "SOCIAL_SECURITY",
      payingBranchId: 1,
      requestedAmount: "200000.00",
      authorityName: "دائرة الضمان الاجتماعي",
      referenceNumber: "SELF-APPROVAL-REMIT-1",
      supportingDocumentUrl: "https://example.test/doc1.pdf",
      sourceKey: "self-approval-remit-source-1",
      status: "APPROVED",
      createdBy: 2,
      approvedBy: 2,
      approvedAt: new Date(),
    });
    // تحويل استقطاعات اعتمده مالكٌ آخر غير مُنشئه — يجب ألّا يظهر.
    await db().insert(s.payrollRemittanceRequests).values({
      kind: "INCOME_TAX",
      payingBranchId: 1,
      requestedAmount: "999999.00",
      authorityName: "الهيئة العامة للضرائب",
      referenceNumber: "SELF-APPROVAL-REMIT-2",
      supportingDocumentUrl: "https://example.test/doc2.pdf",
      sourceKey: "self-approval-remit-source-2",
      status: "APPROVED",
      createdBy: 2,
      approvedBy: 1,
      approvedAt: new Date(),
    });

    const records = await listSelfApprovalRecords();
    const voucherNumbers = records.map((r) => r.subject);

    expect(voucherNumbers).toContain("SELF-APPROVAL-TEST-1");
    expect(voucherNumbers).not.toContain("SELF-APPROVAL-TEST-2");
    expect(voucherNumbers).not.toContain("SELF-APPROVAL-TEST-3");
    expect(records.some((r) => r.subject === "دائرة الضمان الاجتماعي")).toBe(true);
    expect(records.some((r) => r.subject === "الهيئة العامة للضرائب")).toBe(false);

    // الترتيب: المبلغ تنازلياً — السند (٥٠٠٬٠٠٠) قبل تحويل الاستقطاعات (٢٠٠٬٠٠٠).
    const selfApproved = records.filter((r) =>
      ["SELF-APPROVAL-TEST-1", "دائرة الضمان الاجتماعي"].includes(r.subject),
    );
    expect(selfApproved.map((r) => r.subject)).toEqual(["SELF-APPROVAL-TEST-1", "دائرة الضمان الاجتماعي"]);

    const voucherRecord = records.find((r) => r.subject === "SELF-APPROVAL-TEST-1");
    expect(voucherRecord?.kind).toBe("voucher");
    expect(voucherRecord?.actorUserId).toBe(1);
    expect(voucherRecord?.actorName).toBe("المالك الأول");
    expect(voucherRecord?.amount).toBe("500000.00");

    const remitRecord = records.find((r) => r.subject === "دائرة الضمان الاجتماعي");
    expect(remitRecord?.kind).toBe("payrollRemittanceApproval");
    expect(remitRecord?.actorUserId).toBe(2);
    expect(remitRecord?.actorName).toBe("المالك الثاني");
  });

  it("يصنّف سنداً مرتبطاً بمصروفٍ كـ«مصروف» لا «سند مالي»", async () => {
    const [insertedReceipt] = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "300000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "SELF-APPROVAL-EXPENSE-VOUCHER",
      createdBy: 1,
      approvedBy: 1,
    });
    const receiptId = Number((insertedReceipt as unknown as { insertId: number }).insertId);

    await db().insert(s.expenses).values({
      branchId: 1,
      expenseDate: new Date().toISOString().slice(0, 10),
      category: "OTHER",
      amount: "300000.00",
      paymentMethod: "CASH",
      description: "صيانة طارئة",
      status: "ACTIVE",
      createdBy: 1,
      receiptId,
    });

    const records = await listSelfApprovalRecords();
    const expenseRecord = records.find((r) => r.detail === "صيانة طارئة");
    expect(expenseRecord?.kind).toBe("expense");
  });

  it("يستبعد إيصال تجسيد سداد المورّد — لا يظهر مرّتين ولا كسندٍ عامّ حين مُنشئ الطلب غير مُقرِّره", async () => {
    // موظّفٌ (id=3، مُدرَجٌ في beforeEach) يطلب سداد مورّد، ومالكٌ (id=1) يقرّره وينفّذه —
    // الإيصالُ الناتج createdBy=approvedBy=1 (نفّذه actor نفسه)، لكنّ هذا **ليس** اعتماداً
    // ذاتياً: الطلبَ الأصليّ أنشأه موظّفٌ آخر. لولا الاستبعاد لظهر صفٌّ "سند مالي" كاذب.
    const [insertedReceipt] = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "640000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "SUPPLIER-PAY-REQ:1",
      createdBy: 1,
      approvedBy: 1,
    });
    const receiptId = Number((insertedReceipt as unknown as { insertId: number }).insertId);

    await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await db().insert(s.supplierPayments).values({
        paymentNumber: "SP-SELF-APPROVAL-TEST-1",
        requestId: 9001,
        supplierId: 9001,
        branchId: 1,
        currency: "IQD",
        amount: "640000.00",
        currencyAmount: "640000.00",
        paymentMethod: "CASH",
        receiptId,
        accountingEntryId: 9001,
        payloadCanonical: "{}",
        payloadHash: "a".repeat(64),
        postedBy: 1,
      });
    } finally {
      await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }

    const records = await listSelfApprovalRecords();
    expect(records.some((r) => r.subject === "SUPPLIER-PAY-REQ:1")).toBe(false);
    expect(records.some((r) => r.amount === "640000.00")).toBe(false);
  });

  it("يُبقي اعتماد استحقاق مسيّرٍ ذاتيّاً في السجلّ حتى بعد إعادة فتحه (يُصفّر approvedBy/approvedAt)", async () => {
    // نفس المالك (id=1) أنشأ المسيّر واعتمد استحقاقه — ثم أُعيد فتحه للتصحيح، فصار
    // payrollRuns.approvedBy/approvedAt NULL (سلوك reopenPayrollAccrualTx الحقيقي). حدثُ
    // ACCRUAL في الدفتر الإلحاقي يبقى الدليل الوحيد على أنّ الاعتماد الذاتي وقع فعلاً.
    const [insertedRun] = await db().insert(s.payrollRuns).values({
      branchId: 1,
      period: "2026-07",
      status: "draft",
      totalNet: "12500000.00",
      createdBy: 1,
      // بعد إعادة الفتح: approvedBy/approvedAt عائدان لـNULL (الافتراض) — لا نضبطهما هنا.
    });
    const runId = Number((insertedRun as unknown as { insertId: number }).insertId);

    await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      await db().insert(s.payrollAccountingEvents).values({
        runId,
        revisionNo: 0,
        eventKind: "ACCRUAL",
        accountingEntryId: 9002,
        sourceKey: "PAYROLL:ACCRUAL:SELF-APPROVAL-TEST:1",
        sourceHash: "b".repeat(64),
        occurredAt: new Date(),
        createdBy: 1,
      });
    } finally {
      await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }

    const records = await listSelfApprovalRecords();
    const runRecord = records.find((r) => r.kind === "payrollAccrualApproval" && r.subject === "مسيّر 2026-07");
    expect(runRecord).toBeDefined();
    expect(runRecord?.actorUserId).toBe(1);
    expect(runRecord?.amount).toBe("12500000.00");
  });
});
