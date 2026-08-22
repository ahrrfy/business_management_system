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
    expect(source).toContain('shipMethod === "TRANSFER"');
    expect(source).toContain("مرجع التحويل");
    expect(source).toContain("آخر أربعة أرقام للبطاقة");
    expect(source).toContain("shippingPaymentReference:");
    expect(source).toContain("shippingCardLastFour:");
  });

  /**
   * قرار المالك «لا تعامل بالصكوك» كان مطبَّقاً في راوتر السندات وفي `lib/paymentMethod`،
   * وهذا المنتقي هو المنفذ الوحيد الباقي الذي كان يُنشئ صكّاً فعلياً (عبر
   * `createSystemPaymentRequestTx`). يُمنَع رجوعه نصّياً.
   */
  it("لا يعرض «صك» في تسوية الشحن — منفذٌ خلفيّ لقرارٍ مُقفلٍ في كل بابٍ آخر", () => {
    expect(source).not.toContain('"CHECK"');
    expect(source).not.toContain("رقم الصك");
  });

  it("تسوية المورّد نقديّة فقط بلا منتقيٍ يَعِد بما يرفضه الخادم", () => {
    expect(source).not.toContain("SUPPLIER_PAYMENT_METHODS");
    expect(source).not.toContain("payMethod");
    const inlinePayment =
      source.match(
        /const payment = data\.settlementType[\s\S]*?: undefined;/,
      )?.[0] ?? "";
    const laterPayment =
      source.match(
        /async function submitLaterSupplierPayment\(\)[\s\S]*?\r?\n  }\r?\n\r?\n  async function submit\(\)/,
      )?.[0] ?? "";
    expect(inlinePayment).toContain('method: "CASH"');
    expect(laterPayment).toContain('method: "CASH"');
    for (const rejected of ["CARD", "TRANSFER", "WALLET", "CHECK"]) {
      expect(inlinePayment).not.toContain(rejected);
      expect(laterPayment).not.toContain(rejected);
    }
  });
});
