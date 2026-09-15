import { describe, expect, it } from "vitest";
import { correctionLookupBlockReason } from "../sale/correctionLookup";

const eligible = {
  status: "PAID",
  sourceType: "POS",
  returnedTotal: "0.00",
  correctedByInvoiceId: null,
  itemCount: 2,
  hasDigitalCards: false,
  hasActiveInstallmentPlan: false,
  consignmentStatus: null,
  consignmentParcelStatus: null,
  consignmentMoneyStatus: null,
  onlineOrderStatus: null,
};

describe("correctionLookupBlockReason", () => {
  it("يسمح بالفاتورة العادية ويمنع الحقائق التي لا يمكن عكسها بأمان", () => {
    expect(correctionLookupBlockReason(eligible)).toBeNull();
    expect(correctionLookupBlockReason({ ...eligible, status: "SUPERSEDED" })).toMatch(/استُبدلت/);
    expect(correctionLookupBlockReason({ ...eligible, returnedTotal: "10.00" })).toMatch(/مرتجع/);
    expect(correctionLookupBlockReason({ ...eligible, hasDigitalCards: true })).toMatch(/رقمية/);
    expect(correctionLookupBlockReason({ ...eligible, hasActiveInstallmentPlan: true })).toMatch(/أقساط/);
  });

  it("لا يسمح بالتعديل أثناء عهدة التوصيل ويسمح بعد إلغائها نهائياً", () => {
    expect(correctionLookupBlockReason({
      ...eligible,
      consignmentStatus: "DISPATCHED",
      consignmentParcelStatus: "OUT_FOR_DELIVERY",
      consignmentMoneyStatus: "UNSETTLED",
    })).toMatch(/التوصيل/);
    expect(correctionLookupBlockReason({
      ...eligible,
      consignmentStatus: "CANCELLED",
      consignmentParcelStatus: "CANCELLED",
      consignmentMoneyStatus: "CANCELLED",
    })).toBeNull();
  });
});
