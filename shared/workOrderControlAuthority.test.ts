/**
 * مصفوفةُ سلطة التحكّم في أمر الشغل — تحرس قرارَ المالك (١/٩/٢٦) نصّاً:
 * فنّي المطبعة يُلغي، والمالُ وحده هو ما يستدعي مديراً.
 */
import { describe, expect, it } from "vitest";
import {
  hasWorkOrderCommercialAuthority,
  hasWorkOrderDirectCancelAuthority,
  hasWorkOrderExecAuthority,
  hasWorkOrderManagerAuthority,
  mayCancelWorkOrderWithoutApproval,
  mayRequestWorkOrderControl,
  workOrderControlDeniedMessage,
} from "./workOrderControlAuthority";

describe("سلطة التحكّم في أمر الشغل", () => {
  it("تفصل التنفيذ (يشمل الفنّي) عن التجاريّ عن سلطة المدير", () => {
    expect(hasWorkOrderExecAuthority("print_operator", null)).toBe(true);
    expect(hasWorkOrderExecAuthority("cashier", null)).toBe(true);
    expect(hasWorkOrderExecAuthority("manager", null)).toBe(true);
    expect(hasWorkOrderExecAuthority("admin", null)).toBe(true);
    expect(hasWorkOrderExecAuthority("courier", null)).toBe(false);

    expect(hasWorkOrderCommercialAuthority("print_operator", null)).toBe(false);
    expect(hasWorkOrderCommercialAuthority("cashier", null)).toBe(true);

    expect(hasWorkOrderManagerAuthority("cashier", null)).toBe(false);
    expect(hasWorkOrderManagerAuthority("manager", null)).toBe(true);
  });

  it("تحترم قالبَ الدور وتجاوزَه معاً — لا قائمةَ أدوارٍ خام", () => {
    // قالبُ الفنّي يحمل workorders: FULL؛ تضييقُه صراحةً يسحب السلطة رغم بقاء الدور.
    expect(hasWorkOrderExecAuthority("print_operator", { workorders: "READ" } as never)).toBe(false);
    // دورٌ خارج القائمة يُمنح صراحةً ⇒ يمرّ (نمط moduleAccessAllowed).
    expect(hasWorkOrderCommercialAuthority("sales_rep", { workorders: "FULL" } as never)).toBe(true);
  });

  it("تفتح الإلغاءَ وحده لفنّي المطبعة وتُبقي التعديل والعكس على كاشير/مدير", () => {
    expect(mayRequestWorkOrderControl("CANCEL", "print_operator", null)).toBe(true);
    expect(mayRequestWorkOrderControl("COMMERCIAL_EDIT", "print_operator", null)).toBe(false);
    expect(mayRequestWorkOrderControl("MATERIAL_ADJUST", "print_operator", null)).toBe(false);
    expect(mayRequestWorkOrderControl("REVERSE_DELIVERY", "print_operator", null)).toBe(false);

    for (const type of ["CANCEL", "COMMERCIAL_EDIT", "MATERIAL_ADJUST", "REVERSE_DELIVERY"] as const) {
      expect(mayRequestWorkOrderControl(type, "cashier", null)).toBe(true);
      expect(mayRequestWorkOrderControl(type, "manager", null)).toBe(true);
      expect(mayRequestWorkOrderControl(type, "courier", null)).toBe(false);
    }
  });

  it("ترسائلُ الرفض تقول البديل لا «ممنوع» عمياء", () => {
    expect(workOrderControlDeniedMessage("CANCEL")).toContain("فنّي مطبعة");
    expect(workOrderControlDeniedMessage("REVERSE_DELIVERY")).toContain("كاشير أو مدير");
    expect(workOrderControlDeniedMessage("COMMERCIAL_EDIT")).toContain("كاشير أو مدير");
  });
});

