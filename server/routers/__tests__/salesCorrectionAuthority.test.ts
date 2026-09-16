import { describe, expect, it } from "vitest";
import { appRouter } from "../../routers";
import type { TrpcContext } from "../../context";

type Level = "NONE" | "READ" | "FULL";

function caller(role: string, permissionsOverride: Record<string, Level>) {
  return appRouter.createCaller({
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 991,
      role,
      branchId: 1,
      name: "اختبار صلاحية التصحيح",
      email: "correction-authority@test.local",
      loginMethod: "local",
      permissionsOverride,
      totpEnabledAt: new Date(),
      isActive: true,
    } as TrpcContext["user"],
  });
}

const request = {
  requestKey: "authority-matrix-missing-invoice",
  invoiceId: 2_147_483_647,
  reason: "اختبار مصفوفة صلاحيات تعديل الفاتورة",
  payload: { lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
};

describe("مصفوفة صلاحيات تعديل الفاتورة", () => {
  it("يسمح لمدير المبيعات بعرض مقارنة الاعتماد ولو كانت المنتجات محجوبة", async () => {
    await expect(caller("manager", { sales: "FULL", products: "NONE" })
      .salesControl.correctionCatalog({ requestId: 2_147_483_647 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("يبقي إنشاء طلب التعديل محتاجاً قراءة المنتجات", async () => {
    await expect(caller("cashier", { sales: "FULL", products: "NONE" })
      .salesControl.requestExchange(request))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يسمح لمحطة الاستقبال مع قراءة المنتجات ويمنعها عند حجب الكتالوج", async () => {
    await expect(caller("print_operator", { sales: "NONE", workorders: "FULL", products: "READ" })
      .salesControl.requestExchange(request))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("print_operator", { sales: "NONE", workorders: "FULL", products: "NONE" })
      .salesControl.requestExchange(request))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
