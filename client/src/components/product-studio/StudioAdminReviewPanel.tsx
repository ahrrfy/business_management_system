import React, { useState, useMemo, useCallback } from "react";
import {
  CheckCircle2,
  XCircle,
  Star,
  Loader2,
  Sparkles,
  RefreshCw,
  Clock,
  User,
  Barcode,
  Copy,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { resolveStudioImageSrc } from "@/lib/productImages";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";

export interface StudioAdminReviewTask {
  id: number;
  productId?: number | null;
  productName: string;
  sku?: string | null;
  barcode?: string | null;
  variantId?: number | null;
  variantName?: string | null;
  variantKind?: "VARIANT" | "ALTERNATIVE" | string | null;
  variantLabel?: string | null;
  existingImageCount?: number;
  existingImageThumbs?: Array<{ id: number; src: string; isPrimary?: boolean }>;
  status: string;
  mode?: "FLATTEN" | "CUT" | "PRO" | "AI" | "ORIGINAL" | string | null;
  assignedTo?: number | null;
  assigneeName?: string | null;
  photographerName?: string | null;
  submittedAt?: Date | string | null;
  submittedBy?: number | null;
  createdAt?: Date | string | null;
  revision?: number;
  previewUrl?: string | null;
  hasCandidate?: boolean;
  sourceImageId?: number | null;
  isPrimary?: boolean;
}

export interface StudioAdminReviewPanelProps {
  mockTasks?: StudioAdminReviewTask[];
  mockOnApprove?: (taskIds: number[]) => Promise<any> | void;
  mockOnReject?: (taskIds: number[], reason: string) => Promise<any> | void;
  mockOnSetPrimary?: (imageIdOrTaskId: number) => Promise<any> | void;
  className?: string;
}

function RemoteCandidatePreview({ task }: { task: StudioAdminReviewTask }) {
  const previewQuery = trpc.productStudio.candidatePreview.useQuery(
    { taskId: task.id },
    { staleTime: 60_000, retry: 2 },
  );

  const highResSrc = useMemo(() => {
    const base64 = previewQuery.data?.processedBase64;
    if (!base64) return null;
    const mime = previewQuery.data?.processedMime || "image/jpeg";
    return `data:${mime};base64,${base64}`;
  }, [previewQuery.data]);

  const src = highResSrc ?? task.previewUrl ?? null;

  if (src) {
    return (
      <img
        src={src}
        alt={task.productName}
        className="w-full h-full object-contain p-2 transition-transform duration-200 hover:scale-105"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-4 text-muted-foreground">
      <ImageIcon className="size-12 opacity-40 mb-1" />
      <span className="text-xs">
        {previewQuery.isLoading ? "جاري تحميل المعاينة..." : "معاينة الصورة"}
      </span>
    </div>
  );
}

function ReviewCandidateImage({ task }: { task: StudioAdminReviewTask }) {
  if (task.hasCandidate && typeof (trpc.productStudio as any)?.candidatePreview?.useQuery === "function") {
    return <RemoteCandidatePreview task={task} />;
  }

  if (task.previewUrl) {
    return (
      <img
        src={task.previewUrl}
        alt={task.productName}
        className="w-full h-full object-contain p-2 transition-transform duration-200 hover:scale-105"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-4 text-muted-foreground">
      <ImageIcon className="size-12 opacity-40 mb-1" />
      <span className="text-xs">معاينة الصورة</span>
    </div>
  );
}

export function StudioAdminReviewPanel({
  mockTasks,
  mockOnApprove,
  mockOnReject,
  mockOnSetPrimary,
  className = "",
}: StudioAdminReviewPanelProps) {
  const utils = trpc.useUtils();

  // جلب المهام الحقيقية في حال عدم تمرير mockTasks
  const tasksQuery = trpc.productStudio.tasks.useQuery(
    {
      scope: "REVIEW",
      statuses: ["PENDING_REVIEW"],
      limit: 50,
    },
    {
      enabled: !mockTasks,
      staleTime: 10_000,
    },
  );

  const bulkApproveMutation = trpc.productStudio.bulkApproveStudioTasks.useMutation();
  const bulkRejectMutation = trpc.productStudio.bulkRejectStudioTasks.useMutation();
  const setPrimaryMutation = trpc.productStudio.setImagePrimary.useMutation();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [galleryTask, setGalleryTask] = useState<StudioAdminReviewTask | null>(null);

  // دمج المهام المحاكاة أو المسترجعة من الخادم
  const tasks: StudioAdminReviewTask[] = useMemo(() => {
    if (mockTasks) return mockTasks;
    const items = tasksQuery.data?.items ?? [];
    return items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      sku: item.sku ?? null,
      barcode: item.barcode ?? null,
      variantId: item.variantId,
      variantName: item.variantName,
      variantKind: item.variantKind ?? null,
      variantLabel: item.variantLabel ?? null,
      existingImageCount: item.existingImageCount ?? 0,
      existingImageThumbs: item.existingImageThumbs ?? [],
      status: item.status,
      mode: item.mode,
      assignedTo: item.assignedTo,
      assigneeName: item.assigneeName,
      photographerName: item.assigneeName,
      submittedAt: item.submittedAt ?? item.createdAt,
      submittedBy: item.submittedBy,
      createdAt: item.createdAt,
      revision: item.revision,
      previewUrl: item.previewThumbUrl ?? null,
      hasCandidate: item.hasCandidate,
      sourceImageId: item.sourceImageId,
      isPrimary: false,
    }));
  }, [mockTasks, tasksQuery.data?.items]);

  const allSelected = tasks.length > 0 && selectedIds.size === tasks.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < tasks.length;

  const handleToggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tasks.map((t) => t.id)));
    }
  }, [allSelected, tasks]);

  const handleToggleItem = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // الاعتماد الجماعي
  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setIsApproving(true);
    try {
      if (mockOnApprove) {
        await mockOnApprove(ids);
      } else {
        // تنفيذ الاعتماد الجماعي عبر إجراء واحد بدلاً من تجميع نداءات فردية في طلب دفعي واحد
        const result = await bulkApproveMutation.mutateAsync({ taskIds: ids });
        if ((result?.approvedCount ?? 0) === 0) {
          notify.err("تعذر اعتماد الصور المحددة — تأكد من اكتمال بيانات الصور وحالتها");
          return;
        }
      }

      // رسالة فخر واعتزاز محلية عراقية
      toast.success("كفو! تم اعتماد ونشر الصور");

      // كسر الكاش ومزامنة كافة أجزاء النظام
      utils.productStudio.invalidate();
      utils.catalog.adminList.invalidate();
      utils.catalog.posList.invalidate();

      handleClearSelection();
    } catch (err: any) {
      notify.err(err?.message || "تعذر اعتماد الصور المحددة");
    } finally {
      setIsApproving(false);
    }
  };

  // تأكيد الرفض الجماعي مع سبب إلزامي
  const handleConfirmReject = async () => {
    const ids = Array.from(selectedIds);
    const reason = rejectReason.trim();
    if (ids.length === 0 || reason.length < 5) return;

    setIsRejecting(true);
    try {
      if (mockOnReject) {
        await mockOnReject(ids, reason);
      } else {
        await bulkRejectMutation.mutateAsync({
          taskIds: ids,
          reason,
        });
      }

      toast.info("تم رفض الصور المحددة وإعادتها للتصوير");
      utils.productStudio.invalidate();

      setRejectDialogOpen(false);
      setRejectReason("");
      handleClearSelection();
    } catch (err: any) {
      notify.err(err?.message || "تعذر رفض الصور المحددة");
    } finally {
      setIsRejecting(false);
    }
  };

  // تعيين الصورة كغلاف رئيسي للمنتج
  const handleSetPrimary = async (task: StudioAdminReviewTask) => {
    const targetId = task.sourceImageId;
    if (!targetId && !mockOnSetPrimary) {
      toast.info("يجب اعتماد الصورة ونشرها أولاً قبل تعيينها كغلاف رئيسي");
      return;
    }
    try {
      if (mockOnSetPrimary) {
        await mockOnSetPrimary(targetId ?? task.id);
      } else if (targetId) {
        await setPrimaryMutation.mutateAsync({ imageId: targetId });
      }
      toast.success(`تم تعيين صورة "${task.productName}" كغلاف رئيسي`);
      utils.productStudio.invalidate();
      utils.catalog.adminList.invalidate();
      utils.catalog.posList.invalidate();
    } catch (err: any) {
      notify.err(err?.message || "تعذر تعيين الصورة كغلاف رئيسي");
    }
  };

  const formatTimestamp = (d?: Date | string | null): string => {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    if (isNaN(date.getTime())) return "";
    try {
      return date.toLocaleString("ar-IQ-u-nu-latn", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return date.toISOString().slice(0, 16).replace("T", " ");
    }
  };

  const renderModeBadge = (mode?: string | null) => {
    const m = (mode ?? "FLATTEN").toUpperCase();
    const label =
      m === "AI"
        ? "ذكاء اصطناعي"
        : m === "CUT"
        ? "عزل خلفية"
        : m === "PRO"
        ? "احترافي"
        : m === "ORIGINAL"
        ? "أصلية"
        : "تسطيح/توضيح";
    return (
      <Badge
        variant="outline"
        className="text-[10px] font-semibold gap-1 border-primary/30 bg-primary/5 text-primary"
      >
        <Sparkles className="size-2.5" />
        {label}
      </Badge>
    );
  };

  const isLoading = !mockTasks && tasksQuery.isLoading;

  return (
    <div className={`space-y-4 ${className}`} data-testid="studio-admin-review-panel">
      {/* شريط الأدوات العلوي */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="studio-review-select-all"
              data-testid="select-all-reviews-checkbox"
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={handleToggleSelectAll}
              disabled={tasks.length === 0}
            />
            <label
              htmlFor="studio-review-select-all"
              className="text-sm font-semibold cursor-pointer select-none"
            >
              تحديد الكل
            </label>
          </div>
          <Badge variant="secondary" className="text-xs font-medium">
            {tasks.length} بانتظار الاعتماد
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {!mockTasks && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => tasksQuery.refetch()}
              disabled={isLoading}
            >
              <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>تحديث</span>
            </Button>
          )}
        </div>
      </div>

      {/* مؤشر التحميل */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center p-12 text-center">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">جاري استرجاع مهام المراجعة...</p>
        </div>
      )}

      {/* الحالة الفارغة */}
      {!isLoading && tasks.length === 0 && (
        <div
          data-testid="studio-review-empty-state"
          className="flex flex-col items-center justify-center p-12 text-center border rounded-lg bg-card text-card-foreground shadow-sm my-6 space-y-3"
        >
          <div className="p-4 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
            <CheckCircle2 className="size-10" />
          </div>
          <h3 className="text-lg font-bold">لا توجد صور بانتظار الاعتماد حالياً</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            جميع صور المنتجات المرفوعة تم تدقيقها واعتمادها بنجاح، أو لم يتم إرسال مهام جديدة بعد.
          </p>
        </div>
      )}

      {/* شبكة بطاقات المراجعة */}
      {!isLoading && tasks.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {tasks.map((task) => {
            const isSelected = selectedIds.has(task.id);
            const photographer =
              task.photographerName || task.assigneeName || "موظف مجهول";
            const formattedTime = formatTimestamp(task.submittedAt);

            return (
              <Card
                key={task.id}
                data-testid={`studio-review-card-${task.id}`}
                className={`relative flex flex-col overflow-hidden transition-all border ${
                  isSelected
                    ? "border-primary ring-2 ring-primary/20 shadow-md bg-primary/5"
                    : "hover:border-primary/50 shadow-sm"
                }`}
              >
                {/* رأس الصورة وأزرار الاختيار والتعيين الرئيسي */}
                <div className="relative aspect-square w-full bg-muted/40 flex items-center justify-center overflow-hidden border-b">
                  {/* صندوق الاختيار */}
                  <div className="absolute top-2 start-2 z-10 bg-background/90 backdrop-blur rounded p-1 shadow-sm">
                    <Checkbox
                      data-testid={`review-card-checkbox-${task.id}`}
                      checked={isSelected}
                      onCheckedChange={() => handleToggleItem(task.id)}
                    />
                  </div>

                  {/* شارة وضع المعالجة */}
                  <div
                    className="absolute top-2 end-2 z-10"
                    data-testid={`review-card-mode-badge-${task.id}`}
                  >
                    {renderModeBadge(task.mode)}
                  </div>

                  {/* زر الصورة الرئيسية */}
                  <div className="absolute bottom-2 end-2 z-10">
                    <button
                      type="button"
                      data-testid={`review-card-primary-btn-${task.id}`}
                      disabled={!task.sourceImageId && !mockOnSetPrimary}
                      className={`p-1.5 rounded-full backdrop-blur shadow-sm transition-all disabled:opacity-45 disabled:cursor-not-allowed ${
                        task.isPrimary
                          ? "text-amber-500 bg-amber-50/95 dark:bg-amber-950/80 ring-1 ring-amber-400"
                          : "text-muted-foreground bg-background/90 hover:text-amber-500 hover:bg-background"
                      }`}
                      title={
                        !task.sourceImageId && !mockOnSetPrimary
                          ? "تُفعَّل بعد اعتماد الصورة ونشرها"
                          : task.isPrimary
                            ? "صورة رئيسية معتمدة"
                            : "تعيين كصورة رئيسية للمنتج"
                      }
                      onClick={() => handleSetPrimary(task)}
                    >
                      <Star
                        className={`size-4 ${
                          task.isPrimary ? "fill-amber-400" : ""
                        }`}
                      />
                      <span className="sr-only">
                        {task.isPrimary ? "صورة رئيسية" : "تعيين كصورة رئيسية"}
                      </span>
                    </button>
                  </div>

                  {/* عرض الصورة أو جلب معاينة المرشح من الخادم */}
                  <ReviewCandidateImage task={task} />
                </div>

                {/* تفاصيل المنتج والمصور والتوقيت */}
                <CardContent className="flex-1 p-3 flex flex-col justify-between space-y-2">
                  <div className="space-y-1.5">
                    <h4
                      className="font-bold text-sm line-clamp-1 leading-snug"
                      title={task.productName}
                      data-testid={`review-card-product-name-${task.id}`}
                    >
                      {task.productName}
                    </h4>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        data-testid={`review-card-kind-${task.id}`}
                        className={
                          task.variantKind === "ALTERNATIVE"
                            ? "h-5 px-1.5 text-[10px] font-bold border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "h-5 px-1.5 text-[10px] font-semibold border-border bg-muted/50 text-muted-foreground"
                        }
                      >
                        {task.variantKind === "ALTERNATIVE" ? "بديل" : "أساسي"}
                      </Badge>
                      {(task.variantLabel || task.variantName) && (
                        <span
                          className="text-[11px] text-muted-foreground line-clamp-1"
                          title={task.variantLabel || task.variantName || undefined}
                          data-testid={`review-card-variant-${task.id}`}
                        >
                          المتغيّر: {task.variantLabel || task.variantName}
                        </span>
                      )}
                    </div>

                    {(task.barcode || task.sku) && (
                      <div
                        className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground font-mono"
                        data-testid={`review-card-barcode-${task.id}`}
                      >
                        <div className="flex items-center gap-1 min-w-0">
                          <Barcode className="size-3 shrink-0" />
                          <span className="truncate">{task.barcode || task.sku}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const code = task.barcode || task.sku;
                            if (!code) return;
                            void navigator.clipboard?.writeText(code);
                            toast.success("تم نسخ الباركود");
                          }}
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                          title="نسخ الباركود"
                          aria-label="نسخ الباركود"
                        >
                          <Copy className="size-3" />
                        </button>
                      </div>
                    )}

                    <div
                      className="flex items-center justify-between gap-2 pt-0.5"
                      data-testid={`review-card-existing-images-${task.id}`}
                    >
                      <button
                        type="button"
                        disabled={!task.existingImageThumbs?.length}
                        onClick={() => setGalleryTask(task)}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                      >
                        <ImageIcon className="size-3 shrink-0" />
                        <span>
                          {task.existingImageCount && task.existingImageCount > 0
                            ? `${task.existingImageCount} صور حالية`
                            : "لا توجد صور سابقة"}
                        </span>
                      </button>
                      {task.existingImageThumbs && task.existingImageThumbs.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setGalleryTask(task)}
                          className="flex items-center -space-x-1 rtl:space-x-reverse"
                          title="معاينة صور المنتج الحالية"
                        >
                          {task.existingImageThumbs.slice(0, 3).map((thumb) => (
                            <img
                              key={thumb.id}
                              src={thumb.src}
                              alt=""
                              loading="lazy"
                              className="size-6 rounded border bg-background object-cover ring-1 ring-border"
                            />
                          ))}
                          {(task.existingImageCount ?? 0) > 3 && (
                            <span className="inline-flex size-6 items-center justify-center rounded border bg-muted text-[9px] font-bold text-muted-foreground">
                              +{(task.existingImageCount ?? 0) - 3}
                            </span>
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="pt-2 border-t space-y-1 text-xs text-muted-foreground">
                    <div
                      className="flex items-center gap-1.5"
                      data-testid={`review-card-photographer-${task.id}`}
                    >
                      <User className="size-3.5 text-primary/70 shrink-0" />
                      <span className="line-clamp-1">المصور: {photographer}</span>
                    </div>

                    {formattedTime && (
                      <div
                        className="flex items-center gap-1.5 text-[11px]"
                        data-testid={`review-card-timestamp-${task.id}`}
                      >
                        <Clock className="size-3 shrink-0" />
                        <span>{formattedTime}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* الشريط العائم للإجراءات الجماعية عند تحديد عناصر */}
      {selectedIds.size > 0 && (
        <div
          data-testid="studio-review-batch-bar"
          className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border bg-background/95 backdrop-blur shadow-lg border-primary/20 animate-in fade-in slide-in-from-bottom-2 duration-150"
        >
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-bold">
              تم تحديد {selectedIds.size} من {tasks.length}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-foreground h-8"
              onClick={handleClearSelection}
            >
              إلغاء التحديد
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="studio-review-bulk-reject-btn"
              className="text-destructive hover:bg-destructive/10 border-destructive/30 h-9 gap-1.5"
              disabled={isApproving || isRejecting}
              onClick={() => setRejectDialogOpen(true)}
            >
              <XCircle className="size-4" />
              <span>رفض المحدد</span>
            </Button>

            <Button
              type="button"
              size="sm"
              data-testid="studio-review-bulk-approve-btn"
              className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 gap-1.5 shadow-sm"
              disabled={isApproving || isRejecting}
              onClick={handleBulkApprove}
            >
              {isApproving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              <span>اعتماد ونشر المحدد</span>
            </Button>
          </div>
        </div>
      )}

      {/* نافذة حوار إدخال سبب الرفض الإلزامي */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent
          data-testid="studio-review-reject-dialog"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="size-5" />
              رفض الصور المحددة ({selectedIds.size})
            </DialogTitle>
            <DialogDescription>
              سيتم إشعار المصور بحيث يتمكن فوراً من إعادة تصوير المنتج لتجنب تعليق
              المعاملة. يرجى إدخال سبب الرفض بوضوح (الحد الأدنى 5 أحرف).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="studio-reject-reason-input">سبب الرفض</Label>
            <Textarea
              id="studio-reject-reason-input"
              data-testid="studio-review-reject-reason-input"
              placeholder="مثال: الإضاءة غير متوازنة، أو زاوية التصوير لا تبرز الغلاف بوضوح..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
            />
            {rejectReason.trim().length > 0 && rejectReason.trim().length < 5 && (
              <p className="text-xs text-destructive">
                سبب الرفض قصير جداً، يجب ألا يقل عن 5 أحرف.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRejectDialogOpen(false);
                setRejectReason("");
              }}
            >
              إلغاء
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="studio-review-reject-submit-btn"
              disabled={rejectReason.trim().length < 5 || isRejecting}
              onClick={handleConfirmReject}
            >
              {isRejecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              تأكيد الرفض
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {galleryTask != null && (
        <ProductExistingGalleryDialog
          task={galleryTask}
          mockMode={Boolean(mockTasks)}
          onClose={() => setGalleryTask(null)}
        />
      )}
    </div>
  );
}

function ProductExistingGalleryDialog({
  task,
  mockMode,
  onClose,
}: {
  task: StudioAdminReviewTask;
  mockMode: boolean;
  onClose: () => void;
}) {
  const galleryImagesQuery = trpc.productStudio.productImages.useQuery(
    { productId: task.productId ?? 0 },
    {
      enabled: !mockMode && task.productId != null && (task.existingImageCount ?? 0) > 3,
      staleTime: 60_000,
    },
  );
  const galleryImages = useMemo(() => {
    if (galleryImagesQuery.data?.length) {
      return galleryImagesQuery.data
        .map((img) => ({
          id: img.id,
          src: resolveStudioImageSrc(img),
          isPrimary: img.isPrimary,
        }))
        .filter((img) => Boolean(img.src));
    }
    return task.existingImageThumbs ?? [];
  }, [galleryImagesQuery.data, task.existingImageThumbs]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent dir="rtl" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{task.productName}</DialogTitle>
          <DialogDescription>
            الصور المعتمدة حالياً للمنتج ({task.existingImageCount ?? 0})
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 py-2 max-h-[60vh] overflow-y-auto">
          {galleryImages.map((thumb) => (
            <div key={thumb.id} className="relative aspect-square rounded-lg border bg-muted/30 overflow-hidden">
              <img src={thumb.src} alt="" className="w-full h-full object-contain p-1" />
              {thumb.isPrimary && (
                <span className="absolute top-1 end-1 rounded bg-amber-500/90 px-1 py-0.5 text-[9px] font-bold text-white">
                  رئيسية
                </span>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
