import { describe, expect, it } from "vitest";
import { companyStatementPartyTransition } from "./statementDraft";

describe("مسودة كشف شركة التوصيل عند تبديل الجهة", () => {
  it("يمسح سياق الشركة A كاملاً عند الانتقال إلى الشركة B", () => {
    expect(companyStatementPartyTransition("company-a", "company-b", 0)).toEqual({
      partyId: "company-b",
      statementNumber: "",
      statementDate: "",
      statementDeductions: 0,
      statementNotes: "",
      countedCash: 0,
      selections: {},
      amounts: {},
      queueIds: [],
      countedBreakdown: {},
    });
  });

  it("لا يمسح الطابور عند مسح بوليصة أخرى للشركة نفسها", () => {
    expect(companyStatementPartyTransition(17, 17, "")).toBeNull();
  });
});
