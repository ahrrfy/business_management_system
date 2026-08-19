import { ProductMediaContentSection } from "@/components/product/ProductMediaContentSection";
import { StudioProductPicker } from "@/components/product-studio/StudioProductPicker";
import type { ImageItem } from "@/components/form/ImageUploader";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import {
  canEditStudioTask,
  canReviewStudioTask,
  hasStudioOverrideReason,
  needsStudioEditOverride,
  needsStudioReviewOverride,
} from "@/lib/imageStudio/studioWorkflowPolicy";
import {
  adjustStudioReviewZoom,
  defaultStudioScope,
  findScannedOwnedTask,
  mobileStudioPanel,
  STUDIO_REJECTION_PRESETS,
  type StudioReviewImage,
} from "@/lib/productStudio/mobileStudioUi";
import {
  loadStudioDraft,
  purgeStudioDraft,
  purgeStudioDraftsForUser,
  reconcileStudioDraftAfterReconnect,
  saveStudioDraft,
  listStudioDraftsForUser,
  loadStudioDraftIdentity,
  saveStudioDraftIdentity,
  studioTaskRevision,
  type StudioDraft,
  type StudioDraftTaskSnapshot,
} from "@/lib/productStudio/studioDrafts";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { createProductWebpThumbnail } from "@/lib/productImageThumbnail";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  History,
  Image,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanLine,
  UserCheck,
  XCircle,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

type Scope = "QUEUE" | "MINE" | "REVIEW" | "HISTORY";
type StudioTask = RouterOutputs["productStudio"]["tasks"][number];
const CameraScanner = lazy(() =>
  import("@/components/scan/CameraScanner").then((module) => ({
    default: module.CameraScanner,
  })),
);

function taskSnapshot(task: StudioTask): StudioDraftTaskSnapshot {
  return {
    taskId: Number(task.id),
    productName: task.productName,
    currentDescription: task.currentDescription ?? null,
    status: task.status as StudioDraftTaskSnapshot["status"],
    hasOriginal: task.hasOriginal,
    hasCandidate: task.hasCandidate,
    updatedAt: studioTaskRevision(task.updatedAt),
  };
}

export const STUDIO_STORAGE_DISABLED_MESSAGE =
  "وضع القراءة القديم فعّال: مخزن R2 الخاص غير مهيأ. الإسناد ومعالجة الصور والاعتماد متوقفة بأمان، بينما تبقى الإحصاءات والمهام والسجل متاحة للقراءة.";

export function isStudioStorageActionDisabled(
  storageReady: boolean | undefined,
): boolean {
  return storageReady !== true;
}

const STATUS_LABEL: Record<StudioTask["status"], string> = {
  ASSIGNED: "مسندة",
  IN_PROGRESS: "قيد العمل",
  PENDING_REVIEW: "بانتظار المراجعة",
  APPROVED: "معتمدة",
  REJECTED: "تحتاج تعديلاً",
  FAILED: "فشلت",
  REVERTED: "استُرجع الأصل",
};

const STATUS_VARIANT: Record<
  StudioTask["status"],
  "neutral" | "info" | "warning" | "success" | "danger"
> = {
  ASSIGNED: "neutral",
  IN_PROGRESS: "info",
  PENDING_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  FAILED: "danger",
  REVERTED: "neutral",
};

