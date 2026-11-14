/**
 * client/src/components/offers/offersTypes.ts
 *
 * Shared domain models, types, schemas, Iraqi commercial terms, and view models
 * for the Offers & Promotions subsystem (Tier 1 Features F13–F18).
 */

import type { RouterOutputs } from "@/lib/trpc";
import { normalizeBarcodeScannerInput } from "@shared/barcodeScanner";
import { evaluateCartPromotions, type PromotionRule } from "@shared/promotionEngine";
import Decimal from "decimal.js";

export type OfferRow = RouterOutputs["salesPromotions"]["list"][number];
export type PromotionDetail = NonNullable<RouterOutputs["salesPromotions"]["getById"]>;

export type PromoType =
  | "PERCENT"
  | "AMOUNT"
  | "FIXED_PRICE"
  | "BUNDLE_PRICE"
  | "BOGO"
  | "TIERED_QTY"
  | "FREE_SHIPPING";

export type PromoScope = "ALL" | "CATEGORIES" | "PRODUCTS";
export type CustomerTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT" | "";
export type ApplicationMode = "AUTO" | "COUPON";
export type PromoChannel = "ALL" | "POS_ONLY" | "STORE_ONLY" | "POS" | "STORE";
export type ChannelFilter = "ALL" | "POS" | "STORE";
export type ValidityFilter = "ALL" | "CURRENT" | "SCHEDULED" | "EXPIRED";
export type BundleMode = "ALL_REQUIRED" | "PICK_ANY_N";
export type TieredMode = "PER_ITEM" | "POOL_ACROSS_TARGETS";
export type TierType = "PERCENT" | "AMOUNT" | "FIXED_PRICE";

export interface TargetPick {
  kind: "category" | "product";
  id: number;
  label: string;
  productUnitId?: number | null;
  unitName?: string;
}

export interface OfferPackagingUnit {
  id: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  retailPrice: string;
}

export interface SelectedOfferItem {
  targetGrain?: "PRODUCT" | "VARIANT" | "UNIT";
  productId: number;
  productName: string;
  productCode: string;
  variantId: number;
  sku: string;
  variantKind?: "VARIANT" | "ALTERNATIVE";
  isConsignment: boolean;
  costPrice: string | null; // null if masked by RBAC
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  retailPrice: string;
  barcode: string | null;
  isBaseUnit: boolean;
  units: OfferPackagingUnit[];
}

export interface OfferTierItem {
  id?: number;
  minQuantity: string;
  tierType: TierType;
  discountPercent?: string;
  discountAmount?: string;
  fixedPrice?: string;
}

export type ScopeSharingMode = "SHARED" | "PER_RULE";

export interface OfferRuleDraft {
  key: string;
  ruleLabel: string;
  type: PromoType;
  discountPercent: string;
  discountAmount: string;
  maxDiscountAmount: string;
  fixedPrice: string;
  bundlePrice: string;
  bundleMode: BundleMode;
  bundleQuantity: number;
  bogoBuyQuantity: number;
  bogoGetQuantity: number;
  bogoGetDiscountPercent: string;
  tieredMode: TieredMode;
  tiers: OfferTierItem[];
  scope: PromoScope;
  selectedCategories: number[];
  selectedProducts: SelectedOfferItem[];
  allowBelowCost: boolean;
  applyToBaseUnitOnly: boolean;
  minLineAmount: string;
}

export interface OfferOperationalSignals {
  activeNow: OfferRow[];
  scheduled: OfferRow[];
  expiredActive: OfferRow[];
  unusedActive: OfferRow[];
  negative: OfferRow[];
}

export interface OfferPerformanceSummary {
  invoiceCount: number;
  netSales: string | number;
  discount: string | number;
  cost?: string | number | null;
  grossProfit: string | number | null;
}

export interface OfferFormData {
  id?: number;
  name: string;
  description: string;
  campaignId: string;
  priority: string;
  applicationMode: ApplicationMode;
  type: PromoType;
  discountPercent: string;
  discountAmount: string;
  maxDiscountAmount: string;
  fixedPrice: string;
  bundlePrice: string;
  bundleMode: BundleMode;
  bundleQuantity: number;
  bogoBuyQuantity: number;
  bogoGetQuantity: number;
  bogoGetDiscountPercent: string;
  tieredMode: TieredMode;
  tiers: OfferTierItem[];
  scope: PromoScope;
  selectedCategories: number[];
  selectedProducts: SelectedOfferItem[];
  allowBelowCost: boolean;
  applyToBaseUnitOnly: boolean;
  minLineAmount: string;
  minOrderSpend: string;
  channel: PromoChannel;
  branchId?: string;
  freeShipping?: boolean;
  shippingPerkEnabled?: boolean;
  shippingDiscountAmount?: string;
  effectiveFrom: string;
  effectiveTo: string;
  customerTier: CustomerTier;
  activeDays: number[];
  extraRules?: OfferRuleDraft[];
  scopeSharingMode?: ScopeSharingMode;
}

