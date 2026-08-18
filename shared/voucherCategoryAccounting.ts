/**
 * العقد المحاسبي لفئات سندات القبض والصرف الحرة (partyType=OTHER).
 *
 * الفئة لا تختار حساب النقد؛ طريقة الدفع/الدلو تحدده. هذا الدور هو الحساب
 * المقابل فقط: دائن في القبض، ومدين في الصرف. القائمة مغلقة عمداً كي لا
 * تتحول شاشة السند إلى باب خلفي للمخزون أو الذمم أو الأصول الثابتة.
 */
export const VOUCHER_CATEGORY_POSTING_ROLES = [
  "OTHER_REVENUE",
  "CAPITAL",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
  "OTHER_LIABILITY",
  "SALARIES",
  "RENT",
  "UTILITIES",
  "OPERATING_EXPENSE",
  "DELIVERY_EXPENSE",
  "GIFTS_PROMO",
  "LOSSES",
  "OTHER_EXPENSE",
] as const;

export type VoucherCategoryPostingRole =
  (typeof VOUCHER_CATEGORY_POSTING_ROLES)[number];
export type VoucherCategoryDirection = "IN" | "OUT" | "BOTH";

export interface VoucherCategoryPostingRoleOption {
  role: VoucherCategoryPostingRole;
  label: string;
  directions: readonly ("IN" | "OUT")[];
}

export const VOUCHER_CATEGORY_POSTING_ROLE_OPTIONS: readonly VoucherCategoryPostingRoleOption[] =
  Object.freeze([
    { role: "OTHER_REVENUE", label: "إيراد — إيرادات أخرى", directions: ["IN"] },
    { role: "CAPITAL", label: "حقوق ملكية — رأس المال", directions: ["IN"] },
    { role: "OWNER_CURRENT", label: "حقوق ملكية — الحساب الجاري للمالك", directions: ["IN", "OUT"] },
    { role: "LOAN_PAYABLE", label: "التزام — قروض مستحقة", directions: ["IN", "OUT"] },
    { role: "OTHER_LIABILITY", label: "التزام — التزامات وأمانات أخرى", directions: ["IN", "OUT"] },
    { role: "SALARIES", label: "مصروف — الرواتب والأجور", directions: ["OUT"] },
    { role: "RENT", label: "مصروف — الإيجار", directions: ["OUT"] },
    { role: "UTILITIES", label: "مصروف — الكهرباء والخدمات", directions: ["OUT"] },
    { role: "OPERATING_EXPENSE", label: "مصروف — تشغيل عام", directions: ["OUT"] },
    { role: "DELIVERY_EXPENSE", label: "مصروف — التوصيل", directions: ["OUT"] },
    { role: "GIFTS_PROMO", label: "مصروف — هدايا وترويج", directions: ["OUT"] },
    { role: "LOSSES", label: "خسارة — خسائر تشغيلية", directions: ["OUT"] },
    { role: "OTHER_EXPENSE", label: "مصروف — مصروفات أخرى", directions: ["OUT"] },
  ] satisfies VoucherCategoryPostingRoleOption[]);

const OPTION_BY_ROLE = new Map(
  VOUCHER_CATEGORY_POSTING_ROLE_OPTIONS.map((option) => [option.role, option]),
);

export function isVoucherCategoryPostingRole(
  value: unknown,
): value is VoucherCategoryPostingRole {
  return typeof value === "string" && OPTION_BY_ROLE.has(value as VoucherCategoryPostingRole);
}

export function isVoucherCategoryRoleCompatible(
  direction: VoucherCategoryDirection,
  role: unknown,
): role is VoucherCategoryPostingRole {
  if (!isVoucherCategoryPostingRole(role)) return false;
  const supported = OPTION_BY_ROLE.get(role)!.directions;
  return direction === "BOTH"
    ? supported.includes("IN") && supported.includes("OUT")
    : supported.includes(direction);
}

export function voucherCategoryRoleLabel(role: string | null | undefined): string {
  if (!role) return "غير معيّن";
  return OPTION_BY_ROLE.get(role as VoucherCategoryPostingRole)?.label ?? role;
}

export function voucherCategoryRoleOptionsFor(
  direction: VoucherCategoryDirection,
): readonly VoucherCategoryPostingRoleOption[] {
  return VOUCHER_CATEGORY_POSTING_ROLE_OPTIONS.filter((option) =>
    direction === "BOTH"
      ? option.directions.includes("IN") && option.directions.includes("OUT")
      : option.directions.includes(direction),
  );
}

/** تعيينات واضحة فقط. الفئات الملتبسة تبقى بلا تعيين حتى يعتمدها المالك. */
export const IRAQI_DEFAULT_VOUCHER_CATEGORY_ROLE: Readonly<
  Record<string, VoucherCategoryPostingRole>
> = Object.freeze({
  "إيجار": "RENT",
  "رواتب": "SALARIES",
  "خدمات (ماء/كهرباء/إنترنت)": "UTILITIES",
  "صيانة وإصلاح": "OPERATING_EXPENSE",
  "مواصلات ووقود": "OPERATING_EXPENSE",
  "قرطاسية ونثريات": "OPERATING_EXPENSE",
  "إعلانات وتسويق": "OPERATING_EXPENSE",
  "تبرّعات ومساعدات": "OTHER_EXPENSE",
  "سحب شخصي/مالك": "OWNER_CURRENT",
  "عُمولات وأتعاب": "OPERATING_EXPENSE",
  "مصاريف بنكية": "OPERATING_EXPENSE",
  "إيرادات متفرّقة": "OTHER_REVENUE",
  "فوائد بنكية": "OTHER_REVENUE",
});

/**
 * فئات 0036 التي بقيت بلا تعيينٍ محاسبيّ لأنّها غامضة بنيوياً (كلٌّ منها يخفي معاملتين).
 * هجرة 0202 حسمت «ضرائب ورسوم حكومية» (مصروفٌ موضوعيّ ⇒ OTHER_EXPENSE) فخرجت من القائمة،
 * وبقي الثلاثة الغامضة فعلاً — وهي نفسها `RETIRED_VOUCHER_CATEGORIES` في
 * `shared/voucherCategoryDefaults.ts` (يحرس التطابق اختبار وحدة). الواجهة تستعملها لتقول
 * «تحتاج مساراً تخصصياً» بدل «غير معيّن» — رسالةٌ صادقة تُوجّه للبديل بدل أن تطلب تخميناً.
 */
export const UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES = Object.freeze([
  "إيداع نقدي بنكي",
  "ردّ مَردودات/استرداد",
  "أخرى",
] as const);
