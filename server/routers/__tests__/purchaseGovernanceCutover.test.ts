import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { purchaseRouter } from "../purchaseRouter";
import { purchaseReturnsRouter } from "../purchaseReturns";
import { supplierInvoicesRouter } from "../supplierInvoicesRouter";
import {
  assertLegacyPurchaseWritePathDisabled,
  LEGACY_PURCHASE_WRITE_REPLACEMENTS,
} from "../../services/purchase/governanceCutover";

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      role: "admin",
      branchId: 1,
      name: "مالك الاختبار",
      email: "purchase-cutover@test.local",
      isActive: true,
      isOwner: true,
    } as TrpcContext["user"],
  };
}

describe("بوابة cutover لمسارات المشتريات القديمة", () => {
  it("تعلن بديلاً محكوماً لكل مسار كتابة قديم", () => {
    expect(LEGACY_PURCHASE_WRITE_REPLACEMENTS).toEqual({
      "purchases.receive": "/purchases/goods-receipts",
      "purchases.pay": "/purchases/supplier-payments",
      "purchaseReturns.create": "/purchases/returns-governance",
    });
    expect(() => assertLegacyPurchaseWritePathDisabled("purchases.pay")).toThrow(/supplier-payments/);
  });

  it("يرفض receive وpay على حد API قبل أي أثر", async () => {
    const caller = purchaseRouter.createCaller(context());
    await expect(caller.receive({
      purchaseOrderId: 10,
      lines: [{ purchaseOrderItemId: 20, receivedBaseQuantity: 1 }],
      clientRequestId: "legacy-receive-disabled",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.pay({
      purchaseOrderId: 10,
      amount: "100.00",
      method: "CASH",
      clientRequestId: "legacy-pay-disabled",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يرفض إنشاء مرتجع الشراء القديم على حد API قبل أي أثر", async () => {
    const caller = purchaseReturnsRouter.createCaller(context());
    await expect(caller.create({
      clientRequestId: "legacy-return-disabled",
      supplierId: 2,
      branchId: 1,
      purchaseOrderRefId: 10,
      items: [{ purchaseOrderItemId: 20, quantity: "1" }],
      settlement: "CREDIT",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يفرض expectedVersion والسبب والسطور على API تصحيح مسودة فاتورة المورد", async () => {
    const caller = supplierInvoicesRouter.createCaller(context());
    await expect(caller.voidDraft({
      supplierInvoiceId: 1,
      expectedVersion: 1,
      requestKey: "draft-void-invalid-reason",
      reason: "x",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.updateDraft({
      supplierInvoiceId: 1,
      expectedVersion: 1,
      requestKey: "draft-update-empty-lines",
      reason: "تصحيح موثق",
      externalInvoiceNumber: "SUP-1",
      invoiceDate: "2026-08-31",
      evidenceType: "PDF",
      evidenceReference: "sha256:evidence",
      lines: [],
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
