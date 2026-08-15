import { describe, expect, it } from "vitest";
import {
  expenseAuditDetail,
  expenseApprovalExecutionText,
  expenseExecutionMode,
  expenseStatusFromSearch,
  isExpenseFinanciallyPrintable,
} from "./expenseUiPolicy";

describe("سياسة عرض دورة المصروف", () => {
  it("أقل من الحد نقداً من الدرج فوري", () => {
    expect(
      expenseExecutionMode({
        source: "CASH",
        amount: "499999.99",
        paymentMethod: "CASH",
        cashSource: "OWN_DRAWER",
      }),
    ).toBe("DRAWER_IMMEDIATE");
  });

  it("الحد نفسه طلب اعتماد خزينة", () => {
    expect(
      expenseExecutionMode({
        source: "CASH",
        amount: "500000",
        paymentMethod: "CASH",
        cashSource: "OWN_DRAWER",
      }),
    ).toBe("PENDING_OWNER_APPROVAL");
  });

  it("التقريب إلى 500000 يسبق قرار الحد", () => {
    expect(
      expenseExecutionMode({
        source: "CASH",
        amount: "499999.995",
        paymentMethod: "CASH",
        cashSource: "OWN_DRAWER",
      }),
    ).toBe("PENDING_OWNER_APPROVAL");
  });

  it("اختيار الخزينة يحوّل الصغير إلى طلب اعتماد", () => {
    expect(
      expenseExecutionMode({
        source: "CASH",
        amount: "1000",
        paymentMethod: "CASH",
        cashSource: "TREASURY",
      }),
    ).toBe("PENDING_OWNER_APPROVAL");
  });

  it("كل طريقة غير نقدية طلب اعتماد ولو كانت دون الحد", () => {
    for (const paymentMethod of ["CARD", "CHECK", "TRANSFER", "WALLET"]) {
      expect(
        expenseExecutionMode({
          source: "CASH",
          amount: "100",
          paymentMethod,
          cashSource: "OWN_DRAWER",
        }),
      ).toBe("PENDING_OWNER_APPROVAL");
      expect(expenseApprovalExecutionText(paymentMethod)).toContain(
        "خارج رصيد الدرج والخزينة النقدية",
      );
    }
    expect(expenseApprovalExecutionText("CASH")).toContain("خزينة الفرع");
  });

  it("صرف المخزون فوري ولا يمر بالخزينة", () => {
    expect(
      expenseExecutionMode({
        source: "INTERNAL_USE",
        amount: "0",
        paymentMethod: "CASH",
        cashSource: "TREASURY",
      }),
    ).toBe("STOCK_IMMEDIATE");
  });

  it("لا يسمح بطباعة طلب أو رفض كإيصال صرف منفذ", () => {
    expect(isExpenseFinanciallyPrintable("PENDING_APPROVAL")).toBe(false);
    expect(isExpenseFinanciallyPrintable("REJECTED")).toBe(false);
    expect(isExpenseFinanciallyPrintable("ACTIVE")).toBe(true);
  });

  it("يعرض سبب رفض المالك في مسار التدقيق", () => {
    expect(
      expenseAuditDetail("expense.reject", null, {
        status: "REJECTED",
        rejectionReason: "المرفق لا يثبت الجهة المستفيدة",
      }),
    ).toBe("سبب الرفض: المرفق لا يثبت الجهة المستفيدة");
    expect(
      expenseAuditDetail(
        "expense.reject",
        null,
        JSON.stringify({ rejectionReason: "بيانات الصرف ناقصة" }),
      ),
    ).toBe("سبب الرفض: بيانات الصرف ناقصة");
  });

  it("يفتح رابط مركز الاعتمادات بفلتر الطلبات المعلقة فقط", () => {
    expect(
      expenseStatusFromSearch("?tab=expenses&status=PENDING_APPROVAL"),
    ).toBe("PENDING_APPROVAL");
    expect(expenseStatusFromSearch("?status=UNKNOWN")).toBe("");
  });
});
