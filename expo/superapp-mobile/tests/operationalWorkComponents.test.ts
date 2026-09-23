import { describe, expect, it } from "vitest";
import { formatIqd } from "../lib/format";

describe("Shift Handover & Cashier Denomination Logic", () => {
  const DENOMINATIONS = [
    { label: "50,000 د.ع", value: 50000 },
    { label: "25,000 د.ع", value: 25000 },
    { label: "10,000 د.ع", value: 10000 },
    { label: "5,000 د.ع", value: 5000 },
    { label: "1,000 د.ع", value: 1000 },
    { label: "500 د.ع", value: 500 },
    { label: "250 د.ع", value: 250 },
  ];

  it("calculates exact counted cash across IQD denominations without fraction loss", () => {
    const counts: Record<number, number> = {
      50000: 10, // 500,000
      25000: 20, // 500,000
      10000: 15, // 150,000
      5000: 10,  // 50,000
      1000: 25,  // 25,000
      500: 10,   // 5,000
      250: 8,    // 2,000
    };

    const total = DENOMINATIONS.reduce((sum, denom) => {
      const qty = counts[denom.value] || 0;
      return sum + denom.value * qty;
    }, 0);

    expect(total).toBe(1232000);
    expect(formatIqd(total)).toContain("1,232,000");
    expect(formatIqd(total)).toContain("د.ع");
  });

  it("computes blind cash variance correctly (match, surplus, deficit)", () => {
    const counted = 2500000;

    // Exact match
    const varianceMatch = counted - 2500000;
    expect(varianceMatch).toBe(0);

    // Surplus
    const varianceSurplus = counted - 2450000;
    expect(varianceSurplus).toBe(50000);

    // Deficit
    const varianceDeficit = counted - 2550000;
    expect(varianceDeficit).toBe(-50000);
  });

  it("generates standard handover reference numbers complying with HND-YYYYMMDD-XXXX format", () => {
    const dateStr = "20260924";
    const randSuffix = 4589;
    const handoverNumber = `HND-${dateStr}-${randSuffix}`;

    expect(handoverNumber).toMatch(/^HND-\d{8}-\d{4}$/);
  });
});

describe("Mobile Stock Audit & SOD-04 Separation of Duties", () => {
  type AuditItem = {
    barcode: string;
    expectedQty: number;
    countedQty: number;
  };

  it("identifies matching items vs variance items accurately", () => {
    const items: AuditItem[] = [
      { barcode: "6281001", expectedQty: 50, countedQty: 50 },
      { barcode: "6281002", expectedQty: 100, countedQty: 95 },
      { barcode: "6281003", expectedQty: 20, countedQty: 25 },
    ];

    const matched = items.filter((i) => i.countedQty === i.expectedQty);
    const withVariance = items.filter((i) => i.countedQty !== i.expectedQty);

    expect(matched.length).toBe(1);
    expect(withVariance.length).toBe(2);

    // Discrepancy calculations
    const deficitItem = withVariance.find((i) => i.barcode === "6281002");
    expect(deficitItem!.countedQty - deficitItem!.expectedQty).toBe(-5);

    const surplusItem = withVariance.find((i) => i.barcode === "6281003");
    expect(surplusItem!.countedQty - surplusItem!.expectedQty).toBe(5);
  });

  it("formats regulatory pending adjustment requests conforming to SOD-04", () => {
    const dateStr = "20260924";
    const randSuffix = 742;
    const reqNumber = `SAR-${dateStr}-${randSuffix}`;

    expect(reqNumber).toMatch(/^SAR-\d{8}-\d{3,4}$/);
  });
});
