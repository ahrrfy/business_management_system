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
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  BarcodeSearchCue,
  barcodeSearchInputClass,
} from "@/components/scan/BarcodeSearchCue";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { FILTER_LABELS } from "@shared/uiContracts";
import { cn } from "@/lib/utils";

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
  const handleScan = React.useCallback(
    (code: string) => {
      if (onScan) onScan(code);
      else onChange(code);
    },
    [onScan, onChange],
  );

  const barcodeInput = useBarcodeInput(handleScan, { enabled: barcode });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (barcode) barcodeInput.handleKeyDown(event, onChange);
    // الماسح يبتلع Enter الخاصّ به؛ ما يصل هنا هو Enter بشريّ.
    if (event.key === "Enter" && !event.defaultPrevented && onSubmit) {
      event.preventDefault();
      onSubmit(value);
    }
  };

  return (
    <div className={cn("relative", className)}>
      {/*
        تنبيه — تقسيم الجانبين في RTL: `BarcodeSearchCue` مثبَّتة فيزيائياً على `right` وهو
        **جانب البداية** في RTL، و`barcodeSearchInputClass` يحجز `pr-[5.75rem]!` لها.
        ⇒ حين يعمل الباركود تُسقَط عدسة البحث (الشارة نفسها تُعرّف غرض الحقل) ويبقى
        جانب النهاية لزرّ المسح وحده. وضعُ العدسة عند البداية هنا يركبها فوق الشارة.
      */}
      {!barcode && (
        <Search
          aria-hidden
          className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
      )}
      <Input
        id={id}
        type="search"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? (barcode ? FILTER_LABELS.barcodeHint : FILTER_LABELS.search)}
        className={cn(barcode ? barcodeSearchInputClass : "ps-8", value && "pe-8")}
        {...aria}
      />
      {barcode && <BarcodeSearchCue />}
      {/* زرّ المسح يظهر عند وجود قيمة فقط (§Forms disabled-states) — جانب النهاية دائماً. */}
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`${FILTER_LABELS.reset} — ${FILTER_LABELS.search}`}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
