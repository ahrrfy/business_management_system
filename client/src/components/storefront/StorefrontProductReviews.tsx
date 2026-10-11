import React, { useState } from "react";
import { Star, ShieldCheck, MessageSquare, ThumbsUp, Send, CheckCircle2, AlertCircle, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatQuantity } from "@shared/quantityFormat";
import { TurnstileWidget } from "./TurnstileWidget";

interface StorefrontProductReviewsProps {
  productId: number;
  initialOpenForm?: boolean;
  defaultOrderNumber?: string | null;
  onFormToggle?: (isOpen: boolean) => void;
  className?: string;
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

const RATING_DESCRIPTIONS: Record<number, string> = {
  5: "ممتاز (5 من 5)",
  4: "جيد جداً (4 من 5)",
  3: "جيد (3 من 5)",
  2: "مقبول (2 من 5)",
  1: "ضعيف (1 من 5)",
};

export function StorefrontProductReviews({
  productId,
  initialOpenForm = false,
  defaultOrderNumber = null,
  onFormToggle,
  className = "",
}: StorefrontProductReviewsProps) {
  const [showForm, setShowForm] = useState(initialOpenForm);
  const [rating, setRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerPhone, setReviewerPhone] = useState("");
  const [orderNumber, setOrderNumber] = useState(defaultOrderNumber ?? "");
  const [comment, setComment] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  React.useEffect(() => {
    setShowForm(initialOpenForm);
    setRating(5);
    setHoverRating(0);
    setReviewerName("");
    setReviewerPhone("");
    setOrderNumber(defaultOrderNumber ?? "");
    setComment("");
    setTurnstileToken(null);
    setSubmittedMessage(null);
    setFormError(null);
  }, [productId, initialOpenForm, defaultOrderNumber]);

  const settingsQ = trpc.storefront.settings.useQuery(undefined, { staleTime: 300_000 });

  const reviewsQ = trpc.storefront.productReviews.useQuery(
    { productId },
    { staleTime: 60_000 }
  );

  const submitReviewM = trpc.storefront.submitPublicProductReview.useMutation({
    onSuccess: () => {
      setSubmittedMessage("شكراً لمشاركتك! تم استلام تقييمك بنجاح وسيظهر للمتسوقين فور مراجعته واعتماده.");
      setShowForm(false);
      setComment("");
      setReviewerName("");
      setReviewerPhone("");
      setOrderNumber("");
      setTurnstileToken(null);
      setTurnstileResetKey((k) => k + 1);
      setFormError(null);
      void reviewsQ.refetch();
    },
    onError: (err) => {
      setTurnstileToken(null);
      setTurnstileResetKey((k) => k + 1);
      setFormError(err.message || "تعذّر إرسال التقييم، يرجى التحقق من المدخلات وإعادة المحاولة.");
    },
  });

  const summary = reviewsQ.data?.summary ?? { count: 0, average: 0 };
  const items = reviewsQ.data?.items ?? [];
  const effectiveRating = hoverRating > 0 ? hoverRating : rating;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!reviewerName.trim() || reviewerName.trim().length < 2) {
      setFormError("يرجى كتابة اسمك أو اسم مستعار (حرفين على الأقل).");
      return;
    }
    if (!comment.trim() || comment.trim().length < 8) {
      setFormError("يرجى كتابة ملاحظاتك وتجربتك حول المنتج (8 أحرف على الأقل).");
      return;
    }
    submitReviewM.mutate({
      productId,
      rating,
      reviewerName: reviewerName.trim(),
      reviewerPhone: reviewerPhone.trim() || null,
      orderNumber: orderNumber.trim() || null,
      comment: comment.trim(),
      turnstileToken: turnstileToken ?? undefined,
    });
  };

  return (
    <section
      id="storefront-product-reviews"
      className={`mt-5 rounded-2xl border border-slate-200/90 bg-slate-50/70 p-3.5 sm:p-4 dark:border-slate-800 dark:bg-slate-900/60 ${className}`}
      aria-label="تقييمات وآراء العملاء"
    >
      {/* الترويسة الرئيسية للمراجعات مع زر إضافة التقييم */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:bg-amber-400/20 dark:text-amber-400">
            <Star aria-hidden className="size-4 fill-current" />
          </div>
          <div>
            <h4 className="text-xs font-black text-slate-800 dark:text-slate-100">تقييمات المتسوقين</h4>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">آراء معتمدة ومراجعة من المشترين</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
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

          <button
            type="button"
            onClick={() => {
              setShowForm(!showForm);
              setSubmittedMessage(null);
              setFormError(null);
            }}
            className="inline-flex items-center gap-1 rounded-xl bg-amber-500 px-3 py-1.5 text-[11px] font-black text-white shadow-xs transition hover:bg-amber-600 active:scale-95"
            aria-expanded={showForm}
          >
            {showForm ? (
              "إلغاء التقييم"
            ) : (
              <>
                <Star aria-hidden className="size-3 fill-current" />
                <span>أضف تقييمك</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* إشعار النجاح بعد إرسال التقييم */}
      {submittedMessage && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300" role="status">
          <CheckCircle2 aria-hidden className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
          <div className="flex-1 font-bold leading-relaxed">{submittedMessage}</div>
        </div>
      )}

      {/* نموذج كتابة وإرسال التقييم التفاعلي */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mt-3 rounded-xl border border-amber-200/80 bg-white p-3.5 shadow-xs dark:border-slate-700 dark:bg-slate-800/90">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-slate-700">
            <span className="text-xs font-black text-slate-800 dark:text-slate-100">اكتب تقييمك للمنتج</span>
            <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400">
              {RATING_DESCRIPTIONS[effectiveRating] ?? ""}
            </span>
          </div>

          {/* محدد النجوم التفاعلي */}
          <div className="mt-3 flex flex-col items-center gap-1.5 rounded-xl bg-slate-50/80 py-2.5 dark:bg-slate-900/50">
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">حدد تقييمك بالضغط على النجوم</span>
            <div className="flex items-center gap-1" onMouseLeave={() => setHoverRating(0)}>
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRating(s)}
                  onMouseEnter={() => setHoverRating(s)}
                  aria-label={`تقييم ${s} من 5 نجوم`}
                  className="rounded-md p-1 transition hover:scale-125 focus:outline-none focus:ring-1 focus:ring-amber-400"
                >
                  <Star
                    aria-hidden
                    className={`size-6 transition-colors ${
                      s <= effectiveRating
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300 hover:text-amber-300 dark:text-slate-600"
                    }`}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* حقول الاسم ورقم الهاتف ورقم الطلب */}
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <div>
              <label htmlFor="rev-name" className="block text-[10.5px] font-bold text-slate-700 dark:text-slate-300">
                الاسم <span className="text-rose-500">*</span>
              </label>
              <input
                id="rev-name"
                type="text"
                value={reviewerName}
                onChange={(e) => setReviewerName(e.target.value)}
                placeholder="اسمك أو اسم مستعار"
                maxLength={80}
                required
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50/50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 outline-none transition focus:border-amber-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="rev-phone" className="block text-[10.5px] font-bold text-slate-700 dark:text-slate-300">
                رقم الهاتف <span className="text-slate-400 font-normal">(اختياري)</span>
              </label>
              <input
                id="rev-phone"
                type="tel"
                value={reviewerPhone}
                onChange={(e) => setReviewerPhone(e.target.value)}
                placeholder="+964 7... للتحقق"
                maxLength={32}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50/50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 outline-none transition focus:border-amber-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="rev-order" className="block text-[10.5px] font-bold text-slate-700 dark:text-slate-300">
                رقم الطلب <span className="text-slate-400 font-normal">(شارة شراء موثق)</span>
              </label>
              <input
                id="rev-order"
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="ORD-..."
                maxLength={40}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50/50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 outline-none transition focus:border-amber-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
            ملاحظة للخصوصية: تُنشر المراجعات المعتمدة بصفة «متسوق موثق» ولا تظهر أرقامك أو بياناتك للعامة.
          </p>

          {/* نص التقييم والملاحظات */}
          <div className="mt-2.5">
            <div className="flex items-center justify-between">
              <label htmlFor="rev-comment" className="block text-[10.5px] font-bold text-slate-700 dark:text-slate-300">
                رأيك وتجربتك مع المنتج <span className="text-rose-500">*</span>
              </label>
              <span className="font-mono text-[9.5px] text-slate-400">
                {formatQuantity(comment.length)} / {formatQuantity(1000)}
              </span>
            </div>
            <textarea
              id="rev-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="اكتب تجربتك وملاحظاتك حول جودة المنتج، دقة الوصف، سرعة التوصيل، والتغليف..."
              maxLength={1000}
              required
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50/50 p-2.5 text-xs font-semibold leading-relaxed text-slate-800 outline-none transition focus:border-amber-500 focus:bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          {/* اختبار الحماية من الروبوتات Turnstile */}
          {settingsQ.data?.turnstileSiteKey && (
            <div className="mt-2.5">
              <TurnstileWidget
                siteKey={settingsQ.data.turnstileSiteKey}
                resetKey={turnstileResetKey}
                onTokenChange={setTurnstileToken}
              />
            </div>
          )}

          {formError && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400" role="alert">
              <AlertCircle aria-hidden className="size-3.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-xl px-3 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={submitReviewM.isPending}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-1.5 text-xs font-black text-white shadow-sm transition hover:bg-amber-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send aria-hidden className="size-3" />
              <span>{submitReviewM.isPending ? "جارٍ إرسال التقييم…" : "إرسال التقييم"}</span>
            </button>
          </div>
        </form>
      )}

      {/* عرض المراجعات المعتمدة أو الحالة الفارغة */}
      {reviewsQ.isLoading ? (
        <div className="py-4 text-center text-xs text-slate-400 font-medium">جارٍ تحميل التقييمات…</div>
      ) : items.length === 0 ? (
        <div className="py-5 text-center">
          <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
            <ThumbsUp aria-hidden className="size-4" />
          </div>
          <p className="mt-2 text-xs font-bold text-slate-700 dark:text-slate-300">كن أول من يشارك تجربته مع هذا المنتج!</p>
          <p className="mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400">
            رأيك يهمنا ويفيد عملاءنا في بغداد والمحافظات. شاركنا تقييمك الآن.
          </p>
          {!showForm && (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-50 px-3.5 py-1.5 text-xs font-black text-amber-800 shadow-xs transition hover:bg-amber-100 active:scale-95 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <Star aria-hidden className="size-3.5 fill-current text-amber-500" />
              <span>أضف أول تقييم للمنتج</span>
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 divide-y divide-slate-200/60 dark:divide-slate-800/80">
          {items.map((rev) => (
            <article key={rev.id} className="py-2.5 first:pt-1 last:pb-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-0.5" aria-label={`تقييم ${rev.rating} من 5`}>
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
                  <span className="font-bold text-[10.5px] text-slate-800 dark:text-slate-200">
                    {rev.reviewerName ?? "مشتري موثّق"}
                  </span>
                  {rev.isVerifiedPurchase ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100/80 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                      <ShieldCheck aria-hidden className="size-2.5" />
                      <span>شراء موثّق</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      <span>متسوق</span>
                    </span>
                  )}
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
