import { describe, expect, it } from "vitest";
import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
  unwrapBarcodeScanEnvelope,
} from "./barcodeScannerInput";
import { parseScan, resolveOrderLookupBarcode } from "./scanRouter";
import { resolveShippingLabelQrTarget } from "./printing/shippingLabel";

describe("normalizeBarcodeScannerInput", () => {
  it("يصحح رقم الفاتورة المقروء تحت تخطيط لوحة المفاتيح العربية", () => {
    expect(normalizeBarcodeScannerInput("÷آ{-1-20260806-00068")).toBe("INV-1-20260806-00068");
  });

  it("يصحح أحرف قارئ المنتجات والأرقام العربية-الهندية", () => {
    expect(normalizeBarcodeScannerInput("شمق٠٠١٢٣")).toBe("alr00123");
  });

  it("يبقي ASCII الصحيح كما هو", () => {
    expect(normalizeBarcodeScannerInput("INV-1-20260806-00068")).toBe("INV-1-20260806-00068");
    expect(normalizeBarcodeScannerInput("ABC/12[3]{4}")).toBe("ABC/12[3]{4}");
  });
});

describe("normalizeKnownSystemBarcode", () => {
  it("يصحح بادئات النظام المعروفة", () => {
    expect(normalizeKnownSystemBarcode("÷آ{-1-20260806-00068")).toBe("INV-1-20260806-00068");
  });

  it("لا يحول البحث العربي اليدوي", () => {
    expect(normalizeKnownSystemBarcode("قلم ازرق")).toBe("قلم ازرق");
    expect(normalizeKnownSystemBarcode("قلم ازرق ")).toBe("قلم ازرق ");
    expect(normalizeKnownSystemBarcode("عمار السلامي ")).toBe("عمار السلامي ");
  });
});

describe("parseScan", () => {
  it("يوجّه رقم الفاتورة المشوّه بالتخطيط العربي كفاتورة لا كباركود منتج", () => {
    expect(parseScan("÷آ{-1-20260806-00068")).toEqual({
      type: "invoice",
      number: "INV-1-20260806-00068",
    });
  });

  it("يوجّه باركود الإرسالية الكامل إلى سجل الإرسالية بلا تحويله إلى باركود منتج", () => {
    expect(parseScan("CN-1-20260917-00275")).toEqual({
      type: "consignment",
      number: "CN-1-20260917-00275",
    });
  });

  it("resolveOrderLookupBarcode يحفظ بادئات WO وINV وCN ورموز QR الموقّعة والأرقام الموحدة العارية", () => {
    expect(resolveOrderLookupBarcode("INV-100034")).toBe("INV-100034");
    expect(resolveOrderLookupBarcode("INV|100034|100|sig")).toBe("INV-100034");
    expect(resolveOrderLookupBarcode("INV|INV-100034|100|sig")).toBe("INV-100034");
    expect(resolveOrderLookupBarcode("WO-100035")).toBe("WO-100035");
    expect(resolveOrderLookupBarcode("WO|100035|100|sig")).toBe("WO-100035");
    expect(resolveOrderLookupBarcode("CN-100034")).toBe("CN-100034");
    expect(resolveOrderLookupBarcode("CN|100034|2026-10-19|0|1|sig")).toBe("CN-100034");
    expect(resolveOrderLookupBarcode("CNS-001")).toBe("CNS-001");
    expect(resolveOrderLookupBarcode("ؤآس-100034")).toBe("CNS-100034");
    expect(resolveOrderLookupBarcode("ORD-100034")).toBe("ORD-100034");
    expect(resolveOrderLookupBarcode("ORD|ORD-100034|2026-10-19|45000|1|sig")).toBe("ORD-100034");
    expect(resolveOrderLookupBarcode("https://erp.alroya.com/verify?payload=WO%7C100035-1%7C2026-10-19%7C100%7C1%7Csig")).toBe("WO-100035-1");
    expect(resolveOrderLookupBarcode("https://erp.alroya.com/verify?payload=INV%7C100034-1%7C2026-10-19%7C100%7C1%7Csig")).toBe("INV-100034-1");
    expect(resolveOrderLookupBarcode("https://store.alroya.com/?order=ORD-100034&token=abc")).toBe("ORD-100034");
    expect(resolveOrderLookupBarcode("INV-1-20260818-00073-1")).toBe("INV-1-20260818-00073-1");
    expect(resolveOrderLookupBarcode("100034")).toBe("100034");
    expect(resolveOrderLookupBarcode("https://srv1548487.hstgr.cloud/verify?ref=INV-100055")).toBe("INV-100055");
    expect(resolveOrderLookupBarcode("https://srv1548487.hstgr.cloud/verify?p=WO%7C100035%7C2026-11-09%7C100%7C1%7Csig")).toBe("WO-100035");
    expect(resolveOrderLookupBarcode("https://srv1548487.hstgr.cloud/verify/ORD-100009")).toBe("ORD-100009");
    expect(resolveOrderLookupBarcode("اففحس:ظظsrv1548487.hstgr.cloudظverify؟ref=÷آ{-١٠٠٠٥٥")).toBe("INV-100055");
  });

  it("يصنّف طلبات المتجر ORD كـ onlineOrder لا كباركود منتج ويفك أغلفة الروابط العربية", () => {
    expect(parseScan("ORD-100034")).toEqual({
      type: "onlineOrder",
      number: "ORD-100034",
    });
    expect(parseScan("ORD|100034|2026-10-19|45000|1|sig")).toEqual({
      type: "onlineOrder",
      number: "ORD-100034",
    });
    expect(unwrapBarcodeScanEnvelope("اففحس:ظظsrv1548487.hstgr.cloudظverify؟ref=÷آ{-١٠٠٠٥٥")).toBe("INV-100055");
    expect(normalizeKnownSystemBarcode("https;//srv1548487.hstgr.cloud/verify/ref=cn-100065")).toBe("CN-100065");
    expect(unwrapBarcodeScanEnvelope("عمار السلامي ")).toBe("عمار السلامي ");
  });
});

describe("resolveShippingLabelQrTarget", () => {
  it("لا يصنع رابط تحقق وهمياً من رقم الطلب غير الموقّع", () => {
    expect(resolveShippingLabelQrTarget({ orderNumber: "CN-1-20260917-00275" })).toBeNull();
  });

  it("يستعمل رابط صفحة الطلب الحقيقي الذي أرسله الخادم", () => {
    expect(resolveShippingLabelQrTarget({
      orderNumber: "CN-1-20260917-00275",
      qrUrl: "https://erp.example/verify?payload=SIGNED",
    })).toBe("https://erp.example/verify?payload=SIGNED");
  });
});
