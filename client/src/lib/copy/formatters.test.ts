import { describe, expect, it } from "vitest";
import {
  deriveWorkOrderCopyRemaining,
  formatWorkOrderAsWhatsApp,
  formatZReportAsText,
} from "./formatters";

describe("copy formatters", () => {
  it("derives expected cash for an open shift", () => {
    const text = formatZReportAsText({
      shiftId: 7,
      opened: "2026-09-17T08:00:00.000Z",
      openingFloat: "1000",
      cashIn: "400",
      cashOut: "150",
      expectedCash: null,
    });

    expect(text).toContain("1,250");
  });

  it("includes the deposit and remaining balance in a work-order copy", () => {
    const text = formatWorkOrderAsWhatsApp({
      number: "WO-7",
      total: "100000",
      deposit: "25000",
      remaining: "75000",
    });

    expect(text).toContain("25,000");
    expect(text).toContain("75,000");
  });

  it("uses linked invoice payments after delivery", () => {
    expect(deriveWorkOrderCopyRemaining({
      status: "DELIVERED",
      invoiceId: 11,
      salePrice: "100000",
      deposit: "25000",
      invoiceTotal: "100000",
      invoicePaidAmount: "100000",
      invoiceReturnedTotal: "0",
    })).toBe("0");

    expect(deriveWorkOrderCopyRemaining({
      status: "DELIVERED",
      invoiceId: 12,
      salePrice: "100000",
      deposit: "25000",
      invoiceTotal: "100000",
      invoicePaidAmount: "60000",
      invoiceReturnedTotal: "10000",
    })).toBe("30000");
  });
});
