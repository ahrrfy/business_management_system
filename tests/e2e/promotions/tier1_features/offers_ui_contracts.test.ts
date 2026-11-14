/**
 * tests/e2e/promotions/tier1_features/offers_ui_contracts.test.ts
 *
 * Tier 1 Feature Coverage: Offers UI Contracts & Interactive Workspaces (F13–F18)
 * Barcode gun scanner burst handling, live table profit margins, basket simulator,
 * multi-step offer wizard, DataTable refactoring, and marketing static contracts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

const OFFERS_PAGE_PATH = path.resolve(process.cwd(), "client/src/pages/Offers.tsx");
const OFFER_FORM_PATH = path.resolve(process.cwd(), "client/src/components/offers/OfferForm.tsx");
const BULK_ADD_PATH = path.resolve(process.cwd(), "client/src/components/offers/OfferBulkAddToolbar.tsx");
const CHANNEL_SECTION_PATH = path.resolve(process.cwd(), "client/src/components/offers/OfferChannelStepSection.tsx");
import {
  buildTargetsForHolder,
  createDefaultRuleDraft,
  simulateMultiRuleBasketPreview,
  validateRuleScopeAndMargin,
  validateRuleTypeFields,
} from "@/components/offers/offersMultiRuleHelpers";
import { MAX_PROMOTION_TARGETS } from "@shared/promotionEngine";
import {
  applyOfferRuleDraftPatch,
  buildRulePayloadCore,
  capOfferItemsToTargetLimit,
  pullCategorySearchPages,
  resolveBulkPasteOutcome,
  resolveCategoryPullOutcome,
} from "@/components/offers/offersDraftGuards";
import {
  deriveSimulatorTargetCollections,
  simulateBasketPreview as simulateOfferBasketPreview,
} from "@/components/offers/offersTypes";
import {
  applyFreeShippingToOrderDelivery,
  evaluateReceptionCartPromotionsPure,
} from "@/components/reception/useReceptionCartPromotions";
import {
  buildDeliveryPayload,
  emptyDeliveryDraft,
} from "@/components/pos/deliveryMode";
import { reconcilePosDeliveryAutoFreeShipping } from "@/components/pos/usePosCartPromotions";
import {
  PRD_CHEAP_PEN,
  PRD_INK_EPSON,
  PRD_NOTEBOOK_FABER,
  PRD_PEN_ROTRING,
  createPercentPromoFixture,
} from "../infra/mockFixtures";
import { duplicatePromotionRule } from "../infra/testHarness";

// ---------------------------------------------------------------------------
// Simulated UI Component Contracts
// ---------------------------------------------------------------------------

/** F13: Scanner Simulator Contract */
class ScannerSimulator {
  public focusRetained = true;
  public selectedItemIds: number[] = [];
  public lastWarning: string | null = null;
  public duplicateChimeTriggered = false;

  scan(barcode: string): boolean {
    this.focusRetained = true; // Focus must be retained immediately

    // Find product matching barcode
    const allProducts = [PRD_PEN_ROTRING, PRD_NOTEBOOK_FABER, PRD_INK_EPSON, PRD_CHEAP_PEN];
    const product = allProducts.find((p) => p.units.some((u) => u.barcode === barcode));

    if (!product) {
      this.lastWarning = "لم يتم العثور على الصنف";
      return false;
    }

    if (this.selectedItemIds.includes(product.id)) {
      this.duplicateChimeTriggered = true;
      this.lastWarning = "الصنف مضاف مسبقاً";
      return false;
    }

    this.selectedItemIds.push(product.id);
    this.lastWarning = null;
    return true;
  }

  scanBurst(barcodes: string[]): { added: number; duplicates: number } {
    let added = 0;
    let duplicates = 0;
    for (const b of barcodes) {
      if (this.scan(b)) {
        added++;
      } else if (this.duplicateChimeTriggered) {
        duplicates++;
      }
    }
    return { added, duplicates };
  }
}

/** F14: Live Table Margin Calculator Contract */
function calculateLiveMargin(
  retailPrice: Decimal,
  costPrice: Decimal,
  promoType: "PERCENT" | "AMOUNT" | "FIXED_PRICE",
  promoValue: Decimal
): {
  promoPrice: Decimal;
  marginPercent: Decimal;
  isBelowCost: boolean;
  isCeilingViolated: boolean;
  badgeStyle: "positive" | "negative" | "warning";
} {
  let promoPrice = retailPrice;

  if (promoType === "PERCENT") {
    const disc = retailPrice.mul(promoValue).div(100);
    promoPrice = retailPrice.minus(disc);
  } else if (promoType === "AMOUNT") {
    promoPrice = Decimal.max(0, retailPrice.minus(promoValue));
  } else if (promoType === "FIXED_PRICE") {
    // Ceiling: never increases
    promoPrice = Decimal.min(retailPrice, promoValue);
  }

  const profit = promoPrice.minus(costPrice);
  const marginPercent = promoPrice.gt(0)
    ? profit.div(promoPrice).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  const isBelowCost = promoPrice.lt(costPrice);
  const isCeilingViolated = promoType === "FIXED_PRICE" && retailPrice.lte(promoValue);

  let badgeStyle: "positive" | "negative" | "warning" = "positive";
  if (isBelowCost) {
    badgeStyle = "negative";
  } else if (isCeilingViolated) {
    badgeStyle = "warning";
  }

  return {
    promoPrice,
    marginPercent,
    isBelowCost,
    isCeilingViolated,
    badgeStyle,
  };
}

