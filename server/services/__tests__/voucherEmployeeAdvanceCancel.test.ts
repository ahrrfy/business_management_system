import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelAdvance, grantAdvance } from "../advances";
import { approveVoucher, rejectVoucher } from "../voucher/approval";
import { cancelVoucher } from "../voucher/cancel";
import { parseSystemPaymentRequest } from "../voucher/create";
import { truncateTables } from "./__testUtils__";

const MAKER = { userId: 1, branchId: 1, role: "admin" };
const FIRST_OWNER = { userId: 2, branchId: 1, role: "manager" };
const SECOND_OWNER = { userId: 3, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function requestAndApproveAdvance(clientRequestId: string) {
  const requested = await grantAdvance(
    {
      employeeId: 1,
      branchId: 1,
      amount: "100000.00",
      monthlyDeduction: "25000.00",
      note: "اختبار إلغاء ذري",
      clientRequestId,
    },
    MAKER,
  );
  expect(requested.status).toBe("PENDING_APPROVAL");
  await approveVoucher(Number(requested.receiptId), FIRST_OWNER);
  const [advance] = await db()
    .select()
    .from(s.employeeAdvances)
    .where(eq(s.employeeAdvances.receiptId, Number(requested.receiptId)));
  expect(advance).toMatchObject({ status: "ACTIVE", remaining: "100000.00" });
  return { receiptId: Number(requested.receiptId), advance: advance! };
}

async function materializePartialPayrollDeduction(
  advance: typeof s.employeeAdvances.$inferSelect,
  period: string,
) {
  const runInsert = await db().insert(s.payrollRuns).values({
    period,
    branchId: 1,
    status: "paid",
    revisionNo: 0,
    employeeCount: 1,
    totalGross: "1000000.00",
    totalDeductions: "10000.00",
    totalNet: "990000.00",
    createdBy: 1,
  });
  const runId = Number(runInsert[0].insertId);
  await db().insert(s.advanceSettlements).values({
    runId,
    advanceId: Number(advance.id),
    employeeId: Number(advance.employeeId),
    amount: "10000.00",
    revisionNo: 0,
    direction: "APPLY",
    sourceKey: `TEST:ADVANCE:CANCEL:${period}:${advance.id}`,
    createdBy: 1,
  });
  await db()
    .update(s.employeeAdvances)
    .set({ remaining: "90000.00" })
    .where(eq(s.employeeAdvances.id, Number(advance.id)));
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs",
    "journalLines",
    "journalEntries",
    "employeeAdvanceRepaymentAllocations",
    "employeeAdvanceRepaymentRequests",
    "terminationAdvanceAllocations",
    "advanceSettlements",
    "employeeAdvances",
    "payrollItems",
    "payrollRuns",
    "accountingEntries",
    "idempotencyKeys",
    "receipts",
    "doubleEntrySettings",
    "employees",
    "voucherCategories",
    "branches",
    "users",
  ]);
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "advance-cancel-maker",
      name: "منشئ السلفة",
      role: "admin",
      branchId: 1,
      isOwner: false,
    },
    {
      id: 2,
      openId: "advance-cancel-first-owner",
      name: "مالك اعتماد الصرف",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 3,
      openId: "advance-cancel-second-owner",
      name: "مالك اعتماد الإلغاء",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await db().insert(s.employees).values({
    id: 1,
    branchId: 1,
    firstName: "حسن",
    lastName: "التميمي",
    payType: "monthly",
    salary: "1000000.00",
    allowances: "0.00",
    isActive: true,
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "ADVANCE-CANCEL-TREASURY-FUND",
    createdBy: 2,
  });
});

