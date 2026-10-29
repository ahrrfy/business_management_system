import { describe, expect, it } from "vitest";
import {
  resolveCompanyStatementBarcode,
  statementQueueRemaining,
  shipmentStatementCandidates,
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
  it("uses the server's current due instead of rebuilding a historical COD claim", () => {
    expect(statementQueueRemaining({ ...candidate(1, "1"), remainingDue: "1250.10" }).toFixed(2)).toBe("1250.10");
  });
  it.each(["DELIVERED", "WRITTEN_OFF", "RETURNED", "CANCELLED"])("does not demand historical COD on a %s closure", (status) => {
    expect(statementQueueRemaining({ ...candidate(1, "1"), status }).toFixed(2)).toBe("0.00");
  });
  it("does not demand return-declared exposure again", () => {
    expect(statementQueueRemaining({ ...candidate(1, "1"), returnDeclaredAt: new Date() }).toFixed(2)).toBe("0.00");
  });
  it("selects every invoice in a shipment without including an unrelated parcel", () => {
    const rows = [{ ...candidate(1, "PKG1"), shipmentLeaderConsignmentId: 1 },
      { ...candidate(2, ""), shipmentLeaderConsignmentId: 1 }, candidate(3, "PKG3")];
    expect(shipmentStatementCandidates(rows, 2).map((row) => row.id)).toEqual([1, 2]);
    expect(shipmentStatementCandidates(rows, 3).map((row) => row.id)).toEqual([3]);
    expect(shipmentStatementCandidates(rows, 99)).toEqual([]);
  });
  it("يطابق رقم البوليصة ويحافظ على الصفر البادئ", () => {
    const result = resolveCompanyStatementBarcode([candidate(1, "0441446")], " 0441446\r\n", new Set());
    expect(result).toMatchObject({ kind: "ADDED", trackingRef: "0441446" });
  });

  it("يطابق بوليصة مخزنة بدون صفر عند مسح كشف الشركة بصفر أو صفرين أو ثلاثة أصفار بادئة", () => {
    // حالة بلاغ المالك: بوليصة مخزنة كـ 404221 والماسح في كشف الشركة يقرأ 0404221
    const list = [candidate(1, "404221")];
    expect(resolveCompanyStatementBarcode(list, "0404221", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "0404221" });
    expect(resolveCompanyStatementBarcode(list, "00404221", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "00404221" });
    expect(resolveCompanyStatementBarcode(list, "000404221", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "000404221" });
  });

  it("يطابق بوليصة مخزنة بأصفار بادئة عند مسح أو إدخال الرقم مجرداً", () => {
    const listWithLeadingZero = [candidate(2, "0404221")];
    expect(resolveCompanyStatementBarcode(listWithLeadingZero, "404221", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "404221" });
    expect(resolveCompanyStatementBarcode(listWithLeadingZero, "00404221", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "00404221" });
  });

  it("يطابق الأرقام الشرقية المطبوعة أو الممسوحة بتخطيط عربي مع الرقم اللاتيني المخزن", () => {
    const list = [candidate(1, "404221")];
    expect(resolveCompanyStatementBarcode(list, "٠٤٠٤٢٢١", new Set()))
      .toMatchObject({ kind: "ADDED", trackingRef: "0404221" });
  });

  it("يحرس عدم اللبس عند وجود أكثر من إرسالية بنفس النواة الرقمية برفض الحسم", () => {
    const duplicates = [candidate(1, "404221"), candidate(2, "0404221")];
    expect(resolveCompanyStatementBarcode(duplicates, "00404221", new Set()))
      .toMatchObject({ kind: "AMBIGUOUS", matches: 2 });
  });

  it("يمنع إضافة البوليصة المتطابقة قانونياً مرتين إلى الطابور", () => {
    const list = [candidate(1, "404221")];
    expect(resolveCompanyStatementBarcode(list, "0404221", new Set([1]))).toMatchObject({
      kind: "DUPLICATE",
      candidate: { id: 1 },
    });
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
