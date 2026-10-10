import React from "react";
import { Star, ShieldCheck, MessageSquare, ThumbsUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatQuantity } from "@shared/quantityFormat";

interface StorefrontProductReviewsProps {
  productId: number;
}

const dateFormatter = new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatReviewDate(dateVal: Date | string): string {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (Number.isNaN(d.getTime())) return "";
  return dateFormatter.format(d);
}

export function StorefrontProductReviews({ productId }: StorefrontProductReviewsProps) {
  const reviewsQ = trpc.storefront.productReviews.useQuery(
    { productId },
    { staleTime: 60_000 }
  );

  const summary = reviewsQ.data?.summary ?? { count: 0, average: 0 };
  const items = reviewsQ.data?.items ?? [];

  return (
    <section className="mt-5 rounded-2xl border border-slate-200/90 bg-slate-50/70 p-3.5 sm:p-4 dark:border-slate-800 dark:bg-slate-900/60" aria-label="تقييمات وآراء العملاء">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:bg-amber-400/20 dark:text-amber-400">
            <Star aria-hidden className="size-4 fill-current" />
          </div>
          <div>
            <h4 className="text-xs font-black text-slate-800 dark:text-slate-100">تقييمات المتسوقين</h4>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">آراء معتمدة من مشترين حقيقيين</p>
          </div>
        </div>

        {summary.count > 0 ? (
          <div className="flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:ring-slate-700">
            <span className="font-mono text-xs font-black text-amber-600 dark:text-amber-400">
              {summary.average.toFixed(1)}
            </span>
            <div className="flex items-center gap-0.5" aria-label={`متوسط التقييم ${summary.average.toFixed(1)} من 5`}>
              {[1, 2, 3, 4, 5].map((s) => (
                <Star
                  key={s}
                  aria-hidden
                  className={`size-3 ${
                    s <= Math.round(summary.average)
                      ? "fill-amber-400 text-amber-400"
                      : "text-slate-300 dark:text-slate-600"
                  }`}
                />
              ))}
            </div>
            <span className="text-[10px] font-bold text-slate-400">
              ({formatQuantity(summary.count)})
            </span>
          </div>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            تقييمات جديدة
          </span>
        )}
      </div>

      {reviewsQ.isLoading ? (
        <div className="py-4 text-center text-xs text-slate-400 font-medium">جارٍ تحميل التقييمات…</div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center">
          <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
            <ThumbsUp aria-hidden className="size-4" />
          </div>
          <p className="mt-2 text-xs font-bold text-slate-700 dark:text-slate-300">كن أول من يشارك تجربته مع هذا المنتج!</p>
          <p className="mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400">
            يمكنك تقييم المنتج وكتابة ملاحظاتك بعد استلام طلبك من المندوب.
          </p>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-200/60 dark:divide-slate-800/80">
          {items.map((rev) => (
            <article key={rev.id} className="py-2.5 first:pt-1 last:pb-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star
                        key={s}
                        aria-hidden
                        className={`size-2.5 sm:size-3 ${
                          s <= rev.rating
                            ? "fill-amber-400 text-amber-400"
                            : "text-slate-300 dark:text-slate-600"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100/70 px-1.5 py-0.2 text-[9px] font-bold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                    <ShieldCheck aria-hidden className="size-2.5" />
                    <span>مشتري موثّق</span>
                  </span>
                </div>
                {rev.createdAt && (
                  <time className="text-[10px] text-slate-400 font-mono">
                    {formatReviewDate(rev.createdAt)}
                  </time>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                {rev.comment}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