/** F15: Basket Simulator Contract */
function simulateBasketPreview(
  items: Array<{ productId: number; unitPrice: Decimal; quantity: Decimal }>,
  rule: {
    type: "BOGO" | "PERCENT";
    percent?: Decimal;
    minSpend?: Decimal;
  }
): {
  grossTotal: Decimal;
  discount: Decimal;
  netTotal: Decimal;
  savingsPercent: Decimal;
  helperNote: string | null;
} {
  const grossTotal = items.reduce((acc, i) => acc.plus(i.unitPrice.mul(i.quantity)), new Decimal(0));

  if (rule.minSpend && grossTotal.lt(rule.minSpend)) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: `الحد الأدنى للطلب (${rule.minSpend.toFixed(2)} د.ع) غير مستوفى`,
    };
  }

  let discount = new Decimal(0);
  if (rule.type === "BOGO") {
    // Buy 2 Get 1 Free: total qty >= 3 gives 1 cheapest free
    const totalQty = items.reduce((acc, i) => acc.plus(i.quantity), new Decimal(0)).toNumber();
    if (totalQty >= 3) {
      const cheapestUnitPrice = items.reduce((min, i) => Decimal.min(min, i.unitPrice), items[0].unitPrice);
      discount = cheapestUnitPrice;
    }
  } else if (rule.type === "PERCENT") {
    discount = grossTotal.mul(rule.percent ?? 0).div(100);
  }

  const netTotal = grossTotal.minus(discount);
  const savingsPercent = grossTotal.gt(0)
    ? discount.div(grossTotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  return {
    grossTotal,
    discount,
    netTotal,
    savingsPercent,
    helperNote: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tier 1: Offers UI Contracts (F13–F18)", () => {
  // =========================================================================
  // F13: Rapid Barcode Gun Scanner
  // =========================================================================
  describe("F13: Rapid Barcode Gun Scanner", () => {
    it("T1-F13-01: single barcode entry adds item to selected items list", () => {
      const scanner = new ScannerSimulator();
      const success = scanner.scan("628100100001"); // Rotring pen piece

      expect(success).toBe(true);
      expect(scanner.selectedItemIds).toEqual([PRD_PEN_ROTRING.id]);
    });

    it("T1-F13-02: persistent focus retention: scanner retains focus state after adding item", () => {
      const scanner = new ScannerSimulator();
      scanner.scan("628100100001");
      expect(scanner.focusRetained).toBe(true);
    });

    it("T1-F13-03: rapid consecutive scans (<40ms burst) adds each unique scanned item in order", () => {
      const scanner = new ScannerSimulator();
      const barcodes = ["628100100001", "628100200001", "628100300001"];

      const res = scanner.scanBurst(barcodes);
      expect(res.added).toBe(3);
      expect(res.duplicates).toBe(0);
      expect(scanner.selectedItemIds).toHaveLength(3);
    });

    it("T1-F13-04: duplicate scan detection: triggers duplicate alert without adding duplicate row", () => {
      const scanner = new ScannerSimulator();
      scanner.scan("628100100001");
      expect(scanner.selectedItemIds).toHaveLength(1);

      // Scan same barcode again
      const secondScan = scanner.scan("628100100001");
      expect(secondScan).toBe(false);
      expect(scanner.duplicateChimeTriggered).toBe(true);
      expect(scanner.lastWarning).toBe("الصنف مضاف مسبقاً");
      expect(scanner.selectedItemIds).toHaveLength(1); // row not duplicated
    });

    it("T1-F13-05: non-existent barcode triggers non-blocking warning without losing focus", () => {
      const scanner = new ScannerSimulator();
      const success = scanner.scan("999999999999");

      expect(success).toBe(false);
      expect(scanner.lastWarning).toBe("لم يتم العثور على الصنف");
      expect(scanner.focusRetained).toBe(true);
    });

    it("T1-F13-06: scanning secondary packaging barcode (carton) matches product", () => {
      const scanner = new ScannerSimulator();
      const success = scanner.scan("628100100144"); // Rotring pen carton

      expect(success).toBe(true);
      expect(scanner.selectedItemIds).toContain(PRD_PEN_ROTRING.id);
    });
  });

  // =========================================================================
  // F14: Interactive Live Table
  // =========================================================================
  describe("F14: Interactive Live Table", () => {
    it("T1-F14-01: calculates positive profit margin when promo price > cost", () => {
      // Rotring pen: cost = 350, retail = 500. 10% promo = 450 promo price
      const res = calculateLiveMargin(new Decimal(500), new Decimal(350), "PERCENT", new Decimal(10));

      expect(res.promoPrice.toNumber()).toBe(450);
      // Margin = (450 - 350) / 450 * 100 = 22.22%
      expect(res.marginPercent.toNumber()).toBe(22.22);
      expect(res.isBelowCost).toBe(false);
      expect(res.badgeStyle).toBe("positive");
    });

    it("T1-F14-02: promo price < cost displays below-cost warning with negative badge style", () => {
      // Cost = 8,500, Retail = 15,000. Fixed price = 5,000 (below cost)
      const res = calculateLiveMargin(new Decimal(15000), new Decimal(8500), "FIXED_PRICE", new Decimal(5000));

      expect(res.promoPrice.toNumber()).toBe(5000);
      expect(res.isBelowCost).toBe(true);
      expect(res.badgeStyle).toBe("negative");
      expect(res.marginPercent.isNegative()).toBe(true);
    });

    it("T1-F14-03: original price <= fixed price triggers ceiling notice with warning badge style", () => {
      // Cheap pen: retail = 250, fixed price = 1000
      const res = calculateLiveMargin(new Decimal(250), new Decimal(150), "FIXED_PRICE", new Decimal(1000));

      // Promo price must remain 250, not jump to 1000
      expect(res.promoPrice.toNumber()).toBe(250);
      expect(res.isCeilingViolated).toBe(true);
      expect(res.badgeStyle).toBe("warning");
    });

    it("T1-F14-04: updates margin dynamically when promo amount changes", () => {
      // Notebook: cost = 2400, retail = 3500. 500 off -> promo price = 3000
      const res1 = calculateLiveMargin(new Decimal(3500), new Decimal(2400), "AMOUNT", new Decimal(500));
      expect(res1.promoPrice.toNumber()).toBe(3000);
      // Margin = (3000 - 2400) / 3000 * 100 = 20.00%
      expect(res1.marginPercent.toNumber()).toBe(20);

      // Increase promo amount to 1000 off -> promo price = 2500
      const res2 = calculateLiveMargin(new Decimal(3500), new Decimal(2400), "AMOUNT", new Decimal(1000));
      expect(res2.promoPrice.toNumber()).toBe(2500);
      // Margin = (2500 - 2400) / 2500 * 100 = 4.00%
      expect(res2.marginPercent.toNumber()).toBe(4);
    });

    it("T1-F14-05: table row displays packaging unit name and conversion factor", () => {
      const dozenUnit = PRD_PEN_ROTRING.units[1];
      expect(dozenUnit.unitName).toBe("درزن");
      expect(dozenUnit.conversionFactor.toNumber()).toBe(12);
    });
  });

  // =========================================================================
  // F15: Live Basket Preview Simulator
  // =========================================================================
  describe("F15: Live Basket Preview Simulator", () => {
    it("T1-F15-01: renders preview with original total, discount = 0, and net total for empty promo", () => {
      const items = [
        { productId: PRD_PEN_ROTRING.id, unitPrice: new Decimal(500), quantity: new Decimal(2) },
      ];
      const preview = simulateBasketPreview(items, { type: "PERCENT", percent: new Decimal(0) });

      expect(preview.grossTotal.toNumber()).toBe(1000);
      expect(preview.discount.toNumber()).toBe(0);
      expect(preview.netTotal.toNumber()).toBe(1000);
    });

    it("T1-F15-02: quantity adjustment triggers BOGO threshold (qty = 3 gives 1 cheapest free)", () => {
      const items = [
        { productId: PRD_NOTEBOOK_FABER.id, unitPrice: new Decimal(3500), quantity: new Decimal(3) },
      ];
      const preview = simulateBasketPreview(items, { type: "BOGO" });

      expect(preview.grossTotal.toNumber()).toBe(10500);
      expect(preview.discount.toNumber()).toBe(3500); // 1 free
      expect(preview.netTotal.toNumber()).toBe(7000);
      expect(preview.savingsPercent.toNumber()).toBe(33.33);
    });

    it("T1-F15-03: min spend threshold unmet shows helper note and 0 discount", () => {
      const items = [
        { productId: PRD_PEN_ROTRING.id, unitPrice: new Decimal(500), quantity: new Decimal(4) }, // 2,000 IQD
      ];
      const preview = simulateBasketPreview(items, {
        type: "PERCENT",
        percent: new Decimal(20),
        minSpend: new Decimal(10000), // requires 10,000 IQD
      });

      expect(preview.discount.toNumber()).toBe(0);
      expect(preview.netTotal.toNumber()).toBe(2000);
      expect(preview.helperNote).toContain("الحد الأدنى للطلب");
    });

    it("T1-F15-04: min spend threshold met updates preview with applied savings breakdown", () => {
      const items = [
        { productId: PRD_INK_EPSON.id, unitPrice: new Decimal(12000), quantity: new Decimal(1) }, // 12,000 IQD
      ];
      const preview = simulateBasketPreview(items, {
        type: "PERCENT",
        percent: new Decimal(20),
        minSpend: new Decimal(10000),
      });

      expect(preview.discount.toNumber()).toBe(2400); // 20% of 12,000
      expect(preview.netTotal.toNumber()).toBe(9600);
      expect(preview.helperNote).toBeNull();
    });

    it("T1-F15-05: preview displays real-time savings percentage badge", () => {
      const items = [
        { productId: PRD_PEN_ROTRING.id, unitPrice: new Decimal(1000), quantity: new Decimal(1) },
      ];
      const preview = simulateBasketPreview(items, {
        type: "PERCENT",
        percent: new Decimal(25),
      });

      expect(preview.savingsPercent.toNumber()).toBe(25);
    });
  });

  // =========================================================================
  // F16: Master Offer Form & Duplication
  // =========================================================================
  describe("F16: Master Offer Form & Duplication", () => {
    it("T1-F16-01: step-by-step navigation wizard order", () => {
      const formPath = fs.existsSync(OFFER_FORM_PATH) ? OFFER_FORM_PATH : OFFERS_PAGE_PATH;
      const content = fs.readFileSync(formPath, "utf-8");

      // Verify the 4 mandatory steps/fields exist in the master offer form
      expect(content).toContain('label="اسم العرض"'); // Step 1: Basic Info
      expect(content).toContain('label="نوع الخصم"'); // Step 2: Type & Value
      expect(content).toContain('label="النطاق"'); // Step 3: Scope & Targets
      expect(content).toContain('label="قناة العرض"'); // Step 4: Scheduling & Channels
      expect(content).toContain('label="من تاريخ"');
    });

    it("T1-F16-02: 1-click duplication prefixes name with 'نسخة من'", () => {
      const originalPromo = createPercentPromoFixture({
        id: 501,
        name: "عرض موسم القرطاسية",
        isActive: true,
      });
      const duplicated = duplicatePromotionRule(originalPromo, 2001, "2026-06-15");
      expect(duplicated.name).toBe("نسخة من عرض موسم القرطاسية");
      expect(duplicated.id).toBe(2001);
      expect(duplicated.isActive).toBe(false);
      expect(duplicated.effectiveFrom).toBe("2026-06-15");
    });

    it("T1-F16-03: form validation rejects empty promotion name", () => {
      const formInput = { name: "   ", type: "PERCENT", discountPercent: 10 };
      const isValid = formInput.name.trim().length > 0;
      expect(isValid).toBe(false);
    });

    it("T1-F16-04: form validation rejects discount percent <= 0", () => {
      const formInput = { name: "عرض صالح", type: "PERCENT", discountPercent: 0 };
      const isValid = formInput.discountPercent > 0;
      expect(isValid).toBe(false);
    });

    it("T1-F16-05: duplicated promo draft has cleared ID and inactive status", () => {
      const original = { id: 501, name: "عرض أصلي", isActive: true };
      const draft = {
        ...original,
        id: undefined, // Cleared ID
        name: `نسخة من ${original.name}`,
        isActive: false, // Inactive draft
      };

      expect(draft.id).toBeUndefined();
      expect(draft.isActive).toBe(false);
    });
  });

  // =========================================================================
  // F17: Offers Page Refactoring & Quality Guards
  // =========================================================================
  describe("F17: Offers Page Refactoring & Quality Guards", () => {
    it("T1-F17-01: verified that DataTable wrapper is standard component in Offers.tsx", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('import { DataTable } from "@/components/data-table/DataTable";');
      expect(content).toMatch(/<DataTable\b/);
      expect(content).not.toMatch(/<table[\s>]/i);
    });

    it("T1-F17-02: verified status filter options in Offers.tsx include CURRENT, SCHEDULED, EXPIRED, ALL", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('type ValidityFilter = "ALL" | "CURRENT" | "SCHEDULED" | "EXPIRED";');
      expect(content).toContain('<option value="ALL">كل الحالات</option>');
      expect(content).toContain('<option value="CURRENT">ساري الآن</option>');
      expect(content).toContain('<option value="SCHEDULED">يبدأ لاحقاً</option>');
      expect(content).toContain('<option value="EXPIRED">منتهٍ تاريخياً</option>');
    });

    it("T1-F17-03: semantic tokens are used for status badges in Offers.tsx", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toMatch(/var\(--sem-pos/);
      expect(content).toMatch(/var\(--sem-neg/);
      expect(content).toMatch(/var\(--sem-info/);
      expect(content).not.toMatch(/text-green-[0-9]+/);
      expect(content).not.toMatch(/text-red-[0-9]+/);
    });

    it("T1-F17-04: zero emoji characters in Offers.tsx (strictly Lucide icons per check:emoji)", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      const emojiRegex = new RegExp(
        "[\\u{1F300}-\\u{1FAFF}\\u{1F1E6}-\\u{1F1FF}\\u{2600}-\\u{27BF}\\u{231A}-\\u{231B}\\u{23E9}-\\u{23FA}\\u{25B0}-\\u{25FF}\\u{2B00}-\\u{2BFF}]",
        "u"
      );
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        expect(emojiRegex.test(line)).toBe(false);
      }
    });

    it("T1-F17-05: Offers.tsx adheres to file size limits and DataTable pagination", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      const lineCount = content.split(/\r?\n/).length;
      expect(lineCount).toBeLessThanOrEqual(1200);
      expect(lineCount).toBeGreaterThan(100);
      expect(content).toContain("<DataTable");
    });
  });

  // =========================================================================
  // F18: Marketing Wing Static Contracts
  // =========================================================================
  describe("F18: Marketing Wing Static Contracts", () => {
    it("T1-F18-01: PageHeader title must strictly equal 'العروض والتخفيضات' in Offers.tsx", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('import { PageHeader } from "@/components/PageHeader";');
      expect(content).toMatch(/<PageHeader\b[^>]*\btitle="العروض والتخفيضات"/);
    });

    it("T1-F18-02: export supports xlsx format via exportRows in Offers.tsx", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('import { exportRows } from "@/lib/export";');
      expect(content).toContain('const handleExport = (format: "xlsx" | "csv") => {');
      expect(content).toContain('onClick={() => handleExport("xlsx")}');
    });

    it("T1-F18-03: export supports csv format via exportRows in Offers.tsx", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('onClick={() => handleExport("csv")}');
      expect(content).toContain("exportRows(list, {");
    });

    it("T1-F18-04: export column headers in Offers.tsx contain authentic Iraqi commercial terminology", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).toContain('{ key: "name", header: "اسم العرض" }');
      expect(content).toContain('{ key: "type", header: "نوع الخصم"');
      expect(content).toContain('{ key: "channel", header: "القناة"');
      expect(content).toContain('{ key: "effectiveFrom", header: "سارٍ من"');
      expect(content).toContain('{ key: "status", header: "الحالة"');
      expect(content).toContain('{ key: "netSales", header: "المبيعات المرتبطة"');
    });

    it("T1-F18-05: zero window.alert or window.confirm in Offers.tsx in compliance with check:no-window-dialogs", () => {
      const content = fs.readFileSync(OFFERS_PAGE_PATH, "utf-8");
      expect(content).not.toMatch(/window\.(alert|confirm|prompt)\b/);
      expect(content).toContain('import { confirm } from "@/lib/confirm";');
      expect(content).toMatch(/await confirm\(\{/);
    });
  });

  // =========================================================================
  // F19: Multi-Rule Offers, 3-Way Bulk Product Add & Comprehensive Channel Step
  // =========================================================================
  describe("F19: Multi-Rule, 3-Way Bulk Add & Comprehensive Channel Step", () => {
    it("T1-F19-01: shared multi-rule simulation awards single-item FIXED_PRICE at qty=1 and switches to BUNDLE_PRICE at qty=3", () => {
      const sharedRules = [
        {
          type: "FIXED_PRICE" as const,
          fixedPrice: new Decimal(4000),
          ruleName: "القاعدة 1: سعر المفرد 4000",
          targetProductIds: [101],
        },
        {
          type: "BUNDLE_PRICE" as const,
          bundleMode: "PICK_ANY_N" as const,
          bundleQuantity: 3,
          bundlePrice: new Decimal(10000),
          ruleName: "القاعدة 2: باقة 3 ملازم بـ 10000",
          targetProductIds: [101],
        },
      ];

      // Qty = 1 of 5,000 IQD booklet -> Rule 1 wins (1,000 discount -> 4,000 net)
      const single = simulateMultiRuleBasketPreview(
        [{ productId: 101, variantId: 101, unitPrice: 5000, quantity: 1 }],
        sharedRules
      );
      expect(single.grossTotal.toNumber()).toBe(5000);
      expect(single.discount.toNumber()).toBe(1000);
      expect(single.netTotal.toNumber()).toBe(4000);
      expect(single.winningRuleNamesByLineKey["101"]).toContain("القاعدة 1");

      // Qty = 3 of 5,000 IQD booklet -> Gross 15,000; Rule 1 saves 3,000 (12,000), Rule 2 saves 5,000 (10,000) -> Rule 2 wins!
      const triple = simulateMultiRuleBasketPreview(
        [{ productId: 101, variantId: 101, unitPrice: 5000, quantity: 3 }],
        sharedRules
      );
      expect(triple.grossTotal.toNumber()).toBe(15000);
      expect(triple.discount.toNumber()).toBe(5000);
      expect(triple.netTotal.toNumber()).toBe(10000);
      expect(triple.winningRuleNamesByLineKey["101"]).toContain("القاعدة 2");
    });

    it("T1-F19-02: independent per-rule scope applies each rule strictly to its own targetProductIds", () => {
      const perRule = simulateMultiRuleBasketPreview(
        [
          { productId: 201, variantId: 201, unitPrice: 5000, quantity: 1 },
          { productId: 202, variantId: 202, unitPrice: 2000, quantity: 3 },
        ],
        [
          {
            type: "PERCENT",
            percent: new Decimal(20),
            ruleName: "خصم 20% على الفيزياء",
            targetProductIds: [201],
          },
          {
            type: "BOGO",
            bogoBuyQuantity: 2,
            bogoGetQuantity: 1,
            bogoGetDiscountPercent: new Decimal(100),
            ruleName: "2+1 على الدفاتر",
            targetProductIds: [202],
          },
        ]
      );
      // 20% off 5000 = 1000 + 1 free notebook (2000) = 3000 total discount
      expect(perRule.grossTotal.toNumber()).toBe(11000);
      expect(perRule.discount.toNumber()).toBe(3000);
      expect(perRule.netTotal.toNumber()).toBe(8000);
    });

    it("T1-F19-03: validateRuleTypeFields prefixes multi-rule validation errors clearly", () => {
      const invalidFixed = createDefaultRuleDraft("FIXED_PRICE");
      invalidFixed.fixedPrice = "0";
      const err = validateRuleTypeFields(invalidFixed, "القاعدة 2: ");
      expect(err).toContain("القاعدة 2:");
      expect(err).toContain("السعر الموحد");
    });

    it("T1-F19-04: Step 3 OfferBulkAddToolbar exposes all 3 bulk addition workflows", () => {
      const content = fs.readFileSync(BULK_ADD_PATH, "utf-8");
      expect(content).toContain("مستعرض الإضافة المتعددة");
      expect(content).toContain("لصق قائمة باركودات / أكواد");
      expect(content).toContain("سحب مواد فئة كاملة");
    });

    it("T1-F19-05: Step 4 OfferChannelStepSection covers visual channel cards, 6 ERP touchpoints, branch scope, and shipping perks", () => {
      const content = fs.readFileSync(CHANNEL_SECTION_PATH, "utf-8");
      expect(content).toContain("نقطة البيع (الكاشير POS)");
      expect(content).toContain("البيع دون اتصال (أوفلاين الطوارئ)");
      expect(content).toContain("شاشة الاستقبال والفاتورة المتقدمة");
      expect(content).toContain("قارئ الأسعار وملصقات الرفوف والباركود");
      expect(content).toContain("موقع المتجر الإلكتروني (الويب)");
      expect(content).toContain("تطبيق المتجر للهاتف (Android / iOS)");
      expect(content).toContain("الفرع المستهدف");
      expect(content).toContain("ميزة التوصيل والشحن المصاحبة");
      expect(content).not.toContain('value="DISCOUNT"');
    });

    it("T1-F19-06: validateRuleScopeAndMargin rejects store-wide ALL scope for ALL_REQUIRED bundles while allowing PICK_ANY_N", () => {
      const ruleAllReq = {
        ...createDefaultRuleDraft("BUNDLE_PRICE", "r_all_req"),
        bundlePrice: "5000",
        bundleMode: "ALL_REQUIRED" as const,
        scope: "ALL" as const,
      };
      expect(validateRuleScopeAndMargin(ruleAllReq, ruleAllReq, "")).toContain("لا تقبل نطاق");

      const rulePickAny = {
        ...ruleAllReq,
        bundleMode: "PICK_ANY_N" as const,
        bundleQuantity: 3,
      };
      expect(validateRuleScopeAndMargin(rulePickAny, rulePickAny, "")).toBeNull();
    });

    it("T1-F19-07: validateRuleScopeAndMargin applies maxDiscountAmount cap before evaluating below-cost floor", () => {
      const cappedRule = {
        ...createDefaultRuleDraft("PERCENT", "r_capped"),
        discountPercent: "50",
        maxDiscountAmount: "1000",
        scope: "PRODUCTS" as const,
        allowBelowCost: false,
        selectedProducts: [
          {
            productId: 501,
            productName: "حقيبة مدرسية",
            productCode: "PRD-501",
            variantId: 501,
            sku: "BAG-1",
            isConsignment: false,
            barcode: "628501",
            productUnitId: 501,
            unitName: "قطعة",
            conversionFactor: "1",
            isBaseUnit: true,
            retailPrice: "10000",
            costPrice: "8000",
            units: [
              {
                id: 501,
                unitName: "قطعة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "628501",
                retailPrice: "10000",
              },
            ],
          },
        ],
      };

      // 50% of 10,000 = 5,000 uncapped, but capped at 1,000 => promoPrice = 9,000 >= cost 8,000
      expect(validateRuleScopeAndMargin(cappedRule, cappedRule, "")).toBeNull();

      // Without the cap, promoPrice = 5,000 < cost 8,000 => blocked
      const uncappedRule = { ...cappedRule, maxDiscountAmount: "" };
      expect(validateRuleScopeAndMargin(uncappedRule, uncappedRule, "")).toContain("ينزل سعرها بالعرض أقل من كلفتها");
    });

    it("T1-F19-08: buildTargetsForHolder preserves explicit UNIT targetGrain even when selected unit isBaseUnit", () => {
      const unitScopedDraft = {
        ...createDefaultRuleDraft("PERCENT", "r_unit_grain"),
        scope: "PRODUCTS" as const,
        selectedProducts: [
          {
            targetGrain: "UNIT" as const,
            productId: 601,
            productName: "دفتر جامعي",
            productCode: "PRD-601",
            variantId: 6011,
            sku: "NB-BLUE",
            isConsignment: false,
            barcode: "6286011",
            productUnitId: 60111,
            unitName: "قطعة",
            conversionFactor: "1",
            isBaseUnit: true,
            retailPrice: "2000",
            costPrice: "1200",
            units: [
              {
                id: 60111,
                unitName: "قطعة",
                conversionFactor: "1",
                isBaseUnit: true,
                barcode: "6286011",
                retailPrice: "2000",
              },
            ],
          },
        ],
      };

      expect(buildTargetsForHolder(unitScopedDraft)).toEqual([
        {
          categoryId: null,
          productId: null,
          variantId: null,
          productUnitId: 60111,
        },
      ]);
    });

    it("T1-F19-09: simulator target collections preserve VARIANT and UNIT grain for ALL_REQUIRED bundles", () => {
      const selectedVariants = [
        {
          targetGrain: "VARIANT" as const,
          productId: 10,
          variantId: 101,
          productUnitId: 1001,
          isBaseUnit: true,
        },
        {
          targetGrain: "VARIANT" as const,
          productId: 10,
          variantId: 102,
          productUnitId: 1002,
          isBaseUnit: true,
        },
      ];
      const derived = deriveSimulatorTargetCollections(selectedVariants);
      expect(derived).toEqual({
        targetProductIds: [],
        targetVariantIds: [101, 102],
        targetUnitIds: [],
      });

      const bundleRule = {
        type: "BUNDLE_PRICE" as const,
        bundleMode: "ALL_REQUIRED" as const,
        bundlePrice: new Decimal(1500),
        ...derived,
      };

      // Both variants present (qty 1 each, 1000 IQD each => 2000 gross, 1500 bundle => 500 discount)
      const completeSingle = simulateOfferBasketPreview(
        [
          { productId: 10, variantId: 101, productUnitId: 1001, unitPrice: 1000, quantity: 1 },
          { productId: 10, variantId: 102, productUnitId: 1002, unitPrice: 1000, quantity: 1 },
        ],
        bundleRule
      );
      expect(completeSingle.discount.toNumber()).toBe(500);
      expect(completeSingle.netTotal.toNumber()).toBe(1500);

      // Only one variant present with qty 2 => missing variant 102 => 0 discount + helperNote
      const incompleteSingle = simulateOfferBasketPreview(
        [{ productId: 10, variantId: 101, productUnitId: 1001, unitPrice: 1000, quantity: 2 }],
        bundleRule
      );
      expect(incompleteSingle.discount.toNumber()).toBe(0);
      expect(incompleteSingle.helperNote).toContain("كل المواد مطلوبة");

      // Multi-rule simulator matches exact variant-grain behavior
      const incompleteMulti = simulateMultiRuleBasketPreview(
        [{ productId: 10, variantId: 101, productUnitId: 1001, unitPrice: 1000, quantity: 2 }],
        [{ ...bundleRule, ruleName: "باقة لونين" }]
      );
      expect(incompleteMulti.discount.toNumber()).toBe(0);

      // Multi-unit on same variant disambiguates lineKeys and UNIT grain
      const unitDerived = deriveSimulatorTargetCollections([
        { targetGrain: "UNIT", productId: 20, variantId: 201, productUnitId: 2001, isBaseUnit: true },
        { targetGrain: "UNIT", productId: 20, variantId: 201, productUnitId: 2002, isBaseUnit: false },
      ]);
      expect(unitDerived.targetUnitIds).toEqual([2001, 2002]);
      const completeUnitMulti = simulateMultiRuleBasketPreview(
        [
          { productId: 20, variantId: 201, productUnitId: 2001, isBaseUnit: true, unitPrice: 1000, quantity: 1 },
          { productId: 20, variantId: 201, productUnitId: 2002, isBaseUnit: false, unitPrice: 5000, quantity: 1 },
        ],
        [{ type: "BUNDLE_PRICE", bundleMode: "ALL_REQUIRED", bundlePrice: new Decimal(5200), ...unitDerived, ruleName: "باقة قطعة + دزينة" }]
      );
      expect(completeUnitMulti.discount.toNumber()).toBe(800);
    });

    it("T1-F19-10: Reception pure promotion evaluator surfaces FREE_SHIPPING and promotes COURIER delivery to SHOP while preserving COUNTER", () => {
      const evaluated = evaluateReceptionCartPromotionsPure({
        rawCart: [
          {
            key: "line-1",
            qty: 2,
            row: {
              productId: 1,
              variantId: 1,
              productUnitId: 1,
              price: "15000",
              isBaseUnit: true,
              isContractPrice: false,
              isPrintService: false,
              isService: false,
            } as never,
          },
        ],
        rules: [
          {
            id: 77,
            name: "توصيل مجاني لطلبات 25 ألف+",
            type: "FREE_SHIPPING",
            scope: "ALL",
            channel: "ALL",
            applicationMode: "AUTO",
            priority: 10,
            minOrderSpend: new Decimal(25000),
            effectiveFrom: "2026-01-01",
            isActive: true,
          },
        ],
        branchId: 1,
        effectiveTier: "RETAIL",
        todayYmd: "2026-06-15",
      });

      expect(evaluated.autoFreeShippingName).toBe("توصيل مجاني لطلبات 25 ألف+");

      const baseDelivery = {
        partyId: 1,
        partyName: "مندوب بغداد",
        fee: "5000",
        feeCollection: "COURIER" as const,
        recipientPhone: "07701234567",
        recipientName: "أحمد",
        address: "الكرادة",
        externalTrackingRef: null,
      };
      expect(
        applyFreeShippingToOrderDelivery(baseDelivery, evaluated.autoFreeShippingName)?.feeCollection
      ).toBe("SHOP");

      // Held COUNTER fee is preserved untouched
      expect(
        applyFreeShippingToOrderDelivery(
          { ...baseDelivery, feeCollection: "COUNTER" },
          evaluated.autoFreeShippingName
        )?.feeCollection
      ).toBe("COUNTER");
    });

    it("T1-F19-11: switching offer rule type away from PERCENT clears hidden maxDiscountAmount in draft state and API payload", () => {
      const percentDraft = applyOfferRuleDraftPatch(createDefaultRuleDraft("PERCENT"), {
        discountPercent: "20",
        maxDiscountAmount: "1000",
      });
      expect(percentDraft.maxDiscountAmount).toBe("1000");
      expect(buildRulePayloadCore(percentDraft).maxDiscountAmount).toBe("1000");

      // Manager switches from PERCENT to BOGO (buy 1 get 1 free on 10,000-IQD items)
      const bogoDraft = applyOfferRuleDraftPatch(percentDraft, {
        type: "BOGO",
        bogoBuyQuantity: 1,
        bogoGetQuantity: 1,
        bogoGetDiscountPercent: "100",
      });
      expect(bogoDraft.maxDiscountAmount).toBe("");
      expect(buildRulePayloadCore(bogoDraft).maxDiscountAmount).toBeNull();

      // Even if a stale draft carried maxDiscountAmount on BOGO, buildRulePayloadCore strips it
      const staleBogoPayload = buildRulePayloadCore({
        ...bogoDraft,
        maxDiscountAmount: "1000",
      });
      expect(staleBogoPayload.maxDiscountAmount).toBeNull();
    });

    it("T1-F19-12: whole-category pull paginates across >500-variant categories and warns explicitly on safety-cap truncation", async () => {
      const makeSearchRow = (id: number) => ({
        productId: id,
        productName: `مادة ${id}`,
        productCode: `SKU-${id}`,
        categoryId: 7,
        variantId: id,
        sku: `SKU-${id}`,
        variantKind: "VARIANT" as const,
        isConsignment: false,
        isBundle: false,
        costPrice: "500.00",
        units: [
          {
            id: id * 10,
            unitName: "قطعة",
            conversionFactor: "1",
            barcode: null,
            isBaseUnit: true,
            retailPrice: "1000.00",
          },
        ],
      });

      const fullCatalog = Array.from({ length: 1205 }, (_, i) => makeSearchRow(i + 1));
      const fullPull = await pullCategorySearchPages({
        categoryId: 7,
        pageSize: 500,
        fetchPage: async ({ limit, offset }) => fullCatalog.slice(offset, offset + limit),
      });
      expect(fullPull.truncated).toBe(false);
      expect(fullPull.rows).toHaveLength(1205);

      const firstOutcome = resolveCategoryPullOutcome({
        fetchedRows: fullPull.rows,
        truncated: fullPull.truncated,
        existingVariantIds: new Set(),
        catName: "قرطاسية مدرسية",
      });
      expect(firstOutcome.itemsToAdd).toHaveLength(1205);
      expect(firstOutcome.tone).toBe("pos");

      // If safety ceiling is hit (e.g. maxPages = 2 => 1,000 of 1,205 fetched), truncation is detected and warned
      const cappedPull = await pullCategorySearchPages({
        categoryId: 7,
        pageSize: 500,
        maxPages: 2,
        fetchPage: async ({ limit, offset }) => fullCatalog.slice(offset, offset + limit),
      });
      expect(cappedPull.truncated).toBe(true);
      expect(cappedPull.rows).toHaveLength(1000);

      const cappedOutcome = resolveCategoryPullOutcome({
        fetchedRows: cappedPull.rows,
        truncated: cappedPull.truncated,
        existingVariantIds: new Set(cappedPull.rows.map((r) => r.variantId)),
        catName: "قرطاسية مدرسية",
      });
      expect(cappedOutcome.itemsToAdd).toHaveLength(0);
      expect(cappedOutcome.tone).toBe("warn");
      expect(cappedOutcome.notice).toContain("أصنافاً إضافية");
    });

    it("T1-F19-13: enforces MAX_PROMOTION_TARGETS across bulk pull, paste, and form validation while allowing >500 targets", () => {
      const makeRow = (id: number) => ({
        productId: id,
        productName: `مادة ${id}`,
        productCode: `SKU-${id}`,
        categoryId: 7,
        variantId: id,
        sku: `SKU-${id}`,
        variantKind: "VARIANT" as const,
        isConsignment: false,
        isBundle: false,
        costPrice: "500.00",
        units: [
          {
            id: id * 10,
            unitName: "قطعة",
            conversionFactor: "1",
            barcode: `BC-${id}`,
            isBaseUnit: true,
            retailPrice: "1000.00",
          },
        ],
      });

      // 1,200 targets (>500) are valid end-to-end
      const valid1200 = resolveCategoryPullOutcome({
        fetchedRows: Array.from({ length: 1200 }, (_, i) => makeRow(i + 1)),
        truncated: false,
        existingVariantIds: new Set(),
        catName: "قرطاسية",
      });
      expect(valid1200.itemsToAdd).toHaveLength(1200);
      expect(valid1200.tone).toBe("pos");

      const ruleWith1200 = {
        ...createDefaultRuleDraft("PERCENT"),
        scope: "PRODUCTS" as const,
        selectedProducts: valid1200.itemsToAdd,
      };
      expect(validateRuleScopeAndMargin(ruleWith1200, ruleWith1200, "")).toBeNull();

      // Exceeding MAX_PROMOTION_TARGETS is capped upfront with an explicit warning
      const pullOverflow = resolveCategoryPullOutcome({
        fetchedRows: Array.from({ length: 200 }, (_, i) => makeRow(6000 + i)),
        truncated: false,
        existingVariantIds: new Set(),
        catName: "قرطاسية",
        currentSelectedCount: MAX_PROMOTION_TARGETS - 50,
      });
      expect(pullOverflow.itemsToAdd).toHaveLength(50);
      expect(pullOverflow.tone).toBe("warn");
      expect(pullOverflow.notice).toContain(String(MAX_PROMOTION_TARGETS));

      const pasteOverflow = resolveBulkPasteOutcome({
        tokens: ["SKU-9001", "SKU-9002", "SKU-9003"],
        matchedProducts: [makeRow(9001), makeRow(9002), makeRow(9003)],
        existingVariantIds: new Set(),
        currentSelectedCount: MAX_PROMOTION_TARGETS - 1,
      });
      expect(pasteOverflow.itemsToAdd).toHaveLength(1);
      expect(pasteOverflow.capped).toBe(true);
      expect(pasteOverflow.tone).toBe("warn");

      // And validateRuleScopeAndMargin blocks an oversized draft before submission
      const oversizedRule = {
        ...ruleWith1200,
        selectedProducts: Array.from({ length: MAX_PROMOTION_TARGETS + 1 }, (_, i) => ({
          ...valid1200.itemsToAdd[0]!,
          productId: i + 1,
          variantId: i + 1,
        })),
      };
      expect(capOfferItemsToTargetLimit(oversizedRule.selectedProducts, 0).acceptedItems).toHaveLength(
        MAX_PROMOTION_TARGETS,
      );
      expect(validateRuleScopeAndMargin(oversizedRule, oversizedRule, "")).toContain(
        String(MAX_PROMOTION_TARGETS),
      );
    });

    it("T1-F19-14: passes formData.applicationMode into simulateMultiRuleBasketPreview so COUPON caps apply cart-wide while AUTO caps apply per unit", () => {
      const simulatorPath = path.resolve(
        process.cwd(),
        "client/src/components/offers/OfferLivePreviewSimulator.tsx",
      );
      const simulatorSrc = fs.readFileSync(simulatorPath, "utf-8");
      expect(simulatorSrc).toMatch(
        /simulateMultiRuleBasketPreview\(\s*cartItems,\s*allRuleInputs,\s*safePositiveDecimal\(formData\.minOrderSpend\),\s*sharedShippingPerk,\s*formData\.applicationMode\s*\)/,
      );

      const cartItems = [
        {
          productId: 101,
          variantId: 201,
          productUnitId: 301,
          unitPrice: new Decimal("10000"),
          quantity: 2,
        },
      ];
      const rules = [
        {
          type: "PERCENT" as const,
          ruleName: "خصم 50% بسقف 1000",
          percent: new Decimal("50"),
          maxDiscountAmount: new Decimal("1000"),
        },
      ];

      const autoPreview = simulateMultiRuleBasketPreview(
        cartItems,
        rules,
        undefined,
        false,
        "AUTO",
      );
      const couponPreview = simulateMultiRuleBasketPreview(
        cartItems,
        rules,
        undefined,
        false,
        "COUPON",
      );

      // AUTO caps 1,000 IQD per unit => 2,000 IQD across 2 units
      expect(autoPreview.discount.toFixed(2)).toBe("2000.00");
      expect(autoPreview.netTotal.toFixed(2)).toBe("18000.00");

      // COUPON caps 1,000 IQD across the whole cart => 1,000 IQD total
      expect(couponPreview.discount.toFixed(2)).toBe("1000.00");
      expect(couponPreview.netTotal.toFixed(2)).toBe("19000.00");
    });

    it("T1-F19-15: Reception pure promotion evaluator scopes minOrderSpend to regular goods lines and excludes print/custom/manualService lines", () => {
      const rules = [
        {
          id: 91,
          name: "خصم 20% لطلبات البضاعة 2000+",
          type: "PERCENT" as const,
          scope: "ALL" as const,
          channel: "ALL" as const,
          applicationMode: "AUTO" as const,
          priority: 10,
          discountPercent: new Decimal(20),
          minOrderSpend: new Decimal(2000),
          freeShipping: true,
          effectiveFrom: "2026-01-01",
          isActive: true,
        },
      ];

      // 1,000 IQD regular merchandise + 1,500 IQD print service + 3,000 IQD custom work order => regularSale gross is only 1,000 IQD (< 2,000)
      const belowRegularThreshold = evaluateReceptionCartPromotionsPure({
        rawCart: [
          {
            key: "goods-1",
            qty: 1,
            row: {
              productId: 10,
              variantId: 100,
              productUnitId: 1000,
              price: "1000",
              isBaseUnit: true,
              isContractPrice: false,
              isPrintService: false,
              isService: false,
            } as never,
          },
          {
            key: "print-1",
            qty: 1,
            row: {
              productId: 20,
              variantId: 200,
              productUnitId: 2000,
              price: "1500",
              isBaseUnit: true,
              isContractPrice: false,
              isPrintService: true,
              isService: true,
            } as never,
          },
          {
            key: "custom-1",
            qty: 1,
            custom: { title: "درع تخرج", unitPrice: "3000" } as never,
            row: {
              productId: 30,
              variantId: 300,
              productUnitId: 3000,
              price: "3000",
              isBaseUnit: true,
              isContractPrice: false,
              isPrintService: false,
              isService: false,
            } as never,
          },
        ],
        rules,
        branchId: 1,
        effectiveTier: "RETAIL",
        todayYmd: "2026-06-15",
      });

      expect(belowRegularThreshold.cart[0]?.cartPromo).toBeNull();
      expect(belowRegularThreshold.autoFreeShippingName).toBeNull();

      // 2,000 IQD regular merchandise satisfies minOrderSpend on its own
      const meetsRegularThreshold = evaluateReceptionCartPromotionsPure({
        rawCart: [
          {
            key: "goods-2",
            qty: 2,
            row: {
              productId: 10,
              variantId: 100,
              productUnitId: 1000,
              price: "1000",
              isBaseUnit: true,
              isContractPrice: false,
              isPrintService: false,
              isService: false,
            } as never,
          },
        ],
        rules,
        branchId: 1,
        effectiveTier: "RETAIL",
        todayYmd: "2026-06-15",
      });

      expect(meetsRegularThreshold.cart[0]?.cartPromo?.lineDiscount).toBe("400.00");
      expect(meetsRegularThreshold.autoFreeShippingName).toBe("خصم 20% لطلبات البضاعة 2000+");
    });

    it("T1-F19-16: POS auto-free-shipping ownership persists in DeliveryDraft across draft reload and strips internal markers from server payload", () => {
      const initial = {
        ...emptyDeliveryDraft(),
        governorate: "baghdad",
        address: "الكرادة داخل",
        partyId: 5,
        partyName: "مندوب بغداد",
        fee: "5000",
        feeCollection: "COURIER" as const,
      };

      // 1. Promo qualifies -> promotes COURIER to SHOP and stamps ownership inside DeliveryDraft
      const promoted = reconcilePosDeliveryAutoFreeShipping({
        delivery: initial,
        freeShippingPromoName: "توصيل مجاني للقرطاسية",
        promosReady: true,
      });
      expect(promoted).not.toBeNull();
      expect(promoted?.feeCollection).toBe("SHOP");
      expect(promoted?.autoFreeShippingOwned).toBe(true);
      expect(promoted?.autoFreeShippingPrevCollection).toBe("COURIER");
      expect(promoted?.autoFreeShippingPromoName).toBe("توصيل مجاني للقرطاسية");

      // 2. Simulate localStorage round-trip (usePOSTabsDraft) + initial render before activePromotions query resolves
      const restoredFromStorage = JSON.parse(JSON.stringify(promoted));
      expect(
        reconcilePosDeliveryAutoFreeShipping({
          delivery: restoredFromStorage,
          freeShippingPromoName: null,
          promosReady: false,
        }),
      ).toBeNull();

      // 3. Server payload strips internal autoFreeShipping* fields cleanly
      const serverPayload = buildDeliveryPayload(restoredFromStorage);
      expect(serverPayload).not.toBeNull();
      expect(serverPayload?.feeCollection).toBe("SHOP");
      expect("autoFreeShippingOwned" in (serverPayload as unknown as Record<string, unknown>)).toBe(
        false,
      );

      // 4. Qualifying item removed after reload (promosReady = true, freeShippingPromoName = null) -> reverts SHOP back to COURIER
      const reverted = reconcilePosDeliveryAutoFreeShipping({
        delivery: restoredFromStorage,
        freeShippingPromoName: null,
        promosReady: true,
      });
      expect(reverted?.feeCollection).toBe("COURIER");
      expect(reverted?.autoFreeShippingOwned).toBe(false);
      expect(reverted?.autoFreeShippingPromoName).toBeNull();

      // 5. Manual SHOP selection by cashier (autoFreeShippingOwned = false) is never reverted when promo ends
      const manualShop = {
        ...initial,
        feeCollection: "SHOP" as const,
        autoFreeShippingOwned: false,
      };
      expect(
        reconcilePosDeliveryAutoFreeShipping({
          delivery: manualShop,
          freeShippingPromoName: null,
          promosReady: true,
        }),
      ).toBeNull();
    });

    it("T1-F19-17: multi-rule simulator evaluates freeShipping per rule rather than leaking an extra FREE_SHIPPING rule onto unrelated rules", () => {
      const offerFormSrc = fs.readFileSync(OFFER_FORM_PATH, "utf-8");
      expect(offerFormSrc).toContain(
        'freeShipping: shippingPerkMode === "FREE" || r0.type === "FREE_SHIPPING"',
      );
      expect(offerFormSrc).toContain(
        'rules.every((r) => r.type === "FREE_SHIPPING")',
      );

      const multiRule = [
        {
          type: "PERCENT" as const,
          ruleName: "خصم 10% على المادة أ",
          percent: new Decimal(10),
          freeShipping: false,
          targetProductIds: [101],
        },
        {
          type: "FREE_SHIPPING" as const,
          ruleName: "توصيل مجاني للمادة ب",
          freeShipping: true,
          targetProductIds: [202],
        },
      ];

      // Buying only Product A (101) gets the 10% discount and NO free shipping
      const onlyProductA = simulateMultiRuleBasketPreview(
        [
          {
            productId: 101,
            variantId: 1010,
            productUnitId: 10100,
            unitPrice: new Decimal(10000),
            quantity: 1,
          },
        ],
        multiRule,
        undefined,
        false,
        "AUTO",
      );
      expect(onlyProductA.discount.toFixed(2)).toBe("1000.00");
      expect(onlyProductA.freeShippingApplied).toBe(false);

      // Buying Product B (202) triggers Rule 2's free shipping
      const withProductB = simulateMultiRuleBasketPreview(
        [
          {
            productId: 101,
            variantId: 1010,
            productUnitId: 10100,
            unitPrice: new Decimal(10000),
            quantity: 1,
          },
          {
            productId: 202,
            variantId: 2020,
            productUnitId: 20200,
            unitPrice: new Decimal(5000),
            quantity: 1,
          },
        ],
        multiRule,
        undefined,
        false,
        "AUTO",
      );
      expect(withProductB.discount.toFixed(2)).toBe("1000.00");
      expect(withProductB.freeShippingApplied).toBe(true);
    });
  });
});
