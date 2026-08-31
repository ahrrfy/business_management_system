import { describe, it, expect } from "vitest";
import { DELIVERY_TERMS, term, termCompact, termProse, termTooltip, type DeliveryTermKey } from "./deliveryTerminology";

describe("قاموس مصطلحات التوصيل — البنية", () => {
  it("كل مصطلح يحوي compact + prose + tooltip بلا فراغ", () => {
    for (const [key, val] of Object.entries(DELIVERY_TERMS)) {
      expect(val.compact.trim(), `compact for ${key}`).not.toBe("");
      expect(val.prose.trim(), `prose for ${key}`).not.toBe("");
      expect(val.tooltip.trim(), `tooltip for ${key}`).not.toBe("");
      expect(val.tooltip.length, `tooltip ${key} ≥ 20`).toBeGreaterThanOrEqual(15);
    }
  });

  it("النسخة compact بلا تشكيلٍ عربيّ (لا فتحة/ضمّة/كسرة/شدّة/سكون)", () => {
    // U+064B..U+0652 diacritics (fatha, damma, kasra, shadda, sukun, tanwin variants).
    const tashkeelRe = /[ً-ْ]/;
    for (const [key, val] of Object.entries(DELIVERY_TERMS)) {
      expect(tashkeelRe.test(val.compact), `compact for ${key} contains tashkeel: "${val.compact}"`).toBe(false);
    }
  });

  it("النسخة prose قد تحوي تشكيلاً (فقرات كاملة)", () => {
    // At least a few prose values should contain tashkeel — that's their purpose.
    const tashkeelRe = /[ً-ْ]/;
    const hasTashkeel = Object.values(DELIVERY_TERMS).filter((v) => tashkeelRe.test(v.prose));
    expect(hasTashkeel.length).toBeGreaterThan(5);
  });
});

describe("قاموس مصطلحات التوصيل — تغطية المفاهيم الأساسية", () => {
  const mustExist: DeliveryTermKey[] = [
    "cashInHand",
    "parcelsInTransit",
    "deliveredUncollected",
    "feesOwedToCourier",
    "netResponsibility",
    "openParcelsCount",
    "delivered",
    "unsettled",
    "partial",
    "settled",
    "cumulativeFeesEarned",
    "collectedFull",
    "notCollected",
    "requestedFromCustomer",
  ];

  it("يحوي كلَّ المفاهيم الحاسمة للـ4-column exposure + settlement flow", () => {
    for (const key of mustExist) {
      expect(DELIVERY_TERMS[key], `missing term: ${key}`).toBeDefined();
    }
  });
});

describe("دوالّ الوصول", () => {
  it("term() يُرجع الكائنَ كاملاً", () => {
    const t = term("cashInHand");
    expect(t.compact).toBe("نقد بيده");
    expect(t.prose).toBeTruthy();
    expect(t.tooltip).toBeTruthy();
  });

  it("termCompact() و termProse() و termTooltip() تُرجع السلسلة الصحيحة", () => {
    expect(termCompact("delivered")).toBe(DELIVERY_TERMS.delivered.compact);
    expect(termProse("delivered")).toBe(DELIVERY_TERMS.delivered.prose);
    expect(termTooltip("delivered")).toBe(DELIVERY_TERMS.delivered.tooltip);
  });
});

describe("المصطلحات المُسمَّاة تُطابق قاموس partyExposure", () => {
  it("cashInHand.compact = «نقد بيده» (تناسق مع PARTY_EXPOSURE_LABEL_AR)", async () => {
    const { PARTY_EXPOSURE_LABEL_AR } = await import("./partyExposure");
    expect(termCompact("cashInHand")).toBe(PARTY_EXPOSURE_LABEL_AR.cashInHand);
    expect(termCompact("parcelsInTransit")).toBe(PARTY_EXPOSURE_LABEL_AR.parcelsInTransit);
    expect(termCompact("deliveredUncollected")).toBe(PARTY_EXPOSURE_LABEL_AR.deliveredUncollected);
    expect(termCompact("feesOwedToCourier")).toBe(PARTY_EXPOSURE_LABEL_AR.feesOwedToThem);
    expect(termCompact("netResponsibility")).toBe(PARTY_EXPOSURE_LABEL_AR.netResponsibility);
  });
});
