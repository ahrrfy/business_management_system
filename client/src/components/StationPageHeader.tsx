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
import { ArrowRight } from "lucide-react";
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
    <header className="mb-5 flex flex-col gap-3 border-b pb-4">
      <Link
        href={backHref}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground"
      >
        <ArrowRight aria-hidden className="size-3.5" />
        {backLabel}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground"
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-extrabold tracking-tight">{title}</h1>
              {count != null && count > 0 && (
                <span
                  title={countLabel}
                  className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-xs font-extrabold text-[var(--sem-warn)]"
                >
                  {count}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-[68ch] text-[13px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
