import { describe, expect, it } from "vitest";
import {
  assessUnitCostAnomaly,
  assessUsdRateSanity,
  balanceDirectionLabel,
  buildBalanceTrailSnapshot,
} from "./balanceTrail";

describe("balanceTrail", () => {
  it("computes Karwan supplier payment snapshot accurately (470,834 + 4,237,000 - 3,055,000 = 1,652,834)", () => {
    const snap = buildBalanceTrailSnapshot({
      partyType: "SUPPLIER",
      before: "4707834.00",
      debit: "3055000.00",
    });
    expect(snap.before).toBe("4707834.00");
    expect(snap.debit).toBe("3055000.00");
    expect(snap.after).toBe("1652834.00");
    expect(snap.beforeDirectionLabel).toBe("له علينا");
    expect(snap.afterDirectionLabel).toBe("له علينا");

    const overpaid = buildBalanceTrailSnapshot({
      partyType: "SUPPLIER",
      before: "1000000.00",
      debit: "1500000.00",
    });
    expect(overpaid.after).toBe("-500000.00");
    expect(overpaid.afterAbs).toBe("500000.00");
    expect(overpaid.afterDirectionLabel).toBe("لنا عليه");
  });

  it("reverses polarity cleanly for customers (AR)", () => {
    expect(balanceDirectionLabel("CUSTOMER", "50000")).toBe("لنا عليه");
    expect(balanceDirectionLabel("CUSTOMER", "-50000")).toBe("له علينا");
    const snap = buildBalanceTrailSnapshot({
      partyType: "CUSTOMER",
      before: "250000.00",
      credit: "300000.00",
    });
    expect(snap.after).toBe("-50000.00");
    expect(snap.afterDirectionLabel).toBe("له علينا");
  });

  it("catches missing-zero exchange rate bug (169 vs 1,690) and sharp cost drops", () => {
    const anomalous = assessUsdRateSanity("169", "1490");
    expect(anomalous.status).toBe("ANOMALOUS");
    expect(anomalous.suggestedRate).toBe("1690");

    expect(assessUsdRateSanity("1500", "1490").status).toBe("OK");
    expect(assessUsdRateSanity("2100", "1490").status).toBe("WARN");

    const drop = assessUnitCostAnomaly("304200", "3042000", "كابسة ورق");
    expect(drop.isAnomalous).toBe(true);
    expect(drop.kind).toBe("SHARP_DROP");
  });
});
