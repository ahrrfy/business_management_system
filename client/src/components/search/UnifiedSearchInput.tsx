/**
 * UnifiedSearchInput — المكون الموحد الشامل للبحث والكتابة والمسح بالباركود
 * 
 * مستوحى ومطابق لمواصفات وتجربة حقل البحث في الكاشير (POS):
 * 1. الهوية البصرية الأنيقة: إطار بلون الهوية، زوايا مستديرة (rounded-xl)، خلفية ناعمة، وتباين عالٍ.
 * 2. صون المسافات والكتابة العربية: لا استدعاء لـ trim() أثناء الكتابة، والمسافات تظهر فوراً بلا انقطاع.
 * 3. الاستجابة الفورية والتحكم في السرعة (Debounce): تخزين محلي للكتابة السريعة بـ 60fps
 *    مع ترحيل مؤجل ذكي (180ms كالكاشير) لمنع إرهاق الشبكة أو تذبذب ملاحة URL.
 * 4. كشف الباركود الذكي: التقاط فيزيائي للماسح USB HID مع تصحيح تخطيط لوحة المفاتيح العربية (÷آ{... -> INV-...).
 * 5. زر مسح فوري (X) يظهر فقط عند وجود نص، ويعيد التركيز للحقل.
 * 6. اختصارات لوحة المفاتيح: F2 للتركيز، Escape للمسح، و Enter للبحث/الإدخال.
 */
import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BarcodeSearchCue,
  barcodeSearchInputClass,
} from "@/components/scan/BarcodeSearchCue";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";

export interface UnifiedSearchInputProps {
  /** القيمة الحالية (من الأب أو حالة الفلتر/الرابط) */
  value: string;
  /** دالة التحديث (تُستدعى بالقيمة الجديدة بعد انتهاء مهلة debounce أو فوراً عند المسح) */
  onChange: (val: string) => void;
  /** تحديث لحظي اختياري مع كل نقرة زر دون انتظار debounce */
  onImmediateChange?: (val: string) => void;
  /** نص تلميح الحقل */
  placeholder?: string;
  /** هل يقبل الماسح الضوئي للباركود ويعرض شارة الباركود؟ (الافتراضي: true) */
  barcode?: boolean;
  /** الحد الأدنى لطول الباركود الممسوح (الافتراضي: 3؛ يُخفّض إلى 2 في وضع المسح الإلزامي) */
  scanMinLength?: number;
  /** دالة مخصصة تُستدعى عند التقاط مسحة باركود كاملة. الافتراضي: يمرر الكود لـ onChange */
  onScan?: (code: string) => void;
  /** دالة تُستدعى عند ضغط Enter لكتابة بشرية صريحة */
  onSubmit?: (val: string) => void;
  /** دالة اختيارية تُستدعى عند مسح الحقل (زر X أو Escape) */
  onClear?: () => void;
  /** مهلة التأخير بالمللي ثانية لتحديث onChange (الافتراضي: 180ms كالكاشير؛ 0 للتحديث الفوري) */
  debounceMs?: number;
  /** الحجم: default (42px)، compact (34px)، lg (50px كالكاشير الرئيسي) */
  size?: "default" | "compact" | "lg";
  /** الطراز: default (أشرطة الأدوات والقوائم) أو pos (كاشير بنمط بارز) */
  variant?: "default" | "pos";
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  inputClassName?: string;
  clearButtonLabel?: string;
  id?: string;
  maxLength?: number;
  role?: React.AriaRole;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  "aria-autocomplete"?: React.AriaAttributes["aria-autocomplete"];
  "aria-controls"?: string;
  "aria-activedescendant"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Accessible combobox semantics for callers that provide their own suggestion list. */
  inputProps?: Pick<
    React.InputHTMLAttributes<HTMLInputElement>,
    "role" | "maxLength" | "aria-autocomplete" | "aria-expanded" | "aria-controls" | "aria-activedescendant"
  >;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  dir?: "rtl" | "ltr" | "auto";
  /** تفعيل اختصار F2 العالمي للتركيز على هذا الحقل (الافتراضي: يتبع ظهور F2 في التلميح النصّي لمنع تزاحم الحقول الثانوية) */
  f2Shortcut?: boolean;
}

