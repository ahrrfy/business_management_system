/**
 * نموذج تسجيل تقييم الرضا والشكاوى التشغيلية (Feedback & Quality Complaint Modal).
 * يدعم تسجيل التقييم (1 إلى 5 نجوم) وتصنيف محطة الخلل ودورة حياة المعالجة.
 *
 * صفر إيموجي — يعتمد أيقونات lucide-react حصراً (حارس check:emoji).
 */

import { useState, useEffect } from "react";
import {
  Star,
  MessageSquarePlus,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";

export interface FeedbackModalProps {
  isOpen?: boolean;
  open?: boolean;
  onClose: () => void;
  customerId: number;
  customerName: string;
  customerPhone?: string | null;
  workOrderId?: number | null;
  workOrderNumber?: string | null;
  invoiceId?: number | null;
  existingFeedback?: {
    id: number;
    rating: number;
    category: string;
    comment?: string | null;
    issueStatus: "NEW" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
    rootCauseStation?: string | null;
    resolutionAction?: string | null;
  } | null;
  onSuccess?: () => void;
}

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  ROOT_CAUSE_STATIONS,
  ROOT_CAUSE_STATION_LABELS,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type FeedbackCategory,
  type RootCauseStation,
  type IssueStatus,
} from "@shared/customerFeedback";

const CATEGORY_OPTIONS = FEEDBACK_CATEGORIES.map((cat) => ({
  value: cat,
  label: FEEDBACK_CATEGORY_LABELS[cat],
}));

const STATION_OPTIONS = ROOT_CAUSE_STATIONS.map((station) => ({
  value: station,
  label: ROOT_CAUSE_STATION_LABELS[station],
}));

const STATUS_OPTIONS = ISSUE_STATUSES.map((status) => ({
  value: status,
  label: ISSUE_STATUS_LABELS[status],
}));

