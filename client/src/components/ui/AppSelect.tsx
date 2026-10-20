/**
 * AppSelect — wrapper رشيق فوق Radix Select (shadcn) بواجهة API قريبة من `<select>` الأصليّ.
 *
 * الغرض: هجرة تدريجيّة للـ151 ملفاً التي تستعمل `<select>` الأصليّ (تدقيق ٣١/٧: القوائم المنسدلة
 * تظهر مقتطعةً في Chromium — CSS دفاعيّ فوريّ + هذا المكوّن للهجرة التدريجيّة). الجودة الأساسيّة
 * التي يوفّرها Radix: عرض popup يطابق الـtrigger، ظلّ/حدود من نظام الألوان، تمرير سلس، حبس تركيز،
 * تنقّل كامل بلوحة المفاتيح (Type-ahead)، متاح لقارئ الشاشة، RTL-aware، حسّاس لـ`data-theme`.
 *
 * التصميم:
 *  - يقبل `<option value>Label</option>` و`<optgroup label>` أطفالاً — نفس نمط `<select>` الأصليّ
 *    لتقليل تكلفة الهجرة إلى أدنى حدّ (استبدال الاسم + `onChange` → `onValueChange`).
 *  - `<option value="">Label</option>` يُستعمل نصُّه placeholder على الـtrigger **ويُدرَج أيضاً
 *    بنداً قابلاً للاختيار** (بقيمةٍ بديلة داخلية، لأنّ Radix يرفض `value=""` على `SelectItem`).
 *    كان يُسقَط فيتعذّر الرجوع إلى «الكل» بعد أوّل اختيار — أصلحته مراجعة Codex على PR #931.
 *  - ⛔ الأطفال يجب أن يكونوا `<option>`/`<optgroup>` **حرفياً**: المحوِّل لا يُصيّر المكوّنات
 *    المخصّصة، فمكوّنٌ يُرجع options يصل خامّاً إلى `SelectContent` ويصير غير قابل للاختيار.
 *    مرّر العناصر من دالّة بدلاً منه (مثال: categoryOptionElements(list)).
 *  - `disabled` على `<option>` مدعوم عبر `data-[disabled]` (Radix).
 *  - `searchable`: يعتمد نمط Popover + Editable Combobox (`role="combobox"` يملك `role="listbox"`
 *    مستقلاً عبر `aria-controls` و`aria-activedescendant`) مع `UnifiedSearchInput` وتطبيع العربية.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import {
  normalizeArabicSearch,
  tokenizeSearchTerms,
} from "@shared/storefrontSearchNormalize";

interface AppSelectProps {
  /** القيمة الحاليّة (نصّ). حوّل الأرقام يدوياً بـString()/Number() عند الحدود. */
  value: string;
  /** يُستدعى بالقيمة الجديدة مباشرةً — لا SyntheticEvent. */
  onValueChange: (value: string) => void;
  /** نصّ يُعرض على الـtrigger حين تكون القيمة فارغة أو غير مطابقة لأيّ بند. */
  placeholder?: string;
  /** كامل الـcomponent معطَّل — يُعطَّل الـtrigger ويُخفَى الـpopup. */
  disabled?: boolean;
  /** class إضافيّ للـtrigger — يُدمج مع الافتراضيات (border/rounded/h-9/etc.). */
  className?: string;
  /** class إضافيّ للـpopup content — للتحكّم بالعرض/الارتفاع. */
  contentClassName?: string;
  /** ارتفاع الـtrigger: default=h-9 (٣٦px)، sm=h-8 (٣٢px). */
  size?: "sm" | "default";
  /** فتح مسيَّطر — للتحكّم البرمجيّ (نادر، أغلب الاستعمال بلا). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** name/id للـform integration (يمرَّر إلى الـTrigger لأغراض a11y/label). */
  name?: string;
  id?: string;
  /** aria-label اختياري (فُضِّل ربط <Label htmlFor={id}> عبر id، هذا للحالات القليلة بلا Label بصريّ). */
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  /**
   * تلميحُ مرور (tooltip) على الزرّ. أُضيف ١/٩/٢٦: غيابُه كان يدفع الشاشات إلى `<select>`
   * خامّ لمجرّد الحاجة إلى `title` — أي أنّ نقصَ الخاصّية كان يُنتج انحرافاً.
   */
  title?: string;
  /**
   * اتّجاه نصّ الزرّ. يلزم للقيم اللاتينية داخل صفحةٍ RTL (باركود · SKU · مبالغ):
   * بلا `dir="ltr"` تنقلب علامات الترقيم والشرطات في العرض.
   */
  dir?: "rtl" | "ltr";
  /**
   * أنماطٌ سطريّة على الزرّ. يلزم شاشات الكاشير (POS/PrintPOS) التي تبني هويّتها
   * البصريّة على توكنز `--pos-*` بأحجامٍ محسوبة للمس — بلا هذه الخاصّية كانت الشاشة
   * تبقى على `<select>` خامّ لأنّ المكوّن الموحّد لا يسعها.
   */
  style?: React.CSSProperties;
  /** حقلٌ إلزاميّ في نموذج — يُمرَّر إلى Select الأساس ليشارك في تحقّق النموذج. */
  required?: boolean;
  /** ربطُ الحقل بتلميحه/خطئه (§A11y) — تستعمله نماذج المتجر والتوظيف. */
  "aria-describedby"?: string;
  /** تفعيل نمط البحث الموحّد (Editable Combobox + Popover) لتصفية الخيارات الطويلة. */
  searchable?: boolean;
  /** نص تلميح حقل البحث الداخلي عند تفعيل `searchable`. */
  searchPlaceholder?: string;
  /** أطفال `<option>`/`<optgroup>` — يُحلَّلون بنيوياً إلى SelectItem/SelectGroup. */
  children: React.ReactNode;
}

