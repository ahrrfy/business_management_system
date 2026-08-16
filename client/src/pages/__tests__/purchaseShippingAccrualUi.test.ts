import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../PurchaseReceive.tsx", import.meta.url),
  "utf8",
);

describe("واجهة استحقاق وتسوية شحن المشتريات", () => {
  it("تفصل الاعتراف عند الاستلام عن التسوية المعلّقة", () => {
    expect(source).toContain("أُثبت مصروف الشحن والتزامه");
    expect(source).toContain("تسويته معلّقة لاعتماد مالكٍ آخر");
    expect(source).toContain("لا يحدث أي صرف عند الاستلام");
    expect(source).toContain("لا تُسجّله مرةً ثانية من شاشة المصروفات");
    expect(source).toContain("shippingPaymentRequestReceiptId");
  });

  it("تجمع دليل أداة الدفع غير النقدية وترسله إلى API", () => {
    expect(source).toContain('shipMethod === "TRANSFER" || shipMethod === "CHECK"');
    expect(source).toContain("مرجع التحويل");
    expect(source).toContain("رقم الصك");
    expect(source).toContain("آخر أربعة أرقام للبطاقة");
    expect(source).toContain("shippingPaymentReference:");
    expect(source).toContain("shippingCardLastFour:");
  });
});
