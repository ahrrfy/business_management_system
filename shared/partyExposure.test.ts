import { describe, it, expect } from "vitest";
import {
  computePartyExposure,
  PARTY_EXPOSURE_LABEL_AR,
  PARTY_EXPOSURE_COLOR_TOKEN,
  type PartyExposureParcelSnapshot,
  type PartyExposureLedgerEntry,
} from "./partyExposure";

const mkParcel = (over: Partial<PartyExposureParcelSnapshot> = {}): PartyExposureParcelSnapshot => ({
  parcelStatus: "ASSIGNED",
  moneyStatus: "UNSETTLED",
  codAmount: "0",
  collectedAmount: "0",
  counterSettledAmount: null,
  ...over,
});

const mkLedger = (over: Partial<PartyExposureLedgerEntry> = {}): PartyExposureLedgerEntry => ({
  entryType: "COD_ASSIGNED",
  amount: "0",
  ...over,
});

describe("computePartyExposure — العمود ١: نقد بيده", () => {
  it("يعكس currentBalance حرفياً (لا حساب)", () => {
    const r = computePartyExposure({ cashInHand: "12500.5", parcels: [], ledger: [] });
    expect(r.cashInHand).toBe("12500.50");
  });

  it("صفر إن كان الرصيد فارغاً", () => {
    const r = computePartyExposure({ cashInHand: 0, parcels: [], ledger: [] });
    expect(r.cashInHand).toBe("0.00");
  });

  it("لا ينخدع بقيمة نصّيّة غير رقميّة", () => {
    const r = computePartyExposure({ cashInHand: "abc" as never, parcels: [], ledger: [] });
    expect(r.cashInHand).toBe("0.00");
  });
});

describe("computePartyExposure — العمود ٢: طرود بالطريق", () => {
  it("يجمع codAmount للطرود ASSIGNED", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "ASSIGNED", codAmount: "10000" }),
        mkParcel({ parcelStatus: "ASSIGNED", codAmount: "25000" }),
      ],
      ledger: [],
    });
    expect(r.parcelsInTransit).toBe("35000.00");
  });

  it("يشمل OUT_FOR_DELIVERY أيضاً", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "ASSIGNED", codAmount: "10000" }),
        mkParcel({ parcelStatus: "OUT_FOR_DELIVERY", codAmount: "5000" }),
      ],
      ledger: [],
    });
    expect(r.parcelsInTransit).toBe("15000.00");
  });

  it("يستبعد DELIVERED / FAILED / RETURNED / CANCELLED", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "DELIVERED", codAmount: "100000" }),
        mkParcel({ parcelStatus: "FAILED", codAmount: "50000" }),
        mkParcel({ parcelStatus: "RETURNED", codAmount: "30000" }),
        mkParcel({ parcelStatus: "CANCELLED", codAmount: "20000" }),
      ],
      ledger: [],
    });
    expect(r.parcelsInTransit).toBe("0.00");
  });
});

describe("computePartyExposure — العمود ٣: سُلِّم لم يُحصَّل", () => {
  it("يجمع المتبقّي للطرود DELIVERED مع moneyStatus UNSETTLED/PARTIAL", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "UNSETTLED", codAmount: "10000", collectedAmount: "0" }),
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "PARTIAL", codAmount: "20000", collectedAmount: "5000" }),
      ],
      ledger: [],
    });
    // 10000 + (20000 − 5000) = 25000
    expect(r.deliveredUncollected).toBe("25000.00");
  });

  it("يخصم counterSettledAmount من المتبقّي", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "PARTIAL", codAmount: "10000", collectedAmount: "3000", counterSettledAmount: "2000" }),
      ],
      ledger: [],
    });
    // 10000 − 3000 − 2000 = 5000
    expect(r.deliveredUncollected).toBe("5000.00");
  });

  it("يستبعد SETTLED (سُدِّد كاملاً)", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "SETTLED", codAmount: "10000", collectedAmount: "10000" }),
      ],
      ledger: [],
    });
    expect(r.deliveredUncollected).toBe("0.00");
  });

  it("لا يعطي متبقٍّ سالباً (over-collection يُعامَل صفراً في هذا العمود)", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "PARTIAL", codAmount: "10000", collectedAmount: "12000" }),
      ],
      ledger: [],
    });
    expect(r.deliveredUncollected).toBe("0.00");
  });

  it("يستبعد الطرود ASSIGNED من هذا العمود (تنتمي للعمود ٢)", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [
        mkParcel({ parcelStatus: "ASSIGNED", codAmount: "10000" }),
      ],
      ledger: [],
    });
    expect(r.deliveredUncollected).toBe("0.00");
  });
});

