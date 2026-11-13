/**
 * tests/e2e/promotions/infra/mockFixtures.ts
 *
 * Authentic Iraqi Retail Fixtures Catalog & Domain Actors
 * Al-Roya Al-Arabiya General Trading & Stationery Enterprise
 */

import Decimal from "decimal.js";

export interface MockProductUnit {
  id: number;
  unitName: string;
  conversionFactor: Decimal;
  costPrice: Decimal;
  retailPrice: Decimal;
  barcode: string;
  isBaseUnit: boolean;
}

export interface MockProduct {
  id: number;
  name: string;
  code: string;
  categoryId: number;
  categoryName: string;
  isConsignment: boolean;
  variantId: number;
  sku: string;
  units: MockProductUnit[];
}

export interface MockDigitalCard {
  id: number;
  name: string;
  code: string;
  costPrice: Decimal;
  retailPrice: Decimal;
  isDigitalCard: true;
}

export interface MockStaffActor {
  userId: number;
  name: string;
  branchId: number;
  role: "admin" | "manager" | "sales_cashier" | "reception_clerk";
  canViewCost: boolean;
  maxDiscountPercent: number; // e.g. 15% for cashiers
}

export interface MockPromotionTier {
  id?: number;
  minQuantity: Decimal;
  tierType: "PERCENT" | "AMOUNT" | "FIXED_PRICE";
  discountPercent?: Decimal;
  discountAmount?: Decimal;
  fixedPrice?: Decimal;
}

export interface MockPromotionRule {
  id: number;
  name: string;
  type: "PERCENT" | "AMOUNT" | "FIXED_PRICE" | "BUNDLE_PRICE" | "BOGO" | "TIERED_QTY";
  channel: "ALL" | "POS_ONLY" | "STORE_ONLY";
  allowBelowCost: boolean;
  applyToBaseUnitOnly: boolean;
  activeDays?: number[] | null; // [0..6] (0 = Sunday .. 6 = Saturday in Baghdad)
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  priority: number;
  isActive: boolean;
  
  // Type-specific fields
  discountPercent?: Decimal;
  discountAmount?: Decimal;
  fixedPrice?: Decimal;
  bundlePrice?: Decimal;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N";
  bundleQuantity?: number;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  bogoGetDiscountPercent?: Decimal;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS";
  tiers?: MockPromotionTier[];
  
  // Guard thresholds
  minOrderSpend?: Decimal;
  minLineAmount?: Decimal;
  maxDiscountAmount?: Decimal;

  // Targeting
  targetProductIds: Set<number>;
  targetCategoryIds: Set<number>;
  targetUnitIds: Set<number>;
}

// ---------------------------------------------------------------------------
// Authentic Iraqi Retail Catalog Items
// ---------------------------------------------------------------------------

/** باكيت أقلام جاف روترينج أزرق 0.7 ملم (مملوكة) */
export const PRD_PEN_ROTRING: MockProduct = {
  id: 101,
  name: "باكيت أقلام جاف روترينج أزرق 0.7 ملم",
  code: "ROTRING-07-BLU",
  categoryId: 10,
  categoryName: "قرطاسية وأقلام",
  isConsignment: false,
  variantId: 1001,
  sku: "SKU-ROT-07",
  units: [
    {
      id: 1011,
      unitName: "قطعة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(350),
      retailPrice: new Decimal(500),
      barcode: "628100100001",
      isBaseUnit: true,
    },
    {
      id: 1012,
      unitName: "درزن",
      conversionFactor: new Decimal(12),
      costPrice: new Decimal(4200),
      retailPrice: new Decimal(5500),
      barcode: "628100100012",
      isBaseUnit: false,
    },
    {
      id: 1013,
      unitName: "كرتون",
      conversionFactor: new Decimal(144),
      costPrice: new Decimal(50400),
      retailPrice: new Decimal(60000),
      barcode: "628100100144",
      isBaseUnit: false,
    },
  ],
};

