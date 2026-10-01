import { describe, expect, it } from "vitest";
import { EXPENSE_FUNDING_META } from "@shared/expenseLabels";
import { expenseCategoryText, fundingDetail, fundingKindOf } from "./expenseView";

describe("expenseCategoryText — اتساق عرض الفئة والدلو", () => {
  it("يعرض الفئة التشغيلية المدارة عند وجودها", () => {
    expect(
      expenseCategoryText({
        category: "TRANSPORT",
        expenseCategoryName: "وقود ومحروقات",
      }),
    ).toBe("وقود ومحروقات");
  });

  it("يرجع للدلو المحاسبي عند غياب الفئة المدارة (null)", () => {
    expect(
      expenseCategoryText({
        category: "TRANSPORT",
        expenseCategoryName: null,
      }),
    ).toBe("مواصلات/شحن");
  });

  it("يشذب الفراغات ويرجع للدلو عند كون الفئة المدارة نصاً فارغاً أو مسافات فقط", () => {
    expect(
      expenseCategoryText({
        category: "TRANSPORT",
        expenseCategoryName: "   ",
      }),
    ).toBe("مواصلات/شحن");

    expect(
      expenseCategoryText({
        category: "TRANSPORT",
        expenseCategoryName: "",
      }),
    ).toBe("مواصلات/شحن");
  });

  it("يشذب الفراغات من الفئة المدارة الصحيحة", () => {
    expect(
      expenseCategoryText({
        category: "TRANSPORT",
        expenseCategoryName: "  وقود ومحروقات  ",
      }),
    ).toBe("وقود ومحروقات");
  });
});

describe("fundingDetail — وضوح دلالة الوضع الراهن للمصروف المعلق", () => {
  it("يوضح أن المصروف النقدي المعلق بلا أثر مالي حتى الآن ويصرف عند الاعتماد", () => {
    const detail = fundingDetail({
      id: 1,
      status: "PENDING_APPROVAL",
      paymentMethod: "CASH",
      source: "CASH",
      amount: "50000.00",
      category: "TRANSPORT",
      expenseDate: new Date(),
    } as any);

    expect(detail).toBe("طلب معلق بلا أثر مالي حتى الآن — يصرف من الخزينة عند الاعتماد");
  });

  it("يوضح الوضع الراهن للمصروف المعلق غير النقدي", () => {
    const detail = fundingDetail({
      id: 2,
      status: "PENDING_APPROVAL",
      paymentMethod: "TRANSFER",
      source: "CASH",
      amount: "50000.00",
      category: "TRANSPORT",
      expenseDate: new Date(),
    } as any);

    expect(detail).toContain("طلب معلق بلا أثر مالي حتى الآن");
  });
});

describe("EXPENSE_FUNDING_META — شارات الأثر المالي للمصروف المعلق", () => {
  it("يرجع الفئة الأصلية غير المعروفة نصاً إذا لم تكن في قائمة الدلاء ولا توجد فئة مدارة", () => {
    expect(
      expenseCategoryText({
        category: "CUSTOM_UNKNOWN",
        expenseCategoryName: null,
      }),
    ).toBe("CUSTOM_UNKNOWN");
  });

  it("شارة PENDING تؤكد الوضع الراهن كطلب معلق بلا أثر مالي", () => {
    const meta = EXPENSE_FUNDING_META.PENDING;
    expect(meta.short).toBe("معلق بلا أثر مالي");
    expect(meta.label).toContain("بلا أثر مالي حتى الآن");
    expect(meta.badge).toBe("badge-status-pending");
  });

  it("تصنيف نوع التمويل fundingKindOf يرجع PENDING لأي مصروف معلق أو مرفوض", () => {
    const pendingExpense = {
      id: 10,
      status: "PENDING_APPROVAL",
      paymentMethod: "CASH",
      source: "CASH",
      amount: "10000.00",
      category: "OTHER",
      expenseDate: new Date(),
    } as any;
    expect(fundingKindOf(pendingExpense)).toBe("PENDING");
    expect(fundingKindOf({ ...pendingExpense, status: "REJECTED" })).toBe("PENDING");
    expect(fundingDetail(pendingExpense)).toBe("طلب معلق بلا أثر مالي حتى الآن — يصرف من الخزينة عند الاعتماد");
  });
});

