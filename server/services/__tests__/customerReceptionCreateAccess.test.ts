// (١٢/٨، اصلاح عاجل بطلب المالك) — كاشير الاستقبال يحفظ العميل عبر بوّابة customerReceptionCreateAllowed
// (crm=FULL **أو** workorders=FULL) — بلا فتح إدارة العملاء كاملةً، فبقيّة عمليات CRM (notes/update/delete)
// تبقى محميّة ببوّاباتها الأضيق. دورٌ-محايد: يعمل لأيّ دور يفتح محطة الاستقبال.
// (اختبار وحداتٍ نقيّ على منطق البوّابة — لا قاعدة بيانات.)
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@shared/permissions";
import { customerReceptionCreateAllowed } from "../../trpc";

describe("customerReceptionCreateAllowed — بوّابة إنشاء العميل من محطة الاستقبال", () => {
  it("الأدمن يمرّ دائماً (بلا override وبلا لمس الخريطة)", () => {
    expect(customerReceptionCreateAllowed({ role: "admin" })).toBe(true);
  });

  it("cashier القالبيّ يمرّ (crm=FULL في القالب)", () => {
    expect(ROLE_TEMPLATES.cashier.crm).toBe("FULL");
    expect(customerReceptionCreateAllowed({ role: "cashier" })).toBe(true);
  });

  it("print_operator القالبيّ يمرّ (crm=FULL و workorders=FULL)", () => {
    expect(ROLE_TEMPLATES.print_operator.crm).toBe("FULL");
    expect(ROLE_TEMPLATES.print_operator.workorders).toBe("FULL");
    expect(customerReceptionCreateAllowed({ role: "print_operator" })).toBe(true);
  });

  // السيناريو الحقيقي الذي يشتكي منه المالك: دورٌ مخصّص باسم «كاشير استقبال أوامر شغل» أساسه
  // cashier مع override يخفض crm يدوياً إلى READ (رغبةً في تضييق إدارة العملاء) — يبقى قادراً
  // على حفظ العميل لأنه شرطُ إكمال طلب/حجز/تسليم من محطة الاستقبال (workorders=FULL).
  it("cashier بدور مخصّص crm=READ + workorders=FULL يمرّ (النمط المُشتَكى منه)", () => {
    expect(customerReceptionCreateAllowed({
      role: "cashier",
      permissionsOverride: { crm: "READ" },
    })).toBe(true);
  });

  // (مراجعة Codex P1): crm=NONE + workorders=FULL يُرفَض عمداً — البحث الذكيّ (smartSearch) يشترط
  // crm=READ، فبلا قراءةٍ يفشل التعرّف على العميل السابق ⇒ عميل مكرَّر ⇒ CONFLICT على الهاتف يمنع
  // الطلب. الحلّ: نُبقي fallback المرجعيّ الأصليّ (اسم/هاتف على الطلب فقط بلا سجلّ دائم).
  it("print_operator بدور مخصّص crm=NONE + workorders=FULL يُرفَض (لحماية إكمال الطلب من CONFLICT الهاتف)", () => {
    expect(customerReceptionCreateAllowed({
      role: "print_operator",
      permissionsOverride: { crm: "NONE" },
    })).toBe(false);
  });

  it("cashier بدور مخصّص crm=READ + workorders=READ يُرفَض (لا الاثنان يفتح بوّابة)", () => {
    expect(customerReceptionCreateAllowed({
      role: "cashier",
      permissionsOverride: { crm: "READ", workorders: "READ" },
    })).toBe(false);
  });

  it("warehouse (workorders=READ في القالب، crm=READ) يُرفَض", () => {
    expect(ROLE_TEMPLATES.warehouse.workorders).toBe("READ");
    expect(ROLE_TEMPLATES.warehouse.crm).toBe("READ");
    expect(customerReceptionCreateAllowed({ role: "warehouse" })).toBe(false);
  });

  it("accountant (crm=READ، workorders=NONE في القالب) يُرفَض", () => {
    expect(ROLE_TEMPLATES.accountant.crm).toBe("READ");
    expect(customerReceptionCreateAllowed({ role: "accountant" })).toBe(false);
  });

  it("user القالبيّ يُرفَض (لا crm ولا workorders)", () => {
    expect(customerReceptionCreateAllowed({ role: "user" })).toBe(false);
  });

  it("لا انحدار: sales_rep القالبيّ يمرّ (crm=FULL — العميل جزء عمله)", () => {
    expect(ROLE_TEMPLATES.sales_rep.crm).toBe("FULL");
    expect(customerReceptionCreateAllowed({ role: "sales_rep" })).toBe(true);
  });
});
