/**
 * حقل البحث الموحّد — بحثٌ نصّيّ + قارئ باركود اختياريّ في مكوّنٍ واحد.
 *
 * المشكلة التي يغلقها (مسح ١/٩/٢٦): ٤٦ صفحة تبني حقل بحث يدوياً، و٧ صفحات فقط تصل الماسح
 * الضوئيّ (`useBarcodeInput` + `BarcodeSearchCue` + `barcodeSearchInputClass` — ثلاث قطع
 * يجب تركيبها يدوياً في كل مرّة). النتيجة: الموظّف يمسح باركوداً في شاشةٍ فيعمل، ويمسحه في
 * الشاشة المجاورة فلا يحدث شيء — بلا أيّ إشارة تفسّر الفرق.
 *
 * ما يوحّده:
 *   • أيقونة العدسة داخل الحقل (بداية السطر منطقياً — RTL صحيح).
 *   • شارة «باركود» + الهوية البصرية حين `barcode` مفعَّل — الموظّف **يرى** أنّ الماسح يعمل هنا.
 *   • زرّ مسحٍ يظهر عند وجود قيمة فقط (§Forms `disabled-states` — لا تحكّم ميت).
 *   • `type="search"` + `enterKeyHint` + `autoComplete="off"` (§Forms `input-type-keyboard`).
 *   • وصلُ الماسح: تسلسلٌ سريع ثمّ Enter ⇒ `onScan`؛ والكتابة البشرية تبقى كما هي.
 *
 * ⚠️ الحشو: `barcodeSearchInputClass` يحجز يمين الحقل للشارة بـ`!`، فلا تُضِف `px-*` فوقه.
 */
import * as React from "react";
import { FILTER_LABELS } from "@shared/uiContracts";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** نصّ إرشاديّ داخل الحقل. التسمية الظاهرة مسؤولية `FilterField` المحيط. */
  placeholder?: string;
  /**
   * يُفعّل قارئ الباركود: شارة ظاهرة + التقاط التسلسل السريع.
   * مرّر `onScan` لتلقّي الكود المُطبَّع بعد المسح.
   */
  barcode?: boolean;
  /** يُستدعى بالكود المُطبَّع عند اكتمال مسحة. الافتراضي: يضعه في `onChange`. */
  onScan?: (code: string) => void;
  /** Enter بلا مسح (بحثٌ يدويّ صريح). */
  onSubmit?: (value: string) => void;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function SearchField({
  value,
  onChange,
  placeholder,
  barcode = false,
  onScan,
  onSubmit,
  id,
  className,
  autoFocus,
  disabled,
  ...aria
}: SearchFieldProps) {
  return (
    <UnifiedSearchInput
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? (barcode ? FILTER_LABELS.barcodeHint : FILTER_LABELS.search)}
      barcode={barcode}
      onScan={onScan}
      onSubmit={onSubmit}
      autoFocus={autoFocus}
      disabled={disabled}
      className={className}
      {...aria}
    />
  );
}
