import { describe, expect, it } from "vitest";
import {
  resolveCompanyStatementBarcode,
  statementQueueRemaining,
  type CompanyStatementQueueCandidate,
} from "./companyStatementQueue";

const candidate = (id: number, tracking: string): CompanyStatementQueueCandidate => ({
  id,
  consignmentNumber: `CN-${id}`,
  externalTrackingRef: tracking,
  invoiceId: id * 10,
  invoiceNumber: `INV-${id}`,
  codAmount: "89500.00",
  collectedAmount: "0.00",
  counterSettledAmount: "5000.00",
  shortfallAssigned: "250.00",
});

describe("طابور كشف شركة التوصيل بالباركود", () => {
  it("يطابق رقم البوليصة ويحافظ على الصفر البادئ", () => {
    const result = resolveCompanyStatementBarcode([candidate(1, "0441446")], " 0441446\r\n", new Set());
    expect(result).toMatchObject({ kind: "ADDED", trackingRef: "0441446" });
  });

  it("يمنع إضافة البوليصة نفسها مرتين", () => {
    const result = resolveCompanyStatementBarcode([candidate(1, "0441446")], "0441446", new Set([1]));
    expect(result.kind).toBe("DUPLICATE");
  });

  it("يميّز الرقم المفقود والرقم الملتبس بدلاً من اختيار فاتورةٍ عشوائياً", () => {
    expect(resolveCompanyStatementBarcode([candidate(1, "1")], "2", new Set()).kind).toBe("NOT_FOUND");
    expect(resolveCompanyStatementBarcode([candidate(1, "1"), candidate(2, "1")], "1", new Set()))
      .toMatchObject({ kind: "AMBIGUOUS", matches: 2 });
  });

  it("يحسب المتبقّي الحي بعد المقبوض الكاونتري والعجز المثبت", () => {
    expect(statementQueueRemaining(candidate(1, "0441446")).toFixed(2)).toBe("84250.00");
  });
});
