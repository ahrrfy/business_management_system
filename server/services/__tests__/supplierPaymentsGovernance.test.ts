import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  requestSupplierPayment,
  requestSupplierPaymentRefund,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "../purchase/supplierPayments";

/**
 * سدادُ المورّد واستردادُه خروجُ مالٍ ومحوُ أثرٍ حقيقيّان (إيصال + قيدٌ + رصيد مورّد)، وبوّابةُ
 * فصل المهام عليهما (decideSupplierPayment/decideSupplierPaymentRefund) لم تُختبر قطّ ضدّ قاعدةٍ
 * حقيقية — supplierPaymentsS6.test.ts وsupplierPaymentUsdInvariantP0.test.ts يفحصان دوالّ نقيّةً
 * معزولة بلا معاملة أو إيصال أو قيد. هذا الملفّ يسدّ الفجوة: يستدعي الدالّتين فعلياً مرّتين لكلّ
 * مسار — مرّةً بذاتِ الفاعل (يُتوقَّع FORBIDDEN) ومرّةً بفاعلٍ مستقلّ (يُتوقَّع نجاحٌ وحركةُ مالٍ فعلية).
 *
 * ⚠️ **لا اختبار لتجاوز المالك هنا عمداً**: كودُ الخدمة (٣/٩، 3227ce5b) يُجيز اليوم للمالك
 * اعتماد طلبه الخاص، لكنّ chk_supplier_payment_request_maker_checker وchk_supplier_payment_
 * refund_maker_checker (drizzle/schema.ts، من الهجرة 0304) ما زالتا تفرضان reviewedBy<>requestedBy
 * **بلا استثناء مالك** — قيدٌ سابقٌ للسياسة لم يُحدَّث معها. فمحاولةُ المالك اعتمادَ طلبه تسقط
 * اليوم فعلياً بخطأ DB خامّ (ER_CHECK_CONSTRAINT_VIOLATED) لا بنجاحٍ ولا بـFORBIDDEN نظيف — تحقّقتُ
 * منه تجريبياً. إصلاحُه يلزمه تعديل drizzle/schema.ts وهجرةٌ جديدة (ملفٌّ ساخنٌ خارج نطاق هذه
 * الشريحة)؛ تتبّعه مهمّةٌ منفصلة.
 */