export interface SimulatorCartItem {
  productId: number;
  variantId?: number;
  productUnitId?: number;
  productName: string;
  unitName: string;
  unitPrice: Decimal;
  quantity: Decimal;
  isBaseUnit?: boolean;
  costPrice?: Decimal;
}

export interface BasketPreviewOutput {
  grossTotal: Decimal;
  discount: Decimal;
  netTotal: Decimal;
  savingsPercent: Decimal;
  helperNote: string | null;
}

export interface SimulateBasketRule {
  type: PromoType;
  freeShipping?: boolean;
  percent?: Decimal;
  minSpend?: Decimal;
  maxDiscountAmount?: Decimal;
  minLineAmount?: Decimal;
  discountAmount?: Decimal;
  fixedPrice?: Decimal;
  bundlePrice?: Decimal;
  bundleMode?: BundleMode;
  bundleQuantity?: number;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  bogoGetDiscountPercent?: Decimal;
  tieredMode?: TieredMode;
  tiers?: OfferTierItem[];
  applyToBaseUnitOnly?: boolean;
  targetProductIds?: number[];
  targetVariantIds?: number[];
  targetUnitIds?: number[];
  targetCategoryIds?: number[];
}

export interface LiveMarginResult {
  promoPrice: Decimal;
  marginPercent: Decimal;
  isBelowCost: boolean;
  isCeilingViolated: boolean;
  badgeStyle: "positive" | "negative" | "warning";
}

// ---------------------------------------------------------------------------
// Authentic Iraqi Commercial Arabic Terminology
// ---------------------------------------------------------------------------

export const PROMO_TYPE_LABELS: Record<PromoType, string> = {
  PERCENT: "خصم نسبة (%)",
  AMOUNT: "خصم مبلغ ثابت",
  FIXED_PRICE: "سعر موحد للمادة",
  BUNDLE_PRICE: "عرض بكج (مجموعة مواد)",
  BOGO: "اشتري واحصل على مجاني / خصم",
  TIERED_QTY: "خصم حسب الكمية (جملة)",
  FREE_SHIPPING: "توصيل مجاني",
};

export const CHANNEL_LABELS: Record<string, string> = {
  ALL: "كل القنوات (المحل + المتجر الإلكتروني)",
  POS_ONLY: "مبيعات المحل والفروع فقط",
  STORE_ONLY: "المتجر الإلكتروني والتطبيق فقط",
  POS: "مبيعات المحل والفروع",
  STORE: "المتجر الإلكتروني",
};

export const APPLICATION_LABELS: Record<ApplicationMode, string> = {
  AUTO: "تلقائي",
  COUPON: "بكود خصم (كوبون)",
};

export const SCOPE_LABELS: Record<PromoScope, string> = {
  ALL: "كل المواد",
  CATEGORIES: "أقسام محددة",
  PRODUCTS: "مواد محددة",
};

export const CUSTOMER_TIER_LABELS: Record<CustomerTier, string> = {
  "": "كل الزبائن",
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "دوائر ومؤسسات",
};

