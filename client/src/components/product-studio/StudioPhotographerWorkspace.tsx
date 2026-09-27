import { StudioCaptureStation, type ClaimedStudioProduct } from "@/components/product-studio/StudioCaptureStation";
import { StudioProductVariantMatrixCard } from "@/components/product-studio/StudioProductVariantMatrixCard";
import { ProductImageGallery } from "@/components/product-studio/ProductImageGallery";
import { StudioCampaignImageBatch } from "@/components/product-studio/StudioCampaignImageBatch";
import { ProductMediaContentSection } from "@/components/product/ProductMediaContentSection";
import { useStudioSelectedTask } from "@/components/product-studio/useStudioSelectedTask";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { loadStudioDraft, purgeStudioDraft, reconcileStudioDraftAfterReconnect, saveStudioDraft, listStudioDraftsForOwner, loadStudioDraftIdentity, saveStudioDraftIdentity, type StudioDraft, type StudioDraftIdentity } from "@/lib/productStudio/studioDrafts";
import {
  sameStudioTenantScope,
  type StudioTenantScope,
} from "@/lib/productStudio/studioTenantScope";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { AlertTriangle, ShieldCheck, Image, Megaphone, Loader2, ChevronRight, Sparkles, Clock, Camera, CheckCircle2 } from "lucide-react";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { ImageItem } from "@/components/form/ImageUploader";
import { getOfflineProfile, saveOfflineProfile, setOfflinePin, type OfflineProfile } from "@/lib/offline/pinLock";
import { studioOfflineCapabilities, studioOfflineProfileInput } from "@/lib/productStudio/coldOfflinePolicy";
import { ACTION_LABELS } from "@shared/actionLabels";
import { STUDIO_STORAGE_DISABLED_MESSAGE } from "@/pages/ProductImageStudio";

type StudioTask = RouterOutputs["productStudio"]["tasks"]["items"][number];