/** دفتر سلك جامعي 200 ورقة فابر كاستل (مملوكة) */
export const PRD_NOTEBOOK_FABER: MockProduct = {
  id: 102,
  name: "دفتر سلك جامعي 200 ورقة فابر كاستل",
  code: "FABER-NB-200",
  categoryId: 10,
  categoryName: "قرطاسية وأقلام",
  isConsignment: false,
  variantId: 1002,
  sku: "SKU-FBR-200",
  units: [
    {
      id: 1021,
      unitName: "قطعة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(2400),
      retailPrice: new Decimal(3500),
      barcode: "628100200001",
      isBaseUnit: true,
    },
    {
      id: 1022,
      unitName: "باقة 5 دفاتر",
      conversionFactor: new Decimal(5),
      costPrice: new Decimal(12000),
      retailPrice: new Decimal(16000),
      barcode: "628100200005",
      isBaseUnit: false,
    },
  ],
};

/** حبر طابعة إبسون L3150 أصلي أسود 664 (بضاعة أمانة) */
export const PRD_INK_EPSON: MockProduct = {
  id: 103,
  name: "حبر طابعة إبسون L3150 أصلي أسود 664",
  code: "EPSON-INK-664-BK",
  categoryId: 20,
  categoryName: "أحبار ومستلزمات طباعة",
  isConsignment: true,
  variantId: 1003,
  sku: "SKU-EPS-664BK",
  units: [
    {
      id: 1031,
      unitName: "علبة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(9500),
      retailPrice: new Decimal(12000),
      barcode: "628100300001",
      isBaseUnit: true,
    },
  ],
};

/** وشاح تخرج مخمل مطرز ذهبي فاخر (بضاعة أمانة للتصفية) */
export const PRD_GRAD_SASH: MockProduct = {
  id: 104,
  name: "وشاح تخرج مخمل مطرز ذهبي فاخر",
  code: "GRAD-SASH-GLD",
  categoryId: 30,
  categoryName: "أرواب وأوشحة تخرج",
  isConsignment: true,
  variantId: 1004,
  sku: "SKU-SASH-GLD",
  units: [
    {
      id: 1041,
      unitName: "قطعة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(8500),
      retailPrice: new Decimal(15000),
      barcode: "628100400001",
      isBaseUnit: true,
    },
  ],
};

/** درع تكريم كريستال مع علبة قطيفة فاخرة (مملوكة) */
export const PRD_CRYSTAL_SHIELD: MockProduct = {
  id: 105,
  name: "درع تكريم كريستال مع علبة قطيفة فاخرة",
  code: "CRYSTAL-SHIELD-V1",
  categoryId: 30,
  categoryName: "هدايا ودروع تكريم",
  isConsignment: false,
  variantId: 1005,
  sku: "SKU-CRY-SHD",
  units: [
    {
      id: 1051,
      unitName: "قطعة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(14000),
      retailPrice: new Decimal(25000),
      barcode: "628100500001",
      isBaseUnit: true,
    },
  ],
};

/** قلم حبر سائل فاخر باركر أصلي (مملوكة) */
export const PRD_LUX_PEN: MockProduct = {
  id: 106,
  name: "قلم حبر سائل فاخر باركر أصلي",
  code: "PARKER-LUX-PEN",
  categoryId: 10,
  categoryName: "قرطاسية وأقلام",
  isConsignment: false,
  variantId: 1006,
  sku: "SKU-PRK-LUX",
  units: [
    {
      id: 1061,
      unitName: "علبة فردية",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(18000),
      retailPrice: new Decimal(28000),
      barcode: "628100600001",
      isBaseUnit: true,
    },
  ],
};

