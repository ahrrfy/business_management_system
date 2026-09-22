import { describe, expect, it } from "vitest";

import { parseInvoiceSourcePayload } from "../intentSchemas";

function payload(dueDate: string) {
  return {
    branchId: 1,
    shiftId: 1,
    priceTier: "RETAIL" as const,
    clientRequestId: "calendar-date-request",
    dueDate,
    lines: [
      {
        variantId: 1,
        productUnitId: 1,
        quantity: "1",
      },
    ],
  };
}

describe("digital invoice due-date calendar validation", () => {
  it("يقبل يوم الكبيسة الصحيح", () => {
    expect(parseInvoiceSourcePayload(payload("2028-02-29")).dueDate).toBe(
      "2028-02-29",
    );
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "0999-12-31"])(
    "يرفض التاريخ غير الموجود تقويمياً %s",
    (dueDate) => {
      expect(() => parseInvoiceSourcePayload(payload(dueDate))).toThrow(
        /تاريخ الاستحقاق غير صالح/,
      );
    },
  );
});
