// اختبارات RBAC إضافية للشريحة الجديدة:
//  - catalog.updateProduct: managerProcedure (كان protected ⇒ ثغرة تكاليف).
//  - quotation.create/setStatus/convert: managerProcedure (كان protected).
//  - workOrders.list: branchScopedProcedure (IDOR).
//  - workOrders.get: يخفي materialsCost/laborCost/unitCost عن غير المرتفعين.
//  - shifts.report: branchScopedProcedure + يرفض ورديات فرع آخر للكاشير.
//  - barcode.verify: يرفض payload > 1000 خانة.

import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";

function ctxWith(role: string, branchId: number | null = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string, branchId: number | null = 1) => appRouter.createCaller(ctxWith(role, branchId));

async function expectForbidden(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "FORBIDDEN" });
}

describe("RBAC الجديد: شريحة precision-rbac", () => {
  describe("catalog.updateProduct — مدير فأعلى فقط", () => {
    it("الكاشير ممنوع", () =>
      expectForbidden(
        caller("cashier").catalog.updateProduct({
          productId: 1, name: "x",
          variants: [{ id: 1, sku: "s", costPrice: "0", units: [{ unitName: "u", conversionFactor: "1" }] }],
        })
      )
    );
    it("المخزن ممنوع", () =>
      expectForbidden(
        caller("warehouse").catalog.updateProduct({
          productId: 1, name: "x",
          variants: [{ id: 1, sku: "s", costPrice: "0", units: [{ unitName: "u", conversionFactor: "1" }] }],
        })
      )
    );
  });

  describe("quotation.* — مدير فأعلى فقط (كانت ثغرة protected)", () => {
    it("الكاشير ممنوع من إنشاء عرض سعر", () =>
      expectForbidden(
        caller("cashier").quotations.create({
          branchId: 1, lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        })
      )
    );
    it("الكاشير ممنوع من تغيير حالة عرض", () =>
      expectForbidden(caller("cashier").quotations.setStatus({ quotationId: 1, status: "ACCEPTED" }))
    );
    it("الكاشير ممنوع من تحويل عرض لفاتورة", () =>
      expectForbidden(caller("cashier").quotations.convert({ quotationId: 1 }))
    );
  });

  describe("barcode.verify — حدّ الإدخال", () => {
    it("يرفض payload > 1000 خانة", async () => {
      const huge = "X".repeat(1001);
      // publicProcedure — الفحص هو على zod schema قبل الوصول لأي شيء آخر.
      await expect(caller("cashier").barcode.verify({ payload: huge })).rejects.toThrow();
    });
    it("يقبل payload طبيعي", async () => {
      // payload غير صالح (لا توقيع) لكن طوله مسموح ⇒ يرجع invalid (لا exception).
      const out = await caller("cashier").barcode.verify({ payload: "INV|x|2026-01-01|100|1|abc" });
      expect(out).toBeDefined();
    });
  });
});
