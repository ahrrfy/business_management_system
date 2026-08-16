import { describe, expect, it } from "vitest";
import {
  activeSalaryPaymentEvents,
  payrollExpenseFromItems,
  payrollStatusLabel,
  shortHash,
  settledObligationAmount,
  summarizeObligations,
  toExcelMoney,
} from "./payrollAccrual";

describe("payroll accrual presentation", () => {
  it("يعرض الحالات الأربع بأسماء تشغيلية واضحة", () => {
    expect(payrollStatusLabel("draft")).toBe("مسوّدة");
    expect(payrollStatusLabel("approved")).toBe("معتمد استحقاقياً");
    expect(payrollStatusLabel("paid")).toBe("مدفوع");
    expect(payrollStatusLabel("cancelled")).toBe("ملغى");
  });

  it("يحسب مصروف الاستحقاق لا صافي الدفع", () => {
    expect(payrollExpenseFromItems([{
      gross: "1000.00",
      overtime: "100.00",
      commission: "50.00",
      wageReduction: "20.00",
      socialSecurityEmployer: "75.00",
      endOfServiceAccrual: "25.00",
    }])).toBe("1230.00");
  });

  it("يلخص الالتزامات بحسب المراجعة الحالية ولا يخلط المراجعة المعكوسة", () => {
    const rows = [
      { kind: "SALARY_NET" as const, originalAmount: "700", remainingAmount: "200", status: "PARTIAL", revisionNo: 2 },
      { kind: "SALARY_NET" as const, originalAmount: "100", remainingAmount: "0", status: "SETTLED", revisionNo: 2 },
      { kind: "SALARY_NET" as const, originalAmount: "999", remainingAmount: "0", status: "REVERSED", revisionNo: 1 },
      { kind: "INCOME_TAX" as const, originalAmount: "50", remainingAmount: "50", status: "OPEN", revisionNo: 2 },
    ];
    const summary = summarizeObligations(rows, 2);
    expect(summary.find((row) => row.kind === "SALARY_NET")).toMatchObject({
      original: "800.00", remaining: "200.00", count: 2, openCount: 1,
    });
    expect(summary.find((row) => row.kind === "INCOME_TAX")?.remaining).toBe("50.00");
  });

  it("لا يعرض دفعة راتب سبق إعادتها", () => {
    const events = [
      { id: 1, eventKind: "SALARY_PAYMENT", reversalOfId: null },
      { id: 2, eventKind: "SALARY_PAYMENT", reversalOfId: null },
      { id: 3, eventKind: "SALARY_PAYMENT_RETURN", reversalOfId: 1 },
    ];
    expect(activeSalaryPaymentEvents(events).map((event) => event.id)).toEqual([2]);
  });

  it("يحسب صافي المدفوع من تسوية الالتزام ويعكس الإعادة الجزئية", () => {
    const rows = [
      { kind: "SALARY_NET" as const, originalAmount: "700", remainingAmount: "200", status: "PARTIAL", revisionNo: 3 },
      { kind: "SALARY_NET" as const, originalAmount: "100", remainingAmount: "0", status: "SETTLED", revisionNo: 3 },
      { kind: "SALARY_NET" as const, originalAmount: "999", remainingAmount: "0", status: "REVERSED", revisionNo: 2 },
    ];
    expect(settledObligationAmount(rows, "SALARY_NET", 3)).toBe("600.00");
  });

  it("يحافظ تصدير Excel على خلية رقمية ويختصر البصمة دون إخفائها", () => {
    expect(toExcelMoney("1234.50")).toBe(1234.5);
    expect(() => toExcelMoney("90071992547410.00")).toThrow("النطاق الرقمي الآمن");
    expect(shortHash("a".repeat(64))).toBe("aaaaaaaa…aaaaaaaa");
    expect(shortHash(null)).toBe("غير مثبت");
  });
});
