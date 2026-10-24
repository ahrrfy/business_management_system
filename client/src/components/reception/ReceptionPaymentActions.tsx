import { BookmarkCheck, Check, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { PaymentPanelProps } from "./PaymentPanel";
export function ReceptionPaymentActions(
  props: PaymentPanelProps & {
    submitAllowed: boolean;
    noCollectionNow: boolean;
  },
) {
  const {
    splitTender,
    deferred,
    deferredAvailable,
    expectedNow,
    paid,
    hasCustom,
    submitting,
    cartEmpty,
    hasShift,
    submitAllowed,
    onSubmit,
  } = props;
  return (
    <div className="ms-auto flex items-center gap-2">
      {splitTender?.active ? (
        <Button
          type="button"
          size="lg"
          disabled={
            !submitAllowed ||
            cartEmpty ||
            submitting ||
            !hasShift ||
            (deferred && !deferredAvailable)
          }
          onClick={() => onSubmit({ quickFullPay: false })}
        >
          {submitting ? "جارٍ الإرسال…" : "تثبيت الدفعات وطباعة"}
        </Button>
      ) : (
        <>
          {hasCustom ? (
            <>
              {paid > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={
                      !submitAllowed || cartEmpty || submitting || !hasShift
                    }
                    onClick={() =>
                      onSubmit({ quickFullPay: false, isReservation: true })
                    }
                    title="حفظ بدون دفعة وتأجيل كامل المبلغ للدفع عند الاستلام"
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border-2 border-primary/80 bg-primary/5 px-3 text-xs font-black text-primary shadow-xs transition-colors hover:bg-primary/15 disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent disabled:shadow-none"
                  >
                    <BookmarkCheck aria-hidden className="size-4" />
                    <span>دفع عند الاستلام (بلا عربون)</span>
                  </button>
                  {paid < expectedNow && (
                    <button
                      type="button"
                      disabled={
                        !submitAllowed || cartEmpty || submitting || !hasShift
                      }
                      onClick={() => onSubmit({ quickFullPay: true })}
                      title="تحصيل الإجمالي كاملاً وطباعة"
                      className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-3 text-xs font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                    >
                      <Zap aria-hidden className="size-4" />
                      <span>تحصيل الإجمالي وطباعة</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={
                      !submitAllowed || cartEmpty || submitting || !hasShift
                    }
                    onClick={() => onSubmit({ quickFullPay: false })}
                    title={
                      paid >= expectedNow
                        ? "قبض المبلغ كاملاً وإرسال للتنفيذ"
                        : "قبض الدفعة/العربون وإرسال للتنفيذ"
                    }
                    className="inline-flex h-11 min-w-44 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    {submitting ? (
                      "جارٍ الإرسال…"
                    ) : (
                      <>
                        <Check aria-hidden className="size-4" />
                        <span>
                          {paid >= expectedNow
                            ? "قبض المبلغ كاملاً وإرسال للتنفيذ"
                            : "قبض الدفعة وإرسال للتنفيذ"}
                        </span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={
                      !submitAllowed || cartEmpty || submitting || !hasShift
                    }
                    onClick={() => onSubmit({ quickFullPay: true })}
                    title="تحصيل الإجمالي كاملاً وطباعة (F4)"
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-4 text-sm font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    <Zap aria-hidden className="size-4" />
                    <span>تحصيل الإجمالي وطباعة</span>
                  </button>
                  <button
                    type="button"
                    disabled={
                      !submitAllowed || cartEmpty || submitting || !hasShift
                    }
                    onClick={() =>
                      onSubmit({ quickFullPay: false, isReservation: true })
                    }
                    title="تأكيد الطلب للتنفيذ والتحصيل عند الاستلام"
                    className="inline-flex h-11 min-w-48 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                  >
                    {submitting ? (
                      "جارٍ الإرسال…"
                    ) : (
                      <>
                        <BookmarkCheck aria-hidden className="size-4" />
                        <span>الدفع عند الاستلام</span>
                      </>
                    )}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={
                  !submitAllowed || cartEmpty || submitting || !hasShift
                }
                onClick={() =>
                  onSubmit({ quickFullPay: false, isReservation: true })
                }
                title="تأكيد الفاتورة للدفع عند الاستلام مباشرة أو عبر جهة التوصيل"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border-2 border-primary/80 bg-primary/5 px-4 text-sm font-black text-primary shadow-xs transition-colors hover:bg-primary/15 disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent disabled:shadow-none"
              >
                <BookmarkCheck aria-hidden className="size-4" />
                <span>الدفع عند الاستلام</span>
              </button>
              {!deferred && (
                <button
                  type="button"
                  disabled={
                    !submitAllowed || cartEmpty || submitting || !hasShift
                  }
                  onClick={() => onSubmit({ quickFullPay: true })}
                  title="تحصيل المطلوب الآن وطباعة (F4)"
                  className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--sem-warn)] px-4 text-sm font-black text-background shadow-md transition-colors hover:bg-[var(--sem-warn)]/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
                >
                  <Zap aria-hidden className="size-4" />
                  <span>تحصيل المطلوب وطباعة</span>
                </button>
              )}
              <button
                type="button"
                disabled={
                  !submitAllowed ||
                  cartEmpty ||
                  submitting ||
                  !hasShift ||
                  (deferred && !deferredAvailable)
                }
                onClick={() =>
                  onSubmit({ quickFullPay: !deferred && paid <= 0 })
                }
                title="إتمام البيع المباشر"
                className="inline-flex h-11 min-w-44 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {submitting ? (
                  "جارٍ الإرسال…"
                ) : (
                  <>
                    <Check aria-hidden className="size-4" />
                    <span>إتمام البيع المباشر</span>
                  </>
                )}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
