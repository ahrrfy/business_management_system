import { forwardRef, type ComponentProps } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { CARD_BRAND_LOGO_URL, isCardPaymentMethod } from "@/lib/printing/cardBrandLogos";

export { CARD_BRAND_LOGO_URL, isCardPaymentMethod };

export interface CardBrandLogosProps extends Omit<ComponentProps<"span">, "children"> {
  /** حجم الشعارين: xs للشارات والجداول، sm للأزرار العادية، md لأزرار الكاشير والفاتورة، lg للعرض البارز. */
  size?: "xs" | "sm" | "md" | "lg";
  /** إحاطة الشعارين بكبسولة بيضاء تحفظ تباين شعار VISA الأزرق على الأزرار المحدّدة والخلفيات الداكنة. */
  pill?: boolean;
  imgClassName?: string;
}

const SIZE_MAP: Record<NonNullable<CardBrandLogosProps["size"]>, { img: string; pill: string; hPx: number; wPx: number }> = {
  xs: { img: "h-3.5 w-auto", pill: "rounded px-1 py-0.5", hPx: 14, wPx: 42 },
  sm: { img: "h-4 w-auto", pill: "rounded-md px-1.5 py-0.5", hPx: 16, wPx: 48 },
  md: { img: "h-[18px] w-auto", pill: "rounded-md px-1.5 py-0.5", hPx: 18, wPx: 54 },
  lg: { img: "h-5 w-auto", pill: "rounded-lg px-2 py-0.5", hPx: 20, wPx: 60 },
};

/**
 * مكوّن شعارَي البطاقة المعتمدين (Visa + Mastercard) — يُستخدم في أزرار الدفع بالبطاقة
 * وفي شارات وطرق دفع الفواتير والإيصالات في عموم المشروع.
 */
export function CardBrandLogos({
  size = "sm",
  pill = true,
  className,
  imgClassName,
  style,
  ...props
}: CardBrandLogosProps) {
  const s = SIZE_MAP[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center select-none",
        pill && "bg-white/95 shadow-2xs ring-1 ring-black/10 dark:bg-white/95",
        pill && s.pill,
        className,
      )}
      style={style}
      {...props}
    >
      <img
        src={CARD_BRAND_LOGO_URL}
        alt="Visa & Mastercard"
        width={s.wPx}
        height={s.hPx}
        draggable={false}
        className={cn("object-contain", s.img, imgClassName)}
      />
    </span>
  );
}

/**
 * أيقونة متوافقة مع توقيع `LucideIcon` لاستبدال `CreditCard` في الجداول والشارات وقوائم طرق الدفع.
 */
export const CardBrandIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(
  function CardBrandIcon({ className }, _ref) {
    return (
      <CardBrandLogos
        size="xs"
        pill
        className={cn("align-middle", className?.includes("size-") ? undefined : className)}
      />
    );
  },
) as unknown as LucideIcon;
