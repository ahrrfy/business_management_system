/**
 * مساعد تسمية المنتج — ثلاث طبقات إرشادية غير متلفة تحت حقل الاسم:
 *  ١) مشابهات حيّة من القاعدة (debounced) تمنع ازدواج الكتالوج عند المصدر،
 *     مع تحذير أقوى عند التطابق التام في الفضاء المُطبَّع.
 *  ٢) صيغة مقترحة حتمية (suggestCleanName) تُطبَّق بنقرة — لا تغيير صامتاً أبداً.
 *  ٣) تنبيه لون داخل الاسم (شاشات المتغيّرات فقط): الألوان تُدار في المتغيّرات،
 *     وإلا طُبعت الملصقات/التصدير «قلم أزرق أزرق» (الاسم الكامل = الاسم + لون المتغيّر).
 */
import { AlertTriangle, Palette, SearchCheck, Wand2 } from "lucide-react";
import { useMemo } from "react";
import { findColorWordsInName, suggestCleanName } from "@shared/nameAssistant";
import { Button } from "@/components/ui/button";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc } from "@/lib/trpc";

interface NameAssistantProps {
  /** الاسم الفعّال (الصريح أو المركَّب من النوع/الماركة/الموديل). */
  name: string;
  /** تطبيق الصيغة المقترحة على حقل الاسم الصريح. */
  onApply: (clean: string) => void;
  /** شاشة التعديل: استثناء المنتج نفسه من المشابهات. */
  excludeProductId?: number;
  /** تنبيه اللون — لشاشات المتغيّرات فقط (في السلعة البسيطة اللون في الاسم مشروع). */
  warnColors?: boolean;
}

export function NameAssistant({ name, onApply, excludeProductId, warnColors = false }: NameAssistantProps) {
  const debounced = useDebouncedValue(name, 450);
  const trimmed = debounced.trim();

  const suggestion = useMemo(() => suggestCleanName(debounced), [debounced]);
  const showSuggestion = suggestion.length > 0 && suggestion !== trimmed;

  const colorWords = useMemo(
    () => (warnColors && trimmed ? findColorWordsInName(trimmed) : []),
    [warnColors, trimmed]
  );

  const similarQ = trpc.catalog.similarNames.useQuery(
    { name: trimmed, excludeProductId },
    { enabled: trimmed.length >= 3, staleTime: 10_000 }
  );
  const similar = similarQ.data ?? [];
  const exact = similar.find((s) => s.isExact);
  const nearMatches = similar.filter((s) => !s.isExact).slice(0, 5);

  if (!showSuggestion && !colorWords.length && !similar.length) return null;

  return (
    <div className="mt-1.5 space-y-1.5 text-xs" dir="rtl">
      {exact && (
        <div role="alert" className="flex items-start gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0 mt-0.5" />
          <span>
            منتج بنفس الاسم موجود فعلاً:{" "}
            <a href={`/products/${exact.id}/edit`} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
              {exact.name}
            </a>
            {exact.isActive ? "" : " (معطَّل)"} — تأكّد أن هذا ليس ازدواجاً قبل الحفظ.
          </span>
        </div>
      )}

      {nearMatches.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-muted-foreground">
          <SearchCheck aria-hidden className="size-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="font-medium text-foreground">منتجات مشابهة موجودة</span> — تأكّد أنك لا تُكرّر صنفاً قائماً:
            <ul className="mt-0.5 space-y-0.5">
              {nearMatches.map((s) => (
                <li key={s.id} className="truncate">
                  <a href={`/products/${s.id}/edit`} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                    {s.name}
                  </a>
                  {s.isActive ? "" : <span className="ms-1 text-[10px]">(معطَّل)</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {showSuggestion && (
        <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5">
          <Wand2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">
            صيغة مقترحة: <bdi className="font-medium text-foreground">{suggestion}</bdi>
          </span>
          <Button type="button" variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => onApply(suggestion)}>
            تطبيق
          </Button>
        </div>
      )}

      {colorWords.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-muted-foreground">
          <Palette aria-hidden className="size-3.5 shrink-0 mt-0.5" />
          <span>
            الاسم يحوي لوناً ({colorWords.join("، ")}) — الألوان تُدار في المتغيّرات أدناه، والملصقات تطبع
            الاسم واللون معاً فيتكرّر («قلم أزرق أزرق»). يُفضَّل اسم بلا لون.
          </span>
        </div>
      )}
    </div>
  );
}