export const ACTIVE_DAYS_LIST = [
  { day: 0, label: "الأحد" },
  { day: 1, label: "الإثنين" },
  { day: 2, label: "الثلاثاء" },
  { day: 3, label: "الأربعاء" },
  { day: 4, label: "الخميس" },
  { day: 5, label: "الجمعة" },
  { day: 6, label: "السبت" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toYmd(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function offerActivationState(
  offer: { isActive: boolean; effectiveFrom: unknown; effectiveTo: unknown },
  today: string
) {
  if (!offer.isActive) {
    return {
      label: "معطَّل",
      className: "bg-muted text-muted-foreground border-border",
      note: "لا يُطبّق",
    };
  }
  const startsOn = toYmd(offer.effectiveFrom);
  const endsOn = offer.effectiveTo ? toYmd(offer.effectiveTo) : "";
  if (startsOn > today) {
    return {
      label: "يبدأ لاحقاً",
      className: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
      note: `من ${startsOn}`,
    };
  }
  if (endsOn && endsOn < today) {
    return {
      label: "انتهى تاريخياً",
      className: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30",
      note: `انتهى في ${endsOn}`,
    };
  }
  return {
    label: "سارٍ الآن",
    className: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30",
    note: "مفعل وضمن نافذته",
  };
}

/**
 * Live Margin & Pricing Calculation (Pure Function Contract)
 */
export function calculateLiveMargin(
  retailPrice: Decimal,
  costPrice: Decimal,
  promoType: "PERCENT" | "AMOUNT" | "FIXED_PRICE",
  promoValue: Decimal,
  maxDiscountCap?: Decimal | null
): LiveMarginResult {
  const cap =
    maxDiscountCap != null && maxDiscountCap.isFinite() && maxDiscountCap.gt(0)
      ? maxDiscountCap
      : null;
  let promoPrice = retailPrice;

  if (promoType === "PERCENT") {
    let disc = retailPrice.mul(promoValue).div(100);
    if (cap && disc.gt(cap)) disc = cap;
    promoPrice = Decimal.max(0, retailPrice.minus(disc));
  } else if (promoType === "AMOUNT") {
    let disc = promoValue;
    if (cap && disc.gt(cap)) disc = cap;
    promoPrice = Decimal.max(0, retailPrice.minus(disc));
  } else if (promoType === "FIXED_PRICE") {
    // Ceiling: never increases
    if (cap) {
      let disc = retailPrice.gt(promoValue) ? retailPrice.minus(promoValue) : new Decimal(0);
      if (disc.gt(cap)) disc = cap;
      promoPrice = Decimal.max(0, retailPrice.minus(disc));
    } else {
      promoPrice = Decimal.min(retailPrice, promoValue);
    }
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

// ---------------------------------------------------------------------------
// Safe Decimal Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parses any unknown value into a valid Decimal instance.
 * Never throws [DecimalError]. Returns fallback if value is null, undefined,
 * empty string, whitespace, non-numeric, NaN, or non-finite.
 */
export function safeDecimal(
  val: unknown,
  fallback: Decimal = new Decimal(0)
): Decimal {
  if (val instanceof Decimal) {
    return val.isNaN() || !val.isFinite() ? fallback : val;
  }
  if (val == null) return fallback;
  if (typeof val === "number") {
    return isNaN(val) || !isFinite(val) ? fallback : new Decimal(val);
  }
  const str = String(val).trim();
  if (str === "") return fallback;
  try {
    const d = new Decimal(str);
    return d.isNaN() || !d.isFinite() ? fallback : d;
  } catch {
    return fallback;
  }
}

/**
 * Returns Decimal if valid and strictly greater than 0, otherwise undefined.
 */
export function safePositiveDecimal(val: unknown): Decimal | undefined {
  const d = safeDecimal(val);
  return d.gt(0) ? d : undefined;
}

// ---------------------------------------------------------------------------
// Pure Basket Preview Simulation Contract
// ---------------------------------------------------------------------------

export function deriveSimulatorTargetCollections(
  items: Array<{
    productId: number;
    variantId?: number;
    productUnitId?: number;
    isBaseUnit?: boolean;
    targetGrain?: "PRODUCT" | "VARIANT" | "UNIT";
  }>
): {
  targetProductIds: number[];
  targetVariantIds: number[];
  targetUnitIds: number[];
} {
  const variantCountsByProduct = new Map<number, number>();
  const unitCountsByVariant = new Map<number, number>();
  for (const p of items) {
    variantCountsByProduct.set(p.productId, (variantCountsByProduct.get(p.productId) ?? 0) + 1);
    if (p.variantId != null) {
      unitCountsByVariant.set(p.variantId, (unitCountsByVariant.get(p.variantId) ?? 0) + 1);
    }
  }
  const targetProductIds: number[] = [];
  const targetVariantIds: number[] = [];
  const targetUnitIds: number[] = [];
  for (const p of items) {
    if (
      (p.targetGrain === "UNIT" ||
        p.isBaseUnit === false ||
        (p.variantId != null && (unitCountsByVariant.get(p.variantId) ?? 0) > 1)) &&
      p.productUnitId != null
    ) {
      targetUnitIds.push(Number(p.productUnitId));
    } else if (
      (p.targetGrain === "VARIANT" || (variantCountsByProduct.get(p.productId) ?? 0) > 1) &&
      p.variantId != null
    ) {
      targetVariantIds.push(Number(p.variantId));
    } else {
      targetProductIds.push(Number(p.productId));
    }
  }
  return {
    targetProductIds: Array.from(new Set(targetProductIds)),
    targetVariantIds: Array.from(new Set(targetVariantIds)),
    targetUnitIds: Array.from(new Set(targetUnitIds)),
  };
}

/**
 * Pure function: Simulates basket preview calculation matching promotion contracts.
 * Free of DOM and UI dependencies; 100% testable in Node and browser.
 */
export function simulateBasketPreview(
  items: Array<{
    productId: number;
    variantId?: number;
    productUnitId?: number;
    isBaseUnit?: boolean;
    unitPrice: Decimal | number | string;
    quantity: Decimal | number | string;
  }>,
  rule: SimulateBasketRule
): BasketPreviewOutput {
  const grossTotal = items.reduce(
    (acc, i) => acc.plus(safeDecimal(i.unitPrice).mul(safeDecimal(i.quantity))),
    new Decimal(0)
  );

  if (items.length === 0 || grossTotal.lte(0)) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: null,
    };
  }

  // Minimum spend threshold check
  const minSpend = rule.minSpend ? safeDecimal(rule.minSpend) : undefined;
  if (minSpend && minSpend.gt(0) && grossTotal.lt(minSpend)) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: `الحد الأدنى للطلب (${minSpend.toFixed(2)} د.ع) غير مستوفى`,
    };
  }

  const evalItems = items
    .map((item, idx) => ({
      lineKey: String(idx),
      productId: item.productId,
      variantId: item.variantId ?? item.productId,
      productUnitId: item.productUnitId ?? item.productId,
      categoryId: null,
      unitPrice: safeDecimal(item.unitPrice),
      quantity: safeDecimal(item.quantity),
      isBaseUnit: item.isBaseUnit ?? true,
      hasContractPrice: false,
      isBundle: false,
      isGift: false,
      isDigitalCard: false,
      isService: false,
    }))
    .filter((i) => i.quantity.gt(0));

  if (evalItems.length === 0) {
    return {
      grossTotal,
      discount: new Decimal(0),
      netTotal: grossTotal,
      savingsPercent: new Decimal(0),
      helperNote: null,
    };
  }

  const bundleMode: BundleMode = rule.bundleMode ?? "ALL_REQUIRED";
  const hasExplicitTargets =
    (rule.targetProductIds?.length ?? 0) > 0 ||
    (rule.targetVariantIds?.length ?? 0) > 0 ||
    (rule.targetUnitIds?.length ?? 0) > 0 ||
    (rule.targetCategoryIds?.length ?? 0) > 0;
  const resolvedTargets = hasExplicitTargets
    ? {
        targetProductIds: Array.from(new Set(rule.targetProductIds ?? [])),
        targetVariantIds: Array.from(new Set(rule.targetVariantIds ?? [])),
        targetUnitIds: Array.from(new Set(rule.targetUnitIds ?? [])),
        targetCategoryIds: Array.from(new Set(rule.targetCategoryIds ?? [])),
      }
    : rule.type === "BUNDLE_PRICE"
      ? { ...deriveSimulatorTargetCollections(items), targetCategoryIds: [] as number[] }
      : null;
  const useCategoryScope =
    resolvedTargets != null &&
    resolvedTargets.targetCategoryIds.length > 0 &&
    resolvedTargets.targetProductIds.length === 0 &&
    resolvedTargets.targetVariantIds.length === 0 &&
    resolvedTargets.targetUnitIds.length === 0;

  const engineRule: PromotionRule = {
    id: 1,
    name: "معاينة العرض",
    type: rule.type,
    scope: resolvedTargets ? (useCategoryScope ? "CATEGORIES" : "PRODUCTS") : "ALL",
    channel: "ALL",
    applicationMode: "AUTO",
    priority: 1,
    isActive: true,
    allowBelowCost: true,
    applyToBaseUnitOnly: rule.applyToBaseUnitOnly ?? false,
    discountPercent: rule.percent ? safeDecimal(rule.percent) : undefined,
    discountAmount: rule.discountAmount ? safeDecimal(rule.discountAmount) : undefined,
    maxDiscountAmount: rule.maxDiscountAmount ? safeDecimal(rule.maxDiscountAmount) : undefined,
    minOrderSpend: minSpend,
    minLineAmount: rule.minLineAmount ? safeDecimal(rule.minLineAmount) : undefined,
    fixedPrice: rule.fixedPrice ? safeDecimal(rule.fixedPrice) : undefined,
    bundlePrice: rule.bundlePrice ? safeDecimal(rule.bundlePrice) : undefined,
    bundleMode,
    bundleQuantity: bundleMode === "PICK_ANY_N" ? Math.max(1, rule.bundleQuantity ?? 2) : undefined,
    bogoBuyQuantity: Math.max(1, rule.bogoBuyQuantity ?? 2),
    bogoGetQuantity: Math.max(1, rule.bogoGetQuantity ?? 1),
    bogoGetDiscountPercent: rule.bogoGetDiscountPercent
      ? safeDecimal(rule.bogoGetDiscountPercent)
      : new Decimal(100),
    tieredMode: rule.tieredMode ?? "PER_ITEM",
    tiers: (rule.tiers ?? [])
      .filter((t) => safeDecimal(t.minQuantity).gt(0))
      .map((t) => ({
        minQuantity: safeDecimal(t.minQuantity),
        tierType: t.tierType,
        discountPercent: t.discountPercent ? safeDecimal(t.discountPercent) : undefined,
        discountAmount: t.discountAmount ? safeDecimal(t.discountAmount) : undefined,
        fixedPrice: t.fixedPrice ? safeDecimal(t.fixedPrice) : undefined,
      })),
    ...(resolvedTargets
      ? {
          ...(resolvedTargets.targetProductIds.length > 0
            ? { targetProductIds: resolvedTargets.targetProductIds }
            : {}),
          ...(resolvedTargets.targetVariantIds.length > 0
            ? { targetVariantIds: resolvedTargets.targetVariantIds }
            : {}),
          ...(resolvedTargets.targetUnitIds.length > 0
            ? { targetUnitIds: resolvedTargets.targetUnitIds }
            : {}),
          ...(resolvedTargets.targetCategoryIds.length > 0
            ? { targetCategoryIds: resolvedTargets.targetCategoryIds }
            : {}),
        }
      : {}),
  };

  const evaluated = evaluateCartPromotions(evalItems, [engineRule], {
    branchId: 1,
    customerTier: "RETAIL",
    channel: "POS",
    todayYmd: "2026-06-15",
  });

  const discount = Decimal.min(evaluated.totalCartDiscount, grossTotal).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );
  const netTotal = grossTotal.minus(discount);
  const savingsPercent = grossTotal.gt(0)
    ? discount.div(grossTotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  let helperNote: string | null = null;
  if (discount.eq(0)) {
    if (rule.type === "BUNDLE_PRICE" && bundleMode === "ALL_REQUIRED" && resolvedTargets) {
      const presentProducts = new Set(evalItems.map((i) => i.productId));
      const presentVariants = new Set(evalItems.map((i) => i.variantId));
      const presentUnits = new Set(evalItems.map((i) => i.productUnitId));
      const missingAny =
        resolvedTargets.targetProductIds.some((pid) => !presentProducts.has(pid)) ||
        resolvedTargets.targetVariantIds.some((vid) => !presentVariants.has(vid)) ||
        resolvedTargets.targetUnitIds.some((uid) => !presentUnits.has(uid));
      if (missingAny) {
        helperNote = "باقة (كل المواد مطلوبة): يجب توفر كمية 1 على الأقل من جميع أصناف الباقة لتفعيل السعر الموحد.";
      }
    } else if (rule.type === "BUNDLE_PRICE" && bundleMode === "PICK_ANY_N") {
      const totalQty = evalItems.reduce((acc, i) => acc.plus(i.quantity), new Decimal(0));
      const reqQty = Math.max(1, rule.bundleQuantity ?? 2);
      if (totalQty.lt(reqQty)) {
        helperNote = `باقة (اختر أي ${reqQty}): أضف كميات حتى تصل إلى ${reqQty} وحدات لتفعيل سعر الباقة.`;
      }
    } else if (rule.type === "TIERED_QTY" && (rule.tiers?.length ?? 0) > 0) {
      helperNote = "لم تصل الكميات في السلة بعد إلى عتبة التفعيل الدنيا لشرائح الكميات.";
    }
  }

  return {
    grossTotal,
    discount,
    netTotal,
    savingsPercent,
    helperNote,
  };
}
