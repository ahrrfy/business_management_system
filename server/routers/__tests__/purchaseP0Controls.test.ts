import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { receivePurchase } from "../../services/purchaseService";
import { purchaseRouter } from "../purchaseRouter";
import { purchaseReturnsRouter } from "../purchaseReturns";

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      role: "admin",
      branchId: 1,
      name: "مالك الاختبار",
      email: "purchase-owner@test.local",
      isActive: true,
      isOwner: true,
    } as TrpcContext["user"],
  };
}

describe("ضوابط P0 للمشتريات على حد API", () => {
  it("يرفض CHECK في تسوية الشحن وتسديد USD قبل دخول الخدمة", async () => {
    const caller = purchaseRouter.createCaller(context());

    await expect(
      caller.receive({
        purchaseOrderId: 999_991,
        lines: [{ purchaseOrderItemId: 999_992, receivedBaseQuantity: 1 }],
        shippingPaymentMethod: "CHECK" as never,
        clientRequestId: "api-purchase-check-shipping",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.settleUsdDirect({
        purchaseOrderId: 999_991,
        settledUsd: "10.00",
        chargedIqd: "14500.00",
        method: "CHECK" as never,
        referenceNumber: "CHECK-USD-1",
        clientRequestId: "api-purchase-check-usd",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض CHECK في تسوية الشحن حتى عند استدعاء الخدمة مباشرة", async () => {
    await expect(
      receivePurchase(
        {
          purchaseOrderId: 999_991,
          lines: [{ purchaseOrderItemId: 999_992, receivedBaseQuantity: 1 }],
          shippingPaymentMethod: "CHECK",
          clientRequestId: "service-purchase-check-shipping",
        } as never,
        { userId: 1, branchId: 1, role: "admin" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض CHECK والمرتجع الحر بلا أمر شراء مرجعي على حد API", async () => {
    const caller = purchaseReturnsRouter.createCaller(context());
    const base = {
      clientRequestId: "api-purchase-return-p0",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: 999_991,
      items: [{ purchaseOrderItemId: 999_992, quantity: "1" }],
      settlement: "CREDIT" as const,
    };

    await expect(
      caller.create({ ...base, paymentMethod: "CHECK" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { purchaseOrderRefId: _omitted, ...withoutReference } = base;
    await expect(
      caller.create(withoutReference as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
