// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  summarizeEmployeeAdvances,
  type EmployeeAdvanceSummaryInput,
} from "../EmployeeAdvances";

function advance(
  input: Partial<EmployeeAdvanceSummaryInput> &
    Pick<EmployeeAdvanceSummaryInput, "amount" | "status">,
): EmployeeAdvanceSummaryInput {
  return {
    remaining: "0.00",
    workflowStatus: input.status,
    sourceType: "SALARY_ADVANCE",
    financiallyDisbursed: false,
    ...input,
  };
}

describe("ملخص شاشة سلف الموظفين", () => {
  it("يفصل الطلبات والصرف والتسوية والرصيد والتاريخي ولا يعدّ المرفوض أو الملغى مصروفاً", () => {
    const summary = summarizeEmployeeAdvances([
      advance({ amount: "100.00", status: "PENDING_APPROVAL" }),
      advance({ amount: "200.00", status: "APPROVED" }),
      advance({ amount: "900.00", status: "REJECTED" }),
      advance({ amount: "800.00", status: "CANCELLED" }),
      advance({ amount: "700.00", status: "EXPIRED" }),
      advance({
        amount: "1000.00",
        remaining: "600.00",
        status: "ACTIVE",
        financiallyDisbursed: true,
      }),
      advance({
        amount: "500.00",
        remaining: "0.00",
        status: "SETTLED",
        financiallyDisbursed: true,
      }),
      advance({
        amount: "600.00",
        remaining: "600.00",
        status: "CANCELLED",
        financiallyDisbursed: true,
      }),
      advance({
        amount: "300.00",
        status: "LEGACY_UNCLASSIFIED",
        workflowStatus: "LEGACY_UNCLASSIFIED",
      }),
      advance({
        amount: "700.00",
        remaining: "450.00",
        status: "ACTIVE",
        sourceType: "LEGACY_UNCLASSIFIED",
        financiallyDisbursed: true,
      }),
    ]);

    expect(summary).toEqual({
      requestedUndisbursed: { count: 2, amount: "300.00" },
      disbursed: { count: 2, amount: "1500.00" },
      settled: { count: 2, amount: "900.00" },
      outstanding: { count: 1, amount: "600.00" },
      legacyReview: { count: 2, amount: "750.00" },
    });
  });
});
