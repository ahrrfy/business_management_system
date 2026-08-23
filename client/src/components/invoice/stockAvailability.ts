import type { InvoiceLine } from "./types";

export interface LineStockState {
  isKnown: boolean;
  isService: boolean;
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
 * ٢٣/٨ (بلاغ المالك «المخزون لا يظهر عند إضافة المنتج»): كان `isKnown` يشترط `availableBase != null`
 * حصراً، فأصنافٌ محمَّلة من كتالوجٍ أوفلاينيّ أو من مسوّدةٍ قديمة (تحمل `stockBase` بلا حجزٍ محسوب)
 * تُعرَض «غير معروف الرصيد» بلا نهاية. الآن نقبل إمّا `availableBase` وإمّا `stockBase` — العرض
 * يعتمد على أوّل المتوفّرَين والحقلُ الغائب يُحسَب صفراً بأمان (السلوك الأصلي لـ`nonNegative`).
 */
export function getLineStockState(line: InvoiceLine, demandBase: number): LineStockState {
  const isService = line.isService === true;
  const isKnown = isService || line.availableBase != null || line.stockBase != null;
  // الرصيد الفعلي يبقى موقّعاً كي لا نخفي عجزاً حقيقياً في البيانات؛ الذي لا يجوز أن يكون
  // سالباً في العرض التشغيلي هو «المتاح للبيع» فقط. حين يغيب `availableBase` نستعمل الفعليّ
  // (`stockBase`) كتقديرٍ عمليّ (بلا حجزٍ معروف = بلا خصم منه).
  const onHandBase = finiteNumber(line.stockBase);
  const reservedBase = nonNegative(line.reservedBase);
  const availableBase = line.availableBase != null ? nonNegative(line.availableBase) : Math.max(0, onHandBase - reservedBase);
  const factorValue = Number(line.conversionFactor);
  const factor = Number.isFinite(factorValue) && factorValue > 0 ? factorValue : 1;
  const availableInUnit = Math.floor(availableBase / factor);
  const requested = nonNegative(demandBase);

  return {
    isKnown,
    isService,
    isOut: isKnown && !isService && availableBase <= 0,
    isShort: isKnown && !isService && availableBase > 0 && requested > availableBase,
    onHandBase,
    reservedBase,
    availableBase,
    availableInUnit,
    overbookedBase: Math.max(0, reservedBase - Math.max(0, onHandBase)),
  };
}
