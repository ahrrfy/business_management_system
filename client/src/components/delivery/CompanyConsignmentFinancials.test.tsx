import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanyConsignmentFinancials } from "./CompanyConsignmentFinancials";

describe("company consignment mobile financial parity", () => {
  it("retains each settlement amount, movement date and remittance reference", () => {
    const html = renderToStaticMarkup(
      <CompanyConsignmentFinancials
        row={{
          codAmount: "123456",
          collectedAmount: "23000",
          counterSettledAmount: "3400",
          shortfallAssigned: "450",
          deliveryFee: "5600",
          dispatchedAt: new Date("2026-10-01T12:00:00Z"),
          courierDeliveredAt: new Date("2026-10-02T12:00:00Z"),
          remittanceNumber: "REM-77",
        }}
      />,
    );
    for (const value of [
      "123,456",
      "23,000",
      "3,400",
      "450",
      "5,600",
      "REM-77",
    ]) {
      expect(html).toContain(value);
    }
    for (const label of [
      "قيمة COD",
      "سوي بالتوريد",
      "سوي في المكتبة",
      "عجز محمل",
      "أجرة التوصيل",
      "الإرسال",
      "الوصول للعميل",
      "التوريد",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("01/10/2026");
    expect(html).toContain("02/10/2026");
  });
  it("keeps missing dates and references distinct from actual values", () => {
    const html = renderToStaticMarkup(
      <CompanyConsignmentFinancials
        row={{
          codAmount: "0",
          collectedAmount: "0",
          counterSettledAmount: "0",
          shortfallAssigned: "0",
          deliveryFee: "0",
          dispatchedAt: null,
          courierDeliveredAt: null,
          remittanceNumber: null,
        }}
      />,
    );
    expect(html.match(/>—<\/dd>/g)).toHaveLength(3);
    expect(html).not.toContain("Invalid Date");
  });
});
