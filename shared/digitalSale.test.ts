import { describe, expect, it } from "vitest";
import { DIGITAL_BASKET_REFERENCE_LABEL, digitalOfferingDescription, normalizeDigitalSaleReference } from "./digitalSale";

describe("digital basket customer descriptions", () => {
  it("keeps a single operation label for mixed offering types", () => {
    expect(DIGITAL_BASKET_REFERENCE_LABEL).toBe("رقم عملية المزود للسلة");
    expect(normalizeDigitalSaleReference("  ABC 123 \n")).toBe("ABC123");
  });
  it("shows face value and subscription duration without private accounting fields", () => {
    expect(digitalOfferingDescription({ offeringType: "TELECOM_CARD", faceValue: "15000.00" }))
      .toBe("بطاقة اتصالات · القيمة الاسمية: 15000.00");
    expect(digitalOfferingDescription({ offeringType: "EDUCATIONAL_SUBSCRIPTION", subscriptionDurationDays: 30 }))
      .toBe("اشتراك تعليمي · المدة: 30 يوم");
    expect(digitalOfferingDescription({})).toBe("بطاقة رقمية");
  });
});
