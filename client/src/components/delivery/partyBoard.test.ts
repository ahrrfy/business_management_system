import { describe, expect, it } from "vitest";
import { DELIVERY_TERMS } from "@shared/deliveryTerminology";
import { PARTY_EXPOSURE_LABEL_AR } from "@shared/partyExposure";
import {
  BOARD_BUCKETS,
  BOARD_MONEY_LABEL,
  boardFlags,
  boardTotals,
  bucketColumnLabel,
  filterOutstanding,
  hubLinkFor,
  partyDetailLinkFor,
  settleLinkFor,
  sortBoardRows,
  type PartyBoardRow,
} from "./partyBoard";

const bucket = (count = 0, amount = "0.00") => ({ count, amount });
const row = (over: Partial<PartyBoardRow> = {}): PartyBoardRow => ({
  partyId: 3,
  partyName: "مندوب الكرادة",
  partyType: "INDIVIDUAL",
  assigned: bucket(),
  inTransit: bucket(),
  deliveredUnremitted: bucket(),
  returned: bucket(),
  cancelled: bucket(),
  cashInHandLedger: "0.00",
  cashInHandStored: "0.00",
  cashInHandDrift: "0.00",
  feesOwed: "0.00",
  net: "0.00",
  staleOpenParcels: 0,
  ...over,
});

describe("لوحة الخمسة أعمدة — المنطق النقيّ", () => {
  it("الأعمدة الخمسة بترتيب دورة الحياة وتسمياتها من قاموس التوصيل المشترك وحده", () => {
    expect(BOARD_BUCKETS.map((c) => c.key)).toEqual(["assigned", "inTransit", "deliveredUnremitted", "returned", "cancelled"]);
    expect(bucketColumnLabel(BOARD_BUCKETS[0]).compact).toBe(DELIVERY_TERMS.assigned.compact);
    expect(bucketColumnLabel(BOARD_BUCKETS[2])).toEqual({ compact: DELIVERY_TERMS.awaitingRemittance.compact, tooltip: DELIVERY_TERMS.awaitingRemittance.tooltip });
    expect(BOARD_MONEY_LABEL.cashInHand).toBe(PARTY_EXPOSURE_LABEL_AR.cashInHand);
    expect(BOARD_MONEY_LABEL.net).toBe(PARTY_EXPOSURE_LABEL_AR.netResponsibility);
  });

  it("الشارات: الانحراف حين يخالف الدفترُ المخزَّن، والتأخّر بعدد الطرود، والجاهزية للتسوية بنقدٍ أو مُسلَّم لم يُورَّد", () => {
    expect(boardFlags(row())).toEqual({ drift: false, stale: false, hasOpenParcels: false, settleReady: false });
    expect(boardFlags(row({ cashInHandDrift: "-250.00" })).drift).toBe(true);
    expect(boardFlags(row({ cashInHandDrift: "0.004" })).drift).toBe(false);
    expect(boardFlags(row({ staleOpenParcels: 2 })).stale).toBe(true);
    expect(boardFlags(row({ inTransit: bucket(1, "5000.00") })).hasOpenParcels).toBe(true);
    expect(boardFlags(row({ inTransit: bucket(1, "5000.00") })).settleReady).toBe(false);
    expect(boardFlags(row({ deliveredUnremitted: bucket(1, "5000.00") })).settleReady).toBe(true);
    expect(boardFlags(row({ cashInHandLedger: "1000.00" })).settleReady).toBe(true);
  });

  it("المجاميع تُشتقّ من الصفوف المعروضة وتعدّ الجهات المتأخّرة والمنحرفة", () => {
    const totals = boardTotals([
      row({ partyId: 1, assigned: bucket(2, "1000.00"), cashInHandLedger: "250.00", feesOwed: "100.00", net: "150.00", staleOpenParcels: 1 }),
      row({ partyId: 2, deliveredUnremitted: bucket(1, "7500.50"), cashInHandLedger: "7500.50", net: "7500.50", cashInHandDrift: "10.00" }),
    ]);
    expect(totals.parties).toBe(2);
    expect(totals.buckets.assigned).toEqual({ count: 2, amount: "1000.00" });
    expect(totals.buckets.deliveredUnremitted).toEqual({ count: 1, amount: "7500.50" });
    expect(totals.cashInHand).toBe("7750.50");
    expect(totals.feesOwed).toBe("100.00");
    expect(totals.net).toBe("7650.50");
    expect(totals.staleParties).toBe(1);
    expect(totals.driftParties).toBe(1);
    expect(boardTotals([]).net).toBe("0.00");
  });

  it("الروابط: العمود يفتح «قيد التوصيل» بفلتره وبحث الجهة، والتسوية والتفاصيل بمعرّف الجهة", () => {
    const r = row({ partyName: "شركة النقل" });
    expect(hubLinkFor(r, BOARD_BUCKETS[1])).toBe("/delivery?tab=transit&q=%D8%B4%D8%B1%D9%83%D8%A9+%D8%A7%D9%84%D9%86%D9%82%D9%84&view=IN_TRANSIT");
    expect(hubLinkFor(r, { ...BOARD_BUCKETS[0], view: null })).not.toContain("view=");
    expect(settleLinkFor(r)).toBe("/delivery?tab=settle&party=3");
    expect(partyDetailLinkFor(r)).toBe("/delivery?tab=parties&detail=3");
  });

  it("الترتيب التشغيليّ: المتأخّرة أوّلاً ثمّ الأعلى صافياً، والفلتر يُبقي ما له ذمّة أو طرود مفتوحة", () => {
    const a = row({ partyId: 1, partyName: "أ", net: "100.00" });
    const b = row({ partyId: 2, partyName: "ب", net: "900.00" });
    const c = row({ partyId: 3, partyName: "ج", net: "50.00", staleOpenParcels: 1, inTransit: bucket(1, "50.00") });
    expect(sortBoardRows([a, b, c]).map((r) => r.partyId)).toEqual([3, 2, 1]);
    const idle = row({ partyId: 9 });
    const owed = row({ partyId: 8, feesOwed: "1500.00" });
    expect(filterOutstanding([idle, owed, c]).map((r) => r.partyId)).toEqual([8, 3]);
  });
});
