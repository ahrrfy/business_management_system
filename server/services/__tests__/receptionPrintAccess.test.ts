// م١ (طلب المالك) — دور خدمة العملاء (print_operator) يقرأ/يطبع فواتيره ويعيد طباعتها:
// قالبه صار sales=READ (كان NONE يحجب sales.get/list وأزرار الطباعة)، وطابور فواتير المحطة
// انتقل لبوّابة exec التي تُدرجه. القراءة فقط — لا إنشاء بيع؛ وطفرات المال تبقى على بوّابة الكاشير.
// (اختبار وحداتٍ نقيّ على خريطة الصلاحيات — لا قاعدة بيانات.)
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES, moduleAccessAllowed, POS_STATION_GATES } from "@shared/permissions";

const SALES_LIST = ["cashier", "manager", "sales_rep", "print_operator"] as const;

describe("م١ — خدمة العملاء تقرأ/تطبع الفواتير (print_operator)", () => {
  it("قالب print_operator صار sales=READ (كان NONE) — يفكّ جلب/طباعة الفاتورة", () => {
    expect(ROLE_TEMPLATES.print_operator.sales).toBe("READ");
  });

  it("يجتاز sales≥READ (salesReadProcedure) ولا يجتاز sales=FULL — قراءة/طباعة فقط لا إنشاء بيع", () => {
    expect(moduleAccessAllowed("print_operator", null, "sales", "READ", SALES_LIST)).toBe(true);
    expect(moduleAccessAllowed("print_operator", null, "sales", "FULL", SALES_LIST)).toBe(false);
  });

  it("طابور فواتير المحطة (workordersExecProcedure) يُدرج print_operator ⇒ يجتاز؛ والبوّابة القديمة (cashier فقط) كانت تحجبه", () => {
    const execList = POS_STATION_GATES.RECEPTION.allowedRoles; // cashier, manager, print_operator
    expect(moduleAccessAllowed("print_operator", null, "workorders", "FULL", execList)).toBe(true);
    expect(moduleAccessAllowed("print_operator", null, "workorders", "FULL", ["cashier", "manager"])).toBe(false);
  });

  it("لا انحدار: print_operator ما زال crm=FULL (يحفظ العملاء — م٢) و workorders=FULL", () => {
    expect(ROLE_TEMPLATES.print_operator.crm).toBe("FULL");
    expect(ROLE_TEMPLATES.print_operator.workorders).toBe("FULL");
  });

  it("لا انحدار: أدوارٌ أخرى لا تتأثّر — cashier يبقى sales=FULL، والمدير كذلك", () => {
    expect(ROLE_TEMPLATES.cashier.sales).toBe("FULL");
    expect(moduleAccessAllowed("cashier", null, "sales", "READ", SALES_LIST)).toBe(true);
  });
});
