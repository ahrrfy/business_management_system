// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryOperationalIntelligenceBar } from "./DeliveryOperationalIntelligenceBar";
import type { DeliveryPartySummary } from "./DeliveryPartyExposureBadge";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DeliveryOperationalIntelligenceBar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const testParties: DeliveryPartySummary[] = [
    {
      id: 1,
      name: "مندوب السلام (أحمد)",
      partyType: "INDIVIDUAL",
      phone: "07700000001",
      userId: null,
      branchId: 1,
      defaultFee: "5000.00",
      currentBalance: "450000.00",
      floatLimit: "400000.00", // تجاوز السقف (450 > 400)
      isActive: true,
      drivers: [],
      hasPortalAccess: false,
      openConsignments: 5,
      oldestOutstanding: null,
      parcelsInTransitAmount: "450000.00",
      deliveredUncollectedAmount: "0.00",
      feesOwedAmount: "0.00",
      shortfallOwedAmount: "0.00",
      cashInHandLedger: "0.00",
      cashInHandStored: "0.00",
      cashInHandDrift: "0.00",
    },
    {
      id: 2,
      name: "شركة البراق السريع",
      partyType: "COMPANY",
      phone: "07800000002",
      userId: null,
      branchId: 1,
      defaultFee: "6000.00",
      currentBalance: "250000.00",
      floatLimit: null,
      isActive: true,
      drivers: [],
      hasPortalAccess: false,
      openConsignments: 3,
      oldestOutstanding: null,
      parcelsInTransitAmount: "250000.00",
      deliveredUncollectedAmount: "0.00",
      feesOwedAmount: "0.00",
      shortfallOwedAmount: "0.00",
      cashInHandLedger: "0.00",
      cashInHandStored: "0.00",
      cashInHandDrift: "0.00",
    },
  ];

  it("يحسب إجمالي المناديب النشطين وتوزيعهم بين داخلي وشركة", () => {
    act(() => {
      root.render(<DeliveryOperationalIntelligenceBar parties={testParties} />);
    });

    expect(host.textContent).toContain("المناديب النشطون");
    expect(host.textContent).toContain("2");
    expect(host.textContent).toContain("1 داخلي");
    expect(host.textContent).toContain("1 شركة");
  });

  it("يحسب إجمالي الطرود المفتوحة في الشارع ومجموع مبالغ COD بدقة", () => {
    act(() => {
      root.render(<DeliveryOperationalIntelligenceBar parties={testParties} />);
    });

    // 5 + 3 = 8 طرود
    expect(host.textContent).toContain("طرود قيد التوصيل");
    expect(host.textContent).toContain("8");
    expect(host.textContent).toContain("طرد مفتوح");

    // 450,000 + 250,000 = 700,000 د.ع
    expect(host.textContent).toContain("مبالغ بعهدة المناديب (COD)");
    expect(host.textContent).toContain("700,000");
  });

  it("يرصد تنبيه تجاوز سقف العهدة بدقة عند تجاوز عهدة المندوب لسقفه المحدد", () => {
    act(() => {
      root.render(<DeliveryOperationalIntelligenceBar parties={testParties} />);
    });

    expect(host.textContent).toContain("سقوف العهدة والائتمان");
    expect(host.textContent).toContain("1 تجاوز السقف");
  });
});