describe("الإلغاء المباشر بلا اعتماد", () => {
  const base = {
    status: "RECEIVED",
    moneyAtStake: false,
    managerControlRequired: false,
  } as const;

  it("يسمح للفنّي بإلغاء أمرٍ لم يبدأ ولا مالَ فيه", () => {
    expect(
      mayCancelWorkOrderWithoutApproval({ ...base, role: "print_operator", override: null }),
    ).toBe(true);
  });

  it("⭐ يمنع الفنّي متى كان في الطلب عربونٌ أو نقد — وهو نصُّ قرار المالك", () => {
    expect(
      mayCancelWorkOrderWithoutApproval({
        ...base,
        role: "print_operator",
        override: null,
        moneyAtStake: true,
      }),
    ).toBe(false);
  });

  it("يمنع الفنّي بعد بدء التنفيذ — مصيرُ الخامة قرارُ مدير", () => {
    for (const status of ["IN_PROGRESS", "READY", "DELIVERED", "CANCELLED"]) {
      expect(
        mayCancelWorkOrderWithoutApproval({ ...base, status, role: "print_operator", override: null }),
      ).toBe(false);
    }
  });

  it("⭐ أسطرُ الخامة المخطَّطة لا تحجب الفنّي — الإلغاء من RECEIVED لا يمسّ المخزون", () => {
    // `managerControlRequired` مُشتعِلٌ بسبب أسطر الخامة وحدها؛ لا مالَ ولا بدءَ تنفيذ.
    expect(
      mayCancelWorkOrderWithoutApproval({
        ...base,
        role: "print_operator",
        override: null,
        managerControlRequired: true,
      }),
    ).toBe(true);
  });

  it("⛔ بوّابةُ المدير لم تُمَسّ: تبقى محكومةً بـcontrolRequired.cancel حرفياً", () => {
    expect(
      mayCancelWorkOrderWithoutApproval({
        ...base,
        role: "manager",
        override: null,
        managerControlRequired: true,
      }),
    ).toBe(false);
    expect(
      mayCancelWorkOrderWithoutApproval({ ...base, role: "manager", override: null }),
    ).toBe(true);
  });

  it("⛔⭐ الكاشير خارج الإلغاء المباشر — عقدُ RBAC القائم لم يُمَسّ", () => {
    // المالكُ أضاف صلاحيةً للفنّي ولم يُعِد توزيعَ السلطة؛ مسارُ الكاشير يبقى الطلبَ والاعتماد.
    expect(hasWorkOrderDirectCancelAuthority("cashier", null)).toBe(false);
    expect(
      mayCancelWorkOrderWithoutApproval({ ...base, role: "cashier", override: null }),
    ).toBe(false);
    // ولو كان الأمرُ خالياً من المال والخامة معاً.
    expect(
      mayCancelWorkOrderWithoutApproval({
        ...base, role: "cashier", override: null, managerControlRequired: false, moneyAtStake: false,
      }),
    ).toBe(false);
  });

  it("سلطةُ الإلغاء المباشر = مدير أو فنّي مطبعة (مرآة workordersDirectCancelProcedure)", () => {
    expect(hasWorkOrderDirectCancelAuthority("manager", null)).toBe(true);
    expect(hasWorkOrderDirectCancelAuthority("print_operator", null)).toBe(true);
    expect(hasWorkOrderDirectCancelAuthority("admin", null)).toBe(true);
    expect(hasWorkOrderDirectCancelAuthority("cashier", null)).toBe(false);
    expect(hasWorkOrderDirectCancelAuthority("courier", null)).toBe(false);
    // منحٌ صريح يفتحها لدورٍ خارج القائمة (نمط moduleAccessAllowed نفسه).
    expect(hasWorkOrderDirectCancelAuthority("sales_rep", { workorders: "FULL" } as never)).toBe(true);
  });

  it("لا يمنح دوراً بلا سلطةِ تنفيذٍ شيئاً", () => {
    expect(
      mayCancelWorkOrderWithoutApproval({ ...base, role: "courier", override: null }),
    ).toBe(false);
    expect(
      mayCancelWorkOrderWithoutApproval({ ...base, role: "print_operator", override: { workorders: "READ" } as never }),
    ).toBe(false);
    expect(hasWorkOrderDirectCancelAuthority("print_operator", { workorders: "READ" } as never)).toBe(false);
  });
});
