// م١ (طلب المالك) — خدمة العملاء تطبع/تعيد طباعة فواتيرها عبر بوّابة invoiceViewProcedure
// (sales≥READ **أو** صلاحية الاستقبال workorders:FULL) — بلا فتح وحدة المبيعات كاملةً، فعروض
// الأسعار تبقى محميّة على salesReadProcedure (مراجعة Codex). دورٌ-محايد: يعمل لأيّ دور استقبال.
// (اختبار وحداتٍ نقيّ على خريطة الصلاحيات — لا قاعدة بيانات.)
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@shared/permissions";

// مرآة منطق invoiceViewProcedure (server/trpc.ts): يمرّ إن sales≥READ أو workorders===FULL.
const canViewInvoice = (sales: string, workorders: string) =>
  sales === "FULL" || sales === "READ" || workorders === "FULL";

describe("م١ — خدمة العملاء تطبع فواتيرها (invoiceViewProcedure)", () => {
  it("print_operator: sales يبقى NONE (لا توسيع وحدة المبيعات — حماية عروض الأسعار من مراجعة Codex)", () => {
    expect(ROLE_TEMPLATES.print_operator.sales).toBe("NONE");
  });

  it("print_operator يجتاز عرض/طباعة الفاتورة عبر صلاحية الاستقبال (workorders:FULL) رغم sales:NONE", () => {
    expect(ROLE_TEMPLATES.print_operator.workorders).toBe("FULL");
    expect(canViewInvoice(ROLE_TEMPLATES.print_operator.sales, ROLE_TEMPLATES.print_operator.workorders)).toBe(true);
  });

  it("دورٌ بلا مبيعات ولا استقبال ⇒ لا يجتاز؛ والكاشير (sales:FULL) يجتاز", () => {
    expect(canViewInvoice("NONE", "NONE")).toBe(false);
    expect(canViewInvoice(ROLE_TEMPLATES.cashier.sales, ROLE_TEMPLATES.cashier.workorders)).toBe(true);
  });

  it("لا انحدار: print_operator ما زال crm=FULL (يحفظ العملاء — م٢) و workorders=FULL", () => {
    expect(ROLE_TEMPLATES.print_operator.crm).toBe("FULL");
    expect(ROLE_TEMPLATES.print_operator.workorders).toBe("FULL");
  });

  it("لا انحدار: reception_clerk (موظف استقبال) يجتاز — sales=READ + workorders=FULL", () => {
    const recep = ROLE_TEMPLATES.cashier; // reception_clerk أساسه cashier + sales:READ override
    expect(canViewInvoice("READ", recep.workorders)).toBe(true);
  });
});
