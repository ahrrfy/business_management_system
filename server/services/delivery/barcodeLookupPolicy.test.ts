import { describe, expect, it } from "vitest";
import { prepareDeliveryBarcodeLookup, resolveUniqueDeliveryBarcodeTarget } from "./barcodeLookupPolicy";

describe("resolveUniqueDeliveryBarcodeTarget", () => {
  it("يفك رمز الآلة WO إلى رقم العرض القصير مع إبقاء البادئة للسجلات القديمة", () => {
    expect(prepareDeliveryBarcodeLookup("WO-5285")).toMatchObject({
      namespace: "WORK_ORDER",
      systemCode: "WO-5285",
      documentCode: "5285",
    });
  });

  it("يفضّل رقم المستند المطابق على مفاتيح السجلات الرقمية المتصادمة", () => {
    expect(resolveUniqueDeliveryBarcodeTarget("5285", [
      { kind: "ONLINE_ORDER", id: 5285, matchRank: 10 },
      { kind: "INVOICE", id: 5285, matchRank: 10 },
      { kind: "WORK_ORDER", id: 91, matchRank: 100 },
    ])).toEqual({ kind: "WORK_ORDER", id: 91, matchRank: 100 });
  });

  it("يبقى مغلقاً عند تطابق مستندين حقيقيين بالرتبة نفسها", () => {
    expect(() => resolveUniqueDeliveryBarcodeTarget("5285", [
      { kind: "WORK_ORDER", id: 91, matchRank: 100 },
      { kind: "INVOICE", id: 77, matchRank: 100 },
    ])).toThrow(/يطابق أكثر من سجل/);
  });
});
