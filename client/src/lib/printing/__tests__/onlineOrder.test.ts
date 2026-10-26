import { describe, expect, it } from "vitest";
import {
  buildOnlineOrderInvoicePrintData,
  buildOnlineOrderPreparationA4Html,
  buildOnlineOrderThermalDoc,
  type OnlineOrderPrintData,
} from "../onlineOrder";

function makePrintOrder(overrides: Partial<OnlineOrderPrintData> = {}): OnlineOrderPrintData {
  return {
    orderNumber: "WEB-2026-0777",
    customerName: "مؤسسة الرافدين",
    customerPhone: "07709998877",
    governorate: "بغداد",
    addressText: "المنصور - شارع 14 رمضان\nملاحظة: ملاحظة مدمجة قديمة",
    status: "CONFIRMED",
    subtotal: "45000",
    deliveryFee: "5000",
    deliveryFree: false,
    deliveryWaivedAmount: "0",
    total: "50000",
    createdAt: "2026-10-26T07:00:00.000Z",
    barcode: false,
    items: [
      {
        productName: "دفتر ملاحظات جلدي",
        variantLabel: "أسود A5",
        imageUrl: null,
        unitName: "قطعة",
        quantity: "5",
        unitPrice: "9000",
        total: "45000",
        customizationSummary: "حفر ليزري للشعار",
      },
    ],
    ...overrides,
  };
}

describe("onlineOrder printing address & customerNotes resolution", () => {
  it("renders customerNotes ?? notes ?? split.notes and clean shippingAddress in Thermal receipt", () => {
    const withCustomerNotes = buildOnlineOrderThermalDoc(
      makePrintOrder({
        customerNotes: "الاتصال بالمدير الإداري عند الوصول",
      }),
    );
    expect(withCustomerNotes.meta).toContain("العنوان: بغداد — المنصور - شارع 14 رمضان");
    expect(withCustomerNotes.meta.some((m) => m.includes("ملاحظة مدمجة قديمة"))).toBe(false);
    expect(withCustomerNotes.meta).toContain("ملاحظات: الاتصال بالمدير الإداري عند الوصول");

    const withLegacySplitNotes = buildOnlineOrderThermalDoc(
      makePrintOrder({
        customerNotes: null,
        notes: null,
      }),
    );
    expect(withLegacySplitNotes.meta).toContain("العنوان: بغداد — المنصور - شارع 14 رمضان");
    expect(withLegacySplitNotes.meta).toContain("ملاحظات: ملاحظة مدمجة قديمة");
  });

  it("renders customerNotes ?? notes ?? split.notes and clean shippingAddress in Preparation A4 HTML", () => {
    const htmlWithCustomerNotes = buildOnlineOrderPreparationA4Html(
      makePrintOrder({
        customerNotes: "تغليف كل قطعة بكيس شفاف منفصل",
      }),
    );
    expect(htmlWithCustomerNotes).toContain("بغداد — المنصور - شارع 14 رمضان");
    expect(htmlWithCustomerNotes).not.toContain("ملاحظة مدمجة قديمة");
    expect(htmlWithCustomerNotes).toContain("تغليف كل قطعة بكيس شفاف منفصل");

    const htmlWithLegacyNotes = buildOnlineOrderPreparationA4Html(
      makePrintOrder({
        customerNotes: null,
        notes: null,
      }),
    );
    expect(htmlWithLegacyNotes).toContain("بغداد — المنصور - شارع 14 رمضان");
    expect(htmlWithLegacyNotes).toContain("ملاحظة مدمجة قديمة");
  });

  it("renders customerNotes ?? notes ?? split.notes and clean shippingAddress in Unified A4 invoice data", () => {
    const unifiedWithCustomerNotes = buildOnlineOrderInvoicePrintData(
      makePrintOrder({
        governorate: "baghdad",
        customerNotes: "تسليم البوابة الخلفية",
        couponCode: "VIP10",
      }),
    );
    expect(unifiedWithCustomerNotes.customerAddress).toBe("بغداد — المنصور - شارع 14 رمضان");
    expect(unifiedWithCustomerNotes.customerAddress).not.toContain("ملاحظة:");
    expect(unifiedWithCustomerNotes.notes).toBe("تسليم البوابة الخلفية | كوبون خصم: VIP10");

    const unifiedWithLegacyFallback = buildOnlineOrderInvoicePrintData(
      makePrintOrder({
        governorate: "baghdad",
        customerNotes: null,
        notes: undefined,
      }),
    );
    expect(unifiedWithLegacyFallback.customerAddress).toBe("بغداد — المنصور - شارع 14 رمضان");
    expect(unifiedWithLegacyFallback.notes).toBe("ملاحظة مدمجة قديمة");
  });
});
