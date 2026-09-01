export interface PosQuantityEntryResult {
  quantity: number;
  replaceNextDigit: boolean;
}

/**
 * يطبّق ضغطة لوحة أرقام الكاشير على كمية السطر المحدد.
 *
 * `replaceNextDigit` تميّز بداية جلسة إدخال جديدة بعد اختيار السطر أو استعمال +/-.
 */
export function applyPosQuantityKey(
  currentQuantity: number,
  key: string,
  replaceNextDigit: boolean,
): PosQuantityEntryResult {
  let value = String(Math.max(1, Math.trunc(currentQuantity) || 1));

  if (key === "C") {
    return { quantity: 1, replaceNextDigit: true };
  }

  if (key === "⌫") {
    value = value.length > 1 ? value.slice(0, -1) : "1";
    return {
      quantity: Math.max(1, Number.parseInt(value, 10) || 1),
      replaceNextDigit: value === "1",
    };
  }

  // الكمية عدد صحيح موجب؛ مفاتيح الفاصلة والإشارة تخصّ المبلغ ولا تغيّرها.
  if (!/^\d$/.test(key)) {
    return { quantity: Math.max(1, Number.parseInt(value, 10) || 1), replaceNextDigit };
  }

  // صفرٌ منفرد لا يصلح كميةً ولا يستهلك «أول إدخال»؛ الرقم الموجب التالي يظلّ بديلاً للـ1.
  if (replaceNextDigit && key === "0") {
    return { quantity: 1, replaceNextDigit: true };
  }

  value = replaceNextDigit ? key : value + key;

  return {
    quantity: Math.max(1, Number.parseInt(value, 10) || 1),
    replaceNextDigit: false,
  };
}