export default function StudioPhotographerWorkspace({
  offline,
  dashboardData,
}: {
  offline: boolean;
  dashboardData: any;
}) {
  const [captured, setCaptured] = useState<ClaimedStudioProduct | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [images, setImages] = useState<ImageItem[]>([]);
  const [originalDataUrl, setOriginalDataUrl] = useState("");
  const [studioMode, setStudioMode] = useState<"FLATTEN" | "CUT" | "AI">("FLATTEN");
  const [processingReceipt, setProcessingReceipt] = useState<string | null>(null);
  const [isPreparingThumbnail, setIsPreparingThumbnail] = useState(false);
  
  const [offlineDrafts, setOfflineDrafts] = useState<StudioDraft[]>([]);
  const [offlineSelectedDraft, setOfflineSelectedDraft] = useState<StudioDraft | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [coldIdentity, setColdIdentity] = useState<StudioDraftIdentity | null>(null);
  const [resumeRetry, setResumeRetry] = useState(0);

  const [setupPin, setSetupPin] = useState("");
  const [setupPinConfirm, setSetupPinConfirm] = useState("");
  const [setupPinError, setSetupPinError] = useState<string | null>(null);
  const [settingPin, setSettingPin] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinSetupDismissed, setPinSetupDismissed] = useState(false);
  const [offlineProfile, setOfflineProfile] = useState<OfflineProfile | null | undefined>(undefined);
  
  const [description, setDescription] = useState("");
  const [marketingCopy, setMarketingCopy] = useState("");
  const imageBatch = useRef<any>(null); // any for now because we need StudioCampaignImageBatchHandle
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const [isStudioProcessing, setIsStudioProcessing] = useState(false);
  const [editOverrideReason, setEditOverrideReason] = useState("");
  const editOverrideValue = editOverrideReason.trim();
  
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { enabled: !offline });
  const myCampaigns = trpc.productStudio.myCampaigns.useQuery(undefined, {
    enabled: !offline && Boolean(me.data?.id),
    staleTime: 60_000,
  });

  const { selectedTaskQuery, onlineSelected } = useStudioSelectedTask("MINE", selectedId, offline, [], null);

  const previousImages = trpc.productStudio.taskPreviousImages.useQuery(
    { taskId: Number(selectedId) },
    { enabled: !!selectedId && !offline && !captured }
  );

  const selected = onlineSelected ?? (offline && offlineSelectedDraft
    ? ({
        id: offlineSelectedDraft.taskSnapshot.taskId,
        productId: null,
        campaignId: null,
        branchId: null,
        productName: offlineSelectedDraft.taskSnapshot.productName,
        currentDescription: offlineSelectedDraft.taskSnapshot.currentDescription,
        status: offlineSelectedDraft.taskSnapshot.status,
        mode: offlineSelectedDraft.mode === "AI" ? "FLATTEN" : offlineSelectedDraft.mode,
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
        priority: "NORMAL",
        dueAt: null,
        revision: Number(offlineSelectedDraft.revision) || 1,
        overdue: false,
      } as StudioTask)
    : null);

  const workflowUser = {
    userId: Number(me.data?.id ?? 0),
    role: me.data?.role ?? "",
    isOwner: me.data?.isOwner === true,
  };
  const onlineUserId = workflowUser.userId > 0 ? workflowUser.userId : null;
  const onlineOwner = useMemo<StudioTenantScope | null>(
    () =>
      onlineUserId == null
        ? null
        : {
            companyId: me.data?.companyId ?? null,
            userId: onlineUserId,
          },
    [me.data?.companyId, onlineUserId],
  );
  const authenticatedOwner = onlineOwner ?? coldIdentity;
  const authenticatedUserId = authenticatedOwner?.userId ?? null;
  const editable = selected ? (offline && offlineSelectedDraft != null ? true : selected.status === "ASSIGNED" || selected.status === "IN_PROGRESS" || selected.status === "REJECTED") : false;

  const submit = trpc.productStudio.submitCandidate.useMutation({
    onSuccess: async () => {
      notify.ok("أُرسل المرشّح للمراجعة ولن يظهر في المتجر قبل الاعتماد");
      setImages([]);
      setOriginalDataUrl("");
      setProcessingReceipt(null);
      setCaptured(null);
      setSelectedId(null);
      if (!offline) {
        await Promise.all([
          utils.productStudio.myCampaigns.invalidate(),
          utils.productStudio.dashboard.invalidate()
        ]);
      }
    },
    onError: (error) => notify.err(error),
  });

  const revert = trpc.productStudio.revert.useMutation({
    onSuccess: async () => {
      notify.ok("استُرجعت الصورة الأصلية");
      if (!offline) utils.productStudio.dashboard.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const myPendingTasks = trpc.productStudio.tasks.useInfiniteQuery(
    {
      scope: "MINE",
      assigneeId: onlineUserId ?? undefined,
      statuses: ["ASSIGNED", "IN_PROGRESS", "REJECTED"],
    },
    {
      enabled: !offline && !!onlineUserId,
      staleTime: 30_000,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const nextTaskMutation = trpc.productStudio.nextPhotographerTask.useMutation({
    onSuccess: (result: any) => {
      if (!result) {
        notify.ok("رائع! ليس لديك أي مهام مجدولة بانتظار التصوير حالياً.");
        return;
      }
      applyStudioClaim({
        taskId: result.taskId,
        productName: result.productName,
        revision: result.revision,
        approvedImages: result.approvedImages,
        requiredImages: result.requiredImages,
        previousImages: result.previousImages,
      });
      notify.ok(`تم قفل وبدء «${result.productName}» بنجاح!`);
      setTimeout(() => {
        document.getElementById("studio-workspace-section")?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    },
    onError: (err: any) => {
      notify.err(err);
    },
  });

  const claimBarcodeMutation = trpc.productStudio.claimByBarcode.useMutation({
    onSuccess: (result) => {
      applyStudioClaim({
        taskId: result.taskId,
        productId: (result as { productId?: number }).productId,
        variantId: (result as { variantId?: number | null }).variantId ?? null,
        productName: result.productName,
        revision: result.revision,
        approvedImages: result.approvedImages,
        requiredImages: result.requiredImages,
        previousImages: (result as { previousImages?: any[] }).previousImages ?? [],
      });
      notify.ok(result.claimed ? `فُتح «${result.productName}» للتصوير` : `«${result.productName}» بين يديك أصلاً`);
      setTimeout(() => {
        document.getElementById("studio-workspace-section")?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    },
    onError: (err: any) => {
      notify.err(err);
    },
  });

  const handleNextTask = () => {
    if (offline) return;
    nextTaskMutation.mutate();
  };

  useEffect(() => {
    if (!offline && onlineOwner) {
      void saveStudioDraftIdentity(onlineOwner)
        .then(setColdIdentity)
        .catch(() => undefined);
      return;
    }
    if (offline && !onlineOwner) {
      void loadStudioDraftIdentity()
        .then(setColdIdentity)
        .catch(() => setColdIdentity(null));
    }
  }, [offline, onlineOwner]);

  useEffect(() => {
    if (offline || !me.data?.id) return;
    void saveOfflineProfile(studioOfflineProfileInput(me.data))
      .then(() => getOfflineProfile())
      .then(setOfflineProfile)
      .catch(() => setOfflineProfile(null));
  }, [offline, me.data]);

  function applyLocalDraft(draft: StudioDraft) {
    setImages(
      draft.imageDataUrl
        ? [{ id: `studio-draft-${draft.taskId}`, dataUrl: draft.imageDataUrl, isPrimary: true, name: "صورة المسودة المحلية" }]
        : [],
    );
    setStudioMode(draft.mode);
    setOriginalDataUrl(draft.originalDataUrl ?? "");
    setProcessingReceipt(draft.processingReceipt);
  }

  async function discardConflictingDraft() {
    if (!selected || !authenticatedOwner) return;
    await purgeStudioDraft(authenticatedOwner, Number(selected.id));
    setImages([]);
    setOriginalDataUrl("");
    setProcessingReceipt(null);
    setStudioMode("FLATTEN");
    setDraftConflict(false);
    setDraftReady(false);
    setResumeRetry((attempt) => attempt + 1);
  }

  useEffect(() => {
    if (!offline || !authenticatedOwner) return;
    let cancelled = false;
    void listStudioDraftsForOwner(authenticatedOwner)
      .then((drafts) => {
        if (!cancelled) setOfflineDrafts(drafts);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [authenticatedOwner, offline]);

  useEffect(() => {
    if (!selectedId || !authenticatedOwner) return;
    const taskId = Number(selected?.id ?? selectedId);
    let cancelled = false;
    let retryTimer: number | undefined;
    const safetyTimer = window.setTimeout(() => {
      if (!cancelled) setDraftReady(true);
    }, 1_200);
    
    void (async () => {
      try {
        if (offline) {
          const draft = await loadStudioDraft(authenticatedOwner, taskId);
          if (draft && !cancelled) applyLocalDraft(draft);
          return;
        }
        const refreshed = await selectedTaskQuery.refetch();
        if (refreshed.isError) {
          retryTimer = window.setTimeout(() => setResumeRetry((attempt) => attempt + 1), 1_500);
          return;
        }
        const task = refreshed.data?.items.find((item) => Number(item.id) === taskId);
        if (cancelled) return;
        const result = await reconcileStudioDraftAfterReconnect({
          ...authenticatedOwner,
          taskId,
          taskFound: Boolean(task),
          revision: task ? String(task.revision) : null,
          editable: true,
        });
        if (cancelled) return;
        if (result.kind === "RESUME") {
          applyLocalDraft(result.draft);
        }
        if (result.kind === "ALREADY_RESUMED") {
          retryTimer = window.setTimeout(() => setResumeRetry((attempt) => attempt + 1), Math.max(0, result.retryAt - Date.now()) + 25);
        }
        if (result.kind === "CONFLICT") setDraftConflict(true);
      } catch {
        // Fallback
      } finally {
        if (!cancelled) setDraftReady(true);
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      window.clearTimeout(safetyTimer);
    };
  }, [authenticatedOwner, offline, selectedId, selected?.revision, resumeRetry]);

  useEffect(() => {
    if (!selected || !authenticatedOwner || !editable || !draftReady || draftConflict) return;
    const timer = window.setTimeout(() => {
      void saveStudioDraft({
        ...authenticatedOwner,
        taskId: Number(selected.id),
        revision: String(selected.revision),
        proposedName: selected.proposedName ?? selected.productName,
        proposedDescription: selected.proposedDescription ?? "",
        proposedMarketingCopy: selected.proposedMarketingCopy ?? "",
        imageDataUrl: images[0]?.dataUrl ?? null,
        originalDataUrl: originalDataUrl || null,
        processingReceipt,
        taskSnapshot: {
            taskId: Number(selected.id),
            productName: selected.productName,
            status: selected.status as any,
            hasOriginal: selected.hasOriginal,
            hasCandidate: selected.hasCandidate,
            currentDescription: selected.currentDescription ?? "",
            updatedAt: selected.updatedAt.toISOString(),
        },
        mode: studioMode,
      }).catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [authenticatedOwner, draftConflict, draftReady, editable, images, originalDataUrl, processingReceipt, selected, studioMode]);

  const applyStudioClaim = (claimed: ClaimedStudioProduct) => {
    setCaptured(claimed);
    setOfflineSelectedDraft(null);
    setSelectedId(claimed.taskId);
  };

  async function configureOfflinePin() {
    if (settingPin || !setupPin) return;
    if (setupPin !== setupPinConfirm) {
      setSetupPinError("الرمزان غير متطابقين");
      return;
    }
    setSettingPin(true);
    setSetupPinError(null);
    try {
      const result = await setOfflinePin(setupPin);
      if (!result.ok) {
        setSetupPinError(result.error ?? "تعذّر حفظ رمز PIN");
        return;
      }
      setSetupPin("");
      setSetupPinConfirm("");
      setPinSetupOpen(false);
      setOfflineProfile(await getOfflineProfile());
      notify.ok("ضُبط رمز PIN لاستعادة مسودات الاستوديو دون اتصال.");
    } catch (error) {
      setSetupPinError(error instanceof Error ? error.message : "تعذّر حفظ رمز PIN على هذا الجهاز");
    } finally {
      setSettingPin(false);
    }
  }

  function dismissPinSetup() {
    setPinSetupOpen(false);
    setPinSetupDismissed(true);
  }

  async function submitForReview() {
    if (offline || !selected || !images[0]?.dataUrl) return;
    setIsPreparingThumbnail(true);
    try {
      const thumbnailDataUrl = await createProductDisplayThumbnail(images[0].dataUrl);
      await submit.mutateAsync({
        taskId: Number(selected.id),
        expectedRevision: selected.revision,
        originalDataUrl: originalDataUrl || null,
        processedDataUrl: images[0].dataUrl,
        thumbnailDataUrl,
        mode: studioMode,
        processingReceipt,
      });
      if (authenticatedOwner)
        await purgeStudioDraft(authenticatedOwner, Number(selected.id));
    } catch (error) {
      notify.err(error);
    } finally {
      setIsPreparingThumbnail(false);
    }
  }

  const capabilities = studioOfflineCapabilities({
    offline,
    storageReady: dashboardData?.storageReady,
  });
  
  const storageActionsDisabled = !capabilities.canUseProviderOrStorage;
  const localEditingDisabled = !draftReady || draftConflict || !editable || !capabilities.canEditLocalDraft;

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden p-4 md:p-6">
      <PageHeader
        title="استوديو المنتجات (المصور)"
        description="التقط صور المنتجات، عدّلها، وارفعها للاعتماد."
        icon={<Image aria-hidden className="size-6" />}
        actions={
          !offline && (
            <Button
              size="default"
              className="gap-2 bg-primary font-bold shadow-md hover:bg-primary/90 min-h-11"
              disabled={nextTaskMutation.isPending}
              onClick={handleNextTask}
            >
              {nextTaskMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              تصوير المنتج التالي فوراً
            </Button>
          )
        }
      />

      {dashboardData && storageActionsDisabled && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{STUDIO_STORAGE_DISABLED_MESSAGE}</span>
        </div>
      )}

      {offline && offlineDrafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">مسودات محلية قابلة للاستعادة</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {offlineDrafts.map((draft) => (
              <div key={`${draft.userId}-${draft.taskId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{draft.proposedName || `مهمة الاستوديو #${draft.taskId}`}</p>
                  <p className="text-xs text-muted-foreground">
                    مهمة #{draft.taskId} · محفوظة محلياً
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
                    notify.ok("استُعيدت المسودة محلياً.");
                  }}
                >
                  استعادة المسودة
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!offline && onlineOwner != null && offlineProfile?.companyId !== undefined && sameStudioTenantScope({ companyId: offlineProfile.companyId, userId: offlineProfile.userId }, onlineOwner) && !offlineProfile.hasPin && !pinSetupDismissed && (
        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-start gap-2 text-sm">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">تجهيز استعادة المسودة دون اتصال (اختياري)</p>
                <p className="text-xs text-muted-foreground">اضبط رمز PIN لهذا الجهاز لتتمكّن من استعادة مسودتك بعد إعادة تحميل الصفحة أثناء انقطاع الاتصال.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPinSetupOpen((open) => !open)}>
                {pinSetupOpen ? "إخفاء" : "ضبط الآن"}
              </Button>
              <Button variant="ghost" size="sm" onClick={dismissPinSetup}>
                لاحقاً
              </Button>
            </div>
          </div>
          {pinSetupOpen && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="studio-offline-pin">رمز PIN للجهاز</Label>
                <Input id="studio-offline-pin" type="password" inputMode="numeric" autoComplete="new-password" value={setupPin} onChange={(event) => setSetupPin(event.target.value)} placeholder="٤ إلى ٨ أرقام" maxLength={8} />
              </div>
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="studio-offline-pin-confirm">تأكيد الرمز</Label>
                <Input id="studio-offline-pin-confirm" type="password" inputMode="numeric" autoComplete="new-password" value={setupPinConfirm} onChange={(event) => setSetupPinConfirm(event.target.value)} placeholder="أعد إدخال الرمز" maxLength={8} />
              </div>
              <Button className="min-h-11" disabled={settingPin || !setupPin || !setupPinConfirm} onClick={() => void configureOfflinePin()}>
                {settingPin ? ACTION_LABELS.saving : "تعيين PIN للجهاز"}
              </Button>
              {setupPinError && (
                <p role="alert" className="w-full text-sm text-destructive">
                  {setupPinError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!offline && (myCampaigns.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone aria-hidden className="size-4" /> حملاتي النشطة
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(myCampaigns.data ?? []).map((camp) => (
              <div key={camp.campaignId} className={`min-w-0 rounded-md border p-3 ${camp.status === "PAUSED" ? "bg-[var(--sem-warn)]/5 border-[var(--sem-warn)]/30" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{camp.name}</p>
                  <div className="flex shrink-0 items-center gap-1">
                    {camp.status === "PAUSED" && (
                      <Badge variant="warning" className="text-[10px]">موقوفة مؤقّتاً</Badge>
                    )}
                    {camp.requiredImages > 1 && <Badge variant="outline">{camp.requiredImages} صور</Badge>}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded bg-muted/30 p-2">
                    <div className="text-muted-foreground">قيد عملي</div>
                    <div className="text-base font-semibold">{camp.personal.active}</div>
                  </div>
                  <div className="rounded bg-muted/30 p-2">
                    <div className="text-muted-foreground">بانتظار المراجعة</div>
                    <div className="text-base font-semibold">{camp.personal.pendingReview}</div>
                  </div>
                  <div className="rounded bg-muted/30 p-2">
                    <div className="text-muted-foreground">اعتَمدتُ</div>
                    <div className="text-base font-semibold">{camp.personal.done}</div>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* بطاقة طابور مهام المصور الحالية — اختيار سريع أو انتقال فوري */}
      {!offline && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock aria-hidden className="size-4 text-primary" />
                طابوري النشط للمهام المجدولة
              </CardTitle>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="gap-1.5 min-h-9"
                disabled={nextTaskMutation.isPending}
                onClick={handleNextTask}
              >
                {nextTaskMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                ابدأ التالي في طابوري
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {myPendingTasks.isLoading && (
              <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin me-2" /> جارٍ جلب مهامك المجدولة...
              </div>
            )}
            {!myPendingTasks.isLoading && (myPendingTasks.data?.pages[0]?.items ?? []).length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">
                لا توجد مهام مجدولة بانتظار تصويرك حالياً. يمكنك مسح باركود أي منتج أدناه للبدء به فوراً.
              </p>
            )}
            {!myPendingTasks.isLoading && (myPendingTasks.data?.pages[0]?.items ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  لديك <strong>{myPendingTasks.data?.pages[0]?.items.length}</strong> مهمة مجدولة بانتظارك. اضغط على أي منها للبدء:
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {(myPendingTasks.data?.pages[0]?.items ?? []).slice(0, 6).map((task) => (
                    <div
                      key={task.id}
                      className={`flex flex-col justify-between rounded-md border bg-background p-2.5 transition-all hover:border-primary ${
                        selectedId === Number(task.id) ? "border-primary ring-2 ring-primary/30" : ""
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-start justify-between gap-1">
                          <span className="min-w-0 truncate text-xs font-semibold">{task.productName}</span>
                          {task.status === "REJECTED" ? (
                            <Badge variant="danger" className="text-[10px]">مرفوضة وتحتاج تصحيح</Badge>
                          ) : task.priority === "URGENT" || task.priority === "HIGH" ? (
                            <Badge variant="warning" className="text-[10px]">أولوية عالية</Badge>
                          ) : null}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          مهمة #{task.id}
                        </p>
                      </div>
                      <div className="mt-2 pt-2 border-t flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">
                          {task.status === "IN_PROGRESS" ? "قيد العمل" : "مسندة إليك"}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 text-xs px-2"
                          onClick={() => {
                            applyStudioClaim({
                              taskId: Number(task.id),
                              productName: task.productName,
                              revision: Number(task.revision ?? 1),
                              approvedImages: 0,
                              requiredImages: 1,
                            });
                            notify.ok(`تم اختيار «${task.productName}»`);
                            setTimeout(() => {
                              document.getElementById("studio-workspace-section")?.scrollIntoView({ behavior: "smooth" });
                            }, 100);
                          }}
                        >
                          بدء التصوير
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!offline && (
        <StudioCaptureStation
          active={
            captured
              ? {
                  ...captured,
                  productId: captured.productId ?? (selected?.productId ? Number(selected.productId) : undefined),
                  variantId: captured.variantId ?? (selected?.variantId ? Number(selected.variantId) : null),
                }
              : null
          }
          offline={offline}
          onClaimed={applyStudioClaim}
          onClear={() => {
            setCaptured(null);
            setSelectedId(null);
          }}
        />
      )}

      {selected && (
         <div id="studio-workspace-section" className="space-y-4 pt-4">
           {draftConflict && (
              <div className="rounded-md border border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] p-4 text-[var(--sem-warn)]">
                <div className="flex items-start gap-2">
                  <AlertTriangle aria-hidden className="mt-0.5 size-5" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold text-base">المنتج تغيّر على الخادم منذ آخر مسودة</p>
                    <p className="text-sm">اكتشفنا مسودة محلية لك، لكن أحداً آخر (أو أنت من جهاز مختلف) عدّل حالة هذا المنتج. يجب التخلّص من المسودة المحلية وتحديث الشاشة.</p>
                  </div>
                </div>
                <div className="mt-3 text-left">
                  <Button type="button" variant="outline" className="border-[var(--sem-warn)] text-[var(--sem-warn)] hover:bg-[var(--sem-warn)] hover:text-background" onClick={discardConflictingDraft}>
                    تحديث وإلغاء مسودتي
                  </Button>
                </div>
              </div>
           )}

           {!draftConflict && (
              <Card>
                <CardHeader>
                  <Button type="button" variant="ghost" className="-mr-2 min-h-11 self-start lg:hidden" onClick={() => setSelectedId(null)}>
                    <ChevronRight aria-hidden className="size-4" /> عودة إلى المهام
                  </Button>
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>مساحة العمل: {selected.productName}{selected.variantName ? ` — ${selected.variantName}` : ""}</span>
                    <Badge variant="outline">مهمة #{selected.id}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {selected.rejectionReason && (
                    <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-destructive">
                      <p className="font-bold">مرفوضة وتحتاج لتعديل:</p>
                      <p className="text-sm">{selected.rejectionReason}</p>
                    </div>
                  )}

                  {/* مصفوفة بدائل وباركودات المنتج لمنع تصوير بديل واحد وإغفال البقية */}
                  {selected.productId != null && (
                    <StudioProductVariantMatrixCard
                      productId={Number(selected.productId)}
                      activeVariantId={selected.variantId ? Number(selected.variantId) : null}
                      onSelectBarcode={(b) => claimBarcodeMutation.mutate({ barcode: b })}
                      disabled={offline || claimBarcodeMutation.isPending}
                    />
                  )}

                  {previousImages.data && previousImages.data.length > 0 && (
                    <div className="mb-4 rounded-md border p-3">
                      <p className="mb-2 text-sm font-medium">الصور السابقة المعتمدة لهذا المنتج ({previousImages.data.length})</p>
                      <div className="flex flex-wrap gap-2">
                        {previousImages.data.map((img) => (
                          <div key={img.id} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border">
                            {img.thumbDataUrl ? (
                              <img src={img.thumbDataUrl} alt="صورة سابقة" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-muted text-xs text-muted-foreground">بلا مصغّر</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <StudioCampaignImageBatch
                    key={selected.id}
                    ref={imageBatch}
                    taskId={Number(selected.id)}
                    owner={authenticatedOwner}
                    productName={selected.productName}
                    primaryImages={images}
                    onPrimaryImage={(image) => {
                      setImages([image]);
                      setOriginalDataUrl(image.dataUrl);
                      setProcessingReceipt(null);
                      setStudioMode("FLATTEN");
                    }}
                    adminOverrideReason={editOverrideValue}
                    offline={offline}
                    submitting={isPreparingThumbnail}
                    onBusyChange={setIsBatchBusy}
                  >
                    <ProductMediaContentSection
                      title={`صورة المهمة ${selected.activeSlot ?? 1}`}
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
                      captureOnly={true}
                    />
                  </StudioCampaignImageBatch>

                  <div className="flex justify-end gap-2 border-t pt-4">
                    <Button 
                      disabled={offline || submit.isPending || !images[0]?.dataUrl || isPreparingThumbnail} 
                      onClick={submitForReview}
                    >
                      {(submit.isPending || isPreparingThumbnail) ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      إرسال للمراجعة
                    </Button>
                  </div>
                </CardContent>
              </Card>
           )}
         </div>
      )}
    </div>
  );
}
