/**
 * **لوحة فلاتر مطويّة برقاقات نشِطة** — بلغة Odoo (١٩/٨، بلاغ المالك: «الفلاتر تصميمها غير
 * مدروس وفوضوي»).
 *
 * العلّة مقيسة: شاشة المبيعات تعرض **تسعة منتقياتٍ مفتوحةً دائماً** فوق الجدول، فتأكل الشاشة
 * كلّها قبل أن يظهر صفٌّ واحد — والموظّف يمرّر لأسفل ليرى بياناته. وثمانيةٌ منها فارغةٌ في
 * أغلب الأوقات، أي أنّها تشغل المساحة بلا خبر.
 *
 * والعلاج نمطُ Odoo نفسه: **الفلاتر مطويّة، والمفعَّل منها وحده يظهر رقاقةً قابلةً للإزالة**.
 * فيرى الموظّف في سطرٍ واحد «ما الذي يُصفّي نتائجي الآن» ويزيله بنقرة، ويفتح اللوحة حين
 * يريد إضافة فلترٍ جديد. وتُفتَح تلقائياً إن كان ثمّة فلترٌ مفعَّل عند الدخول (رابطٌ مُشارَك)
 * كي لا تكون النتيجةُ مُصفّاةً بسببٍ مخفيّ.
 *
 * ⛔ توكنز فقط، وخصائص اتّجاهٍ منطقية (RTL)، وأيقونات `lucide-react`.
 */
import { useEffect, useState } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";

export interface FilterChip {
  /** مفتاحٌ فريد — يُستعمل للإزالة. */
  key: string;
  /** اسم الحقل («الحالة») — يُعرض خافتاً قبل القيمة. */
  field: string;
  /** القيمة المقروءة («مدفوعة»). */
  value: string;
  onClear: () => void;
}

export default function FilterPanel({
  chips,
  onResetAll,
  children,
  /** يُعرض بجوار العنوان — مثلاً منتقي الفترة السريع (الأكثر استعمالاً يبقى ظاهراً). */
  quickSlot,
}: {
  chips: FilterChip[];
  onResetAll: () => void;
  children: ReactNode;
  quickSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasChips = chips.length > 0;

  // فلترٌ مفعَّلٌ عند الدخول (رابطٌ مُشارَك) ⇒ تُفتَح اللوحة مرّةً واحدة: نتيجةٌ مُصفّاةٌ بسببٍ
  // مخفيّ أسوأ من لوحةٍ مفتوحة.
  const [didAutoOpen, setDidAutoOpen] = useState(false);
  useEffect(() => {
    if (!didAutoOpen && hasChips) {
      setDidAutoOpen(true);
      setOpen(true);
    }
  }, [didAutoOpen, hasChips]);

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-extrabold hover:bg-muted"
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
          الفلاتر
          {chips.length > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-2xs font-bold text-primary-foreground">
              {chips.length}
            </span>
          )}
          <ChevronDown
            aria-hidden
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {quickSlot}

        {hasChips && (
          <button
            type="button"
            onClick={onResetAll}
            className="ms-auto text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            مسح الكل
          </button>
        )}
      </div>

      {/* رقاقاتُ المفعَّل — تقول «لماذا نتيجتي هذه» وتُزال بنقرة. */}
      {hasChips && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/60 py-0.5 pe-1 ps-2 text-2xs font-semibold"
            >
              <span className="text-muted-foreground">{c.field}:</span>
              <span>{c.value}</span>
              <button
                type="button"
                onClick={c.onClear}
                aria-label={`إزالة فلتر ${c.field}`}
                className="grid size-4 place-items-center rounded-full hover:bg-background"
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}
