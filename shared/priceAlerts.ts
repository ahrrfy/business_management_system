/**
 * تنبيهات الأسعار الذكية لسطور الفاتورة — **دالّة نقيّة** (بلا شبكة ولا قاعدة بيانات).
 *
 * الخادم يجلب الحقائق وحدها (`server/services/pricing/lineInsights.ts`: آخر المبيعات الفعليّة لهذا
 * العميل)، وهذا المُقيِّم يحوّل «السعر المُدخَل الآن + المرجع التاريخيّ» إلى تنبيهات بدرجة خطورة.
 * الفصل مقصود: السعر يتغيّر مع كل ضغطة مفتاح فيُعاد التقييم محلّياً بلا أيّ طلب شبكة،
 * وكلُّ تنبيهٍ قابلٌ للشرح («لأنّ فاتورة INV-… كانت بسعر …») ومُختبَرٌ بلا قاعدة.
 *
 * الأموال بـ`decimal.js` حصراً — لا `Number`/`parseFloat` على مبلغ (§٥ في CLAUDE.md).
 * الدرجات إرشاديّة فقط: لا شيءَ هنا يمنع الحفظ.
 */
import Decimal from "decimal.js";

/** مرجعُ بيعٍ سابقٍ لسطرٍ واحد (وحدة الصفّ نفسها). السعر قبل الخصم، كما حُفظ في `invoiceItems.unitPrice`. */
export type SaleRef = {
  invoiceId: number;
  invoiceNumber: string;
  /** سعر الوحدة (نص decimal) قبل خصم السطر. */
  price: string;
  /** نسبة خصم السطر وقتَها (نص decimal، "0" إن لا خصم). */
  discountPercent: string;
  /** لحظة الفاتورة ISO-8601. */
  at: string;
};

/** رؤى سطرٍ واحد من الخادم: آخر المبيعات الفعليّة لهذا العميل (الأحدث أولاً). */
export type SaleLineInsight = { lastSales: SaleRef[] };

export type PriceAlertSeverity = "good" | "info" | "warn" | "danger";

export type PriceAlertCode = "FIRST_TIME" | "SAME_AS_LAST" | "BELOW_LAST_SALE" | "ABOVE_LAST_SALE";

export type PriceAlert = {
  code: PriceAlertCode;
  severity: PriceAlertSeverity;
  /** نسبة الفرق عن آخر سعر بيع، بمنزلة عشريّة واحدة (موجبة = أعلى). غائبة في FIRST_TIME. */
  deltaPercent?: string;
  /** المرجع الذي بُنيَ عليه التنبيه — لزرّ «استخدم هذا السعر» ولسطر التفسير. */
  reference?: SaleRef;
};

/**
 * عتبات الصرامة (نسبٌ مئويّة نصّيّة). ثوابتُ مُسمّاة هنا بقصد: قرار المالك — تبدأ ثابتةً ولا تُنقل
 * إلى الإعدادات (تحتاج هجرة) قبل أن يُثبت الاستعمال حاجةً لها.
 */
export const PRICE_ALERT_THRESHOLDS = {
  /** دون هذا الفرق = «نفس السعر». */
  same: "1",
  /** فرق نزولٍ من هنا فصاعداً = تنبيه (برتقالي). */
  warn: "5",
  /** فرق نزولٍ من هنا فصاعداً = تنبيه قوي (أحمر). */
  danger: "15",
} as const;

function toDecimal(raw: string | null | undefined): Decimal | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  try {
    const d = new Decimal(text);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** أحدثُ مرجعٍ صالحٍ للمقارنة: سعره موجبٌ ومقروء (يتخطّى الأصفار — بيعٌ مجّانيّ ليس سعراً مرجعيّاً). */
export function pickReferenceSale(lastSales: readonly SaleRef[]): SaleRef | null {
  for (const ref of lastSales) {
    const price = toDecimal(ref.price);
    if (price && price.gt(0)) return ref;
  }
  return null;
}

/**
 * تنبيهات سطر بيعٍ لعميلٍ مُسمّى.
 *
 * - `lastSales` مرتّبةً من الأحدث؛ فارغة ⇒ «لم يشترِ هذا الصنف سابقاً» (معلومة).
 * - السعر المُدخَل فارغ/صفر/غير مقروء ⇒ لا تنبيه (الموظّف لم يُسعّر بعد).
 * - نزولٌ عن آخر سعر: <٥٪ معلومة، ≥٥٪ تنبيه، ≥١٥٪ تنبيه قويّ. ارتفاعٌ ≥١٪ معلومة (لا يُقلق).
 */
export function evaluateSalePriceAlerts(input: {
  enteredPrice: string | null | undefined;
  lastSales: readonly SaleRef[];
}): PriceAlert[] {
  const entered = toDecimal(input.enteredPrice);
  if (!entered || entered.lte(0)) return [];

  if (input.lastSales.length === 0) return [{ code: "FIRST_TIME", severity: "info" }];

  const reference = pickReferenceSale(input.lastSales);
  if (!reference) return [{ code: "FIRST_TIME", severity: "info" }];

  const last = new Decimal(reference.price);
  const deltaPct = entered.minus(last).dividedBy(last).times(100);
  const abs = deltaPct.abs();
  const deltaPercent = deltaPct.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);

  if (abs.lt(PRICE_ALERT_THRESHOLDS.same)) {
    return [{ code: "SAME_AS_LAST", severity: "good", deltaPercent: "0.0", reference }];
  }
  if (deltaPct.gt(0)) {
    return [{ code: "ABOVE_LAST_SALE", severity: "info", deltaPercent, reference }];
  }
  const severity: PriceAlertSeverity = abs.gte(PRICE_ALERT_THRESHOLDS.danger)
    ? "danger"
    : abs.gte(PRICE_ALERT_THRESHOLDS.warn)
      ? "warn"
      : "info";
  return [{ code: "BELOW_LAST_SALE", severity, deltaPercent, reference }];
}

/** أيامٌ كاملة منذ `atIso` حتى `now` (≥٠). تاريخ غير مقروء ⇒ `null`. */
export function daysSince(atIso: string, now: Date = new Date()): number | null {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
