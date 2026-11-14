import { describe, expect, it } from "vitest";
import { createTab, itemTotal, type PosRow, type POSTab } from "./posShared";
import {
  applyPosCouponPreviewToTabs,
  capturePosCouponPreviewSnapshot,
  isPosCouponPreviewFresh,
  type PosCouponPreviewResult,
} from "./posCouponPreview";

function makePosRow(overrides: Partial<PosRow> = {}): PosRow {
  return {
    branchId: 1,
    productId: 10,
    productName: "دفتر سلك",
    variantId: 100,
    variantName: null,
    color: null,
    colorHex: null,
    size: null,
    sku: "NB-100",
    productUnitId: 1000,
    unitName: "قطعة",
    conversionFactor: "1.0000",
    barcode: "6291000001",
    isBaseUnit: true,
    price: "1000.00",
    stockBase: 50,
    reservedBase: 0,
    availableBase: 50,
    openedAt: null,
    isService: false,
    allowBackorder: false,
    isCustomizable: false,
    isPrintService: false,
    isContractPrice: false,
    isBundle: false,
    isConsignment: false,
    promotionId: null,
    promotionName: null,
    promotionDiscountForUnit: "0.00",
    promotionEffectivePrice: null,
    costPriceBase: null,
    ...overrides,
  };
}

const TEN_PCT_ON_TWO_RESULT: PosCouponPreviewResult = {
  code: "SAVE10",
  programName: "خصم 10%",
  freeShipping: false,
  freeShippingPromotionName: null,
  lines: [
    {
      productUnitId: 1000,
      promotionId: 77,
      promotionName: "خصم 10%",
      promotionDiscountForUnit: "100.00",
      promotionEffectivePrice: "900.00",
      promotionLineDiscount: "200.00",
    },
  ],
};

describe("posCouponPreview — حارس سباق معاينة الكوبون في نقطة البيع", () => {
  it("يطبق معاينة الكوبون عندما تظل السلة ومراجعة التبويب مطابقتين للقطة الطلب", () => {
    const tab: POSTab = {
      ...createTab(1),
      couponInput: "SAVE10",
      cart: [{ row: makePosRow(), qty: 2 }],
    };
    const snapshot = capturePosCouponPreviewSnapshot({
      requestSeq: 1,
      cartRevision: 3,
      tab,
      branchId: 1,
      effectiveTier: "RETAIL",
    });

    // تحديث الرصيد الدوري في الخلفية لا يبطل معاينة الكوبون ما دامت البنود والكميات ثابتة
    const tabAfterStockPoll: POSTab = {
      ...tab,
      cart: [{ row: makePosRow({ stockBase: 48, availableBase: 48 }), qty: 2 }],
    };

    expect(
      isPosCouponPreviewFresh(snapshot, {
        latestRequestSeq: 1,
        cartRevision: 3,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
        tab: tabAfterStockPoll,
      }),
    ).toBe(true);

    const updatedTabs = applyPosCouponPreviewToTabs(
      [tabAfterStockPoll],
      snapshot,
      {
        latestRequestSeq: 1,
        cartRevision: 3,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
      },
      TEN_PCT_ON_TWO_RESULT,
    );

    expect(updatedTabs[0].couponCode).toBe("SAVE10");
    expect(updatedTabs[0].couponLabel).toBe("خصم 10%");
    expect(updatedTabs[0].cart[0].cartPromo?.lineDiscount).toBe("200.00");
    expect(itemTotal(updatedTabs[0].cart[0])).toBe(1800);
  });

  it("R8-1: يهمل استجابة الكوبون المتأخرة إذا تغيرت الكمية (2 -> 4) أثناء انتظار الطلب ولا يثبت خصم 200 على 4 وحدات", () => {
    const initialTab: POSTab = {
      ...createTab(1),
      couponInput: "SAVE10",
      cart: [{ row: makePosRow(), qty: 2 }],
    };
    const snapshot = capturePosCouponPreviewSnapshot({
      requestSeq: 1,
      cartRevision: 5,
      tab: initialTab,
      branchId: 1,
      effectiveTier: "RETAIL",
    });

    // الكاشير يرفع الكمية إلى 4 قبل عودة الرد (حتى قبل اكتمال إعادة الرسم أو بعدها)
    const tabQty4: POSTab = {
      ...initialTab,
      cart: [{ row: makePosRow(), qty: 4 }],
    };

    expect(
      isPosCouponPreviewFresh(snapshot, {
        latestRequestSeq: 1,
        cartRevision: 6,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
        tab: tabQty4,
      }),
    ).toBe(false);

    // حتى لو فُحصت اللقطة داخل setTabs مع نفس رقم المراجعة الافتراضي فإن تغيّر بصمة السلة يرفض التطبيق
    const unchangedTabs = applyPosCouponPreviewToTabs(
      [tabQty4],
      snapshot,
      {
        latestRequestSeq: 1,
        cartRevision: 5,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
      },
      TEN_PCT_ON_TWO_RESULT,
    );

    expect(unchangedTabs[0]).toBe(tabQty4);
    expect(unchangedTabs[0].couponCode).toBeNull();
    expect(unchangedTabs[0].cart[0].cartPromo).toBeUndefined();
    expect(itemTotal(unchangedTabs[0].cart[0])).toBe(4000);
  });

  it("يهمل استجابة الكوبون إذا تغيرت مراجعة السلة ذهاباً وإياباً (2 -> 4 -> 2) أو تبدّل التبويب أو فئة السعر", () => {
    const tab1: POSTab = {
      ...createTab(1),
      couponInput: "SAVE10",
      cart: [{ row: makePosRow(), qty: 2 }],
    };
    const tab2: POSTab = createTab(2);
    const snapshot = capturePosCouponPreviewSnapshot({
      requestSeq: 1,
      cartRevision: 10,
      tab: tab1,
      branchId: 1,
      effectiveTier: "RETAIL",
    });

    // تغيّر المراجعة ذهاباً وإياباً (cartRevision: 12 !== 10)
    expect(
      isPosCouponPreviewFresh(snapshot, {
        latestRequestSeq: 1,
        cartRevision: 12,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
        tab: tab1,
      }),
    ).toBe(false);

    // تبديل التبويب النشط أثناء الطلب
    expect(
      isPosCouponPreviewFresh(snapshot, {
        latestRequestSeq: 1,
        cartRevision: 10,
        activeTabId: 2,
        branchId: 1,
        effectiveTier: "RETAIL",
        cartHasDigital: false,
        tab: tab2,
      }),
    ).toBe(false);

    // تغيير فئة السعر أثناء الطلب
    expect(
      isPosCouponPreviewFresh(snapshot, {
        latestRequestSeq: 1,
        cartRevision: 10,
        activeTabId: 1,
        branchId: 1,
        effectiveTier: "WHOLESALE",
        cartHasDigital: false,
        tab: tab1,
      }),
    ).toBe(false);
  });
});