/** قلم جاف صيني تجاري عادي (مملوكة) */
export const PRD_CHEAP_PEN: MockProduct = {
  id: 107,
  name: "قلم جاف صيني تجاري عادي",
  code: "CHINA-BALL-PEN",
  categoryId: 10,
  categoryName: "قرطاسية وأقلام",
  isConsignment: false,
  variantId: 1007,
  sku: "SKU-CHN-PEN",
  units: [
    {
      id: 1071,
      unitName: "قطعة",
      conversionFactor: new Decimal(1),
      costPrice: new Decimal(150),
      retailPrice: new Decimal(250),
      barcode: "628100700001",
      isBaseUnit: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Digital Cards (Isolated From Promotions)
// ---------------------------------------------------------------------------

export const CARD_ZAIN_10K: MockDigitalCard = {
  id: 201,
  name: "كرت شحن زين العراق 10,000 د.ع",
  code: "DIGITAL-ZAIN-10K",
  costPrice: new Decimal(9600),
  retailPrice: new Decimal(10000),
  isDigitalCard: true,
};

export const CARD_ASIA_5K: MockDigitalCard = {
  id: 202,
  name: "كرت شحن آسياسيل 5,000 د.ع",
  code: "DIGITAL-ASIA-5K",
  costPrice: new Decimal(4800),
  retailPrice: new Decimal(5000),
  isDigitalCard: true,
};

// ---------------------------------------------------------------------------
// Staff Actors
// ---------------------------------------------------------------------------

export const CASHIER_SALWA: MockStaffActor = {
  userId: 11,
  name: "سلوى الكاشيرة",
  branchId: 1,
  role: "sales_cashier",
  canViewCost: false,
  maxDiscountPercent: 15,
};

export const CASHIER_AHMED: MockStaffActor = {
  userId: 12,
  name: "أحمد كاشير الاستقبال",
  branchId: 1,
  role: "reception_clerk",
  canViewCost: false,
  maxDiscountPercent: 15,
};

export const MANAGER_HAIDER: MockStaffActor = {
  userId: 2,
  name: "حيدر مدير الفرع",
  branchId: 1,
  role: "manager",
  canViewCost: true,
  maxDiscountPercent: 100,
};

export const ADMIN_MUSTAFA: MockStaffActor = {
  userId: 1,
  name: "مصطفى مدير النظام",
  branchId: 1,
  role: "admin",
  canViewCost: true,
  maxDiscountPercent: 100,
};

// ---------------------------------------------------------------------------
// Factory Helpers for Promotion Rules
// ---------------------------------------------------------------------------

export function createPercentPromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 501,
    name: "خصم القرطاسية 20%",
    type: "PERCENT",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 10,
    isActive: true,
    discountPercent: new Decimal(20),
    discountAmount: new Decimal(0),
    targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}

export function createAmountPromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 502,
    name: "خصم 1500 دينار على الحبر",
    type: "AMOUNT",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 10,
    isActive: true,
    discountPercent: new Decimal(0),
    discountAmount: new Decimal(1500),
    targetProductIds: new Set([PRD_INK_EPSON.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}

export function createFixedPricePromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 503,
    name: "سعر موحد 1000 د.ع للأقلام",
    type: "FIXED_PRICE",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 15,
    isActive: true,
    fixedPrice: new Decimal(1000),
    targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_CHEAP_PEN.id, PRD_LUX_PEN.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}

export function createBundlePromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 504,
    name: "باقة حقيبة الطالب 9000 د.ع",
    type: "BUNDLE_PRICE",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 20,
    isActive: true,
    bundlePrice: new Decimal(9000),
    bundleMode: "ALL_REQUIRED",
    bundleQuantity: 3,
    targetProductIds: new Set([PRD_PEN_ROTRING.id, PRD_NOTEBOOK_FABER.id, PRD_CRYSTAL_SHIELD.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}

export function createBogoPromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 505,
    name: "اشترِ 2 واحصل على 1 مجاناً",
    type: "BOGO",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 15,
    isActive: true,
    bogoBuyQuantity: 2,
    bogoGetQuantity: 1,
    bogoGetDiscountPercent: new Decimal(100),
    targetProductIds: new Set([PRD_NOTEBOOK_FABER.id, PRD_PEN_ROTRING.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}

export function createTieredQtyPromoFixture(
  overrides?: Partial<MockPromotionRule>
): MockPromotionRule {
  return {
    id: 506,
    name: "شرائح كميات حبر إبسون",
    type: "TIERED_QTY",
    channel: "ALL",
    allowBelowCost: false,
    applyToBaseUnitOnly: true,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    priority: 10,
    isActive: true,
    tieredMode: "PER_ITEM",
    tiers: [
      {
        minQuantity: new Decimal(5),
        tierType: "AMOUNT",
        discountAmount: new Decimal(1500),
      },
      {
        minQuantity: new Decimal(10),
        tierType: "AMOUNT",
        discountAmount: new Decimal(3000),
      },
    ],
    targetProductIds: new Set([PRD_INK_EPSON.id]),
    targetCategoryIds: new Set(),
    targetUnitIds: new Set(),
    ...overrides,
  };
}
