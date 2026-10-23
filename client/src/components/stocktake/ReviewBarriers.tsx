import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, X, Pen } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";
import { nf, money, dt } from "./ReviewDisplay";
type Review = RouterOutputs["stocktakes"]["review"];
export function ReviewBarriers({
  barriers,
  s,
  isOpening,
}: {
  barriers: Review["barriers"];
  s: Review["session"];
  isOpening: boolean;
}) {
  return (
    <>
      {" "}
      {/* لوحة حواجز الاعتماد */}
      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-3">
          <CardTitle className="text-sm">
            حواجز الاعتماد — يجب أن تخضرّ كلها قبل التنفيذ
          </CardTitle>
        </CardHeader>
        <div className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.notCounted === 0 ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"}`}
          >
            {barriers.notCounted === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل منتجات النطاق
                معدودة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" /> {nf(barriers.notCounted)}{" "}
                منتج غير معدود — يحجب الاعتماد
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.countedPendingReview === 0 ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"}`}
          >
            {barriers.countedPendingReview === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل المنتجات المعدودة
                معتمدة ببصمة صالحة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.countedPendingReview)} منتج يحتاج اعتماداً مرحلياً
                {barriers.staleReviewApprovals > 0
                  ? ` (${nf(barriers.staleReviewApprovals)} اعتماد قديم)`
                  : ""}
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.pendingRecounts === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.pendingRecounts === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا إعادات عدّ معلّقة
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.pendingRecounts)} منتج بانتظار إعادة العدّ
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.openConflicts === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.openConflicts === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا تعارض بين عدَّين
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.openConflicts)} تعارض مفتوح يحتاج فصلاً
              </>
            )}
          </p>
          <p
            className={`inline-flex items-center gap-1.5 ${barriers.undecidedOverThreshold === 0 ? "text-money-positive" : "text-money-negative"}`}
          >
            {barriers.undecidedOverThreshold === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> كل ما يتجاوز الحدّ له
                قرار
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.undecidedOverThreshold)} فرق يتجاوز الحدّ بلا قرار
              </>
            )}
          </p>
          {s.requireRecountOverThreshold && (
            <p
              className={`inline-flex items-center gap-1.5 ${barriers.overThresholdNeedingRecount === 0 ? "text-money-positive" : "text-money-negative"}`}
            >
              {barriers.overThresholdNeedingRecount === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" /> كل ما يتجاوز الحدّ
                  أُعيد عدّه
                </>
              ) : (
                <>
                  <X aria-hidden className="size-3.5" />{" "}
                  {nf(barriers.overThresholdNeedingRecount)} فرق يتجاوز الحدّ
                  يلزمه إعادة عدّ فعلية
                </>
              )}
            </p>
          )}
          {isOpening && (
            <p
              className={`inline-flex items-center gap-1.5 ${
                barriers.valuationBlockingAnomalies === 0
                  ? "text-money-positive"
                  : "text-money-negative"
              }`}
            >
              {barriers.valuationBlockingAnomalies === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" /> لا تضخم مادي في
                  أساس التكلفة
                </>
              ) : (
                <>
                  <X aria-hidden className="size-3.5" />{" "}
                  {nf(barriers.valuationBlockingAnomalies)} تضخم تكلفة/وحدة يحجب
                  الاعتماد
                </>
              )}
            </p>
          )}
          <p
            className={`inline-flex items-center gap-1.5 ${
              barriers.countInputAnomalies === 0
                ? "text-money-positive"
                : "text-money-negative"
            }`}
          >
            {barriers.countInputAnomalies === 0 ? (
              <>
                <Check aria-hidden className="size-3.5" /> لا توجد بصمة باركود
                داخل كميات العدّ
              </>
            ) : (
              <>
                <X aria-hidden className="size-3.5" />{" "}
                {nf(barriers.countInputAnomalies)} كمية مشتبهة تحجب الاعتماد
              </>
            )}
          </p>
          {barriers.requiresDualSign && (
            <p
              className={`inline-flex items-center gap-1.5 sm:col-span-2 xl:col-span-4 ${barriers.firstSigned ? "text-violet-700" : "text-[var(--sem-warn)]"}`}
            >
              <Pen aria-hidden className="size-3.5" />
              <span>
                {isOpening
                  ? "توقيع مزدوج إلزامي لتأسيس الأرصدة"
                  : `توقيع مزدوج مطلوب (فروقات فوق ${money(s.dualThreshold)})`}{" "}
                —{" "}
                {barriers.firstSigned ? (
                  <>
                    التوقيع الأول
                    <Check
                      aria-hidden
                      className="mx-1 inline size-3.5 align-text-bottom"
                    />
                    {s.firstSign
                      ? `(${s.firstSign.byName} · ${dt(s.firstSign.at)})`
                      : ""}{" "}
                    — الاعتماد النهائي من مسؤول آخر
                  </>
                ) : (
                  "لم يوقَّع التوقيع الأول بعد"
                )}
              </span>
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