describe("computePartyExposure — العمود ٤: أجور مستحقّة له", () => {
  it("FEE_EARNED يزيد الأجور", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "3000" }),
        mkLedger({ entryType: "FEE_EARNED", amount: "2000" }),
      ],
    });
    expect(r.feesOwedToThem).toBe("5000.00");
  });

  it("FEE_PAID و FEE_OFFSET يخصمان من الأجور", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "10000" }),
        mkLedger({ entryType: "FEE_PAID", amount: "3000" }),
        mkLedger({ entryType: "FEE_OFFSET", amount: "2000" }),
      ],
    });
    expect(r.feesOwedToThem).toBe("5000.00");
  });

  it("FEE_REFUNDED يخصم أيضاً", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "5000" }),
        mkLedger({ entryType: "FEE_REFUNDED", amount: "2000" }),
      ],
    });
    expect(r.feesOwedToThem).toBe("3000.00");
  });

  it("لا يعطي أجراً سالباً (الفائض يُقصّ عند صفر لأنّ الجهة لا تدين لنا بأجر مقصوصاً)", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "1000" }),
        mkLedger({ entryType: "FEE_PAID", amount: "5000" }), // زائد عن المستحقّ
      ],
    });
    expect(r.feesOwedToThem).toBe("0.00");
  });

  it("يتجاهل قيود COD_* في احتساب الأجور", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "COD_ASSIGNED", amount: "50000" }),
        mkLedger({ entryType: "COD_COLLECTED", amount: "50000" }),
        mkLedger({ entryType: "COD_REMITTED", amount: "50000" }),
        mkLedger({ entryType: "FEE_EARNED", amount: "3000" }),
      ],
    });
    expect(r.feesOwedToThem).toBe("3000.00");
  });
});

describe("computePartyExposure — صافي المسؤوليّة (الحسبة النهائيّة)", () => {
  it("net = cash + in_transit + delivered_uncollected − fees_owed", () => {
    const r = computePartyExposure({
      cashInHand: "15000",
      parcels: [
        mkParcel({ parcelStatus: "ASSIGNED", codAmount: "20000" }),
        mkParcel({ parcelStatus: "DELIVERED", moneyStatus: "PARTIAL", codAmount: "10000", collectedAmount: "3000" }),
      ],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "5000" }),
        mkLedger({ entryType: "FEE_PAID", amount: "2000" }),
      ],
    });
    // 15000 + 20000 + 7000 − 3000 = 39000
    expect(r.cashInHand).toBe("15000.00");
    expect(r.parcelsInTransit).toBe("20000.00");
    expect(r.deliveredUncollected).toBe("7000.00");
    expect(r.feesOwedToThem).toBe("3000.00");
    expect(r.netResponsibility).toBe("39000.00");
  });

  it("net قد يكون سالباً إن كانت أجور المندوب أكبر من مسؤوليّته الأخرى", () => {
    const r = computePartyExposure({
      cashInHand: 0,
      parcels: [],
      ledger: [
        mkLedger({ entryType: "FEE_EARNED", amount: "10000" }),
      ],
    });
    expect(r.netResponsibility).toBe("-10000.00");
  });

  it("جهةٌ فارغةٌ تماماً: كلّ الأعمدة صفر", () => {
    const r = computePartyExposure({ cashInHand: 0, parcels: [], ledger: [] });
    expect(r.cashInHand).toBe("0.00");
    expect(r.parcelsInTransit).toBe("0.00");
    expect(r.deliveredUncollected).toBe("0.00");
    expect(r.feesOwedToThem).toBe("0.00");
    expect(r.netResponsibility).toBe("0.00");
  });
});

describe("قواميس التسميات + الألوان", () => {
  it("تسميات الأعمدة موجودة ومجمَّدة", () => {
    expect(Object.isFrozen(PARTY_EXPOSURE_LABEL_AR)).toBe(true);
    expect(PARTY_EXPOSURE_LABEL_AR.cashInHand).toBe("نقد بيده");
    expect(PARTY_EXPOSURE_LABEL_AR.parcelsInTransit).toBe("طرود بالطريق");
    expect(PARTY_EXPOSURE_LABEL_AR.deliveredUncollected).toBe("سُلِّم لم يُحصَّل");
    expect(PARTY_EXPOSURE_LABEL_AR.feesOwedToThem).toBe("أجور مستحقّة له");
    expect(PARTY_EXPOSURE_LABEL_AR.netResponsibility).toBe("صافي المسؤوليّة");
  });

  it("توكينات ألوان الأعمدة موجودة ومجمَّدة", () => {
    expect(Object.isFrozen(PARTY_EXPOSURE_COLOR_TOKEN)).toBe(true);
    expect(PARTY_EXPOSURE_COLOR_TOKEN.deliveredUncollected).toBe("danger");
    expect(PARTY_EXPOSURE_COLOR_TOKEN.parcelsInTransit).toBe("warning");
    expect(PARTY_EXPOSURE_COLOR_TOKEN.netResponsibility).toBe("primary");
  });
});
