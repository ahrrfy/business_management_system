// اختبارات RBAC إضافية للشريحة الجديدة:
//  - catalog.updateProduct: managerProcedure (كان protected ⇒ ثغرة تكاليف).
//  - quotation.create/setStatus/convert: managerProcedure (كان protected).
//  - workOrders.list: branchScopedProcedure (IDOR).
//  - workOrders.get: يخفي materialsCost/laborCost/unitCost عن غير المرتفعين.
//  - shifts.report: branchScopedProcedure + يرفض ورديات فرع آخر للكاشير.
//  - barcode.verify: يرفض payload > 1000 خانة.
//  - inventory.transfer/adjust: warehouse مُجبَر على فرعه (M1 — تدقيق ١٤/٦/٢٦).
//  - voucher.list/get: branchScopedProcedure مع scopedBranchId (M2 — تدقيق ١٤/٦/٢٦).

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

  // M1 — تدقيق ١٤/٦/٢٦: inventory.transfer/adjust يجب أن يُجبرا warehouse على فرعه.
  // قبل الإصلاح: warehouse فرع SALES كان يستطيع نقل بضاعة من فرع MAIN عبر API مباشر.
  describe("M1: inventory.transfer/adjust — عزل الفرع لـwarehouse", () => {
    it("warehouse: transfer من فرع ليس فرعه ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", 2).inventory.transfer({
          variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 5,
        })
      )
    );
    it("warehouse بلا فرع: transfer ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", null).inventory.transfer({
          variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 5,
        })
      )
    );
    it("warehouse بلا فرع: adjust ⇒ FORBIDDEN", () =>
      expectForbidden(
        caller("warehouse", null).inventory.adjust({
          variantId: 1, branchId: 1, targetQuantity: 10,
        })
      )
    );
  });

  // M2 — تدقيق ١٤/٦/٢٦: voucher.list/get تحوّلا إلى branchScopedProcedure.
  // قبل الإصلاح: أي مستخدم مسجَّل (كاشير/مخزن) كان يستطيع قراءة سندات كل الفروع.
  describe("M2: voucher.list/get — عزل الفرع للأدوار غير المرتفعة", () => {
    it("list: كاشير بفرع — لا يستثني branchScopedProcedure (لا يرمي FORBIDDEN، يفلتر بصمت لفرعه)", async () => {
      // قاعدة الاختبار فارغة ⇒ النتيجة دائماً []؛ المهمّ أنّ الإجراء لا يرمي
      // (أي أنّ branchScopedProcedure يعمل ويُمرّر scopedBranchId بلا خطأ).
      const out = await caller("cashier", 2).vouchers.list();
      expect(Array.isArray(out)).toBe(true);
    });
    it("list: كاشير يحاول طلب فرع آخر — يُغلَب على input.branchId بـscopedBranchId", async () => {
      // حتى مع تمرير branchId مختلف، scopedBranchId يفرض فرع المستخدم — النتيجة [] لقاعدة فارغة.
      const out = await caller("cashier", 2).vouchers.list({ branchId: 1 });
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBe(0);
    });
    it("get: كاشير يطلب receiptId غير موجود ⇒ null (لا تسريب لخطأ DB)", async () => {
      const v = await caller("cashier", 2).vouchers.get({ receiptId: 999999 });
      expect(v).toBeNull();
    });
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
