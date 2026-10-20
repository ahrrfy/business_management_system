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
 *  - `searchable`: يفعّل شريط `UnifiedSearchInput` الموحّد أعلى القائمة لتصفية الخيارات الطويلة
 *    عبر `normalizeSearchText` مع إبقاء العناصر المثبّتة في الشجرة لضمان عدم فقدان عنوان `SelectValue`.
 */
import * as React from "react";
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
import { normalizeSearchText, tokenizeSearchQuery } from "@shared/searchNormalize";

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
  /** تفعيل شريط بحث موحّد داخل القائمة المنسدلة لتصفية الخيارات الطويلة (العملاء، الموردون، الوصفات، الحسابات...). */
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
  searchTokens: string[],
  stats: { matched: number },
  groupTitle?: string,
): React.ReactNode {
  const isFiltering = searchTokens.length > 0;
  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return null;
    const name = elementName(child);

    // <optgroup label="...">...</optgroup> → <SelectGroup><SelectLabel>...</SelectLabel>...</SelectGroup>
    if (name === "optgroup") {
      const props = child.props as { label?: string; children?: React.ReactNode };
      const groupStats = { matched: 0 };
      const groupItems = convertChildren(
        props.children,
        extractedPlaceholder,
        searchTokens,
        groupStats,
        props.label,
      );
      stats.matched += groupStats.matched;
      return (
        <SelectGroup className={isFiltering && groupStats.matched === 0 ? "hidden" : undefined}>
          {props.label ? <SelectLabel>{props.label}</SelectLabel> : null}
          {groupItems}
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
      const labelText = extractText(props.children);
      let matches = true;
      if (isFiltering) {
        const haystack = normalizeSearchText(`${labelText} ${value} ${groupTitle ?? ""}`);
        matches = searchTokens.every((tok) => haystack.includes(tok));
      }
      if (matches) stats.matched += 1;

      if (value === "") {
        if (extractedPlaceholder.text == null) extractedPlaceholder.text = labelText.trim() || null;
        return (
          <SelectItem
            value={EMPTY_VALUE}
            disabled={props.disabled || !matches}
            className={!matches ? "hidden" : undefined}
          >
            {props.children}
          </SelectItem>
        );
      }

      return (
        <SelectItem
          value={value}
          disabled={props.disabled || !matches}
          className={!matches ? "hidden" : undefined}
        >
          {props.children}
        </SelectItem>
      );
    }

    // عنصر آخر (Fragment/تكرار محتمل) — كرِّر التحويل على أطفاله؛ يُبقي البنى المرنة عاملةً.
    const props = child.props as { children?: React.ReactNode };
    if (props && "children" in props) {
      return React.cloneElement(
        child,
        {},
        convertChildren(props.children, extractedPlaceholder, searchTokens, stats, groupTitle),
      );
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

export function AppSelect({
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
  searchable = false,
  searchPlaceholder,
  children,
}: AppSelectProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const searchTokens = React.useMemo(
    () => (searchable ? tokenizeSearchQuery(searchQuery) : []),
    [searchable, searchQuery],
  );

  const { items, resolvedPlaceholder, matchedCount } = React.useMemo(() => {
    const holder = { text: null as string | null };
    const stats = { matched: 0 };
    const converted = convertChildren(children, holder, searchTokens, stats);
    return {
      items: converted,
      resolvedPlaceholder: placeholder ?? holder.text ?? undefined,
      matchedCount: stats.matched,
    };
  }, [children, placeholder, searchTokens]);

  return (
    <Select
      value={value === "" ? EMPTY_VALUE : value}
      onValueChange={(next) => {
        if (next === "") return;
        onValueChange(next === EMPTY_VALUE ? "" : next);
      }}
      disabled={disabled}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && searchQuery) {
          setSearchQuery("");
        }
        onOpenChange?.(nextOpen);
      }}
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
      <SelectContent
        className={contentClassName}
        onCloseAutoFocus={searchable ? () => setSearchQuery("") : undefined}
        onKeyDown={
          searchable
            ? (e) => {
                if (
                  document.activeElement !== searchInputRef.current &&
                  (e.key === "Backspace" || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey))
                ) {
                  searchInputRef.current?.focus();
                }
              }
            : undefined
        }
      >
        {searchable ? (
          <div
            className="sticky top-0 z-10 bg-popover p-1.5 pb-1 border-b border-border/60"
            onKeyDown={(e) => {
              if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") {
                e.stopPropagation();
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
          >
            <UnifiedSearchInput
              ref={searchInputRef}
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={searchPlaceholder ?? "ابحث في القائمة..."}
              barcode={false}
              debounceMs={0}
              size="compact"
              variant="pos"
              f2Shortcut={false}
              aria-label={searchPlaceholder ?? "ابحث في القائمة"}
            />
          </div>
        ) : null}
        {items}
        {searchable && searchTokens.length > 0 && matchedCount === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            لا توجد نتائج مطابقة
          </div>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/** cn محلّي بسيط لتفادي استيراد @/lib/utils داخل مكوّن نظام صغير (يبقى مستقلاً). */
function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
