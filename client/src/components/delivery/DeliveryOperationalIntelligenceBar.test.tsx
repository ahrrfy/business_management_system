// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryOperationalIntelligenceBar } from "./DeliveryOperationalIntelligenceBar";
import {
  formatPartyObligationOptionLabel,
  type DeliveryPartySummary,
} from "./DeliveryPartyExposureBadge";

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

  it("يدمج النقد بيد المندوب مع الطرود بالطريق ضمن إجمالي COD المفتوح ويفصل بينهما", () => {
    const mixedParties: DeliveryPartySummary[] = [
      {
        ...testParties[0]!,
        id: 10,
        name: "ابراهيم احمد",
        currentBalance: "143000.00",
        cashInHandStored: "143000.00",
        parcelsInTransitAmount: "72000.00",
        openConsignments: 17,
        floatLimit: "200000.00",
      },
    ];
    act(() => {
      root.render(<DeliveryOperationalIntelligenceBar parties={mixedParties} />);
    });

    // 143,000 + 72,000 = 215,000 د.ع (يتجاوز السقف 200,000)
    expect(host.textContent).toContain("215,000");
    expect(host.textContent).toContain("نقد بيده: 143,000");
    expect(host.textContent).toContain("بالطريق: 72,000");
    expect(host.textContent).toContain("1 تجاوز السقف");
  });

  it("يوحّد صياغة خيار الجهة في القوائم المنسدلة بين التحصيل بالباركود وتسوية الجهات", () => {
    expect(
      formatPartyObligationOptionLabel("ابراهيم احمد", "مندوب", {
        currentBalance: "143000.00",
        parcelsInTransitAmount: "72000.00",
        deliveredUncollectedAmount: "0.00",
        codDueTotal: "215000.00",
      }),
    ).toBe(
      "ابراهيم احمد (مندوب) — نقد بيده: 143,000 · بالطريق: 72,000 د.ع (إجمالي 215,000)",
    );

    expect(
      formatPartyObligationOptionLabel("احمد صبار حسن", "مندوب", {
        currentBalance: "0.00",
        parcelsInTransitAmount: "85750.00",
        deliveredUncollectedAmount: "0.00",
        codDueTotal: "85750.00",
      }),
    ).toBe("احمد صبار حسن (مندوب) — طرود بالطريق: 85,750 د.ع (نقد بيده: 0)");
  });
});