function elementName(el: React.ReactElement): string | undefined {
  const t = el.type;
  return typeof t === "string" ? t : undefined;
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const p = node.props as { children?: React.ReactNode };
    return extractText(p.children);
  }
  return "";
}

const EMPTY_VALUE = "__appselect_empty__";

function convertChildren(
  children: React.ReactNode,
  extractedPlaceholder: { text: string | null },
): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return null;
    const name = elementName(child);

    // <optgroup label="...">...</optgroup> → <SelectGroup><SelectLabel>...</SelectLabel>...</SelectGroup>
    if (name === "optgroup") {
      const props = child.props as { label?: string; children?: React.ReactNode };
      return (
        <SelectGroup>
          {props.label ? <SelectLabel>{props.label}</SelectLabel> : null}
          {convertChildren(props.children, extractedPlaceholder)}
        </SelectGroup>
      );
    }

    // <option value="X" disabled>Label</option>
    if (name === "option") {
      const props = child.props as {
        value?: string | number;
        disabled?: boolean;
        children?: React.ReactNode;
      };
      const raw = props.value;
      const value = raw == null ? "" : String(raw);
      if (value === "") {
        const text = extractText(props.children).trim();
        if (extractedPlaceholder.text == null) extractedPlaceholder.text = text || null;
        return (
          <SelectItem value={EMPTY_VALUE} disabled={props.disabled}>
            {props.children}
          </SelectItem>
        );
      }
      return (
        <SelectItem value={value} disabled={props.disabled}>
          {props.children}
        </SelectItem>
      );
    }

    // عنصر آخر (Fragment/تكرار محتمل) — كرِّر التحويل على أطفاله؛ يُبقي البنى المرنة عاملةً.
    const props = child.props as { children?: React.ReactNode };
    if (props && "children" in props) {
      return React.cloneElement(child, {}, convertChildren(props.children, extractedPlaceholder));
    }
    if (import.meta.env?.DEV && typeof child.type !== "string") {
      const label = typeof child.type === "function" ? (child.type.name || "مكوّن") : String(child.type);
      console.error(
        `[AppSelect] الطفل «${label}» مكوّنٌ مخصّص لا option/optgroup — خياراته لن تكون قابلة للاختيار. ` +
        `مرّر العناصر من دالّة بدلاً منه (مثال: categoryOptionElements(list)).`,
      );
    }
    return child;
  });
}

