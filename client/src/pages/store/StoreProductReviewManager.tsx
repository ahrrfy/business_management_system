import {
  Check,
  EyeOff,
  LockKeyhole,
  MessageSquare,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingState } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
type ReviewDecision = Extract<ReviewStatus, "APPROVED" | "REJECTED">;

const STATUS_AR: Record<ReviewStatus, string> = {
  PENDING: "بانتظار الاعتماد",
  APPROVED: "منشورة",
  REJECTED: "مرفوضة",
};

const STATUS_DESCRIPTION: Record<ReviewStatus, string> = {
  PENDING:
    "لا تظهر هذه المراجعات للمتسوقين. راجع النص والتقييم ثم احسم القرار مرة واحدة.",
  APPROVED:
    "هذه المراجعات ظاهرة علناً بالنص والتقييم فقط، من دون اسم العميل أو أي بيانات تعريفية.",
  REJECTED: "هذه المراجعات محفوظة في السجل الداخلي فقط ولا تظهر للمتسوقين.",
};

const dateFormatter = new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatReviewDate(value: Date | string) {
  return dateFormatter.format(value instanceof Date ? value : new Date(value));
}

function statusBadgeVariant(status: ReviewStatus) {
  if (status === "APPROVED") return "success" as const;
  if (status === "REJECTED") return "danger" as const;
  return "warning" as const;
}

function RatingStars({ rating }: { rating: number }) {
  return (
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={`التقييم ${rating} من 5`}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <Star
          key={index}
          aria-hidden
          className={`size-4 ${index < rating ? "fill-current text-[var(--sem-warn)]" : "text-muted-foreground/30"}`}
        />
      ))}
      <span
        className="ms-1 text-xs font-medium text-muted-foreground"
        dir="ltr"
      >
        {rating} / 5
      </span>
    </div>
  );
}