function PreviewPair({
  data,
}: {
  data: RouterOutputs["productStudio"]["candidatePreview"];
}) {
  const [mobileImage, setMobileImage] =
    useState<StudioReviewImage>("candidate");
  const [zoom, setZoom] = useState(1);
  const urls = useMemo(() => {
    function make(base64: string, mime: string): string {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
    return {
      original: make(data.originalBase64, data.originalMime),
      processed: make(data.processedBase64, data.processedMime),
    };
  }, [data]);
  useEffect(
    () => () => {
      URL.revokeObjectURL(urls.original);
      URL.revokeObjectURL(urls.processed);
    },
    [urls],
  );
  return (
    <div className="space-y-3">
      <div className="sm:hidden">
        <div
          className="grid grid-cols-2 gap-2"
          role="group"
          aria-label="اختيار صورة المراجعة"
        >
          <Button
            type="button"
            variant={mobileImage === "original" ? "default" : "outline"}
            className="min-h-11"
            onClick={() => setMobileImage("original")}
          >
            الصورة الأصلية
          </Button>
          <Button
            type="button"
            variant={mobileImage === "candidate" ? "default" : "outline"}
            className="min-h-11"
            onClick={() => setMobileImage("candidate")}
          >
            المرشّح
          </Button>
        </div>
        <figure className="mt-3 space-y-2 overflow-hidden rounded-md border p-2">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <figcaption className="text-xs text-muted-foreground">
              {mobileImage === "original"
                ? "الأصل المحفوظ"
                : "المرشّح قبل النشر"}
            </figcaption>
            <div className="flex gap-1">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-11"
                aria-label="تصغير الصورة"
                disabled={zoom <= 0.5}
                onClick={() =>
                  setZoom((current) => adjustStudioReviewZoom(current, "out"))
                }
              >
                <Minus aria-hidden className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-11"
                aria-label="تكبير الصورة"
                disabled={zoom >= 3}
                onClick={() =>
                  setZoom((current) => adjustStudioReviewZoom(current, "in"))
                }
              >
                <Plus aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
          <img
            src={mobileImage === "original" ? urls.original : urls.processed}
            alt={
              mobileImage === "original" ? "الصورة الأصلية" : "الصورة المرشحة"
            }
            className="mx-auto aspect-square max-h-80 w-full object-contain transition-transform"
            style={{ transform: `scale(${zoom})` }}
          />
        </figure>
      </div>
      <div className="hidden gap-3 sm:grid sm:grid-cols-2">
        <figure className="space-y-1 rounded-md border p-2">
          <img
            src={urls.original}
            alt="الصورة الأصلية"
            className="mx-auto aspect-square max-h-72 w-full object-contain"
          />
          <figcaption className="text-center text-xs text-muted-foreground">
            الأصل المحفوظ
          </figcaption>
        </figure>
        <figure className="space-y-1 rounded-md border p-2">
          <img
            src={urls.processed}
            alt="الصورة المرشحة"
            className="mx-auto aspect-square max-h-72 w-full object-contain"
          />
          <figcaption className="text-center text-xs text-muted-foreground">
            المرشّح قبل النشر
          </figcaption>
        </figure>
      </div>
    </div>
  );
}

export default function ProductImageStudio() {
  const [scope, setScope] = useState<Scope>("MINE");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [productId, setProductId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [sourceChoice, setSourceChoice] = useState("new");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [marketingCopy, setMarketingCopy] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [originalDataUrl, setOriginalDataUrl] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [studioMode, setStudioMode] = useState<"FLATTEN" | "CUT" | "AI">(
    "FLATTEN",
  );
  const [processingReceipt, setProcessingReceipt] = useState<string | null>(
    null,
  );
  const [isPreparingThumbnail, setIsPreparingThumbnail] = useState(false);
  const [isStudioProcessing, setIsStudioProcessing] = useState(false);
  const [editOverrideReason, setEditOverrideReason] = useState("");
  const [reviewOverrideReason, setReviewOverrideReason] = useState("");
  const [scopeInitialized, setScopeInitialized] = useState(false);
  const [taskScannerOpen, setTaskScannerOpen] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [offlineDrafts, setOfflineDrafts] = useState<StudioDraft[]>([]);
  const [offlineSelectedDraft, setOfflineSelectedDraft] =
    useState<StudioDraft | null>(null);
  const [coldIdentityUserId, setColdIdentityUserId] = useState<number | null>(
    null,
  );
  const previousUserId = useRef<number | null>(null);

  const utils = trpc.useUtils();
  const connectivity = useConnectivity();
  const offline =
    isDisconnected(connectivity) ||
    (typeof navigator !== "undefined" && !navigator.onLine);
  const dashboard = trpc.productStudio.dashboard.useQuery();
  const me = trpc.auth.me.useQuery();
  const tasks = trpc.productStudio.tasks.useQuery({ scope, limit: 100 });
  const productImages = trpc.productStudio.productImages.useQuery(
    { productId: Number(productId) || 0 },
    { enabled: Boolean(productId) && dashboard.data?.canManage === true },
  );
  const assignees = trpc.productStudio.assignees.useQuery(undefined, {
    enabled: dashboard.data?.canManage === true,
  });
  const onlineSelected =
    tasks.data?.find((task) => Number(task.id) === selectedId) ?? null;
  const selected =
    onlineSelected ??
    (offline && offlineSelectedDraft
      ? ({
          id: offlineSelectedDraft.taskSnapshot.taskId,
          productId: null,
          branchId: null,
          productName: offlineSelectedDraft.taskSnapshot.productName,
          currentDescription:
            offlineSelectedDraft.taskSnapshot.currentDescription,
          status: offlineSelectedDraft.taskSnapshot.status,
          mode:
            offlineSelectedDraft.mode === "AI"
              ? "FLATTEN"
              : offlineSelectedDraft.mode,
          assignedTo: offlineSelectedDraft.userId,
          assigneeName: null,
          proposedName: offlineSelectedDraft.proposedName,
          proposedDescription: offlineSelectedDraft.proposedDescription,
          proposedMarketingCopy: offlineSelectedDraft.proposedMarketingCopy,
          rejectionReason: null,
          sourceImageId: null,
          hasOriginal: offlineSelectedDraft.taskSnapshot.hasOriginal,
          hasCandidate: offlineSelectedDraft.taskSnapshot.hasCandidate,
          createdAt: new Date(offlineSelectedDraft.createdAt),
          updatedAt: new Date(offlineSelectedDraft.taskSnapshot.updatedAt),
          submittedAt: null,
          submittedBy: null,
          reviewedAt: null,
        } as StudioTask)
      : null);
  const selectedRevision = selected
    ? studioTaskRevision(selected.updatedAt)
    : "";
  const workflowUser = {
    userId: Number(me.data?.id ?? 0),
    role: me.data?.role ?? "",
    isOwner: me.data?.isOwner === true,
  };
  const onlineUserId = workflowUser.userId > 0 ? workflowUser.userId : null;
  const authenticatedUserId = onlineUserId ?? coldIdentityUserId;
  const editOverrideRequired = selected
    ? needsStudioEditOverride(selected, workflowUser)
    : false;
  const reviewOverrideRequired = selected
    ? needsStudioReviewOverride(selected, workflowUser)
    : false;
  const editable = selected
    ? offline && offlineSelectedDraft != null
      ? true
      : canEditStudioTask(selected, workflowUser, editOverrideReason)
    : false;
  const reviewable = selected
    ? canReviewStudioTask(selected, workflowUser, reviewOverrideReason)
    : false;
  const editOverrideValue = hasStudioOverrideReason(editOverrideReason)
    ? editOverrideReason.trim()
    : undefined;
  const reviewOverrideValue = hasStudioOverrideReason(reviewOverrideReason)
    ? reviewOverrideReason.trim()
    : undefined;
  const preview = trpc.productStudio.candidatePreview.useQuery(
    { taskId: selectedId ?? 0 },
    {
      enabled:
        !offline &&
        Boolean(
          selectedId && selected?.hasCandidate && dashboard.data?.storageReady,
        ),
      staleTime: 0,
      gcTime: 0,
    },
  );
  const sourcePreview = trpc.productStudio.sourcePreview.useQuery(
    { taskId: selectedId ?? 0 },
    {
      enabled:
        !offline &&
        Boolean(
          selectedId &&
          selected?.hasOriginal &&
          dashboard.data?.storageReady &&
          editable,
        ),
      staleTime: 0,
      gcTime: 0,
    },
  );

  async function refresh() {
    await Promise.all([
      utils.productStudio.dashboard.invalidate(),
      utils.productStudio.tasks.invalidate(),
      utils.productStudio.products.invalidate(),
    ]);
  }

  const assign = trpc.productStudio.assign.useMutation({
    onSuccess: async () => {
      notify.ok("أُسندت المهمة");
      setProductId("");
      setAssigneeId("");
      setSourceChoice("new");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const saveDraft = trpc.productStudio.saveDraft.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظت مسودة الصور والمحتوى");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const submit = trpc.productStudio.submitCandidate.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل المرشّح للمراجعة ولن يظهر في المتجر قبل الاعتماد");
      setImages([]);
      setOriginalDataUrl("");
      setProcessingReceipt(null);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const approve = trpc.productStudio.approve.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمدت الصورة والمحتوى ونُشرت النسخة المعتمدة");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const reject = trpc.productStudio.reject.useMutation({
    onSuccess: async () => {
      notify.ok("أُعيدت المهمة للموظف مع السبب");
      setRejectReason("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const revert = trpc.productStudio.revert.useMutation({
    onSuccess: async () => {
      notify.ok("استُرجعت الصورة الأصلية");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });

  useEffect(() => {
    if (!dashboard.data || scopeInitialized) return;
    setScope(defaultStudioScope(dashboard.data));
    setSelectedId(null);
    setScopeInitialized(true);
  }, [dashboard.data, scopeInitialized]);

  useEffect(() => {
    const previous = previousUserId.current;
    const current = authenticatedUserId;
    if (previous != null && previous !== current) {
      void purgeStudioDraftsForUser(previous);
    }
    previousUserId.current = current;
  }, [authenticatedUserId]);

  useEffect(() => {
    if (!offline && onlineUserId) {
      setColdIdentityUserId(onlineUserId);
      void saveStudioDraftIdentity(onlineUserId).catch(() => undefined);
      return;
    }
    if (offline && !onlineUserId) {
      void loadStudioDraftIdentity()
        .then((identity) => setColdIdentityUserId(identity?.userId ?? null))
        .catch(() => setColdIdentityUserId(null));
    }
  }, [offline, onlineUserId]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.proposedName ?? selected.productName);
    setDescription(
      selected.proposedDescription ?? selected.currentDescription ?? "",
    );
    setMarketingCopy(selected.proposedMarketingCopy ?? "");
    setRejectReason(selected.rejectionReason ?? "");
    setImages([]);
    setOriginalDataUrl("");
    setStudioMode("FLATTEN");
    setProcessingReceipt(null);
    setEditOverrideReason("");
    setReviewOverrideReason("");
    setDraftConflict(false);
    setDraftReady(false);
  }, [selected?.id]);

  function applyLocalDraft(draft: StudioDraft) {
    setName(draft.proposedName);
    setDescription(draft.proposedDescription);
    setMarketingCopy(draft.proposedMarketingCopy);
    setImages(
      draft.imageDataUrl
        ? [
            {
              id: `studio-draft-${draft.taskId}`,
              dataUrl: draft.imageDataUrl,
              isPrimary: true,
              name: "صورة المسودة المحلية",
            },
          ]
        : [],
    );
    setStudioMode(draft.mode);
    setOriginalDataUrl(draft.originalDataUrl ?? "");
    setProcessingReceipt(draft.processingReceipt);
  }

  useEffect(() => {
    if (!offline || !authenticatedUserId) return;
    let cancelled = false;
    void listStudioDraftsForUser(authenticatedUserId)
      .then((drafts) => {
        if (!cancelled) setOfflineDrafts(drafts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authenticatedUserId, offline]);

  useEffect(() => {
    if (!selectedId || !authenticatedUserId) return;
    const taskId = Number(selected?.id ?? selectedId);
    let cancelled = false;
    void (async () => {
      try {
        if (offline) {
          const draft = await loadStudioDraft(authenticatedUserId, taskId);
          if (draft && !cancelled) applyLocalDraft(draft);
          return;
        }
        const refreshed = await tasks.refetch();
        const task = refreshed.data?.find((item) => Number(item.id) === taskId);
        if (cancelled) return;
        const result = await reconcileStudioDraftAfterReconnect({
          userId: authenticatedUserId,
          taskId,
          taskFound: Boolean(task),
          revision: task ? studioTaskRevision(task.updatedAt) : null,
          editable: task
            ? canEditStudioTask(task, workflowUser, editOverrideReason)
            : false,
        });
        if (cancelled) return;
        if (result.kind === "RESUME") applyLocalDraft(result.draft);
        if (result.kind === "CONFLICT") setDraftConflict(true);
      } catch {
        // IndexedDB is best-effort; a local failure must not block the online editor.
      } finally {
        if (!cancelled) setDraftReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authenticatedUserId,
    editOverrideReason,
    offline,
    selectedId,
    selectedRevision,
  ]);

  useEffect(() => {
    if (
      !selected ||
      !authenticatedUserId ||
      !editable ||
      !draftReady ||
      draftConflict
    )
      return;
    const timer = window.setTimeout(() => {
      void saveStudioDraft({
        userId: authenticatedUserId,
        taskId: Number(selected.id),
        revision: selectedRevision,
        proposedName: name,
        proposedDescription: description,
        proposedMarketingCopy: marketingCopy,
        // ImageUploader has already compressed every accepted image to WebP/JPEG when possible.
        imageDataUrl: images[0]?.dataUrl ?? null,
        originalDataUrl: originalDataUrl || null,
        processingReceipt,
        taskSnapshot: taskSnapshot(selected),
        mode: studioMode,
      }).catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    authenticatedUserId,
    description,
    draftConflict,
    draftReady,
    editable,
    images,
    marketingCopy,
    name,
    originalDataUrl,
    processingReceipt,
    selected?.id,
    selectedRevision,
    studioMode,
  ]);

  useEffect(() => {
    if (!selectedId || !sourcePreview.data || images.length > 0) return;
    const dataUrl = `data:${sourcePreview.data.mime};base64,${sourcePreview.data.base64}`;
    setImages([
      {
        id: `studio-source-${selectedId}`,
        dataUrl,
        isPrimary: true,
        name: "صورة المصدر",
      },
    ]);
  }, [images.length, selectedId, sourcePreview.data]);

  function selectTask(task: StudioTask) {
    setOfflineSelectedDraft(null);
    setSelectedId(Number(task.id));
  }

  async function selectScannedOwnedTask(barcode: string) {
    setTaskScannerOpen(false);
    try {
      const product = await utils.productStudio.resolveBarcode.fetch({
        barcode,
      });
      const task = findScannedOwnedTask(tasks.data ?? [], product.productId);
      if (!task) {
        notify.err("لا توجد مهمة مسندة إليك لهذا المنتج ضمن قائمة عملي.");
        return;
      }
      selectTask(task);
    } catch (error) {
      notify.err(error);
    }
  }

  async function submitForReview() {
    if (!selected || !images[0]?.dataUrl) return;
    setIsPreparingThumbnail(true);
    try {
      const thumbnailDataUrl = await createProductWebpThumbnail(
        images[0].dataUrl,
      );
      await submit.mutateAsync({
        taskId: Number(selected.id),
        originalDataUrl: originalDataUrl || null,
        processedDataUrl: images[0].dataUrl,
        thumbnailDataUrl,
        mode: studioMode === "AI" ? "FLATTEN" : studioMode,
        processingReceipt,
        adminOverrideReason: editOverrideValue,
        proposedName: name,
        proposedDescription: description,
        proposedMarketingCopy: marketingCopy,
      });
      if (authenticatedUserId)
        await purgeStudioDraft(authenticatedUserId, Number(selected.id));
    } catch (error) {
      notify.err(error);
    } finally {
      setIsPreparingThumbnail(false);
    }
  }

  const counts = dashboard.data?.counts;
  const busy =
    isStudioProcessing ||
    isPreparingThumbnail ||
    saveDraft.isPending ||
    submit.isPending ||
    approve.isPending ||
    reject.isPending ||
    revert.isPending;
  const storageActionsDisabled = isStudioStorageActionDisabled(
    dashboard.data?.storageReady,
  );
  const mobilePanel = mobileStudioPanel(selected ? Number(selected.id) : null);

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden p-4 md:p-6">
      <PageHeader
        title="استوديو المنتجات"
        description="مركز مستقل للصور والمحتوى: إسناد، تنفيذ، مراجعة، واعتماد. لا يعرض أسعاراً أو تكلفة أو مخزوناً."
        icon={<Image aria-hidden className="size-6" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            <RefreshCw aria-hidden className="size-4" /> تحديث
          </Button>
        }
      />

      {dashboard.data && storageActionsDisabled && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{STUDIO_STORAGE_DISABLED_MESSAGE}</span>
        </div>
      )}

      {offline && offlineDrafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              مسودات محلية قابلة للاستعادة
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {offlineDrafts.map((draft) => (
              <div
                key={`${draft.userId}-${draft.taskId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {draft.proposedName || `مهمة الاستوديو #${draft.taskId}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    مهمة #{draft.taskId} · محفوظة محلياً حتى{" "}
                    {new Date(draft.expiresAt).toLocaleString("ar-IQ")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    applyLocalDraft(draft);
                    setOfflineSelectedDraft(draft);
                    setSelectedId(draft.taskId);
                    setDraftReady(true);
                    notify.ok(
                      "استُعيدت المسودة محلياً؛ سيُتحقق من المهمة عند عودة الاتصال.",
                    );
                  }}
                >
                  استعادة المسودة
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">المهام النشطة</div>
            <div className="mt-1 text-2xl font-bold">
              {dashboard.data?.active ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">قيد العمل</div>
            <div className="mt-1 text-2xl font-bold">
              {(counts?.ASSIGNED ?? 0) + (counts?.IN_PROGRESS ?? 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">
              بانتظار المراجعة
            </div>
            <div className="mt-1 text-2xl font-bold">
              {counts?.PENDING_REVIEW ?? 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">المعتمدة</div>
            <div className="mt-1 text-2xl font-bold">
              {counts?.APPROVED ?? 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {dashboard.data?.canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">إسناد مهمة جديدة</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="studio-product-search">ابحث عن المنتج</Label>
              <StudioProductPicker
                canManage={dashboard.data?.canManage === true}
                value={Number(productId) || null}
                onPick={(product) => {
                  setProductId(String(product.productId));
                  setSourceChoice("new");
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-source-image">نوع المهمة</Label>
              <select
                id="studio-source-image"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9"
                value={sourceChoice}
                onChange={(event) => setSourceChoice(event.target.value)}
                disabled={!productId}
              >
                <option value="new">إضافة صورة جديدة</option>
                {(productImages.data ?? []).map((image, index) => (
                  <option key={Number(image.id)} value={String(image.id)}>
                    {image.isPrimary
                      ? "استبدال الصورة الرئيسية"
                      : `استبدال الصورة ${index + 1}`}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                الاستبدال يلتقط النسخة المنشورة خادمياً قبل بدء العمل.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-assignee">الموظف المصرح</Label>
              <select
                id="studio-assignee"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9"
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
              >
                <option value="">اختر الموظف</option>
                {(assignees.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                لكل منتج مهمة نشطة واحدة ومالك واحد؛ وزّع منتجات مختلفة على أكثر
                من موظف.
              </p>
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={
                  offline ||
                  storageActionsDisabled ||
                  !productId ||
                  !assigneeId ||
                  assign.isPending
                }
                onClick={() =>
                  assign.mutate({
                    productId: Number(productId),
                    assigneeId: Number(assigneeId),
                    sourceImageId:
                      sourceChoice === "new" ? null : Number(sourceChoice),
                  })
                }
              >
                <UserCheck aria-hidden className="size-4" />{" "}
                {assign.isPending ? "جارٍ الإسناد" : "إسناد المهمة"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs
        value={scope}
        onValueChange={(value) => {
          setScope(value as Scope);
          setSelectedId(null);
          setOfflineSelectedDraft(null);
        }}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="QUEUE">
            <ClipboardList aria-hidden className="size-4" /> طابور العمل
          </TabsTrigger>
          <TabsTrigger value="MINE">
            <UserCheck aria-hidden className="size-4" /> عملي
          </TabsTrigger>
          <TabsTrigger value="REVIEW">
            <CheckCircle2 aria-hidden className="size-4" /> المراجعة
          </TabsTrigger>
          <TabsTrigger value="HISTORY">
            <History aria-hidden className="size-4" /> السجل
          </TabsTrigger>
        </TabsList>
        {(["QUEUE", "MINE", "REVIEW", "HISTORY"] as Scope[]).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            <div className="min-w-0 grid gap-4 lg:grid-cols-[minmax(260px,360px)_1fr]">
              <Card
                className={
                  mobilePanel === "DETAIL" ? "hidden lg:block" : undefined
                }
              >
                <CardHeader>
                  <CardTitle className="text-base">المهام</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {tasks.isLoading && (
                    <div className="py-8 text-center">
                      <Loader2
                        aria-hidden
                        className="mx-auto size-6 animate-spin"
                      />
                    </div>
                  )}
                  {!tasks.isLoading && (tasks.data?.length ?? 0) === 0 && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      لا مهام في هذا المسار.
                    </p>
                  )}
                  {(tasks.data ?? []).map((task) => (
                    <button
                      key={Number(task.id)}
                      type="button"
                      onClick={() => selectTask(task)}
                      className={`min-h-11 w-full rounded-md border p-3 text-start transition-colors hover:bg-muted/50 active:bg-muted ${selectedId === Number(task.id) ? "border-primary bg-muted/40" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium">
                          {task.productName}
                        </span>
                        <Badge variant={STATUS_VARIANT[task.status]}>
                          {STATUS_LABEL[task.status]}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        المسؤول: {task.assigneeName ?? "غير مسند"}
                      </div>
                      {task.rejectionReason && (
                        <div className="mt-2 text-xs text-destructive">
                          سبب الإعادة: {task.rejectionReason}
                        </div>
                      )}
                    </button>
                  ))}
                </CardContent>
              </Card>

              {!selected ? (
                <Card className="hidden lg:block">
                  <CardContent className="py-16 text-center text-sm text-muted-foreground">
                    اختر مهمة لعرض مسارها.
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  <Card>
                    <CardHeader>
                      <Button
                        type="button"
                        variant="ghost"
                        className="-mr-2 min-h-11 self-start lg:hidden"
                        onClick={() => setSelectedId(null)}
                      >
                        <ChevronRight aria-hidden className="size-4" /> عودة إلى
                        المهام
                      </Button>
                      <CardTitle className="flex items-center justify-between gap-2 text-base">
                        <span>{selected.productName}</span>
                        <Badge variant={STATUS_VARIANT[selected.status]}>
                          {STATUS_LABEL[selected.status]}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="studio-name">اسم العرض</Label>
                        <Input
                          id="studio-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          disabled={!editable || storageActionsDisabled}
                          maxLength={255}
                        />
                      </div>
                      {editOverrideRequired && (
                        <div className="space-y-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
                          <Label htmlFor="studio-admin-edit-override">
                            سبب التصحيح الإداري
                          </Label>
                          <Textarea
                            id="studio-admin-edit-override"
                            rows={2}
                            maxLength={500}
                            value={editOverrideReason}
                            onChange={(event) =>
                              setEditOverrideReason(event.target.value)
                            }
                            placeholder="سبب واضح للعمل نيابة عن مالك المهمة (يسجل في التدقيق)"
                          />
                        </div>
                      )}
                      {!editable &&
                        !editOverrideRequired &&
                        ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(
                          selected.status,
                        ) && (
                          <p className="text-sm text-muted-foreground">
                            المهمة للعرض فقط؛ التحرير والإرسال محصوران بالموظف
                            المسند إليه.
                          </p>
                        )}
                    </CardContent>
                  </Card>

                  {draftConflict && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                    >
                      احتُفظ بالمسودة المحلية ولم تُطبّق لأن المهمة تغيّرت أو لم
                      تعد قابلة للتحرير بعد عودة الاتصال. راجعها قبل متابعة
                      العمل.
                    </div>
                  )}

                  {editable && !storageActionsDisabled && (
                    <>
                      <ProductMediaContentSection
                        title="تنفيذ المهمة — الصور والمحتوى"
                        description={description}
                        onDescriptionChange={setDescription}
                        marketingCopy={marketingCopy}
                        onMarketingCopyChange={setMarketingCopy}
                        images={images}
                        onImagesChange={setImages}
                        maxImages={1}
                        onOriginalCaptured={setOriginalDataUrl}
                        onStudioModeChange={setStudioMode}
                        studioTaskId={Number(selected.id)}
                        adminOverrideReason={editOverrideValue}
                        onProcessingReceiptChange={setProcessingReceipt}
                        onStudioBusyChange={setIsStudioProcessing}
                        offline={offline}
                        hint="صورة واحدة في كل دورة مراجعة. الأصل يودع في المخزن الخاص، والنسخة المعدّلة تبقى مرشّحاً محجوزاً."
                      />
                      {offline && (
                        <p
                          role="status"
                          className="text-sm text-muted-foreground"
                        >
                          تُحفظ تعديلاتك محلياً ومشفّرةً حتى 24 ساعة. الإرسال
                          والاعتماد والرفض والنشر متوقفة إلى أن يعود الاتصال.
                        </p>
                      )}
                      <div className="sticky bottom-24 z-20 -mx-4 flex flex-wrap gap-2 border-y bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
                        <Button
                          className="min-h-11"
                          variant="outline"
                          disabled={offline || busy}
                          onClick={() =>
                            saveDraft.mutate({
                              taskId: Number(selected.id),
                              proposedName: name,
                              proposedDescription: description,
                              proposedMarketingCopy: marketingCopy,
                              adminOverrideReason: editOverrideValue,
                            })
                          }
                        >
                          حفظ المسودة
                        </Button>
                        <Button
                          className="min-h-11"
                          disabled={
                            offline ||
                            busy ||
                            (!selected.hasOriginal && !originalDataUrl) ||
                            !images[0]?.dataUrl
                          }
                          onClick={() => void submitForReview()}
                        >
                          {isPreparingThumbnail && (
                            <Loader2
                              aria-hidden
                              className="size-4 animate-spin"
                            />
                          )}
                          إرسال المحتوى والصورة للمراجعة
                        </Button>
                      </div>
                    </>
                  )}

                  {selected.hasCandidate && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">
                          المقارنة قبل الاعتماد
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {preview.isLoading && (
                          <Loader2
                            aria-hidden
                            className="mx-auto size-6 animate-spin"
                          />
                        )}
                        {preview.data && <PreviewPair data={preview.data} />}
                        {dashboard.data?.canManage &&
                          selected.status === "PENDING_REVIEW" && (
                            <div className="space-y-3 border-t pt-4">
                              {reviewOverrideRequired && (
                                <div className="space-y-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
                                  <Label htmlFor="studio-admin-review-override">
                                    سبب تجاوز فصل الواجبات
                                  </Label>
                                  <Textarea
                                    id="studio-admin-review-override"
                                    rows={2}
                                    maxLength={500}
                                    value={reviewOverrideReason}
                                    onChange={(event) =>
                                      setReviewOverrideReason(
                                        event.target.value,
                                      )
                                    }
                                    placeholder="سبب تصحيح إداري موثق لاعتماد عمل شاركت في تنفيذه"
                                  />
                                </div>
                              )}
                              {!reviewable && !reviewOverrideRequired && (
                                <p className="text-sm text-destructive">
                                  لا يمكنك مراجعة مهمة أُسندت إليك أو كنت آخر من
                                  أرسلها.
                                </p>
                              )}
                              <div className="rounded-md border bg-muted/30 p-3 text-xs">
                                <p className="font-medium">قائمة فحص سريعة</p>
                                <ul className="mt-2 space-y-1 text-muted-foreground">
                                  <li>المنتج وتفاصيله مطابقة للأصل.</li>
                                  <li>
                                    الخلفية والقصّ واضحان ولا يحجبان المنتج.
                                  </li>
                                  <li>الاسم والوصف المقترحان صالحان للنشر.</li>
                                </ul>
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="studio-reject-reason">
                                  سبب الرفض عند الإعادة
                                </Label>
                                <div className="flex flex-wrap gap-2">
                                  {STUDIO_REJECTION_PRESETS.map((reason) => (
                                    <Button
                                      key={reason}
                                      type="button"
                                      variant="outline"
                                      className="min-h-11 text-xs"
                                      disabled={storageActionsDisabled}
                                      onClick={() => setRejectReason(reason)}
                                    >
                                      {reason}
                                    </Button>
                                  ))}
                                </div>
                                <Textarea
                                  id="studio-reject-reason"
                                  rows={2}
                                  maxLength={500}
                                  value={rejectReason}
                                  onChange={(event) =>
                                    setRejectReason(event.target.value)
                                  }
                                  placeholder="ملاحظة إضافية مطلوبة للتعديل"
                                  disabled={storageActionsDisabled}
                                />
                              </div>
                              <div className="sticky bottom-24 z-20 -mx-4 flex flex-wrap gap-2 border-y bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
                                <Button
                                  className="min-h-11"
                                  disabled={
                                    offline ||
                                    storageActionsDisabled ||
                                    busy ||
                                    !reviewable
                                  }
                                  onClick={() =>
                                    approve.mutate({
                                      taskId: Number(selected.id),
                                      adminOverrideReason: reviewOverrideValue,
                                    })
                                  }
                                >
                                  <CheckCircle2
                                    aria-hidden
                                    className="size-4"
                                  />{" "}
                                  اعتماد ونشر
                                </Button>
                                <Button
                                  className="min-h-11"
                                  variant="destructive"
                                  disabled={
                                    offline ||
                                    storageActionsDisabled ||
                                    busy ||
                                    !reviewable ||
                                    rejectReason.trim().length < 5
                                  }
                                  onClick={() =>
                                    reject.mutate({
                                      taskId: Number(selected.id),
                                      reason: rejectReason,
                                      adminOverrideReason: reviewOverrideValue,
                                    })
                                  }
                                >
                                  <XCircle aria-hidden className="size-4" />{" "}
                                  إعادة للتعديل
                                </Button>
                              </div>
                            </div>
                          )}
                        {dashboard.data?.canManage &&
                          selected.status === "APPROVED" && (
                            <Button
                              variant="outline"
                              disabled={
                                offline || storageActionsDisabled || busy
                              }
                              onClick={() =>
                                revert.mutate({ taskId: Number(selected.id) })
                              }
                            >
                              <RotateCcw aria-hidden className="size-4" />{" "}
                              استرجاع الأصل
                            </Button>
                          )}
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      {scope === "MINE" && mobilePanel === "LIST" && (
        <>
          <Button
            type="button"
            className="fixed bottom-24 end-4 z-30 min-h-11 rounded-full px-4 shadow-lg lg:hidden"
            onClick={() => setTaskScannerOpen(true)}
          >
            <ScanLine aria-hidden className="size-4" /> مسح مهمة
          </Button>
          {taskScannerOpen && (
            <Suspense fallback={null}>
              <CameraScanner
                open
                onClose={() => setTaskScannerOpen(false)}
                onDetect={(barcode) => void selectScannedOwnedTask(barcode)}
              />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
