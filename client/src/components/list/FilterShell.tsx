/**
 * مساحة الفلاتر الموحّدة — **السطح الوحيد** لبطاقة الفلاتر في كل شاشات النظام.
 *
 * بلاغ المالك (١/٩/٢٦): «مساحة الفلاتر ليست بمكوّن واحد ولا تصميمها وترتيبها بمكوّن واحد
 * ولا مطبَّق على الجميع». المسح أثبته: ٤٥ صفحة · أكثر من ٢٠ توقيع شبكة لمفهومٍ واحد.
 *
 * ما يثبّته هذا المكوّن في مكانٍ واحد:
 *   ١) **الغلاف**: بطاقة بعنوان «الفلاتر» + عدّاد المفعَّل + زرّ تصفير بصياغةٍ واحدة.
 *   ٢) **الإيقاع**: الأعمدة تُطلب بعددٍ منطقيّ (١..٤) من `FILTER_GRID_CLASS`، لا بسلسلة
 *      Tailwind يخترعها كل ملفّ. mobile-first دائماً (عمودٌ واحد على الجوّال).
 *   ٣) **الترتيب**: البحث أوّلاً (أوسع حقل)، ثم الفلاتر، ثم المفاتيح الثنائية أسفلها.
 *   ٤) **الدلالة**: `role="search"` + `aria-label`، وزرّ التصفير يختفي حين لا فلتر مفعَّل
 *      (لا زرّ ميت — §Forms `disabled-states`).
 *
 * ⛔ لا تبنِ بطاقة فلاتر يدوياً بعد اليوم — يحرسه `scripts/check-filter-shell.mjs`.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  FILTER_GRID_CLASS,
  FILTER_LABELS,
  type FilterGridColumns,
} from "@shared/uiContracts";

export type FilterShellProps = {
  /** حقول الفلاتر — كلٌّ منها `<FilterField>`. */
  children: React.ReactNode;
  /**
   * عدد الفلاتر المفعّلة. يُظهر العدّاد وزرّ التصفير حين > 0.
   * ⚠️ احسبه **بلا حقل البحث** (اتفاقية `ListToolbar` القائمة) كي لا يقفز العدّاد مع كل حرف.
   */
  activeCount?: number;
  /** تصفير كل الفلاتر. مطلوبٌ متى كان `activeCount` قد يتجاوز الصفر. */
  onReset?: () => void;
  /** أعمدة الشبكة — منطقيّة لا Tailwind. الافتراضي ٣ (الأشيع في الشاشات القائمة). */
  columns?: FilterGridColumns;
  /** عنوان بديل حين تكون البطاقة مخصّصة («فلاتر التقرير»). الافتراضي «الفلاتر». */
  title?: string;
  /**
   * صفٌّ سفليّ للمفاتيح الثنائية (checkbox/switch) — يُعرض تحت الشبكة بمحاذاةٍ مستقلّة
   * كي لا تُشوِّه خليّةَ شبكةٍ بارتفاعٍ مختلف.
   */
  toggles?: React.ReactNode;
  /** إجراءات تُلحق بالرأس (تصدير/حفظ عرض) — تبقى يسار العنوان. */
  headerActions?: React.ReactNode;
  className?: string;
  /** يُخفي الرأس كلّياً حين تكون الفلاتر مضمّنةً داخل بطاقةٍ أكبر. */
  bare?: boolean;
};

export function FilterShell({
  children,
  activeCount = 0,
  onReset,
  columns = 3,
  title = FILTER_LABELS.title,
  toggles,
  headerActions,
  className,
  bare = false,
}: FilterShellProps) {
  const hasActive = activeCount > 0;

  const body = (
    <>
      <div className={FILTER_GRID_CLASS[columns]}>{children}</div>
      {toggles && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3">
          {toggles}
        </div>
      )}
    </>
  );

  if (bare) {
    return (
      <section role="search" aria-label={title} className={cn("min-w-0", className)}>
        {body}
      </section>
    );
  }

  return (
    <Card role="search" aria-label={title} className={cn("min-w-0", className)}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          {hasActive && (
            <span
              className="rounded bg-primary px-1.5 py-0.5 text-2xs font-bold text-primary-foreground"
              aria-label={`${activeCount.toLocaleString("ar-IQ-u-nu-latn")} ${FILTER_LABELS.activeCountLabel}`}
            >
              {activeCount.toLocaleString("ar-IQ-u-nu-latn")}
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {headerActions}
          {/* يظهر عند وجود فلتر فقط — لا زرّ بلا أثر (§Forms disabled-states). */}
          {hasActive && onReset && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="text-muted-foreground"
            >
              <X aria-hidden className="size-4" />
              {FILTER_LABELS.reset}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
