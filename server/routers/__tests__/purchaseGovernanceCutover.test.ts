import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { purchaseRouter } from "../purchaseRouter";
import { purchaseReturnsRouter } from "../purchaseReturns";
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
    expect(LEGACY_PURCHASE_WRITE_REPLACEMENTS).toMatchObject({
      "purchases.pay": "/purchases/supplier-payments",
      "purchaseReturns.create": "/purchases/returns-governance",
    });
    expect(() =>
      assertLegacyPurchaseWritePathDisabled("purchases.pay"),
    ).toThrow(/supplier-payments/);
  });

  it("يحذف receive وراوتري GRN/فاتورة المورد من API العام", () => {
    const caller = purchaseRouter.createCaller(context());
    const rootCaller = appRouter.createCaller(context());
    expect(caller).not.toHaveProperty("receive");
    expect(rootCaller).not.toHaveProperty("goodsReceipts");
    expect(rootCaller).not.toHaveProperty("supplierInvoices");
  });

  it("يبقي pay القديم مغلقاً قبل أي أثر", async () => {
    const caller = purchaseRouter.createCaller(context());
    await expect(
      caller.pay({
        purchaseOrderId: 10,
        amount: "100.00",
        method: "CASH",
        clientRequestId: "legacy-pay-disabled",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يرفض إنشاء مرتجع الشراء القديم على حد API قبل أي أثر", async () => {
    const caller = purchaseReturnsRouter.createCaller(context());
    await expect(
      caller.create({
        clientRequestId: "legacy-return-disabled",
        supplierId: 2,
        branchId: 1,
        purchaseOrderRefId: 10,
        items: [{ purchaseOrderItemId: 20, quantity: "1" }],
        settlement: "CREDIT",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يربط الاعتماد النهائي بالترحيل التلقائي داخل المعاملة", () => {
    const controls = readFileSync(
      path.resolve(process.cwd(), "server/services/purchase/controls.ts"),
      "utf8",
    );
    expect(controls).toContain(
      "const posting = await postApprovedPurchaseInvoiceInTx(",
    );
    expect(controls).toContain("automaticInvoicePosting: true");
    expect(controls).toContain("goodsReceiptId: posting.goodsReceiptId");
    expect(controls).toContain("supplierInvoiceId: posting.supplierInvoiceId");
    expect(controls).toContain('status: "CONFIRMED"');
  });
});
