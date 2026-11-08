/**
 * CATALOG-SURGICAL-20261107 — نموذج تصنيف الاستخدام المخزني للأصناف المملوكة.
 *
 * القيم المسموحة للصنف المخزني المملوك (`!isService && !isBundle && !isConsignment`):
 * - `SALE_ONLY`: سلعة جاهزة للبيع فقط (الافتراضي لإضافة سلعة جديدة).
 * - `MATERIAL_ONLY`: مادة خام للإنتاج وأوامر العمل فقط (الافتراضي لإضافة مادة خام).
 * - `SALE_AND_MATERIAL`: صنف مزدوج الاستخدام في سجلّ واحد (يُباع ويُستهلك في الوصفات/أوامر العمل).
 * - `OPERATING_SUPPLY`: مستلزم تشغيل داخلي يُشترى ويُخزَّن ويُصرف داخلياً في المصروفات.
 *
 * السجلات التاريخية ذات `stockUsage = null` غير المصنّفة تتبع قواعدها القائمة (توافق خلفي).
 */

export const STOCK_USAGES = [
  "SALE_ONLY",
  "MATERIAL_ONLY",
  "SALE_AND_MATERIAL",
  "OPERATING_SUPPLY",
] as const;

export const STOCK_USAGE_VALUES = STOCK_USAGES;

export type StockUsage = (typeof STOCK_USAGES)[number];

export const STOCK_USAGE_LABELS: Record<StockUsage, string> = {
  SALE_ONLY: "للبيع فقط",
  MATERIAL_ONLY: "مادة خام (إنتاج وأوامر عمل)",
  SALE_AND_MATERIAL: "مزدوج الاستخدام (بيع + إنتاج)",
  OPERATING_SUPPLY: "مستلزم تشغيل (صرف داخلي)",
};

export const STOCK_USAGE_DESCRIPTIONS: Record<StockUsage, string> = {
  SALE_ONLY: "يُشترى ويُجرد ويُباع في قنوات المبيعات؛ محجوب عن الوصفات وأوامر العمل والصرف الداخلي.",
  MATERIAL_ONLY: "يدخل في الشراء والجرد والوصفات وأوامر العمل؛ محجوب عن جميع قنوات البيع والمتجر.",
  SALE_AND_MATERIAL: "سجلّ موحّد يُسمح ببيعه واستهلاكه كمادة خام في الوصفات وأوامر العمل.",
  OPERATING_SUPPLY: "يدخل في الشراء والمخزن والصرف الداخلي للمصروفات؛ محجوب عن قنوات البيع والوصفات.",
};

export interface ProductStructuralFlags {
  isService?: boolean | null;
  isBundle?: boolean | null;
  isConsignment?: boolean | null;
}

/** الصنف المخزني المملوك وحده يحمل `stockUsage`؛ الخدمة والبكج والأمانة لها مساراتها المستقلة. */
export function canCarryStockUsage(flags: ProductStructuralFlags): boolean {
  return !flags.isService && !flags.isBundle && !flags.isConsignment;
}

/** هل يُسمح ببيع الصنف في قنوات البيع (POS / الاستقبال / العروض / الحجز / المتجر / الأوفلاين)؟ */
export function isSellableStockUsage(
  stockUsage: StockUsage | null | undefined,
): boolean {
  return (
    stockUsage == null ||
    stockUsage === "SALE_ONLY" ||
    stockUsage === "SALE_AND_MATERIAL"
  );
}

/** هل يُسمح باستهلاك الصنف كمادة في الوصفات وأوامر العمل وتجهيز البكجات؟ */
export function isMaterialEligibleStockUsage(
  stockUsage: StockUsage | null | undefined,
): boolean {
  return (
    stockUsage == null ||
    stockUsage === "MATERIAL_ONLY" ||
    stockUsage === "SALE_AND_MATERIAL"
  );
}

export const isMaterialStockUsage = isMaterialEligibleStockUsage;

/** هل يُسمح بصرف الصنف داخلياً عبر المصروفات المخزنية (`expenseStockItems`)؟ */
export function isOperatingSupplyEligibleStockUsage(
  stockUsage: StockUsage | null | undefined,
): boolean {
  return stockUsage == null || stockUsage === "OPERATING_SUPPLY";
}

export const isOperatingSupplyStockUsage = isOperatingSupplyEligibleStockUsage;

/** الاشتقاق الافتراضي عند إنشاء صنف جديد (يحافظ على الحارس حتى لو أُرسل بدون الحقل من واجهة أقدم). */
export function resolveCreateStockUsage(
  flags: ProductStructuralFlags & {
    stockUsage?: StockUsage | null;
    isRawMaterialPreset?: boolean;
  },
): StockUsage | null {
  if (!canCarryStockUsage(flags)) {
    return null;
  }
  if (flags.stockUsage != null) {
    return flags.stockUsage;
  }
  return flags.isRawMaterialPreset ? "MATERIAL_ONLY" : "SALE_ONLY";
}
