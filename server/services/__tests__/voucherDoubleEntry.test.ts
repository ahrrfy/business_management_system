import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePostingIntentAgainstSource } from "../accounting/postingEngine";
import { money } from "../money";
import type { Tx } from "../../db";
import { voucherPostingPlan } from "../voucher/posting";
import {
  createVoucherTx,
  hasSystemPaymentRequestEnvelope,
  isCanonicalSystemPaymentRequest,
  parseSystemPaymentRequest,
  parseTerminationSettlementReference,
  employeeAdvanceReference,
  employeeAdvanceSourceHash,
  terminationSettlementReference,
} from "../voucher/create";
import {
  expensePaymentResubmitDescriptionSuffix,
  expensePaymentResubmitKey,
  parseExpensePaymentResubmitDescription,
  parseExpensePaymentResubmitKey,
} from "../voucher/resubmitLineage";
import {
  isMysqlDeadlock,
  withMysqlDeadlockRetry,
} from "../voucher/deadlockRetry";

describe("voucher immediate double-entry contract", () => {
  it("retries only a complete MySQL deadlock victim transaction", async () => {
    expect(
      isMysqlDeadlock({ cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } }),
    ).toBe(true);
    expect(isMysqlDeadlock({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(false);

    let attempts = 0;
    await expect(
      withMysqlDeadlockRetry(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw { code: "ER_LOCK_DEADLOCK", errno: 1213 };
        }
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(attempts).toBe(3);

    const createSource = readFileSync(
      new URL("../voucher/create.ts", import.meta.url),
      "utf8",
    );
    expect(createSource).toContain("withMysqlDeadlockRetry(() =>");
    // ن-٢-هـ (٢٩/٨): بعد إضافة enqueuePostCommit للإشعارات المركزية، تحوّلت الـcallback
    // من arrow-single-expression إلى block. يبقى العقد المطلوب: retry يغلّف withTx،
    // وwithTx يستقبل tx يمرَّر إلى createVoucherTx(tx, input, actor) داخلَه.
    expect(createSource).toContain("withTx(async (tx) =>");
    expect(createSource).toContain("createVoucherTx(tx, input, actor)");
  });

  it("keeps expense and asset resubmission attempts explicit and immutable", () => {
    const key = expensePaymentResubmitKey({
      family: "expense",
      rootReceiptId: 17,
      attempt: 2,
    });
    expect(key).toBe("system-expense-resubmit-17-A2");
    expect(parseExpensePaymentResubmitKey(key)).toEqual({
      family: "expense",
      rootReceiptId: 17,
      attempt: 2,
    });
    expect(
      parseExpensePaymentResubmitKey("system-expense-resubmit-17"),
    ).toBeNull();
    expect(
      parseExpensePaymentResubmitKey("system-asset-resubmit-17-A0"),
    ).toBeNull();

    const suffix = expensePaymentResubmitDescriptionSuffix({
      attempt: 2,
      priorReceiptId: 29,
      reissueReason: "تصحيح مرجع الدفع",
    });
    expect(parseExpensePaymentResubmitDescription(`تسوية — ${suffix}`)).toEqual(
      {
        attempt: 2,
        priorReceiptId: 29,
        reissueReason: "تصحيح مرجع الدفع",
      },
    );
    expect(
      parseExpensePaymentResubmitDescription(
        `تسوية — ${suffix}\n[رُفض 2026-08-16T09:00:00: المستند غير واضح]`,
      ),
    ).toEqual({
      attempt: 2,
      priorReceiptId: 29,
      reissueReason: "تصحيح مرجع الدفع",
    });

    const approval = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    expect(approval).not.toContain(".delete(idempotencyKeys)");
    expect(approval).not.toContain("system-asset-resubmit-${receiptId}");
    expect(approval).not.toContain("system-expense-resubmit-${receiptId}");
    expect(approval).toContain("latestAttempt !== priorAttempt");
    expect(approval).toContain("priorReceiptId: receiptId");
    expect(approval).toContain("reissueReason");
    expect(approval).toMatch(
      /assertAccrualSettlementReceiptBindingTx[\s\S]*"ACCRUED_UNPAID"[\s\S]*"PAYMENT_PENDING"[\s\S]*"PAID"/,
    );
  });

  it("locks cancellation receipt chains in ascending order before revalidation", () => {
    const approval = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    const lockSet = approval.indexOf("const receiptIdsToLock = Array.from(");
    const sortedLock = approval.indexOf(
      ".where(inArray(receipts.id, receiptIdsToLock))",
      lockSet,
    );
    const revalidation = approval.indexOf(
      "JSON.stringify(currentAttemptIds)",
      sortedLock,
    );
    expect(lockSet).toBeGreaterThan(-1);
    expect(sortedLock).toBeGreaterThan(lockSet);
    expect(revalidation).toBeGreaterThan(sortedLock);
    expect(approval.slice(sortedLock, revalidation)).toContain(
      ".orderBy(asc(receipts.id))",
    );
  });

  it.each([
    {
      referenceNumber: "  EMP-ADV-1-forged",
      internalNote: null,
    },
    {
      referenceNumber: null,
      internalNote: '  @SYSTEM_PAYMENT_REQUEST:{"kind":"EMPLOYEE_ADVANCE"}',
    },
  ])(
    "normalizes and rejects whitespace-prefixed reserved sources before DB",
    async (reserved) => {
      await expect(
        createVoucherTx(
          {} as Tx,
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "10.00",
            paymentMethod: "CASH",
            partyType: "OTHER",
            counterpartyName: "طرف اختباري",
            description: "اختبار حارس المرجع النظامي",
            clientRequestId: "voucher-system-guard-unit",
            ...reserved,
          },
          { userId: 1, branchId: 1, role: "admin" },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it.each([
    ["CUSTOMER", "PAYMENT_IN_CUSTOMER"],
    ["SUPPLIER", "PAYMENT_IN_SUPPLIER_REFUND"],
  ] as const)("builds exact source components for %s", (partyType, profile) => {
    const plan = voucherPostingPlan({
      entryType: "PAYMENT_IN",
      partyType,
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      amount: money("75000"),
    });
    expect(plan?.intent.profile).toBe(profile);
    expect(() =>
      validatePostingIntentAgainstSource(plan!.intent, {
        amount: money("75000"),
        ...plan!.sourceComponents,
      }),
    ).not.toThrow();
  });

  it("keeps unclassified OTHER and a spoofed EMP-ADV reference fail-closed", () => {
    expect(
      voucherPostingPlan({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        amount: money("1000"),
      }),
    ).toBeUndefined();
    expect(
      voucherPostingPlan({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        amount: money("1000"),
        referenceNumber: "EMP-ADV-9",
      }),
    ).toBeUndefined();
  });

  it("derives CHECK category cancellation assets from the original direction", () => {
    const inboundCancellation = voucherPostingPlan({
      entryType: "PAYMENT_OUT",
      partyType: "OTHER",
      paymentMethod: "CHECK",
      amount: money("25000"),
      categoryPostingRole: "OTHER_REVENUE",
      categoryReversalOfDirection: "IN",
    });
    expect(inboundCancellation?.sourceComponents).toMatchObject({
      roleDebits: { OTHER_REVENUE: expect.anything() },
      roleCredits: { CHECKS_RECEIVABLE: expect.anything() },
    });

    const outboundCancellation = voucherPostingPlan({
      entryType: "PAYMENT_IN",
      partyType: "OTHER",
      paymentMethod: "CHECK",
      amount: money("25000"),
      categoryPostingRole: "RENT",
      categoryReversalOfDirection: "OUT",
    });
    expect(outboundCancellation?.sourceComponents).toMatchObject({
      roleDebits: { CARD_BANK: expect.anything() },
      roleCredits: { RENT: expect.anything() },
    });
  });

  it("maps classified OTHER normal and reversal directions with signed exact sources", () => {
    const rentPayment = voucherPostingPlan({
      entryType: "PAYMENT_OUT",
      partyType: "OTHER",
      paymentMethod: "TRANSFER",
      amount: money("125000"),
      categoryPostingRole: "RENT",
    });
    expect(rentPayment?.intent.profile).toBe("PAYMENT_OUT_CATEGORY");
    expect(() =>
      validatePostingIntentAgainstSource(rentPayment!.intent, {
        amount: money("125000"),
        ...rentPayment!.sourceComponents,
      }),
    ).not.toThrow();

    const rentReversal = voucherPostingPlan({
      entryType: "PAYMENT_IN",
      partyType: "OTHER",
      paymentMethod: "TRANSFER",
      amount: money("125000"),
      categoryPostingRole: "RENT",
      categoryReversalOfDirection: "OUT",
    });
    expect(rentReversal?.intent.profile).toBe("PAYMENT_IN_CATEGORY_REVERSAL");
    expect(rentReversal?.sourceComponents).toMatchObject({
      roleDebits: { CARD_BANK: expect.anything() },
      roleCredits: { RENT: expect.anything() },
    });

    const revenueReceipt = voucherPostingPlan({
      entryType: "PAYMENT_IN",
      partyType: "OTHER",
      paymentMethod: "TRANSFER",
      amount: money("80000"),
      categoryPostingRole: "OTHER_REVENUE",
    });
    expect(revenueReceipt?.intent.profile).toBe("PAYMENT_IN_CATEGORY");
    expect(
      voucherPostingPlan({
        entryType: "PAYMENT_IN",
        partyType: "OTHER",
        paymentMethod: "TRANSFER",
        amount: money("1"),
        categoryPostingRole: "RENT",
      }),
    ).toBeUndefined();
    expect(
      voucherPostingPlan({
        entryType: "PAYMENT_OUT",
        partyType: "OTHER",
        paymentMethod: "TRANSFER",
        amount: money("1"),
        categoryPostingRole: "OTHER_REVENUE",
      }),
    ).toBeUndefined();
  });

  it("passes both the intent and independent source components to postEntry", () => {
    const source = readFileSync(
      new URL("../voucher/create.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const posting = voucherPostingPlan({");
    expect(source).toContain("if (!posting)");
    expect(source).toContain("postingIntent: posting.intent");
    expect(source).toContain(
      "postingSourceComponents: posting.sourceComponents",
    );
  });

  it("binds idempotency to the complete financial and instrument fingerprint", () => {
    const source = readFileSync(
      new URL("../voucher/create.ts", import.meta.url),
      "utf8",
    );
    for (const field of [
      "requestedCategoryId",
      "requestedInternalNote",
      "requestedDescription",
      "requestedCounterpartyName",
      "requestedCheckNumber",
      "requestedCardLastFour",
      "requestedAttachmentUrl",
      "requestedVoucherDate",
    ]) {
      expect(source).toContain(field);
    }
    expect(
      source.indexOf("hasSystemPaymentRequestEnvelope(input.internalNote)"),
    ).toBeLessThan(source.indexOf('findIdempotentRefId(tx, "voucher.create"'));
    expect(source.indexOf("isCanonicalSystemPaymentRequest(")).toBeLessThan(
      source.indexOf('findIdempotentRefId(tx, "voucher.create"'),
    );
    expect(source).toContain('code: "CONFLICT"');
  });

  it("requires a mapped accounting category for every new manual OTHER voucher", () => {
    const source = readFileSync(
      new URL("../voucher/create.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('input.partyType === "OTHER" &&');
    expect(source).not.toContain(
      'input.referenceNumber?.startsWith("EMP-ADV-") !== true',
    );
    expect(source).toContain(
      "requiresCategoryAccounting && input.voucherCategoryId == null",
    );
    expect(source).toContain("loadVoucherCategoryForPosting(");
  });

  it("accepts an employee advance only through exact canonical typed metadata", () => {
    const source = {
      employeeId: 7,
      branchId: 2,
      expectedAmount: "100000.00",
      monthlyDeduction: "20000.00",
      note: "سلفة طارئة",
      sourceClientRequestId: "req-77",
    };
    const request = {
      kind: "EMPLOYEE_ADVANCE" as const,
      ...source,
      sourceHash: employeeAdvanceSourceHash(source),
    };
    expect(employeeAdvanceReference(request)).toBe(
      `EMP-ADV-7-${request.sourceHash.slice(0, 16)}`,
    );
    expect(
      employeeAdvanceReference({ ...request, expectedAmount: "100001.00" }),
    ).toBeNull();
  });

  it("detects every reserved system envelope and keeps malformed metadata fail-closed", () => {
    const malformed = '@SYSTEM_PAYMENT_REQUEST:{"kind":"EMPLOYEE_ADVANCE"';
    expect(hasSystemPaymentRequestEnvelope(malformed)).toBe(true);
    expect(parseSystemPaymentRequest(malformed)).toBeNull();

    const approval = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    const cancellation = readFileSync(
      new URL("../voucher/cancel.ts", import.meta.url),
      "utf8",
    );
    expect(approval).toContain(
      "hasSystemPaymentRequestEnvelope(preview.internalNote)",
    );
    expect(cancellation).toContain(
      "hasSystemPaymentRequestEnvelope(r.internalNote)",
    );
    expect(approval).toContain(
      "hasSystemPaymentRequestEnvelope(r.internalNote)",
    );
  });

  it("keeps accrual correction refunds canonical, evidenced, and pending-only", () => {
    const request = {
      kind: "ACCRUAL_CORRECTION_REFUND" as const,
      correctionRequestId: 17,
      obligationId: 41,
      obligationSourceHash: "a".repeat(64),
      expectedAmount: "25000.00",
      originalSettlementReceiptId: 73,
      providerEvidenceReference: "BANK-REFUND-991",
    };
    expect(isCanonicalSystemPaymentRequest(request, "ACCRUAL-REFUND-17")).toBe(
      true,
    );
    expect(
      isCanonicalSystemPaymentRequest(
        { ...request, expectedAmount: "25000" },
        "ACCRUAL-REFUND-17",
      ),
    ).toBe(false);
    expect(
      isCanonicalSystemPaymentRequest(
        { ...request, providerEvidenceReference: " BANK-REFUND-991" },
        "ACCRUAL-REFUND-17",
      ),
    ).toBe(false);
    expect(() =>
      isCanonicalSystemPaymentRequest(
        {
          ...request,
          providerEvidenceReference: 991,
        } as unknown as typeof request,
        "ACCRUAL-REFUND-17",
      ),
    ).not.toThrow();
    expect(
      isCanonicalSystemPaymentRequest(
        {
          ...request,
          providerEvidenceReference: 991,
        } as unknown as typeof request,
        "ACCRUAL-REFUND-17",
      ),
    ).toBe(false);
    const createSource = readFileSync(
      new URL("../voucher/create.ts", import.meta.url),
      "utf8",
    );
    expect(createSource).toContain("createSystemReceiptRequestTx(");
    expect(createSource).toContain('{ ...input, voucherType: "RECEIPT" }');
    expect(createSource).toContain("مرفق دليل استرداد المبلغ إلزامي");
    const vouchersUi = readFileSync(
      new URL("../../../client/src/pages/Vouchers.tsx", import.meta.url),
      "utf8",
    );
    expect(vouchersUi).toContain('"ACCRUAL-REFUND-"');
    const approvalSource = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    expect(approvalSource).toContain("settleAccrualCorrectionRefundTx(tx,");
    expect(approvalSource).toContain("rejectAccrualCorrectionRefundTx(tx,");
    expect(approvalSource).toContain(
      'systemRequest?.kind === "ACCRUAL_CORRECTION_REFUND";',
    );
    expect(approvalSource.indexOf(".update(receipts)")).toBeLessThan(
      approvalSource.indexOf("settleAccrualCorrectionRefundTx(tx,"),
    );
    expect(approvalSource).toContain(
      "أعد طلب استرداد التصحيح من مسار تصحيح المصدر",
    );
  });

  it("requires exact locked-obligation metadata on accrual settlement requests", () => {
    const obligationSource = {
      obligationId: 41,
      obligationSourceHash: "b".repeat(64),
      beneficiaryType: "OTHER" as const,
      beneficiaryId: null,
      beneficiaryNameSnapshot: "شركة النقل العراقية",
      sourceEvidenceReference: "PO-91-SHIP",
    };
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "ASSET_ACQUISITION",
          assetId: 7,
          ...obligationSource,
        },
        "ASSET-ACQ-7",
      ),
    ).toBe(true);
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "PURCHASE_SHIPPING",
          purchaseOrderId: 91,
          requestToken: "abcdef0123456789",
          expectedAmount: "12000.00",
          sourceShippingTotal: "12000.00",
          paymentReference: null,
          ...obligationSource,
        },
        "SHIP-PO-91-abcdef0123456789",
      ),
    ).toBe(true);
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "ASSET_ACQUISITION",
          assetId: 7,
        } as unknown as Parameters<typeof isCanonicalSystemPaymentRequest>[0],
        "ASSET-ACQ-7",
      ),
    ).toBe(false);
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "ASSET_ACQUISITION",
          assetId: 7,
          ...obligationSource,
          beneficiaryType: "SUPPLIER",
          beneficiaryId: null,
        },
        "ASSET-ACQ-7",
      ),
    ).toBe(false);
    const supplierSource = {
      ...obligationSource,
      obligationId: 42,
      beneficiaryType: "SUPPLIER" as const,
      beneficiaryId: 9,
      beneficiaryNameSnapshot: "مورد الأصل",
    };
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "ASSET_SUPPLIER_SETTLEMENT",
          assetId: 8,
          supplierId: 9,
          expectedAmount: "125000.00",
          ...supplierSource,
        },
        "ASSET-SUP-SETTLE-8-42",
      ),
    ).toBe(true);
    expect(
      isCanonicalSystemPaymentRequest(
        {
          kind: "ASSET_SUPPLIER_SETTLEMENT",
          assetId: 8,
          supplierId: 10,
          expectedAmount: "125000.00",
          ...supplierSource,
        },
        "ASSET-SUP-SETTLE-8-42",
      ),
    ).toBe(false);
    const approvalSource = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    expect(approvalSource).toContain("assertAccrualRequestBindingTx(tx,");
    expect(approvalSource).toContain(
      'eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED")',
    );
    expect(approvalSource).toContain('eventType: "PAYMENT_SETTLED"');
    expect(approvalSource).toContain('eventType: "PAYMENT_REJECTED"');
    expect(approvalSource).toContain("receiptId: Number(r.id)");
    expect(approvalSource).toContain('nextStatus: "PAID"');
    expect(approvalSource).toContain(
      'args.systemKind === "ASSET_SUPPLIER_SETTLEMENT"',
    );
  });

  it("fails closed for legacy asset reacquisition and preserves exact EOS settlement", () => {
    expect(
      parseSystemPaymentRequest(
        '@SYSTEM_PAYMENT_REQUEST:{"kind":"ASSET_REACQUISITION","assetId":7}',
      ),
    ).toBeNull();
    const approval = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    expect(approval).not.toContain("PAYMENT_OUT_SALARY");
    expect(approval).toContain("settleTerminationVoucherTx");
    expect(approval).toContain(
      'systemRequest?.kind === "TERMINATION_SETTLEMENT"',
    );
    expect(approval).toContain("parseTerminationSettlementReference(");
    expect(approval).toContain("expectedObligationId:");
    expect(approval).toContain("baghdadToday(approvedAt)");
    expect(approval).not.toContain("const [alreadyPaid]");
  });

  it("parses only canonical termination request references and keeps evidence out of them", () => {
    expect(
      parseTerminationSettlementReference("TERM-SETTLEMENT-17-A1"),
    ).toEqual({
      terminationId: 17,
      attempt: 1,
      originReturnEventId: null,
    });
    expect(
      parseTerminationSettlementReference("TERM-SETTLEMENT-17-REPAY-91-A3"),
    ).toEqual({
      terminationId: 17,
      attempt: 3,
      originReturnEventId: 91,
    });
    expect(
      terminationSettlementReference({
        terminationId: 17,
        attempt: 3,
        originReturnEventId: 91,
      }),
    ).toBe("TERM-SETTLEMENT-17-REPAY-91-A3");
    expect(
      parseTerminationSettlementReference(
        "TERM-SETTLEMENT-17-REPAY-91-A3:TX-SECRET",
      ),
    ).toBeNull();
    expect(
      parseTerminationSettlementReference("TERM-SETTLEMENT-17"),
    ).toBeNull();
  });

  it("preserves rejected system-payment instruments and verifies shipping evidence", () => {
    const approval = readFileSync(
      new URL("../voucher/approval.ts", import.meta.url),
      "utf8",
    );
    expect(approval).toContain(
      "paymentMethod: rejected.paymentMethod as PaymentMethod",
    );
    expect(approval).toContain("checkNumber: rejected.checkNumber");
    expect(approval).toContain("cardLastFour: rejected.cardLastFour");
    expect(approval).toContain('replacement.paymentMethod === "CASH"');
    expect(approval).toContain('replacement.cashBucket === "TREASURY"');
    expect(approval).toContain("!fundingStateMatches");
    expect(approval).toContain(
      "systemRequest.paymentReference?.trim() || null",
    );
    expect(approval).toContain(
      "actualPaymentReference !== declaredPaymentReference",
    );
  });
});
