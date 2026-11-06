import { describe, expect, it } from "vitest";
import { D } from "@/lib/money";
import {
  resolveCompanyStatementBarcode,
  statementQueueRemaining,
  shipmentStatementCandidates,
  statementAmountsMatchClaims,
  statementClaimSnapshot,
  statementDraftLines,
  statementDifference,
  statementShipmentFees,
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
  it("rejects a missing, changed or malformed statement amount before it can be replaced by the current claim", () => {
    const row = { ...candidate(1, "1"), remainingDue: "1250.10", cashInCourierCustody: "0" };
    const snapshots = { 1: statementClaimSnapshot(row) };
    expect(statementAmountsMatchClaims([row], { 1: "1250.10" }, snapshots)).toBe(true);
    expect(statementAmountsMatchClaims([row], { 1: "1250" }, snapshots)).toBe(true);
    expect(statementAmountsMatchClaims([row], {}, snapshots)).toBe(false);
    expect(statementAmountsMatchClaims([row], { 1: "." }, snapshots)).toBe(false);
    expect(statementAmountsMatchClaims([{ ...row, remainingDue: "1200" }], { 1: "1000" }, snapshots)).toBe(false);
    expect(statementAmountsMatchClaims([{ ...row, cashInCourierCustody: "5" }], { 1: "1000" }, snapshots)).toBe(false);
    expect(statementAmountsMatchClaims([row], { 1: "1250.11" }, snapshots)).toBe(false);
  });
  it("keeps the entered partial amount, frozen claim and explicit responsibility in the payload", () => {
    const row = { ...candidate(1, "1"), remainingDue: "100", cashInCourierCustody: "70", parcelStatus: "DELIVERED" };
    const snapshots = { 1: statementClaimSnapshot(row) };
    const difference = statementDifference(row, "40")!;
    expect(difference.custody.toFixed(2)).toBe("30.00");
    expect(difference.unproven.toFixed(2)).toBe("30.00");
    expect(statementDraftLines([row], { 1: "40" }, snapshots, {})).toBeNull();
    expect(statementDraftLines([row], { 1: "40" }, snapshots, { 1: { shortfallResponsibility: "CUSTOMER" } })).toEqual([
      { consignmentId: 1, collectedAmount: "40.00", expectedDue: "100.00", expectedProven: "70.00", shortfallResponsibility: "CUSTOMER" },
    ]);
    expect(statementDraftLines([row], { 1: "40" }, snapshots, { 1: { shortfallResponsibility: "DELIVERY_PARTY" } })).toBeNull();
    expect(statementDraftLines([row], { 1: "40" }, snapshots, { 1: { shortfallResponsibility: "DELIVERY_PARTY", shortfallReason: "OTHER" } })?.[0].shortfallReason).toBe("OTHER");
    expect(statementDraftLines([{ ...row, cashInCourierCustody: "100" }], { 1: "40" }, { 1: statementClaimSnapshot({ ...row, cashInCourierCustody: "100" }) }, { 1: { shortfallResponsibility: "CUSTOMER" } })).toBeNull();
  });
  it("requires an explicit zero-delivery acknowledgement and does not infer one from selection", () => {
    const row = { ...candidate(1, "1"), remainingDue: "0", cashInCourierCustody: "0", parcelStatus: "OUT_FOR_DELIVERY" };
    const snapshots = { 1: statementClaimSnapshot(row) };
    expect(statementDraftLines([row], { 1: "0" }, snapshots, {})).toBeNull();
    expect(statementDraftLines([row], { 1: "0" }, snapshots, { 1: { zeroDeliveryConfirmed: true } })).toEqual([
      { consignmentId: 1, collectedAmount: "0.00", expectedDue: "0.00", expectedProven: "0.00", zeroDeliveryConfirmed: true },
    ]);
    const delivered = { ...row, remainingDue: "100", parcelStatus: "DELIVERED" };
    const deliveredSnapshot = { 1: statementClaimSnapshot(delivered) };
    expect(statementDraftLines([delivered], { 1: "0" }, deliveredSnapshot, { 1: { shortfallResponsibility: "CUSTOMER" } })).toBeNull();
    expect(statementDraftLines([delivered], { 1: "0" }, deliveredSnapshot, { 1: { shortfallResponsibility: "CUSTOMER", zeroDeliveryConfirmed: true } })).toEqual([
      { consignmentId: 1, collectedAmount: "0.00", expectedDue: "100.00", expectedProven: "0.00", zeroDeliveryConfirmed: true, shortfallResponsibility: "CUSTOMER" },
    ]);
  });
  it("projects a zero-cash owner's fee only onto the same shipment's cash", () => {
    const rows = [
      { ...candidate(1, "1"), shipmentLeaderConsignmentId: 1, remainingDue: "100", feeWithholdingCash: "5", sourceType: "ONLINE_ORDER", feeCollection: "SHOP" },
      { ...candidate(2, "1"), shipmentLeaderConsignmentId: 1, remainingDue: "100", feeWithholdingCash: "0" },
      { ...candidate(3, "3"), shipmentLeaderConsignmentId: 3, remainingDue: "100", feeWithholdingCash: "10", sourceType: "ONLINE_ORDER", feeCollection: "SHOP" },
    ];
    const preview = statementShipmentFees(rows, { 1: "0", 2: "100", 3: "100" });
    expect(preview.total.toFixed(2)).toBe("15.00");
    expect(preview.insufficient).toBe(false);
    expect(D("200").minus(preview.total).toFixed(2)).toBe("185.00");
    expect(D("100").minus(statementShipmentFees(rows.slice(0, 2), { 1: "0", 2: "100" }).total).toFixed(2)).toBe("95.00");
    expect(statementShipmentFees(rows, { 1: "0", 2: "3", 3: "100" }).insufficient).toBe(true);
    expect(statementShipmentFees([{ ...rows[0], remainingDue: "0" }, ...rows.slice(1)], { 1: "0", 2: "100", 3: "100" }).needsExplicit).toBe(true);
  });
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
  it("treats identical and zero-normalized references within one shipment as one barcode", () => {
    const rows = [
      { ...candidate(1, "0404221"), shipmentLeaderConsignmentId: 1 },
      { ...candidate(2, "0404221"), shipmentLeaderConsignmentId: 1 },
    ];
    expect(resolveCompanyStatementBarcode(rows, "0404221", new Set())).toMatchObject({
      kind: "ADDED",
      candidate: { id: 1 },
    });
    expect(resolveCompanyStatementBarcode(rows, "00404221", new Set())).toMatchObject({
      kind: "ADDED",
      candidate: { id: 1 },
    });
    expect(resolveCompanyStatementBarcode(rows, "0404221", new Set([1]))).toMatchObject({ kind: "ADDED" });
    expect(resolveCompanyStatementBarcode(rows, "0404221", new Set([1, 2]))).toMatchObject({ kind: "DUPLICATE" });
  });

  it("uses the shipment tracking reference when its leader is absent from the filtered list", () => {
    const rows = [
      { ...candidate(2, ""), shipmentLeaderConsignmentId: 1, shipmentTrackingRef: "0404221", shipmentInvoiceCount: 2 },
    ];
    expect(resolveCompanyStatementBarcode(rows, "404221", new Set())).toMatchObject({
      kind: "ADDED",
      candidate: { id: 2 },
    });
  });

  it("still rejects references matching distinct shipments rather than invoice rows", () => {
    const rows = [
      { ...candidate(1, "0404221"), shipmentLeaderConsignmentId: 1 },
      { ...candidate(2, "0404221"), shipmentLeaderConsignmentId: 1 },
      { ...candidate(3, "0404221"), shipmentLeaderConsignmentId: 3 },
    ];
    expect(resolveCompanyStatementBarcode(rows, "0404221", new Set())).toMatchObject({
      kind: "AMBIGUOUS",
      matches: 2,
    });
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
