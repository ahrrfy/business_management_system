// TablePager — شريط ترقيم موحّد أسفل جداول القوائم الطويلة.
//
// لماذا: كان كل شاشة تكتب ترقيمها بيدها، فاختلفت الصيغ والاتجاهات (Products كانت
// «← السابق / التالي →» وInventoryMovements «السابق → / ← التالي» — سهمان متعاكسان
// لنفس الفعل). وأسوأ: شاشات كثيرة تمرّر limit بلا offset فتقتطع الصفوف الزائدة **بصمت**
// بلا أي مؤشّر أن هناك المزيد. هذا المكوّن هو البيت الواحد للترقيم: صيغة واحدة، اتجاه
// واحد صحيح لـRTL، وعدّاد صريح يمنع الاقتطاع الصامت.
//
// الاتجاه في RTL: «السابق» يرجع لليمين (ChevronRight) و«التالي» يتقدّم لليسار (ChevronLeft).
//
// وضعان:
//   • وضع الإجمالي (total معلوم) ⇒ «عرض ١–٥٠ من ١٢٣» + تعطيل «التالي» عند آخر صفحة.
//   • وضع hasMore (بلا COUNT — keyset) ⇒ «عرض ١–٥٠» + «التالي» يعتمد hasMore.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtInt } from "@/lib/money";
import { cn } from "@/lib/utils";

export function TablePager({
  page,
  onPageChange,
  pageSize,
  rowsOnPage,
  total,
  hasMore,
  isLoading = false,
  className,
}: {
  /** رقم الصفحة الحالية بدءاً من ٠. */
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  /** عدد الصفوف المعروضة فعلاً في هذه الصفحة. */
  rowsOnPage: number;
  /** الإجمالي حين يكون معلوماً (offset + COUNT). اتركه undefined في وضع keyset. */
  total?: number;
  /** هل بعد هذه الصفحة المزيد — يُستعمل حين لا إجمالي (keyset). */
  hasMore?: boolean;
  isLoading?: boolean;
  className?: string;
}) {
  const offset = page * pageSize;
  const knownTotal = typeof total === "number";
  const pages = knownTotal ? Math.max(1, Math.ceil(total / pageSize)) : undefined;

  // «التالي» متاح إمّا لأن الإجمالي يقول إن بعدها صفحات، أو لأن الخادم قال hasMore.
  const canNext = knownTotal ? page + 1 < (pages as number) : Boolean(hasMore);
  const canPrev = page > 0;

  // لا تعرض شيئاً حين لا صفوف أصلاً ولا صفحة سابقة (الجدول الفارغ له رسالته الخاصة).
  if (rowsOnPage === 0 && !canPrev) return null;

  const first = rowsOnPage > 0 ? offset + 1 : 0;
  const last = offset + rowsOnPage;

  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-2 border-t p-3", className)}
      role="navigation"
      aria-label="ترقيم الصفحات"
    >
      <span className="text-xs text-muted-foreground" aria-live="polite">
        عرض {fmtInt(first)}–{fmtInt(last)}
        {knownTotal ? <> من {fmtInt(total)}</> : null}
        {pages && pages > 1 ? <> · صفحة {fmtInt(page + 1)} من {fmtInt(pages)}</> : null}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrev || isLoading}
          onClick={() => onPageChange(Math.max(0, page - 1))}
        >
          السابق
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canNext || isLoading}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronLeft aria-hidden className="size-4" />
          التالي
        </Button>
      </div>
    </div>
  );
}