interface ParsedOptionItem {
  value: string;
  labelText: string;
  children: React.ReactNode;
  disabled: boolean;
  groupLabel?: string;
}

function parseOptionsTree(
  children: React.ReactNode,
  extractedPlaceholder: { text: string | null },
  out: ParsedOptionItem[],
  groupLabel?: string,
): void {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const name = elementName(child);
    if (name === "optgroup") {
      const props = child.props as { label?: string; children?: React.ReactNode };
      parseOptionsTree(props.children, extractedPlaceholder, out, props.label);
      return;
    }
    if (name === "option") {
      const props = child.props as {
        value?: string | number;
        disabled?: boolean;
        children?: React.ReactNode;
      };
      const raw = props.value;
      const value = raw == null ? "" : String(raw);
      const labelText = extractText(props.children);
      if (value === "" && extractedPlaceholder.text == null) {
        extractedPlaceholder.text = labelText.trim() || null;
      }
      out.push({
        value,
        labelText,
        children: props.children,
        disabled: Boolean(props.disabled),
        groupLabel,
      });
      return;
    }
    const props = child.props as { children?: React.ReactNode };
    if (props && "children" in props) {
      parseOptionsTree(props.children, extractedPlaceholder, out, groupLabel);
    }
  });
}

function resolveDefaultActiveIndex(
  options: ParsedOptionItem[],
  currentValue: string,
): number {
  if (options.length === 0) return -1;
  const selectedIdx = options.findIndex(
    (opt) => opt.value === currentValue && !opt.disabled,
  );
  if (selectedIdx >= 0) return selectedIdx;
  const firstNonEmptyIdx = options.findIndex(
    (opt) => opt.value !== "" && !opt.disabled,
  );
  if (firstNonEmptyIdx >= 0) return firstNonEmptyIdx;
  return options.findIndex((opt) => !opt.disabled);
}

