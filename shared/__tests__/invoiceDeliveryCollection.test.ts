import { describe, expect, it } from "vitest";
import {
  invoiceDeliveryCollection,
  isInvoiceCodInTransit,
} from "../invoiceDeliveryCollection";

describe("invoice delivery collection policy", () => {
  it("keeps credit debt separate from the courier fee (invoice 101567)", () => {
    expect(
      invoiceDeliveryCollection({
        paymentMode: "CREDIT",
        remainingAmount: "5000",
        fee: "5000",
        feeCollection: "COURIER",
      }),
    ).toEqual({
      goodsDue: "0.00",
      creditDue: "5000.00",
      feeDue: "5000.00",
      atDoorDue: "5000.00",
    });
    expect(
      isInvoiceCodInTransit({
        paymentMode: "CREDIT",
        consignmentStatus: "DISPATCHED",
      }),
    ).toBe(false);
  });

  it("collects current COD goods plus the courier fee once", () => {
    expect(
      invoiceDeliveryCollection({
        paymentMode: "COD",
        remainingAmount: "5000.10",
        fee: "5000.20",
        feeCollection: "COURIER",
      }),
    ).toEqual({
      goodsDue: "5000.10",
      creditDue: "0.00",
      feeDue: "5000.20",
      atDoorDue: "10000.30",
    });
    expect(
      isInvoiceCodInTransit({
        paymentMode: "COD",
        consignmentStatus: "PARTIAL",
      }),
    ).toBe(true);
    expect(
      isInvoiceCodInTransit({
        paymentMode: "PREPAID",
        consignmentStatus: "DISPATCHED",
      }),
    ).toBe(false);
    expect(isInvoiceCodInTransit({ paymentMode: "PREPAID", consignmentStatus: "DISPATCHED", consignmentCodAmount: "1000" })).toBe(true);
  });

  it.each(["COUNTER", "SHOP"] as const)(
    "does not charge a %s fee to the customer again",
    (feeCollection) => {
      expect(
        invoiceDeliveryCollection({
          paymentMode: "CREDIT",
          remainingAmount: "5000",
          fee: "5000",
          feeCollection,
        }).atDoorDue,
      ).toBe("0.00");
    },
  );

  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"])(
    "does not collect on a %s invoice",
    (status) => {
      expect(
        invoiceDeliveryCollection({
          status,
          paymentMode: "CREDIT",
          remainingAmount: "5000",
          fee: "5000",
          feeCollection: "COURIER",
        }),
      ).toEqual({
        goodsDue: "0.00",
        creditDue: "0.00",
        feeDue: "0.00",
        atDoorDue: "0.00",
      });
      expect(
        isInvoiceCodInTransit({
          status,
          paymentMode: "COD",
          consignmentStatus: "DISPATCHED",
        }),
      ).toBe(false);
    },
  );
});
