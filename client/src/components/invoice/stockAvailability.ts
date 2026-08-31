import type { InvoiceLine } from "./types";

export interface LineStockState {
  isKnown: boolean;
  isService: boolean;
  /** «يُباع بالطلب»: الخادم يقبله قبل التوريد ⇒ لا نافد ولا ناقص، والرصيد يبقى معروضاً كما هو. */
  allowBackorder: boolean;
  isOut: boolean;
  isShort: boolean;
  onHandBase: number;
  reservedBase: number;
  availableBase: number;
  availableInUnit: number;
  overbookedBase: number;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * يحوّل لقطة المخزون الخادمية إلى دلالة عرض واحدة لكل مسارات إضافة سطر الفاتورة.
 * `stockBase` فعلي، و`availableBase` وحده يحدّد البيع؛ والخدمة لا تُوسَم نافذةً أبداً.
 *
 * ⚠ العقد المحفوظ: لقطةُ نسخٍ قديمة (`availableBase` غائب و`stockBase` قديم) تُعامَل مجهولةً
 * حتى يصل التحديث الحيّ من `posList`/الاحتياط — يُخفي الرصيدَ الخطأ من المستخدم في يوم النسخ
 * (اختبار stockAvailability.test.ts:61). فحصُ ذلك لا يتحمّل رخاءً هنا.
 */
export function getLineStockState(line: InvoiceLine, demandBase: number): LineStockState {
  const isService = line.isService === true;
  // «يُباع بالطلب» (0318): الخادم يُعفيه من حارس النفاد إعفاءً دائماً، فوسمُه «نافذاً» هنا
  // يكذب على المستخدم ويحجب حفظاً سينجح. يُعامَل معاملة الخدمة **في الوسم وحده** — الرصيد
  // الفعليّ (`onHandBase`) يبقى معروضاً بصدق، سالباً كان أو موجباً، فهو عدّاد المطلوب توريده.
  const allowBackorder = line.allowBackorder === true;
  const stockExempt = isService || allowBackorder;
  const isKnown = stockExempt || line.availableBase != null;
  // الرصيد الفعلي يبقى موقّعاً كي لا نخفي عجزاً حقيقياً في البيانات؛ الذي لا يجوز أن يكون
  // سالباً في العرض التشغيلي هو «المتاح للبيع» فقط.
  const onHandBase = finiteNumber(line.stockBase);
  const reservedBase = nonNegative(line.reservedBase);
  const availableBase = nonNegative(line.availableBase);
  const factorValue = Number(line.conversionFactor);
  const factor = Number.isFinite(factorValue) && factorValue > 0 ? factorValue : 1;
  const availableInUnit = Math.floor(availableBase / factor);
  const requested = nonNegative(demandBase);

  return {
    isKnown,
    isService,
    allowBackorder,
    isOut: isKnown && !stockExempt && availableBase <= 0,
    isShort: isKnown && !stockExempt && availableBase > 0 && requested > availableBase,
    onHandBase,
    reservedBase,
    availableBase,
    availableInUnit,
    overbookedBase: Math.max(0, reservedBase - Math.max(0, onHandBase)),
  };
}
