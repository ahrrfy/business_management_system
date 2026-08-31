import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { purchaseRouter } from "../purchaseRouter";
import { supplierPaymentsRouter } from "../supplierPaymentsRouter";

function context(
  role = "admin",
  permissionsOverride?: Record<string, "NONE" | "READ" | "FULL">,
): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      role,
      branchId: 1,
      name: "مدير الاختبار",
      email: "purchase-governance@test.local",
      isActive: true,
      isOwner: true,
      permissionsOverride: permissionsOverride ?? null,
    } as TrpcContext["user"],
  };
}

describe("عقد API لحوكمة المشتريات S1+S2", () => {
  it("يرفض إرسالاً أو إلغاءً بلا نسخة وسبب ومفتاح ثابت قبل دخول الخدمة", async () => {
    const caller = purchaseRouter.createCaller(context());
    await expect(
      caller.confirmOrder({ purchaseOrderId: 1, reason: "مراجعة", clientRequestId: "submit-1" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.cancel({ purchaseOrderId: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض قراراً بلا مفتاح replay وسبب، وطلب شراء بلا مبرر بند", async () => {
    const caller = purchaseRouter.createCaller(context());
    await expect(
      caller.decideControl({ requestId: 1, approve: true } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.createRequisition({
        branchId: 1,
        purpose: "احتياج تشغيلي",
        clientRequestId: "req-api-1",
        items: [{ variantId: 1, productUnitId: 1, requestedBaseQuantity: 5, justification: "" }],
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض سلطة المشتريات وحدها قبل دخول خدمة قرار دفعة المورد", async () => {
    const purchasing = supplierPaymentsRouter.createCaller(
      context("purchasing", { purchases: "FULL", treasury: "NONE" }),
    );
    await expect(
      purchasing.decidePayment({
        requestId: 999999,
        decisionKey: "treasury-gate-payment",
        action: "REJECT",
        reviewReason: "اختبار بوابة الخزينة",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      purchasing.decideRefund({
        requestId: 999999,
        decisionKey: "treasury-gate-refund",
        action: "REJECT",
        reviewReason: "اختبار بوابة الخزينة",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

  });
});
