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
    "goodsReceiptReversalRequests",
    "goodsReceipts",
    "supplierInvoiceApprovalRequests",
    "supplierInvoices",
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

  describe("توسيعُ قرار المالك (٤/٩/٢٦) على المشتريات — عكس استلام + عكس فاتورة مورّد", () => {
    it("عكسُ استلامٍ اعتمده المالك على طلبه هو نفسه يظهر بمبلغ الإذن؛ الرفضُ (بلا بوّابة) لا يظهر", async () => {
      await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await db().insert(s.goodsReceipts).values({
          id: 1,
          receiptNumber: "GRN-SELF-APPROVAL-1",
          clientRequestId: "grn-self-approval-1",
          origin: "LEGACY_AGGREGATE",
          purchaseOrderId: 9001,
          supplierId: 9001,
          branchId: 1,
          currency: "IQD",
          netAmount: "800000.00",
          taxAmount: "0.00",
          totalAmount: "800000.00",
          payloadCanonical: "{}",
          payloadHash: "c".repeat(64),
        });
        await db().insert(s.goodsReceiptReversalRequests).values({
          requestKey: "grn-reversal-self-approval-1",
          goodsReceiptId: 1,
          branchId: 1,
          baseReceiptVersion: 1,
          payloadCanonical: "{}",
          payloadHash: "d".repeat(64),
          reason: "اختبار",
          status: "APPROVED",
          requestedBy: 1,
          requestedAt: new Date(),
          reviewedBy: 1,
          reviewedAt: new Date(),
          decisionKey: "grn-reversal-self-approval-decision-1",
          decisionHash: "e".repeat(64),
          appliedAt: new Date(),
        });
        // طلبٌ آخر مرفوضٌ (REJECT بلا بوّابة أصلاً — لا معنى لاعتمادٍ ذاتيّ عليه) — يجب ألّا يظهر.
        await db().insert(s.goodsReceiptReversalRequests).values({
          requestKey: "grn-reversal-self-rejected-1",
          goodsReceiptId: 1,
          branchId: 1,
          baseReceiptVersion: 1,
          payloadCanonical: "{}",
          payloadHash: "f".repeat(64),
          reason: "اختبار رفض",
          status: "REJECTED",
          requestedBy: 1,
          requestedAt: new Date(),
          reviewedBy: 1,
          reviewedAt: new Date(),
          decisionKey: "grn-reversal-self-rejected-decision-1",
          decisionHash: "1".repeat(64),
        });
      } finally {
        await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }

      const records = await listSelfApprovalRecords();
      const record = records.find((r) => r.kind === "goodsReceiptReversal");
      expect(record).toBeDefined();
      expect(record?.subject).toBe("عكس GRN-SELF-APPROVAL-1");
      expect(record?.amount).toBe("800000.00");
      expect(record?.actorUserId).toBe(1);
      expect(records.filter((r) => r.kind === "goodsReceiptReversal")).toHaveLength(1);
    });

    it("عكسُ فاتورة موردٍ اعتمده المالك على طلبه هو نفسه يظهر بمبلغ الفاتورة؛ ترحيلُها (بلا بوّابة) لا يظهر", async () => {
      await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await db().insert(s.supplierInvoices).values({
          id: 1,
          invoiceNumber: "SINV-SELF-APPROVAL-1",
          clientRequestId: "sinv-self-approval-1",
          externalInvoiceNumber: "EXT-SELF-APPROVAL-1",
          externalNumberNorm: "EXT-SELF-APPROVAL-1",
          supplierId: 9001,
          branchId: 1,
          invoiceDate: new Date().toISOString().slice(0, 10),
          currency: "IQD",
          subtotal: "450000.00",
          taxAmount: "0.00",
          discountAmount: "0.00",
          totalAmount: "450000.00",
          payloadCanonical: "{}",
          payloadHash: "a1".padEnd(64, "0"),
          evidenceReference: "دليل اختباريّ",
          createdBy: 1,
        });
        await db().insert(s.supplierInvoiceApprovalRequests).values({
          requestKey: "sinv-reversal-self-approval-1",
          supplierInvoiceId: 1,
          branchId: 1,
          kind: "REVERSE_INVOICE",
          baseInvoiceVersion: 1,
          payloadCanonical: "{}",
          payloadHash: "b1".padEnd(64, "0"),
          reason: "اختبار",
          status: "APPROVED",
          requestedBy: 1,
          requestedAt: new Date(),
          reviewedBy: 1,
          reviewedAt: new Date(),
          decisionKey: "sinv-reversal-self-approval-decision-1",
          decisionHash: "c1".padEnd(64, "0"),
          appliedAt: new Date(),
        });
        // طلبُ ترحيلٍ (POST_INVOICE بلا بوّابة أصلاً — ينشئ ذمّةً لا يمحو أثراً) — يجب ألّا يظهر
        // حتى لو تساوى فيه المُنشئ والمُقرِّر.
        await db().insert(s.supplierInvoiceApprovalRequests).values({
          requestKey: "sinv-post-self-approval-1",
          supplierInvoiceId: 1,
          branchId: 1,
          kind: "POST_INVOICE",
          baseInvoiceVersion: 1,
          payloadCanonical: "{}",
          payloadHash: "d1".padEnd(64, "0"),
          reason: "اختبار ترحيل",
          status: "APPROVED",
          requestedBy: 1,
          requestedAt: new Date(),
          reviewedBy: 1,
          reviewedAt: new Date(),
          decisionKey: "sinv-post-self-approval-decision-1",
          decisionHash: "e1".padEnd(64, "0"),
          appliedAt: new Date(),
        });
      } finally {
        await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }

      const records = await listSelfApprovalRecords();
      const record = records.find((r) => r.kind === "supplierInvoiceReversal");
      expect(record).toBeDefined();
      expect(record?.subject).toBe("عكس فاتورة SINV-SELF-APPROVAL-1");
      expect(record?.amount).toBe("450000.00");
      expect(record?.actorUserId).toBe(1);
      expect(records.filter((r) => r.kind === "supplierInvoiceReversal")).toHaveLength(1);
    });
  });

  describe("اعتماد استحقاق مسيّر — تطابق revisionNo (مراجعة Codex الثانية على #984)", () => {
    // ⭐ الثابت المحروس: الحدث التاريخيّ يُقرأ فقط حين تطابق revisionNo الحاليّة على
    // payrollRuns — لا مقارنة بعمودَي createdBy/totalNet المتقلّبَين مباشرةً. راجع رأس
    // selfApprovalReport.ts للتعليل الكامل (Codex أمسك أنّ المقارنة المباشرة قد تُسيء
    // نسبةَ/تسعيرَ مراجعةٍ سابقة استبدلها معدٌّ لاحق).
    async function insertAccrualEvent(runId: number, revisionNo: number, sourceSuffix: string, createdBy = 1) {
      await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
      try {
        await db().insert(s.payrollAccountingEvents).values({
          runId,
          revisionNo,
          eventKind: "ACCRUAL",
          accountingEntryId: 9100 + revisionNo,
          sourceKey: `PAYROLL:ACCRUAL:SELF-APPROVAL-TEST:${sourceSuffix}`,
          sourceHash: "b".repeat(64),
          occurredAt: new Date("2026-01-01"), // تاريخ استحقاق الفترة المحاسبية — يجب ألّا يُستعمَل كتاريخ قرار.
          createdBy,
        });
      } finally {
        await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
      }
    }

    it("مراجعةٌ حاليّة (revisionNo مطابق): تظهر بالمبلغ/الفاعل الحاليَّين، وبتاريخ createdAt الحدث لا occurredAt الفترة", async () => {
      const [insertedRun] = await db().insert(s.payrollRuns).values({
        branchId: 1,
        period: "2026-07",
        status: "approved",
        revisionNo: 0,
        totalNet: "12500000.00",
        createdBy: 1,
        approvedBy: 1,
        approvedAt: new Date(),
      });
      const runId = Number((insertedRun as unknown as { insertId: number }).insertId);
      await insertAccrualEvent(runId, 0, "current-rev");

      const records = await listSelfApprovalRecords();
      const runRecord = records.find((r) => r.kind === "payrollAccrualApproval" && r.subject === "مسيّر 2026-07");
      expect(runRecord).toBeDefined();
      expect(runRecord?.actorUserId).toBe(1);
      expect(runRecord?.amount).toBe("12500000.00");
      // occurredAt مضروبٌ على ٢٠٢٦-٠١-٠١ عمداً أعلاه (تاريخ فترةٍ محاسبية بعيد) — لو استُعمل
      // خطأً بدل createdAt (تاريخ إدراج الحدث الفعليّ، defaultNow) لظهر شهرُ يناير هنا.
      expect(runRecord?.decidedAt.toISOString().slice(0, 7)).not.toBe("2026-01");
    });

    it("مراجعةٌ سابقة استُبدلت بإعادة فتحٍ (revisionNo الحاليّة أعلى): لا تظهر — بدل عرض بياناتٍ خاطئة", async () => {
      // اعتُمد ذاتياً عند revisionNo=0 (المالك id=1)، ثم أُعيد فتحه فصار draft عند
      // revisionNo=1 بمُنشئٍ مختلف (موظّفٌ id=3، يحاكي `update.ts` يعيد نسب createdBy
      // لآخر معدّلٍ ماليّ). حدثُ المراجعة ٠ يبقى في الدفتر لكنه لم يعد يصف الحالة الحالية.
      const [insertedRun] = await db().insert(s.payrollRuns).values({
        branchId: 1,
        period: "2026-08",
        status: "draft",
        revisionNo: 1,
        totalNet: "9000000.00",
        createdBy: 3,
        // approvedBy/approvedAt تُصفَّر فعلياً عند إعادة الفتح — لا نضبطهما.
      });
      const runId = Number((insertedRun as unknown as { insertId: number }).insertId);
      await insertAccrualEvent(runId, 0, "superseded-rev");

      const records = await listSelfApprovalRecords();
      expect(records.some((r) => r.subject === "مسيّر 2026-08")).toBe(false);
    });

    it("اعتمادٌ ذاتيٌّ جديدٌ بعد إعادة الفتح (مراجعةٌ ثانية): يظهر بالبيانات الصحيحة للمراجعة الجديدة فقط", async () => {
      const [insertedRun] = await db().insert(s.payrollRuns).values({
        branchId: 1,
        period: "2026-09",
        status: "approved",
        revisionNo: 1,
        totalNet: "5000000.00",
        createdBy: 1,
        approvedBy: 1,
        approvedAt: new Date(),
      });
      const runId = Number((insertedRun as unknown as { insertId: number }).insertId);
      // حدثُ المراجعة القديمة (٠) بمبلغٍ/فاعلٍ مختلفَين — يجب ألّا يُخلَط بحدث المراجعة ١.
      await insertAccrualEvent(runId, 0, "old-rev-9", 3);
      await insertAccrualEvent(runId, 1, "new-rev-9", 1);

      const records = await listSelfApprovalRecords();
      const matches = records.filter((r) => r.subject === "مسيّر 2026-09");
      expect(matches).toHaveLength(1);
      expect(matches[0]?.actorUserId).toBe(1);
      expect(matches[0]?.amount).toBe("5000000.00");
    });

    it("مسيّرٌ ذاتيّ الاعتماد بلا أيّ حدث ACCRUAL (تعويضٌ صفريّ لكل الموظفين): يظهر عبر مسار الاستثناء لا يسقط صامتاً", async () => {
      await db().insert(s.payrollRuns).values({
        branchId: 1,
        period: "2026-10",
        status: "approved",
        revisionNo: 0,
        totalNet: "0.00",
        createdBy: 1,
        approvedBy: 1,
        approvedAt: new Date(),
      });

      const records = await listSelfApprovalRecords();
      const runRecord = records.find((r) => r.kind === "payrollAccrualApproval" && r.subject === "مسيّر 2026-10");
      expect(runRecord).toBeDefined();
      expect(runRecord?.actorUserId).toBe(1);
      expect(runRecord?.amount).toBe("0.00");
    });
  });

  describe("روابط المرجع تُطابق مساراتٍ مسجَّلة فعلياً في App.tsx (مراجعة Codex الثانية على #984)", () => {
    it("مسيّرُ رواتبٍ ذاتيّ الاعتماد يربط بـ/hr?tab=payroll لا /payroll (مسارٌ غير مسجَّل)", async () => {
      await db().insert(s.payrollRuns).values({
        branchId: 1,
        period: "2026-11",
        status: "approved",
        revisionNo: 0,
        totalNet: "1000000.00",
        createdBy: 1,
        approvedBy: 1,
        approvedAt: new Date(),
      });
      const records = await listSelfApprovalRecords();
      const runRecord = records.find((r) => r.subject === "مسيّر 2026-11");
      expect(runRecord?.href).toBe("/hr?tab=payroll");
    });
  });
});