const maker = { userId: 7, branchId: 1, role: "purchasing" as const };
const reviewer = { userId: 8, branchId: 1, role: "accountant" as const };
const owner = { userId: 9, branchId: 1, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const insertId = (res: unknown): number =>
  Number((res as [{ insertId: number }])?.[0]?.insertId ?? (res as { insertId: number })?.insertId);

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "supplierPaymentRefundItems",
    "supplierPaymentRefunds",
    "supplierPaymentRefundRequestItems",
    "supplierPaymentRefundRequests",
    "supplierPaymentAllocations",
    "supplierPaymentRequestAllocations",
    "supplierPaymentRequests",
    "supplierPayments",
    "receipts",
    "accountingEntries",
    "supplierInvoices",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db()
    .insert(schema.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      {
        id: 7,
        openId: "sp-gov-maker",
        name: "طالب",
        role: "purchasing",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 8,
        openId: "sp-gov-reviewer",
        name: "مراجع",
        role: "accountant",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 9,
        openId: "sp-gov-owner",
        name: "المالك",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(schema.suppliers)
    .values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
  // فاتورة المورد POSTED/NATIVE تلزمها chk_supplier_invoice_lifecycle (قيد ترحيلٍ حقيقي)
  // وchk_supplier_invoice_native_document (رقمٌ خارجيّ + منشئ) — قيدٌ محاسبيّ بسيط يكفي؛
  // decideSupplierPayment لا يقرأ منه سوى وجوده (لا يتحقّق من نوعه أو مبلغه).
  const postingEntry = await db()
    .insert(schema.accountingEntries)
    .values({
      entryType: "PURCHASE",
      entryDate: "2026-01-01",
      branchId: 1,
      supplierId: 1,
    });
  await db()
    .insert(schema.supplierInvoices)
    .values({
      id: 1,
      invoiceNumber: "SI-TEST-1",
      clientRequestId: "sp-gov-inv-1",
      supplierId: 1,
      branchId: 1,
      status: "POSTED",
      liabilityClass: "NATIVE_AP",
      paymentGate: "OPEN",
      invoiceDate: "2026-01-01",
      currency: "IQD",
      subtotal: "100000.00",
      totalAmount: "100000.00",
      payloadCanonical: "{}",
      payloadHash: "0".repeat(64),
      evidenceType: "OTHER",
      externalInvoiceNumber: "EXT-SI-TEST-1",
      externalNumberNorm: "EXTSITEST1",
      evidenceReference: "sp-gov-evidence",
      createdBy: owner.userId,
      postingEntryId: insertId(postingEntry),
      postedBy: owner.userId,
      postedAt: new Date(),
    });
}

beforeEach(async () => {
  await reset();
  await seed();
});

function paymentInput() {
  return {
    supplierId: 1,
    branchId: 1,
    requestKey: randomUUID(),
    currency: "IQD" as const,
    amount: "10000.00",
    currencyAmount: "10000.00",
    paymentMethod: "TRANSFER" as const,
    externalReference: `TR-${randomUUID()}`,
    evidenceType: "TRANSFER_RECEIPT" as const,
    evidenceReference: `ev-${randomUUID()}`,
    reason: "دفعة اختبار",
    allocations: [
      {
        supplierInvoiceId: 1,
        invoiceVersion: 1,
        amount: "10000.00",
        currencyAmount: "10000.00",
      },
    ],
  };
}

/** يُنشئ ويعتمد دفعة سليمة (طالبٌ + مراجعٌ مستقلّ) لتجهيز سياق اختبارات الاسترداد. */
async function approveFreshPayment() {
  const requested = await requestSupplierPayment(paymentInput(), maker);
  const decided = await decideSupplierPayment(
    {
      requestId: requested.requestId,
      decisionKey: randomUUID(),
      action: "APPROVE",
      reviewReason: "اعتماد مستقل لتجهيز الاسترداد",
    },
    reviewer,
    SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
  );
  expect(decided.status).toBe("APPROVED");
  const [paymentRow] = await db()
    .select()
    .from(schema.supplierPayments)
    .where(eq(schema.supplierPayments.requestId, requested.requestId));
  const supplierPaymentId = Number(paymentRow.id);
  const [allocation] = await db()
    .select()
    .from(schema.supplierPaymentAllocations)
    .where(
      eq(schema.supplierPaymentAllocations.supplierPaymentId, supplierPaymentId),
    );
  return { supplierPaymentId, allocationId: Number(allocation.id) };
}

describe("حوكمة سداد المورد — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب السداد لطلبه ذاته", async () => {
    const requested = await requestSupplierPayment(paymentInput(), maker);
    expect(requested.status).toBe("PENDING");

    await expect(
      decideSupplierPayment(
        {
          requestId: requested.requestId,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "محاولة اعتماد ذاتي",
        },
        maker,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(schema.receipts)).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(schema.accountingEntries)
        .where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT")),
    ).toHaveLength(0);
    const [supplier] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, 1));
    expect(Number(supplier.currentBalance)).toBe(0);
  });

  it("يعتمد مراجعٌ مستقلّ طلب السداد فتتحرك الخزينة وذمّة المورّد فعلياً", async () => {
    const requested = await requestSupplierPayment(paymentInput(), maker);

    const decided = await decideSupplierPayment(
      {
        requestId: requested.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "راجعت السند والمرجع البنكي",
      },
      reviewer,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    expect(decided.status).toBe("APPROVED");

    const receiptsRows = await db().select().from(schema.receipts);
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({
      direction: "OUT",
      partyType: "SUPPLIER",
      partyId: 1,
      cashBucket: null,
    });

    const entries = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "PAYMENT_OUT",
      dedupeKey: `SUPPLIER_PAYMENT_REQUEST:${requested.requestId}`,
    });

    const [supplier] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, 1));
    expect(Number(supplier.currentBalance)).toBe(-10000);

    const [paymentRow] = await db()
      .select()
      .from(schema.supplierPayments)
      .where(eq(schema.supplierPayments.requestId, requested.requestId));
    const allocations = await db()
      .select()
      .from(schema.supplierPaymentAllocations)
      .where(
        eq(schema.supplierPaymentAllocations.supplierPaymentId, Number(paymentRow.id)),
      );
    expect(allocations).toHaveLength(1);
    expect(Number(allocations[0].supplierInvoiceId)).toBe(1);
  });
});

