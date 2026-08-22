import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Tx } from "../../db";
import {
  correctionPayloadHash,
  lockAccrualRecognitionTx,
  transitionAccrualObligationTx,
} from "../accounting/accrualObligations";

const obligation = {
  id: 41,
  status: "CORRECTION_PENDING",
  recognizedAmount: "1250.00",
};

function transitionTx(row = obligation, affectedRows = 1) {
  const inserted: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(async (value: unknown) => {
      inserted.push(value);
      return [{ affectedRows: 1 }];
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([{ affectedRows }]),
    })),
  }));
  return { tx: { select, insert, update } as unknown as Tx, inserted };
}

function recognitionTx(entryOverrides: Record<string, unknown> = {}) {
  const rows = [
    [{
      id: 41,
      kind: "PURCHASE_SHIPPING",
      branchId: 1,
      purchaseOrderId: 17,
      beneficiarySupplierId: null,
      sourceKey: "PURCHASE_SHIPPING_ACCRUAL:17:token",
      recognizedAmount: "1250.00",
      recognizedBy: 7,
      evidenceReference: "SHIP-INV-17",
    }],
    [{
      id: 51,
      obligationId: 41,
      eventType: "RECOGNIZED",
      amount: "1250.00",
      receiptId: null,
      accountingEntryId: 61,
      evidenceReference: "SHIP-INV-17",
      actorId: 7,
      reviewerId: null,
    }],
    [{
      id: 61,
      entryType: "ADJUST",
      postingProfile: "ADJUST_EXPENSE_ACCRUAL",
      dedupeKey: "PURCHASE_SHIPPING_ACCRUAL:17:token",
      branchId: 1,
      purchaseOrderId: 17,
      supplierId: null,
      receiptId: null,
      amount: "1250.00",
      ...entryOverrides,
    }],
  ];
  let index = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: vi.fn(() => ({
          limit: vi.fn().mockImplementation(async () => rows[index++]),
        })),
      })),
    })),
  }));
  return { select } as unknown as Tx;
}

describe("accrual correction invariants", () => {
  it("follows obligation -> RECOGNIZED event -> exact ledger entry, never the replaceable receipt", async () => {
    const linked = await lockAccrualRecognitionTx(recognitionTx(), 41);
    expect(linked.event.accountingEntryId).toBe(61);
    expect(linked.entry).toMatchObject({
      postingProfile: "ADJUST_EXPENSE_ACCRUAL",
      purchaseOrderId: 17,
      receiptId: null,
    });
    await expect(
      lockAccrualRecognitionTx(recognitionTx({ receiptId: 88 }), 41),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      lockAccrualRecognitionTx(recognitionTx({ amount: "1249.99" }), 41),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps generic expense cancellation fail-closed before cash or receipt writes", () => {
    const source = readFileSync(
      new URL("../expenseService.ts", import.meta.url),
      "utf8",
    );
    const cancelStart = source.indexOf("export async function cancelExpense");
    const dedicatedGuard = source.indexOf("if (linkedAccrual)", cancelStart);
    const cashLock = source.indexOf("await lockCashSourceForUpdate", cancelStart);
    const receiptLock = source.indexOf("const linkedReceipt", cancelStart);
    expect(cancelStart).toBeGreaterThanOrEqual(0);
    expect(dedicatedGuard).toBeGreaterThan(cancelStart);
    expect(dedicatedGuard).toBeLessThan(cashLock);
    expect(dedicatedGuard).toBeLessThan(receiptLock);
    expect(source.slice(dedicatedGuard, cashLock)).toContain("استخدم طلب تصحيح المصدر المعتمد");
  });

  it("hashes asset scope, evidence, refund proof, and client id for replay safety", () => {
    const base = {
      obligationId: 41,
      expectedAssetId: 9,
      reason: "إلغاء فاتورة الاقتناء",
      externalEvidenceReference: "CN-19",
      attachmentUrl: "data:image/png;base64,AAA",
      refundPaymentMethod: "TRANSFER" as const,
      refundCashBucket: null,
      refundReferenceNumber: "BANK-REF-3",
      refundCardLastFour: null,
      clientRequestId: "corr-client-0001",
    };
    const hash = correctionPayloadHash(base);
    expect(correctionPayloadHash({ ...base })).toBe(hash);
    expect(correctionPayloadHash({ ...base, expectedAssetId: 10 })).not.toBe(hash);
    expect(correctionPayloadHash({ ...base, externalEvidenceReference: "CN-20" })).not.toBe(hash);
    expect(correctionPayloadHash({ ...base, refundReferenceNumber: "BANK-REF-4" })).not.toBe(hash);
  });

  it("appends PAYMENT_REJECTED with its receipt while keeping correction pending", async () => {
    const { tx, inserted } = transitionTx();
    await transitionAccrualObligationTx(tx, {
      obligationId: 41,
      expectedStatus: "CORRECTION_PENDING",
      nextStatus: "CORRECTION_PENDING",
      eventType: "PAYMENT_REJECTED",
      actorId: 7,
      receiptId: 88,
      evidenceReference: "CORRECTION-CN-19",
      dedupeKey: "ACCRUAL:PAYMENT_REJECTED:CORRECTION:41:88",
    });
    expect(inserted).toEqual([
      expect.objectContaining({
        obligationId: 41,
        eventType: "PAYMENT_REJECTED",
        amount: "1250.00",
        receiptId: 88,
        accountingEntryId: null,
      }),
    ]);
  });

  it("fails closed on missing receipt, partial amount, or a lost projection race", async () => {
    const missingReceipt = transitionTx();
    await expect(
      transitionAccrualObligationTx(missingReceipt.tx, {
        obligationId: 41,
        expectedStatus: "CORRECTION_PENDING",
        nextStatus: "CORRECTION_PENDING",
        eventType: "PAYMENT_REJECTED",
        actorId: 7,
        evidenceReference: "CN-19",
        dedupeKey: "missing-receipt",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const partial = transitionTx();
    await expect(
      transitionAccrualObligationTx(partial.tx, {
        obligationId: 41,
        expectedStatus: "CORRECTION_PENDING",
        nextStatus: "RECOGNITION_REVERSED",
        eventType: "RECOGNITION_REVERSED",
        actorId: 7,
        reviewerId: 8,
        accountingEntryId: 99,
        evidenceReference: "CN-19",
        dedupeKey: "partial",
        amount: "1249.99",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const raced = transitionTx(obligation, 0);
    await expect(
      transitionAccrualObligationTx(raced.tx, {
        obligationId: 41,
        expectedStatus: "CORRECTION_PENDING",
        nextStatus: "RECOGNITION_REVERSED",
        eventType: "RECOGNITION_REVERSED",
        actorId: 7,
        reviewerId: 8,
        accountingEntryId: 99,
        evidenceReference: "CN-19",
        dedupeKey: "raced",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
