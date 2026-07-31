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
 *  - `<option value="">Label</option>` يُعامَل تلقائياً كـplaceholder على الـtrigger — Radix يرفض
 *    القيمة الفارغة على `<SelectItem>` (documented) فلا يجوز تمريرها. نستخرج نصّه كـplaceholder
 *    ولا نُدرجه بنداً.
 *  - `disabled` على `<option>` مدعوم عبر `data-[disabled]` (Radix).
 *
 * لماذا `onValueChange` بدل `onChange` النمطيّ؟ Radix API يعطي القيمة مباشرةً بلا SyntheticEvent —
 * أنظف من `(e) => e.target.value`. الهجرة النموذجيّة: `onChange={(e) => setX(e.target.value)}` تصير
 * `onValueChange={setX}`. أوضح وأقلّ تفافاً.
 *
 * القيم رقميّة؟ Radix يتعامل بالنصوص. حوّل خارجياً (`value={String(id)}` + `Number(v)` عند التغيير)
 * — نفس اتّفاقيّة `<select>` الأصليّ التي تُرجع نصّاً في `e.target.value` دائماً.
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
  /** أطفال `<option>`/`<optgroup>` — يُحلَّلون بنيوياً إلى SelectItem/SelectGroup. */
  children: React.ReactNode;
}

/**
 * يفحص إن كان العنصر `<option>` أصليّاً أو `<optgroup>` — نقارن بالسلسلة النصّيّة كي لا نعتمد على
 * تصنيف React internal (الذي قد يتغيّر بين الإصدارات) وكي نتفادى false-positive على مكوّنات
 * مسمّاة "option" في مساحات أخرى.
 */
function elementName(el: React.ReactElement): string | undefined {
  const t = el.type;
  return typeof t === "string" ? t : undefined;
}

/**
 * يحوّل شجرة `<option>` / `<optgroup>` إلى شجرة `<SelectItem>` / `<SelectGroup>+<SelectLabel>`.
 * يستخرج `<option value="">` كـplaceholder ويُبلّغ عنه للـcaller (كي يظهر على الـtrigger فارغاً).
 */
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

      // Placeholder: <option value="">النصّ</option> — Radix يرفض value="" على SelectItem فنستخرجه.
      if (value === "") {
        if (extractedPlaceholder.text == null) {
          const t = typeof props.children === "string" ? props.children : String(props.children ?? "");
          extractedPlaceholder.text = t.trim() || null;
        }
        return null;
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
  children,
}: AppSelectProps) {
  // نستخرج placeholder من `<option value="">` إن وُجد ولم يُمرَّر placeholder صريحاً.
  // useMemo كي لا نُعيد التحليل في كل رِندر (children تُبنى مجدّداً من الأب في العادة).
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
      value={value === "" ? undefined : value}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      name={name}
    >
      <SelectTrigger
        id={id}
        size={size}
        className={cn("w-full", className)}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
      >
        <SelectValue placeholder={resolvedPlaceholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>{items}</SelectContent>
    </Select>
  );
}

/** cn محلّي بسيط لتفادي استيراد @/lib/utils داخل مكوّن نظام صغير (يبقى مستقلاً). */
function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}
