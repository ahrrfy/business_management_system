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

  /**
   * دفعةُ المورّد لحظة الاستلام نقديّة فقط: `receivePurchase` يرفض غيرها من أوّل سطر داخل
   * `withTx`، والرفض يُسقِط الاستلام كلّه (لا مخزون ولا ذمّة ولا قيد شراء). عرضُ طريقةٍ
   * يرفضها العقد = إدخالٌ كاملٌ يضيع — نمط #596 الذي يحذّر منه CLAUDE.md §٦.
   */
  it("منتقي دفعة المورّد نقديّ فقط — لا يَعِد بما يرفضه الخادم", () => {
    expect(source).toContain("SUPPLIER_PAYMENT_METHODS");
    const list = source.match(/const SUPPLIER_PAYMENT_METHODS[^;]+;/s)?.[0] ?? "";
    expect(list).toContain('v: "CASH"');
    for (const rejected of ["CARD", "TRANSFER", "WALLET", "CHECK"]) {
      expect(list).not.toContain(rejected);
    }
  });
});