describe("employee advance voucher cancellation", () => {
  it("يلغي السلفة غير المستعملة ذرياً مع الإيصال والقيد ويعيد الاعتماد idempotently", async () => {
    const original = await requestAndApproveAdvance("advance-cancel-happy");
    const cancellation = await cancelVoucher(original.receiptId, FIRST_OWNER);
    expect(cancellation.status).toBe("PENDING_APPROVAL");

    let [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advance).toMatchObject({ status: "ACTIVE", remaining: "100000.00" });
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, Number(cancellation.approvalReceiptId))),
    ).toHaveLength(0);

    const approved = await approveVoucher(
      Number(cancellation.approvalReceiptId),
      SECOND_OWNER,
    );
    expect(approved.replayed).toBe(false);
    [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advance).toMatchObject({ status: "CANCELLED", remaining: "0.00" });
    const [sourceReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, original.receiptId));
    expect(sourceReceipt.status).toBe("REVERSED");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);

    const replay = await approveVoucher(
      Number(cancellation.approvalReceiptId),
      SECOND_OWNER,
    );
    expect(replay).toMatchObject({
      receiptId: Number(cancellation.approvalReceiptId),
      replayed: true,
      signatureHash: approved.signatureHash,
    });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    expect(await db().select().from(s.employeeAdvances)).toHaveLength(1);
  });

  /*
   * cancelAdvance المستقلّة (advancesService.ts) تشترط advance.status="ACTIVE" و
   * receipt.status="REVERSED" معاً قبل أن تُنجح. لكن المسار الحقيقيّ أعلاه (cancelVoucher ثم
   * approveVoucher) يقلب الاثنين معاً **ذرّياً داخل نفس المعاملة**: بحلول لحظة صيرورة السند
   * REVERSED تكون السلفة CANCELLED فعلاً (تُرى في السطر ١٧٨ أعلاه). فالحالة التي تنتظرها
   * cancelAdvance (نشطة + سندها معكوس) لا تقع أبداً لسلفةٍ مُرتبطة بسند — الزرّ المستقلّ في
   * الشاشة (EmployeeAdvances.tsx) يصطدم دائماً برفضٍ آمن لا بنجاحٍ ثانٍ. هذا اختبارٌ يثبّت أنّ
   * الاصطدام آمنٌ (رفضٌ واضح، لا إلغاءً مزدوجاً ولا حالةً فاسدة) لا أنه الطريق المُوصى به.
   */
  it("cancelAdvance المستقلّة بعد مسار السند الحقيقيّ: رفضٌ آمن لا إلغاءٌ مزدوج (مسارٌ ميت عملياً)", async () => {
    const original = await requestAndApproveAdvance("advance-cancel-real-path-then-direct");
    const cancellation = await cancelVoucher(original.receiptId, FIRST_OWNER);
    await approveVoucher(Number(cancellation.approvalReceiptId), SECOND_OWNER);

    const [sourceReceipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, original.receiptId));
    expect(sourceReceipt.status).toBe("REVERSED"); // السند عاد فعلاً — الحالة التي تشترطها cancelAdvance متحقّقة
    const [advanceAfterVoucherFlow] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advanceAfterVoucherFlow.status).toBe("CANCELLED"); // لكن السلفة أُلغيت أصلاً قبل أن تُستدعى cancelAdvance

    await expect(
      cancelAdvance({ advanceId: Number(original.advance.id) }, FIRST_OWNER),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("تُلغى السلف النشطة فقط") });

    // لا أثرٌ إضافيّ — الرفض لم يُغيّر شيئاً (لا قيدَ ثالثاً ولا حالةً جديدة).
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    const [advanceAfterDirectAttempt] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advanceAfterDirectAttempt).toMatchObject({ status: "CANCELLED", remaining: "0.00" });
  });

  it("يرفض السلفة المستقطعة جزئياً قبل إنشاء إيصال الإلغاء أو قيده", async () => {
    const original = await requestAndApproveAdvance("advance-cancel-used");
    await materializePartialPayrollDeduction(original.advance, "2026-07");
    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await db().select().from(s.accountingEntries);

    await expect(cancelVoucher(original.receiptId, FIRST_OWNER)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(await db().select().from(s.receipts)).toHaveLength(receiptsBefore.length);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      entriesBefore.length,
    );
    const [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advance).toMatchObject({ status: "ACTIVE", remaining: "90000.00" });
  });

  it("يعيد فحص الاستعمال تحت القفل عند الاعتماد ولا يعكس طلب إلغاء سبق الخصم بعده", async () => {
    const original = await requestAndApproveAdvance("advance-cancel-race");
    const cancellation = await cancelVoucher(original.receiptId, FIRST_OWNER);
    await materializePartialPayrollDeduction(original.advance, "2026-08");

    await expect(
      approveVoucher(Number(cancellation.approvalReceiptId), SECOND_OWNER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [sourceReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, original.receiptId));
    const [cancellationReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(cancellation.approvalReceiptId)));
    const [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(sourceReceipt.status).toBe("COMPLETED");
    expect(cancellationReceipt).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    expect(advance).toMatchObject({ status: "ACTIVE", remaining: "90000.00" });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("يرفض محاولة الإلغاء A1 ثم يعيد إصدار A2 مرتبطة بها مرة واحدة ويُبقي المفتاح القديم", async () => {
    const original = await requestAndApproveAdvance("advance-cancel-reissue");
    const first = await cancelVoucher(original.receiptId, FIRST_OWNER);
    await rejectVoucher(
      Number(first.approvalReceiptId),
      SECOND_OWNER,
      "بيانات طلب الإلغاء تحتاج مراجعة",
    );

    const second = await cancelVoucher(original.receiptId, FIRST_OWNER);
    expect(second.approvalReceiptId).not.toBe(first.approvalReceiptId);
    const [secondReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(second.approvalReceiptId)));
    const request = parseSystemPaymentRequest(secondReceipt.internalNote);
    expect(request).toMatchObject({
      kind: "VOUCHER_CANCELLATION",
      attempt: 2,
      priorCancellationReceiptId: Number(first.approvalReceiptId),
    });
    expect(
      request?.kind === "VOUCHER_CANCELLATION"
        ? request.reissueReason
        : null,
    ).toMatch(/رفض/);

    const keys = await db().select().from(s.idempotencyKeys);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientRequestId: `voucher-cancellation-${original.receiptId}-A1`,
          refId: Number(first.approvalReceiptId),
        }),
        expect.objectContaining({
          clientRequestId: `voucher-cancellation-${original.receiptId}-A2`,
          refId: Number(second.approvalReceiptId),
        }),
      ]),
    );

    await approveVoucher(Number(second.approvalReceiptId), SECOND_OWNER);
    await expect(
      approveVoucher(Number(first.approvalReceiptId), SECOND_OWNER),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const replay = await cancelVoucher(original.receiptId, FIRST_OWNER).catch(
      (error: unknown) => error,
    );
    expect(replay).toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    const [advance] = await db()
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, Number(original.advance.id)));
    expect(advance).toMatchObject({ status: "CANCELLED", remaining: "0.00" });
  });
});
