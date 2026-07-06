import { describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { canSeeCost } from "../../trpc";

// سياق وهمي بدور مُعطى — يكفي لاختبار وسطاء الأدوار (تقصر الدارة قبل بلوغ DB).
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

describe("canSeeCost", () => {
  it("يسمح للمدير والأدمن فقط", () => {
    expect(canSeeCost("admin")).toBe(true);
    expect(canSeeCost("manager")).toBe(true);
    expect(canSeeCost("cashier")).toBe(false);
    expect(canSeeCost("warehouse")).toBe(false);
    expect(canSeeCost("user")).toBe(false);
  });
});

describe("RBAC — الكاشير ممنوع من العمليات الإدارية", () => {
  const c = caller("cashier");
  it("لا يُنشئ منتجاً", () => expectForbidden(c.catalog.createProduct({ name: "x", variants: [] as never }) as Promise<unknown>));
  it("لا يطّلع على بحث المشتريات (يكشف التكلفة)", () => expectForbidden(c.catalog.forPurchase({ branchId: 1 })));
  it("لا يعطّل/يفعّل منتجاً", () => expectForbidden(c.catalog.setProductActive({ productId: 1, isActive: false })));
  it("لا يُنشئ أمر شراء", () => expectForbidden(c.purchases.createOrder({ supplierId: 1, branchId: 1, items: [] as never })));
  it("لا يستلم مشتريات (مخزن فأعلى)", () => expectForbidden(c.purchases.receive({ purchaseOrderId: 1, lines: [] as never })));
  it("لا يُنشئ مرتجعاً", () => expectForbidden(c.returns.create({ invoiceId: 1, lines: [] as never })));
  it("لا يحوّل مخزوناً", () => expectForbidden(c.inventory.transfer({ variantId: 1, fromBranchId: 1, toBranchId: 2, baseQuantity: 1 })));
  it("لا يسوّي مخزوناً", () => expectForbidden(c.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 0 })));
  it("لا يسحب تقرير أعمار الذمم", () => expectForbidden(c.reports.arAging()));
  // v3-add-screens: الكاشير يُنشئ عميلاً جديداً أثناء أمر شغل/بيع نقدي ⇒ ✅ مسموح.
  // (التعديل/التعطيل تبقى للمدير).
  it("يُنشئ عميلاً (مسموح في v3 لإدخال الزبون الجديد بسرعة)", async () => {
    await expect(c.customers.create({ name: "v3-cashier-customer" })).resolves.toBeTruthy();
  });
  it("لا يُنشئ مورّداً", () => expectForbidden(c.suppliers.create({ name: "x" })));
  it("لا يلغي أمر شغل", () => expectForbidden(c.workOrders.cancel({ workOrderId: 1 })));
});

describe("RBAC — أمين المخزن ممنوع من العمليات المالية/الإدارية", () => {
  const w = caller("warehouse");
  it("لا يُنشئ منتجاً (كتالوج = مديريّ)", () => expectForbidden(w.catalog.createProduct({ name: "x", variants: [] as never }) as Promise<unknown>));
  // ٦/٧ (بعد مراجعة عدائية): بوّابة التقارير على قائمة [manager/accountant/auditor] + منح صريح —
  // أمين المخزن القالبيّ محجوب عنها (لئلا تُكشَف تقارير التكلفة/الربح لدور canSeeCost=false).
  it("لا يقرأ التقارير المالية (قالبه لا يفتح بوّابة reportViewer)", () => expectForbidden(w.reports.apAging()));
  it("لا ينفّذ سنداً مالياً (treasury=NONE)", () =>
    expectForbidden(
      w.vouchers.create({ voucherType: "PAYMENT", branchId: 1, amount: "1000", paymentMethod: "CASH", partyType: "OTHER", description: "x" } as never),
    ));
});

describe("RBAC — الأدمن يتجاوز كل الأدوار (لا FORBIDDEN على البوّابة)", () => {
  it("الأدمن يجتاز بوّابة الدور في reports.arAging", async () => {
    // قد يرمي خطأ آخر (DB) لكن ليس FORBIDDEN — المهم أنّ بوّابة الدور لا تمنعه.
    let code: string | undefined;
    try {
      await caller("admin").reports.arAging();
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).not.toBe("FORBIDDEN");
  });
});