function findNextEnabledOptionIndex(
  options: ParsedOptionItem[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const len = options.length;
  if (len === 0) return -1;
  for (let step = 1; step <= len; step++) {
    const base =
      currentIndex < 0
        ? direction === 1
          ? -1
          : 0
        : currentIndex;
    const idx = ((base + direction * step) % len + len) % len;
    if (!options[idx]?.disabled) {
      return idx;
    }
  }
  return -1;
}

export function AppSelect(props: AppSelectProps) {
  if (props.searchable) {
    return <SearchableAppSelect {...props} />;
  }
  return <StandardAppSelect {...props} />;
}

function StandardAppSelect({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  contentClassName,
  size = "default",
  open,
  onOpenChange,
  name,
  id,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  title,
  dir,
  style,
  required,
  "aria-describedby": ariaDescribedBy,
  children,
}: AppSelectProps) {
  const { items, resolvedPlaceholder } = React.useMemo(() => {
    const holder = { text: null as string | null };
    const converted = convertChildren(children, holder);
    return {
      items: converted,
      resolvedPlaceholder: placeholder ?? holder.text ?? undefined,
    };
  }, [children, placeholder]);

  return (
    <Select
      value={value === "" ? EMPTY_VALUE : value}
      onValueChange={(next) => {
        if (next === "") return;
        onValueChange(next === EMPTY_VALUE ? "" : next);
      }}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      name={name}
      required={required}
    >
      <SelectTrigger
        id={id}
        size={size}
        className={cn("w-full", className)}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        title={title}
        dir={dir}
        style={style}
        aria-describedby={ariaDescribedBy}
      >
        <SelectValue placeholder={resolvedPlaceholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>{items}</SelectContent>
    </Select>
  );
}

interface FloatingMenuPosition {
  side: "bottom" | "top";
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxListboxHeight: number;
}

function computeCollisionAwarePosition(
  triggerEl: HTMLElement | null,
): FloatingMenuPosition {
  if (!triggerEl || typeof window === "undefined") {
    return {
      side: "bottom",
      top: 0,
      left: 0,
      width: 220,
      maxListboxHeight: 256,
    };
  }
  const rect = triggerEl.getBoundingClientRect();
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const sideOffset = 4;
  const viewportPad = 8;
  const searchHeaderReserve = 48;
  const desiredListboxHeight = 256;
  const minListboxHeight = 96;

  const spaceBelow = vh - rect.bottom - sideOffset - viewportPad;
  const spaceAbove = rect.top - sideOffset - viewportPad;
  const placeAbove =
    spaceBelow < desiredListboxHeight + searchHeaderReserve &&
    spaceAbove > spaceBelow;

  const availableSpace = placeAbove ? spaceAbove : spaceBelow;
  const maxListboxHeight = Math.max(
    minListboxHeight,
    Math.min(desiredListboxHeight, availableSpace - searchHeaderReserve),
  );

  const width = Math.max(rect.width, 192);
  const left = Math.min(
    Math.max(viewportPad, rect.left),
    Math.max(viewportPad, vw - width - viewportPad),
  );

  if (placeAbove) {
    return {
      side: "top",
      bottom: Math.max(viewportPad, vh - rect.top + sideOffset),
      left,
      width,
      maxListboxHeight,
    };
  }
  return {
    side: "bottom",
    top: Math.max(viewportPad, rect.bottom + sideOffset),
    left,
    width,
    maxListboxHeight,
  };
}

function SearchableAppSelect({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  contentClassName,
  size = "default",
  open: controlledOpen,
  onOpenChange,
  name,
  id,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  title,
  dir,
  style,
  required,
  "aria-describedby": ariaDescribedBy,
  searchPlaceholder,
  children,
}: AppSelectProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isOpen = disabled ? false : (controlledOpen !== undefined ? controlledOpen : uncontrolledOpen);
  const [searchQuery, setSearchQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeOptionRef = React.useRef<HTMLDivElement | null>(null);
  const instanceId = React.useId();
  const listboxId = `${instanceId}-listbox`;

  const { allOptions, resolvedPlaceholder } = React.useMemo(() => {
    const holder = { text: null as string | null };
    const parsed: ParsedOptionItem[] = [];
    parseOptionsTree(children, holder, parsed);
    return {
      allOptions: parsed,
      resolvedPlaceholder: placeholder ?? holder.text ?? undefined,
    };
  }, [children, placeholder]);

  const allOptionsRef = React.useRef(allOptions);
  allOptionsRef.current = allOptions;
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const [activeIndex, setActiveIndex] = React.useState(() =>
    resolveDefaultActiveIndex(allOptions, value),
  );
  const [menuPos, setMenuPos] = React.useState<FloatingMenuPosition>(() =>
    computeCollisionAwarePosition(null),
  );

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setSearchQuery("");
      } else {
        setActiveIndex(resolveDefaultActiveIndex(allOptionsRef.current, valueRef.current));
      }
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChangeRef.current?.(nextOpen);
    },
    [controlledOpen],
  );

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      setMenuPos(computeCollisionAwarePosition(triggerRef.current));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const popupEl = popupRef.current;
    const containerEl = containerRef.current;
    const stopFocusIn = (e: FocusEvent) => {
      e.stopPropagation();
    };
    const stopFocusOutFromPopup = (e: FocusEvent) => {
      e.stopPropagation();
    };
    const stopFocusOutToPopup = (e: FocusEvent) => {
      if (popupEl && e.relatedTarget instanceof Node && popupEl.contains(e.relatedTarget)) {
        e.stopPropagation();
      }
    };
    popupEl?.addEventListener("focusin", stopFocusIn);
    popupEl?.addEventListener("focusout", stopFocusOutFromPopup);
    containerEl?.addEventListener("focusout", stopFocusOutToPopup);
    return () => {
      popupEl?.removeEventListener("focusin", stopFocusIn);
      popupEl?.removeEventListener("focusout", stopFocusOutFromPopup);
      containerEl?.removeEventListener("focusout", stopFocusOutToPopup);
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    setActiveIndex(resolveDefaultActiveIndex(allOptionsRef.current, valueRef.current));
    searchInputRef.current?.focus();
    const handlePointerDownOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        containerRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      ) {
        return;
      }
      handleOpenChange(false);
    };
    document.addEventListener("mousedown", handlePointerDownOutside);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
    };
  }, [isOpen, handleOpenChange]);

  const selectedOption = React.useMemo(
    () => allOptions.find((opt) => opt.value === value && (value !== "" || opt.labelText.trim() !== "")),
    [allOptions, value],
  );

  const searchTokens = React.useMemo(
    () => tokenizeSearchTerms(searchQuery),
    [searchQuery],
  );

  const matchedOptions = React.useMemo(() => {
    if (searchTokens.length === 0) return allOptions;
    return allOptions.filter((opt) => {
      const haystack = normalizeArabicSearch(
        `${opt.labelText} ${opt.value} ${opt.groupLabel ?? ""}`,
      );
      return searchTokens.every((tok) => haystack.includes(tok));
    });
  }, [allOptions, searchTokens]);

  const safeActiveIndex = React.useMemo(() => {
    if (matchedOptions.length === 0) return -1;
    const clamped = Math.min(Math.max(activeIndex, 0), matchedOptions.length - 1);
    if (activeIndex >= 0 && !matchedOptions[clamped]?.disabled) {
      return clamped;
    }
    return matchedOptions.findIndex((opt) => !opt.disabled);
  }, [activeIndex, matchedOptions]);
  const activeOption = safeActiveIndex >= 0 ? matchedOptions[safeActiveIndex] : undefined;
  const activeOptionDomId =
    safeActiveIndex >= 0 ? `${listboxId}-opt-${safeActiveIndex}` : undefined;

  React.useEffect(() => {
    if (isOpen && safeActiveIndex >= 0) {
      activeOptionRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, safeActiveIndex]);

  const commitOption = React.useCallback(
    (opt: ParsedOptionItem) => {
      if (opt.disabled) return;
      onValueChange(opt.value);
      handleOpenChange(false);
    },
    [onValueChange, handleOpenChange],
  );

  const showPlaceholder = value === "" || !selectedOption;

  const popupContent =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={popupRef}
            data-slot="popover-content"
            data-side={menuPos.side}
            style={{
              position: "fixed",
              top: menuPos.top,
              bottom: menuPos.bottom,
              left: menuPos.left,
              width: menuPos.width,
              pointerEvents: "auto",
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            className={cn(
              "bg-popover text-popover-foreground z-[150] min-w-[12rem] overflow-hidden rounded-md border p-0 shadow-md",
              contentClassName,
            )}
          >
            <div className="bg-popover p-1.5 pb-1 border-b border-border/60">
              <UnifiedSearchInput
                ref={searchInputRef}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isOpen}
                aria-controls={listboxId}
                aria-activedescendant={activeOptionDomId}
                aria-label={searchPlaceholder ?? ariaLabel ?? resolvedPlaceholder ?? "ابحث في القائمة"}
                value={searchQuery}
                onChange={(q) => {
                  setSearchQuery(q);
                  if (!q) {
                    setActiveIndex(resolveDefaultActiveIndex(allOptions, value));
                  } else {
                    setActiveIndex(0);
                  }
                }}
                placeholder={searchPlaceholder ?? "ابحث في القائمة..."}
                barcode={false}
                debounceMs={0}
                size="compact"
                variant="pos"
                f2Shortcut={false}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const nextIdx = findNextEnabledOptionIndex(
                      matchedOptions,
                      safeActiveIndex,
                      1,
                    );
                    if (nextIdx >= 0) setActiveIndex(nextIdx);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const prevIdx = findNextEnabledOptionIndex(
                      matchedOptions,
                      safeActiveIndex,
                      -1,
                    );
                    if (prevIdx >= 0) setActiveIndex(prevIdx);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (activeOption && !activeOption.disabled) {
                      commitOption(activeOption);
                    }
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    handleOpenChange(false);
                    triggerRef.current?.focus();
                  }
                }}
              />
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel ?? resolvedPlaceholder ?? "الخيارات"}
              style={{ maxHeight: menuPos.maxListboxHeight }}
              className="max-h-64 overflow-y-auto p-1"
            >
              {matchedOptions.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  لا توجد نتائج مطابقة
                </div>
              ) : (
                matchedOptions.map((opt, idx) => {
                  const isSelected = opt.value === value;
                  const isActive = idx === safeActiveIndex && !opt.disabled;
                  const prevGroup = idx > 0 ? matchedOptions[idx - 1]?.groupLabel : undefined;
                  const showGroupHeader = opt.groupLabel && opt.groupLabel !== prevGroup;
                  return (
                    <React.Fragment key={`${opt.groupLabel ?? ""}:${opt.value}:${idx}`}>
                      {showGroupHeader ? (
                        <div
                          data-slot="select-label"
                          className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
                        >
                          {opt.groupLabel}
                        </div>
                      ) : null}
                      <div
                        ref={isActive ? activeOptionRef : undefined}
                        id={`${listboxId}-opt-${idx}`}
                        role="option"
                        data-slot="select-item"
                        aria-selected={isSelected}
                        aria-disabled={opt.disabled || undefined}
                        data-disabled={opt.disabled ? "" : undefined}
                        data-highlighted={isActive ? "" : undefined}
                        onMouseEnter={() => {
                          if (!opt.disabled) setActiveIndex(idx);
                        }}
                        onClick={() => commitOption(opt)}
                        className={cn(
                          "relative flex min-h-[var(--ui-control-sm)] w-full cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-sm outline-hidden select-none",
                          isActive && "bg-accent text-accent-foreground",
                          opt.disabled && "pointer-events-none opacity-50",
                        )}
                      >
                        <span className="absolute right-2 flex size-3.5 items-center justify-center">
                          {isSelected ? <CheckIcon className="size-4" /> : null}
                        </span>
                        <span className="truncate">{opt.children}</span>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div ref={containerRef} className="relative w-full">
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        data-slot="select-trigger"
        data-size={size}
        data-placeholder={showPlaceholder ? "" : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={title}
        dir={dir}
        style={style}
        onClick={() => {
          if (!disabled) handleOpenChange(!isOpen);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            if (!isOpen) {
              e.preventDefault();
              handleOpenChange(true);
            }
          } else if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            handleOpenChange(false);
          }
        }}
        className={cn(
          "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-full items-center justify-between gap-2 rounded-[var(--ui-radius-control)] border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[var(--ui-control)] data-[size=sm]:h-[var(--ui-control-sm)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
      >
        <span
          data-slot="select-value"
          className="line-clamp-1 flex items-center gap-2 truncate"
        >
          {selectedOption ? selectedOption.children : resolvedPlaceholder}
        </span>
        <ChevronDownIcon className="size-4 opacity-50" />
      </button>
      {popupContent}
    </div>
  );
}

/** cn محلّي بسيط لتفادي استيراد @/lib/utils داخل مكوّن نظام صغير (يبقى مستقلاً). */
function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