describe("حوكمة استرداد سداد المورد — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب الاسترداد لطلبه ذاته", async () => {
    const { supplierPaymentId, allocationId } = await approveFreshPayment();
    const [supplierAfterPayment] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, 1));

    const refundRequested = await requestSupplierPaymentRefund(
      {
        supplierPaymentId,
        expectedPaymentVersion: 1,
        requestKey: randomUUID(),
        refundMethod: "TRANSFER",
        externalReference: `TR-R-${randomUUID()}`,
        evidenceType: "TRANSFER_RECEIPT",
        evidenceReference: `ev-r-${randomUUID()}`,
        reason: "استرداد اختبار",
        allocations: [
          { supplierPaymentAllocationId: allocationId, amount: "3000.00", currencyAmount: "3000.00" },
        ],
      },
      maker,
    );
    expect(refundRequested.status).toBe("PENDING");

    await expect(
      decideSupplierPaymentRefund(
        {
          requestId: refundRequested.requestId,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "محاولة اعتماد ذاتي للاسترداد",
        },
        maker,
        SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(schema.receipts)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(schema.accountingEntries)
        .where(eq(schema.accountingEntries.entryType, "PAYMENT_IN")),
    ).toHaveLength(0);
    const [supplierAfterAttempt] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, 1));
    expect(Number(supplierAfterAttempt.currentBalance)).toBe(
      Number(supplierAfterPayment.currentBalance),
    );
  });

  it("يعتمد مراجعٌ مستقلّ طلب الاسترداد فيعود المال فعلياً لذمّة المورّد", async () => {
    const { supplierPaymentId, allocationId } = await approveFreshPayment();

    const refundRequested = await requestSupplierPaymentRefund(
      {
        supplierPaymentId,
        expectedPaymentVersion: 1,
        requestKey: randomUUID(),
        refundMethod: "TRANSFER",
        externalReference: `TR-R-${randomUUID()}`,
        evidenceType: "TRANSFER_RECEIPT",
        evidenceReference: `ev-r-${randomUUID()}`,
        reason: "استرداد اختبار",
        allocations: [
          { supplierPaymentAllocationId: allocationId, amount: "3000.00", currencyAmount: "3000.00" },
        ],
      },
      maker,
    );

    const decided = await decideSupplierPaymentRefund(
      {
        requestId: refundRequested.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "راجعت الاسترداد والمرجع البنكي",
      },
      reviewer,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    expect(decided.status).toBe("APPROVED");

    const receiptsRows = await db()
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.direction, "IN"));
    expect(receiptsRows).toHaveLength(1);
    expect(receiptsRows[0]).toMatchObject({ direction: "IN", partyType: "SUPPLIER", partyId: 1 });

    const entries = await db()
      .select()
      .from(schema.accountingEntries)
      .where(eq(schema.accountingEntries.entryType, "PAYMENT_IN"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "PAYMENT_IN",
      dedupeKey: `SUPPLIER_PAYMENT_REFUND_REQUEST:${refundRequested.requestId}`,
    });

    const [supplier] = await db()
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, 1));
    expect(Number(supplier.currentBalance)).toBe(-7000); // -10000 دفعاً + 3000 استرداداً

    const [allocation] = await db()
      .select()
      .from(schema.supplierPaymentAllocations)
      .where(eq(schema.supplierPaymentAllocations.id, allocationId));
    expect(Number(allocation.refundedAmount)).toBe(3000);
  });
});