export function FeedbackModal({
  isOpen,
  open,
  onClose,
  customerId,
  customerName,
  workOrderId,
  workOrderNumber,
  invoiceId,
  existingFeedback,
  onSuccess,
}: FeedbackModalProps) {
  const modalOpen = open ?? isOpen ?? false;
  const [rating, setRating] = useState<number>(5);
  const [category, setCategory] = useState<string>("GENERAL");
  const [rootCauseStation, setRootCauseStation] = useState<string>("PRINTING");
  const [comment, setComment] = useState<string>("");
  const [issueStatus, setIssueStatus] = useState<
    "NEW" | "IN_PROGRESS" | "RESOLVED" | "CLOSED"
  >("NEW");
  const [resolutionAction, setResolutionAction] = useState<string>("");

  const utils = trpc.useUtils();

  useEffect(() => {
    if (existingFeedback) {
      setRating(existingFeedback.rating);
      setCategory(existingFeedback.category);
      setComment(existingFeedback.comment || "");
      setIssueStatus(existingFeedback.issueStatus);
      setRootCauseStation(existingFeedback.rootCauseStation || "PRINTING");
      setResolutionAction(existingFeedback.resolutionAction || "");
    } else {
      setRating(workOrderId ? 2 : 5);
      setCategory(workOrderId ? "COLOR_QUALITY" : "GENERAL");
      setComment("");
      setIssueStatus("NEW");
      setRootCauseStation("PRINTING");
      setResolutionAction("");
    }
  }, [existingFeedback, modalOpen, workOrderId]);

  const createMutation = trpc.customers.createFeedback.useMutation({
    onSuccess: () => {
      notify.ok("تم تسجيل التقييم والملاحظة بنجاح");
      utils.customers.dossier360.invalidate({ customerId });
      utils.customers.feedbackList.invalidate();
      onSuccess?.();
      onClose();
    },
    onError: (err) => {
      notify.err(err.message || "تعذر تسجيل التقييم");
    },
  });

  const updateMutation = trpc.customers.updateFeedbackStatus.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الشكوى بنجاح");
      utils.customers.dossier360.invalidate({ customerId });
      utils.customers.feedbackList.invalidate();
      onSuccess?.();
      onClose();
    },
    onError: (err) => {
      notify.err(err.message || "تعذر تحديث حالة الشكوى");
    },
  });

  const handleSubmit = () => {
    if (existingFeedback) {
      updateMutation.mutate({
        feedbackId: existingFeedback.id,
        customerId,
        issueStatus,
        resolutionAction: resolutionAction.trim() || undefined,
        rootCauseStation: rootCauseStation || undefined,
      });
    } else {
      createMutation.mutate({
        customerId,
        rating,
        category,
        comment: comment.trim() || undefined,
        rootCauseStation:
          rating <= 3 || !!workOrderId ? rootCauseStation : undefined,
        workOrderId: workOrderId || undefined,
        invoiceId: invoiceId || undefined,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={modalOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <MessageSquarePlus
              aria-hidden="true"
              className="size-5 text-primary"
            />
            <span>
              {existingFeedback
                ? "متابعة وتحديث حالة الشكوى"
                : workOrderId
                  ? `تسجيل شكوى على أمر الشغل #${workOrderNumber || workOrderId}`
                  : `تقييم تجربة العميل: ${customerName}`}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {existingFeedback
              ? "تحديث إجراء المعالجة ومحطة الخلل وحل الشكوى أصولياً"
              : workOrderId
                ? `توثيق الملاحظة أو الخلل ومحطة الإنتاج المتسببة للزبون: ${customerName}`
                : "تسجيل تقييم الجودة والتغذية العكسية لتحسين جودة الطباعة والخدمة"}
          </DialogDescription>
        </DialogHeader>

        {workOrderId && !existingFeedback && (
          <div className="flex items-center gap-1.5 p-2 rounded-md bg-rose-50 border border-rose-200 text-rose-800 dark:bg-rose-950/30 dark:border-rose-900 dark:text-rose-300 text-xs">
            <AlertCircle
              aria-hidden="true"
              className="size-4 shrink-0 text-rose-600 dark:text-rose-400"
            />
            <span>
              شكوى وملاحظة جودة مرتبطة بأمر الشغل:{" "}
              <strong className="font-mono font-bold">
                #{workOrderNumber || workOrderId}
              </strong>
            </span>
          </div>
        )}

        <div className="space-y-4 py-2 text-xs">
          {/* مقياس التقييم بالنجوم */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">
              مستوى رضا العميل (1 إلى 5 نجوم):
            </Label>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-muted/40 p-2 rounded-lg border">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    disabled={!!existingFeedback}
                    onClick={() => setRating(star)}
                    className="p-1 hover:scale-110 transition-transform focus:outline-none disabled:cursor-not-allowed"
                    title={`${star} نجوم`}
                  >
                    <Star
                      aria-hidden="true"
                      className={`size-6 ${
                        star <= rating
                          ? "fill-amber-400 text-amber-500"
                          : "text-muted-foreground/30"
                      }`}
                    />
                  </button>
                ))}
              </div>
              <span className="text-xs font-semibold text-foreground/80">
                {rating === 5 && "ممتاز جداً راضٍ بالكامل"}
                {rating === 4 && "جيد جداً تجربة إيجابية"}
                {rating === 3 && "متوسط مع ملاحظات"}
                {rating === 2 && "غير راضٍ يوجد عتب"}
                {rating === 1 && "استياء شديد شكوى عاجلة"}
              </span>
            </div>
          </div>

          {/* تصنيف المشكلة */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">
              تصنيف التقييم أو الملاحظة:
            </Label>
            <AppSelect
              value={category}
              onValueChange={(val: string) => setCategory(val)}
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </AppSelect>
          </div>

          {/* محطة الخلل (تظهر عند التقييم المتوسط أو المنخفض أو وجود شكوى أو أمر شغل) */}
          {(rating <= 3 || !!workOrderId || existingFeedback) && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-rose-700 dark:text-rose-400 flex items-center gap-1">
                <AlertCircle aria-hidden="true" className="size-3.5" />
                <span>محطة العمل المتسببة بالعتب / الشكوى:</span>
              </Label>
              <AppSelect
                value={rootCauseStation}
                onValueChange={(val: string) => setRootCauseStation(val)}
              >
                {STATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </AppSelect>
            </div>
          )}

          {/* نص الملاحظة أو الشكوى */}
          {!existingFeedback && (
            <div className="space-y-1.5">
              <Label htmlFor="comment-text" className="text-xs font-semibold">
                تفاصيل ملاحظة الزبون:
              </Label>
              <Textarea
                id="comment-text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="أدخل نص الملاحظة أو العتب من الزبون..."
                rows={3}
                className="text-xs resize-none"
              />
            </div>
          )}

          {/* دورة حياة معالجة الشكوى (عند تعديل شكوى موجودة) */}
          {existingFeedback && (
            <div className="space-y-3 p-3 rounded-lg border bg-amber-50/30 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">
                  حالة معالجة الشكوى:
                </Label>
                <AppSelect
                  value={issueStatus}
                  onValueChange={(val: string) =>
                    setIssueStatus(
                      val as "NEW" | "IN_PROGRESS" | "RESOLVED" | "CLOSED",
                    )
                  }
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="resolution-action"
                  className="text-xs font-semibold"
                >
                  الإجراء المتخذ للحل والتعويض:
                </Label>
                <Textarea
                  id="resolution-action"
                  value={resolutionAction}
                  onChange={(e) => setResolutionAction(e.target.value)}
                  placeholder="بيّن ما تم اتخاذه لإرضاء الزبون (إعادة طباعة، خصم، ترضية بقسيمة...)"
                  rows={2}
                  className="text-xs resize-none"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={isPending}
          >
            إلغاء
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={isPending}
            className="gap-1.5"
          >
            {isPending ? (
              <RefreshCw aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
            )}
            <span>
              {existingFeedback ? "حفظ وتحديث الشكوى" : "تسجيل التقييم"}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
