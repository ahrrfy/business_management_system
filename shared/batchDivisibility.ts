import { QUANTITY_SCALE, quantityDecimal } from "./quantity";

/** المواد محفوظة بأربع منازل عشرية؛ لا يفرض كسر المادة مضاعفات على عدد الناتج. */

/** أقصى منازل عشرية يخزّنها محرّر الوصفات لمعامِل المكوّن (`qtyPerOutputBase`). */
export const RECIPE_COEF_DECIMALS = QUANTITY_SCALE;

/** كل دفعة صحيحة موجبة قابلة للتحجيم ضمن حدود دقة المخزون. */
export const MAX_BATCH_MULTIPLE = 1;

/**
 * 1 للمعامل الصالح، و0 عند غياب أي دفعة صالحة. لا يرمي أثناء الكتابة في محرر الوصفة.
 */
export function coefficientBatchMultiple(coef: string | number): number {
  try {
    return quantityDecimal(coef).gt(0) ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * تبقى أسماء العقد متوافقة مع شاشات الإنتاج؛ الصفر يعني وجود معامل غير صالح.
 */
export function requiredBatchMultiple(coefficients: Array<string | number>): number {
  return coefficients.every((coefficient) => coefficientBatchMultiple(coefficient) === 1) ? 1 : 0;
}

/** هل هذه الدفعة صالحة لهذه المعامِلات؟ */
export function isBatchDivisible(coefficients: Array<string | number>, batch: number): boolean {
  if (!Number.isSafeInteger(batch) || batch <= 0 || requiredBatchMultiple(coefficients) !== 1) return false;
  try {
    quantityDecimal(batch);
    for (const coefficient of coefficients) quantityDecimal(quantityDecimal(coefficient).times(batch));
    return true;
  } catch {
    return false;
  }
}

/** أكبر دفعةٍ صالحة لا تتجاوز سقفاً (تُستعمل لقصّ «الأقصى الممكن إنتاجه» على المضاعف). */
export function largestValidBatchAtMost(cap: number, multiple: number): number {
  const m = Number.isInteger(multiple) && multiple > 0 ? multiple : 1;
  if (!Number.isFinite(cap) || cap < m) return 0;
  return Math.floor(cap / m) * m;
}

/** جملة عربية جاهزة تشرح القيد — نصٌّ واحدٌ لا يُعاد صوغه في كل شاشة. */
export function batchMultipleNote(multiple: number): string | null {
  if (!Number.isInteger(multiple) || multiple <= 1) return null;
  return `هذه الوصفة تقبل دفعاتٍ مضاعفةً لـ${multiple} فقط (${multiple} · ${multiple * 2} · ${multiple * 3} …) — لأنّ أحد معامِلاتها كسريّ بالوحدة الأساس.`;
}