export const UnifiedSearchInput = React.forwardRef<HTMLInputElement, UnifiedSearchInputProps>(
  function UnifiedSearchInput(
    {
      value,
      onChange,
      onImmediateChange,
      placeholder,
      barcode = true,
      scanMinLength,
      onScan,
      onSubmit,
      onClear,
      debounceMs = 180,
      size = "default",
      variant = "pos",
      autoFocus = false,
      disabled = false,
      className,
      wrapperClassName,
      inputClassName,
      clearButtonLabel = "مسح البحث",
      id,
      maxLength,
      role,
      "aria-label": ariaLabel,
      "aria-expanded": ariaExpanded,
      "aria-haspopup": ariaHasPopup,
      "aria-autocomplete": ariaAutoComplete,
      "aria-controls": ariaControls,
      "aria-activedescendant": ariaActiveDescendant,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      inputProps,
      onKeyDown: externalOnKeyDown,
      onFocus,
      onBlur,
      dir,
      f2Shortcut,
    },
    forwardedRef,
  ) {
    const internalRef = React.useRef<HTMLInputElement | null>(null);

    // دمج ref الخارجي مع الداخلي
    React.useImperativeHandle(forwardedRef, () => internalRef.current as HTMLInputElement);

    // حالة محلية تضمن استجابة بصرية فورية وسلسة 60fps بدون تجميد أو تقطيع
    const [localValue, setLocalValue] = React.useState(value);

    // مؤقت الترحيل المؤجل (Debounce)
    const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // مزامنة الحالة المحلية إذا تغيّرت القيمة من الخارج (مثل إعادة تعيين الفلاتر أو التنقل)
    React.useEffect(() => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
      }
      setLocalValue(value);
    }, [value]);

    // مرجع مستقر لـ onChange لمنع إعادة بناء المؤقتات
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;

    const triggerChange = React.useCallback(
      (newVal: string, immediate = false) => {
        setLocalValue(newVal);
        onImmediateChange?.(newVal);

        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }

        if (immediate || debounceMs <= 0) {
          onChangeRef.current(newVal);
        } else {
          debounceTimerRef.current = setTimeout(() => {
            onChangeRef.current(newVal);
          }, debounceMs);
        }
      },
      [debounceMs, onImmediateChange],
    );

    // تنظيف المؤقت عند إزالة المكون
    React.useEffect(() => {
      return () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      };
    }, []);

    // معالجة مسح الباركود
    const handleScan = React.useCallback(
      (code: string) => {
        if (onScan) {
          onScan(code);
        } else {
          triggerChange(code, true);
        }
      },
      [onScan, triggerChange],
    );

    const barcodeInput = useBarcodeInput(handleScan, {
      enabled: barcode,
      minLength: scanMinLength,
    });

    // مسح الحقل فوراً واستعادة التركيز
    const handleClear = React.useCallback(() => {
      triggerChange("", true);
      onClear?.();
      internalRef.current?.focus();
    }, [triggerChange, onClear]);

    // معالجة ضغطات المفاتيح (Enter, Escape, والماسح الذكي)
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (barcode && e.key === "Escape") {
        barcodeInput.reset();
      }

      if (barcode && onScan) {
        barcodeInput.handleKeyDown(e, (scannedVal) => {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          setLocalValue(scannedVal);
          triggerChange(scannedVal, true);
        });
        if (e.defaultPrevented) return;
      }

      externalOnKeyDown?.(e);
      if (e.defaultPrevented) return;

      if (barcode && !onScan) {
        barcodeInput.handleKeyDown(e, (scannedVal) => {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          setLocalValue(scannedVal);
          if (scannedVal) {
            triggerChange(scannedVal, true);
          }
        });
        if (e.defaultPrevented) return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        handleClear();
        return;
      }

      if (e.key === "Enter") {
        if (onSubmit) {
          e.preventDefault();
          onSubmit(localValue);
        }
      }
    };

    const effectivePlaceholder =
      placeholder ??
      (barcode
        ? "ابحث بالاسم أو SKU أو امسح الباركود… (F2)"
        : "ابحث بالاسم أو التفاصيل… (F2)");
    const enableF2 = f2Shortcut ?? effectivePlaceholder.includes("F2");

    // دعم اختصار F2 للتركيز السريع على حقل البحث الرئيسي دون تزاحم الحقول الثانوية
    React.useEffect(() => {
      if (!enableF2 || disabled) return;
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.defaultPrevented || !internalRef.current) return;
        const active = document.activeElement as HTMLElement | null;
        const isEditable =
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT" ||
            active.isContentEditable);
        if (e.key === "F2" || (e.key === "/" && !isEditable && !e.ctrlKey && !e.metaKey && !e.altKey)) {
          e.preventDefault();
          internalRef.current.focus();
          internalRef.current.select();
        }
      };
      window.addEventListener("keydown", handleGlobalKeyDown);
      return () => window.removeEventListener("keydown", handleGlobalKeyDown);
    }, [enableF2, disabled]);

    // تحديد الارتفاع والأبعاد حسب الحجم
    const sizeClasses = {
      compact: "h-8 text-xs",
      default: "h-9.5 text-sm",
      lg: "h-12 text-base",
    }[size];

    const isPosVariant = variant === "pos";

    return (
      <div className={cn("relative flex items-center min-w-48", wrapperClassName ?? className)}>
        {/* أيقونة البحث في جانب البداية (اليمين في RTL) عند عدم تفعيل شارة الباركود */}
        {!barcode && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground flex items-center z-10"
          >
            <Search className={size === "compact" ? "size-3.5" : "size-4"} />
          </span>
        )}

        <input
          {...inputProps}
          ref={internalRef}
          id={id}
          type="text"
          role={role ?? inputProps?.role}
          dir={dir}
          maxLength={maxLength ?? inputProps?.maxLength}
          value={localValue}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          enterKeyHint="search"
          aria-expanded={ariaExpanded ?? inputProps?.["aria-expanded"]}
          aria-haspopup={ariaHasPopup}
          aria-autocomplete={ariaAutoComplete ?? inputProps?.["aria-autocomplete"]}
          aria-controls={ariaControls ?? inputProps?.["aria-controls"]}
          aria-activedescendant={ariaActiveDescendant ?? inputProps?.["aria-activedescendant"]}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          onChange={(e) => {
            // لا استدعاء لـ normalizeKnownSystemBarcode هنا: المسافات تُحفظ وتُعرض طبيعياً
            triggerChange(e.target.value, false);
          }}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={
            placeholder ??
            (barcode
              ? "ابحث بالاسم أو SKU أو امسح الباركود… (F2)"
              : "ابحث بالاسم أو التفاصيل… (F2)")
          }
          aria-label={ariaLabel ?? placeholder ?? "حقل البحث"}
          className={cn(
            "w-full font-inherit outline-none transition-all duration-150 rounded-xl",
            isPosVariant
              ? "border-2 border-primary bg-[var(--pos-primary-soft,rgba(var(--primary-rgb),0.06))] shadow-[inset_0_0_0_1px_rgba(var(--primary-rgb),0.15)] text-foreground focus:ring-2 focus:ring-primary/30"
              : "border border-input bg-background focus:border-primary focus:ring-2 focus:ring-primary/20",
            sizeClasses,
            barcode ? barcodeSearchInputClass : "pr-8",
            localValue ? "pl-8" : "pl-3",
            wrapperClassName !== undefined ? className : undefined,
            inputClassName,
          )}
        />

        {/* شارة الباركود التوضيحية عند تفعيل الماسح */}
        {barcode && <BarcodeSearchCue />}

        {/* زر المسح السريع X في جانب النهاية (اليسار في RTL) عند وجود نص فقط */}
        {Boolean(localValue) && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearButtonLabel}
            title={clearButtonLabel}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded p-1 transition-colors z-10 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <X aria-hidden className={size === "compact" ? "size-3.5" : "size-4"} />
          </button>
        )}
      </div>
    );
  },
);