function FeedbackMetric({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
        {note && <div className="mt-1 text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

export default function StoreProductReviewManager() {
  const [status, setStatus] = useState<ReviewStatus>("PENDING");
  const [pendingDecision, setPendingDecision] = useState<{
    reviewId: number;
    status: ReviewDecision;
  } | null>(null);
  const utils = trpc.useUtils();
  const reviews = trpc.storeAdmin.reviews.list.useQuery({ status });
  const summaryUnavailable = reviews.isLoading || reviews.isError;
  const feedbackSummary = useMemo(() => {
    const rows = reviews.data ?? [];
    const ratingTotal = rows.reduce(
      (total, review) => total + review.rating,
      0,
    );

    return {
      count: rows.length,
      average: rows.length ? (ratingTotal / rows.length).toFixed(1) : "—",
      lowRatings: rows.filter((review) => review.rating <= 2).length,
    };
  }, [reviews.data]);
  const moderate = trpc.storeAdmin.reviews.moderate.useMutation({
    onMutate: (variables) => setPendingDecision(variables),
    onSuccess: async (_, variables) => {
      await utils.storeAdmin.reviews.list.invalidate();
      notify.ok(
        variables.status === "APPROVED"
          ? "تم اعتماد المراجعة ونشرها بلا بيانات تعريفية للعميل"
          : "تم رفض المراجعة وإبقاؤها خارج المتجر العام",
      );
    },
    onError: (error) => notify.err(error),
    onSettled: () => setPendingDecision(null),
  });

  async function handleDecision(reviewId: number, decision: ReviewDecision) {
    const isApproval = decision === "APPROVED";
    const accepted = await confirm({
      title: isApproval ? "اعتماد ونشر المراجعة" : "رفض المراجعة",
      description: isApproval
        ? "سيظهر التقييم والنص للمتسوقين دون اسم العميل أو أي بيانات تعريفية. القرار نهائي ولا يمكن تغييره."
        : "ستبقى المراجعة في السجل الداخلي ولن تظهر للمتسوقين. القرار نهائي ولا يمكن تغييره.",
      confirmText: isApproval ? "اعتماد ونشر" : "رفض نهائي",
      variant: isApproval ? "warning" : "danger",
    });

    if (accepted) moderate.mutate({ reviewId, status: decision });
  }

  const rows = reviews.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-8">
      <PageHeader
        title="مراجعات العملاء"
        description="اعتمد المراجعات الموثقة بعد تسليم الطلب؛ النشر لا يشمل اسم العميل أو بياناته التعريفية."
      />

      <section
        aria-label="حالة المراجعات"
        className="rounded-xl border bg-muted/30 p-3"
      >
        <div className="flex flex-wrap gap-2">
          {(["PENDING", "APPROVED", "REJECTED"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? "default" : "outline"}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {STATUS_AR[value]}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {STATUS_DESCRIPTION[status]}
        </p>
      </section>

      <section
        aria-label="ملخص المراجعات المعروضة"
        className="grid gap-3 sm:grid-cols-3"
      >
        <FeedbackMetric
          label="مراجعات الحالة"
          value={summaryUnavailable ? "—" : feedbackSummary.count}
          note={
            summaryUnavailable ? "بعد اكتمال تحميل السجل" : "ضمن السجل المعروض"
          }
        />
        <FeedbackMetric
          label="متوسط التقييم"
          value={summaryUnavailable ? "—" : feedbackSummary.average}
          note="من 5"
        />
        <FeedbackMetric
          label="تقييمات تحتاج انتباهاً"
          value={summaryUnavailable ? "—" : feedbackSummary.lowRatings}
          note="نجمتان أو أقل"
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare aria-hidden className="size-4" />
            {STATUS_AR[status]}
          </CardTitle>
          <CardDescription>{STATUS_DESCRIPTION[status]}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reviews.isLoading ? (
            <LoadingState message={ACTION_LABELS.loading} />
          ) : reviews.isError ? (
            <ErrorState
              message={reviews.error.message}
              onRetry={() => reviews.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              reason="NO_ROWS_YET"
              title={`لا توجد مراجعات ${STATUS_AR[status]} حالياً.`}
              description="غيّر الحالة أو عد لاحقاً بعد وصول مراجعات موثقة من الطلبات المسلّمة."
            />
          ) : (
            rows.map((review) => {
              const isThisReviewPending =
                pendingDecision?.reviewId === review.id;

              return (
                <article
                  key={review.id}
                  className="rounded-xl border bg-card p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold">{review.productName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          أُرسلت في {formatReviewDate(review.createdAt)}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck aria-hidden className="size-3" />
                          العميل: {review.customerName} (للاستخدام الداخلي فقط)
                        </span>
                      </div>
                    </div>
                    <Badge variant={statusBadgeVariant(review.status)}>
                      {STATUS_AR[review.status]}
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <RatingStars rating={review.rating} />
                    {review.status === "APPROVED" && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <EyeOff aria-hidden className="size-3.5" />
                        المنشور: النص والتقييم فقط
                      </span>
                    )}
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/85">
                    {review.comment}
                  </p>

                  {review.status === "PENDING" ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <LockKeyhole aria-hidden className="size-3.5" />
                        القرار نهائي: الاعتماد ينشر النص والتقييم فقط، والرفض
                        يبقيه خاصاً.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={moderate.isPending}
                          onClick={() => handleDecision(review.id, "REJECTED")}
                        >
                          <X aria-hidden className="size-4" />
                          {isThisReviewPending &&
                          pendingDecision.status === "REJECTED"
                            ? ACTION_LABELS.rejecting
                            : "رفض نهائي"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={moderate.isPending}
                          onClick={() => handleDecision(review.id, "APPROVED")}
                        >
                          <Check aria-hidden className="size-4" />
                          {isThisReviewPending &&
                          pendingDecision.status === "APPROVED"
                            ? ACTION_LABELS.approving
                            : "اعتماد ونشر"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 flex items-center gap-1.5 border-t pt-4 text-xs text-muted-foreground">
                      <LockKeyhole aria-hidden className="size-3.5" />
                      حُسم القرار نهائياً ولا يمكن تعديل حالة هذه المراجعة.
                    </p>
                  )}
                </article>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
