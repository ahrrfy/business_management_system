import { describe, expect, it } from "vitest";
import { canUseDigitalCardsSellingStation, resolvePermissions } from "@shared/permissions";
import { captureDigitalBasketLines, toDigitalPrepareLine } from "./digitalBasket";

describe("عقد سلة الكروت للقنوات غير التجزئة", () => {
  it("يحفظ إصدار السعر الحقيقي ومرجع المزوّد ومفتاح السلة وبيانات الطالب", () => {
    const [captured] = captureDigitalBasketLines(
      {
        providerBasketKey: "basket-9",
        providerReference: "TX-2048",
        lines: [{
          card: {
            offeringId: 41,
            providerId: 7,
            priceVersionId: 73,
            sellPrice: "350000.00",
            providerName: "المزوّد",
            offeringType: "EDUCATIONAL_SUBSCRIPTION",
            faceValue: null,
            subscriptionDurationDays: 180,
            requiresStudentData: true,
          },
          student: { studentName: "حسن", studentPhone: "+9647700000000" },
        }],
      },
      () => "line-1",
    );

    expect(toDigitalPrepareLine(captured.digital)).toEqual({
      lineKey: "line-1",
      providerBasketKey: "basket-9",
      offeringId: 41,
      priceVersionId: 73,
      expectedSellPrice: "350000.00",
      providerReference: "TX-2048",
      student: { studentName: "حسن", studentPhone: "+9647700000000" },
    });
  });

  it("يفشل مغلقاً إن وصل كرت بلا إصدار سعر نافذ", () => {
    expect(() => captureDigitalBasketLines({
      providerBasketKey: "basket-1",
      providerReference: "TX-1",
      lines: [{ card: {
        offeringId: 1,
        providerId: 2,
        priceVersionId: null,
        sellPrice: null,
        providerName: "مزوّد",
        offeringType: "TELECOM_CARD",
        faceValue: "5000.00",
        subscriptionDurationDays: null,
        requiresStudentData: false,
      } }],
    }, () => "line")).toThrow(/بلا سعر نافذ/);
  });

  it("يسمح لمحطتي التجزئة والاستقبال دون توسيع البوابة إلى موظف بلا محطة بيع", () => {
    expect(canUseDigitalCardsSellingStation("cashier")).toBe(true);
    expect(canUseDigitalCardsSellingStation("manager")).toBe(true);
    expect(canUseDigitalCardsSellingStation("print_operator")).toBe(true);
    expect(resolvePermissions("print_operator", undefined).digital_cards).toBe("READ");
    expect(canUseDigitalCardsSellingStation("sales_rep")).toBe(false);
    expect(canUseDigitalCardsSellingStation("warehouse")).toBe(false);
  });
});
