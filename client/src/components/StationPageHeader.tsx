/**
 * **رأس صفحةٍ موحّد** لشاشات المحطّة (١٩/٨) — لوحةُ التحكّم العلوية بلغة Odoo/Fiori.
 *
 * كانت كل شاشةٍ تبني رأسها يدوياً بأحجامٍ وحشواتٍ مختلفة، فلا تتعرّف العين على نمطٍ واحد
 * وهي تنتقل بينها. وهذا المكوّن يثبّت الأربعة التي تُميّز شاشةً مرتّبة:
 *   ① **أين أنا** (عنوانٌ بارز) · ② **ما غرضها** (سطرٌ واحد خافت)
 *   ③ **طريق الرجوع** (إلى المحطّة — لا يُترك الموظّف في طريقٍ مسدود)
 *   ④ **أفعالها** (فتحةٌ يمينَ الرأس، لا مبعثرةً في الجسم)
 *
 * ⛔ لا ألوان خامّة ولا إيموجي — التوكنز وأيقونات `lucide-react` وحدها. والاتّجاه منطقيّ
 * (`inline-start/end`) لا يساريّ/يمينيّ، فالواجهة RTL.
 */
import { ArrowRight, Home } from "lucide-react";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface StationPageHeaderProps {
  title: string;
  /** سطرٌ واحد يقول **غرض الشاشة** — لا وصفاً تسويقياً. */
  description: string;
  Icon: LucideIcon;
  /** وجهةُ الرجوع — الافتراضيّ محطّة خدمة العملاء. */
  backHref?: string;
  backLabel?: string;
  /** عدّادٌ يصف حجم العمل المعروض (يُخفى عند الصفر — لا شارةَ بلا خبر). */
  count?: number;
  countLabel?: string;
  /** أفعال الشاشة — تُرسَم في طرف الرأس. */
  actions?: ReactNode;
}

export default function StationPageHeader({
  title,
  description,
  Icon,
  backHref = "/pos?mode=RECEPTION",
  backLabel = "محطة خدمة العملاء",
  count,
  countLabel,
  actions,
}: StationPageHeaderProps) {
  return (
    <header className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={backHref}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-card px-2 text-2xs font-bold text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowRight aria-hidden className="size-3" />
            {backLabel}
          </Link>
          <Link
            href="/"
            className="inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            title="الرئيسية"
            aria-label="الرئيسية"
          >
            <Home aria-hidden className="size-3.5" />
          </Link>
        </div>

        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground"
        >
          <Icon className="size-4" />
        </span>

        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-base font-extrabold tracking-tight">{title}</h1>
          {count != null && count > 0 && (
            <span
              title={countLabel}
              className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]"
            >
              {count}
            </span>
          )}
        </div>

        {description && (
          <p
            className="hidden min-w-0 max-w-lg truncate border-s border-border/70 ps-2 text-xs text-muted-foreground xl:block"
            title={description}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </header>
  );
}
