import { StudioCampaignImageBatch, taskSnapshot, type StudioCampaignImageBatchHandle } from "@/components/product-studio/StudioCampaignImageBatch";
import { CampaignAssigneeEditor } from "@/components/product-studio/CampaignAssigneeEditor";
import { StudioPreviewPair as PreviewPair } from "@/components/product-studio/StudioPreviewPair";
import { ProductMediaContentSection } from "@/components/product/ProductMediaContentSection";
import { StudioCaptureStation, type ClaimedStudioProduct } from "@/components/product-studio/StudioCaptureStation";
import { StudioImageExportPanel } from "@/components/product-studio/StudioImageExportPanel";
import { ProductImageGallery } from "@/components/product-studio/ProductImageGallery";
import { StudioStandaloneImageManagerCard } from "@/components/product-studio/StudioStandaloneImageManagerCard";
import { StudioImageDiscoveryPanel } from "@/components/product-studio/StudioImageDiscoveryPanel";
import { StudioProductPicker } from "@/components/product-studio/StudioProductPicker";
import { useStudioSelectedTask } from "@/components/product-studio/useStudioSelectedTask";
import type { ImageItem } from "@/components/form/ImageUploader";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppSelect } from "@/components/ui/AppSelect";
import { backlogButtonSuffix, canApproveStudioCandidate, isQueuedStudioTask, studioTaskSelection } from "@/lib/productStudio/studioBoardLabels";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { canEditStudioTask, canReviewStudioTask, hasStudioOverrideReason, needsStudioEditOverride, needsStudioReviewOverride } from "@/lib/imageStudio/studioWorkflowPolicy";
import { adjustStudioReviewZoom, defaultStudioScope, mobileStudioPanel, STUDIO_EMPTY_HINTS, STUDIO_REJECTION_PRESETS, type StudioReviewImage } from "@/lib/productStudio/mobileStudioUi";
import { loadStudioDraft, purgeStudioDraft, purgeStudioDraftsForUser, reconcileStudioDraftAfterReconnect, saveStudioDraft, listStudioDraftsForUser, loadStudioDraftIdentity, saveStudioDraftIdentity, studioDraftWritesAllowed, type StudioDraft, type StudioDraftTaskSnapshot } from "@/lib/productStudio/studioDrafts";
import { studioOfflineCapabilities, studioOfflineProfileInput } from "@/lib/productStudio/coldOfflinePolicy";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { getOfflineProfile, saveOfflineProfile, setOfflinePin, type OfflineProfile } from "@/lib/offline/pinLock";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { STUDIO_CAMPAIGN_STATUS_AR, STUDIO_CAMPAIGN_STATUS_VARIANT, STUDIO_CAMPAIGN_EDITABLE, type StudioCampaignStatus } from "@shared/studioCampaignStatus";
import { AlertTriangle, Bell, CheckCircle2, ChevronRight, ClipboardList, History, Image, Loader2, Megaphone, Minus, PauseCircle, PlayCircle, Plus, RefreshCw, RotateCcw, ScanLine, ShieldCheck, UserCheck, XCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { ACTION_LABELS } from "@shared/actionLabels";

type Scope = "QUEUE" | "MINE" | "REVIEW" | "HISTORY";

/**
 * حفظُ آخر تبويبٍ اختاره المستخدم (٢٩/٨) — يخصّه هو (لا يُشارَك مع مستخدمٍ آخر على نفس
 * الجهاز)، ويُخزَّن في localStorage. `defaultStudioScope(dashboard)` يظلّ الاحتياطيّ
 * الوحيد إن لم يُختَر تبويبٌ بعد. النسخة v1 تسمح ترقيةً لاحقة بلا كسر: أيّ قيمةٍ غير
 * معروفة تُقابَل بعودةٍ صامتةٍ للافتراضيّ.
 */
const STUDIO_LAST_TAB_KEY = "studio.dashboard.last-tab.v1";
const STUDIO_SCOPES: readonly Scope[] = ["QUEUE", "MINE", "REVIEW", "HISTORY"] as const;

function loadPersistedStudioScope(): Scope | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STUDIO_LAST_TAB_KEY);
    if (!raw) return null;
    return STUDIO_SCOPES.includes(raw as Scope) ? (raw as Scope) : null;
  } catch {
    return null;
  }
}

function persistStudioScope(scope: Scope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STUDIO_LAST_TAB_KEY, scope);
  } catch {
    // تخطٍّ صامت (Safari Private).
  }
}
type StudioTask = RouterOutputs["productStudio"]["tasks"]["items"][number];
const CameraScanner = lazy(() =>
  import("@/components/scan/CameraScanner").then((module) => ({
    default: module.CameraScanner,
  })),
);


export const STUDIO_STORAGE_DISABLED_MESSAGE = "وضع القراءة القديم فعّال: مخزن R2 الخاص غير مهيأ. الإسناد ومعالجة الصور والاعتماد متوقفة بأمان، بينما تبقى الإحصاءات والمهام والسجل متاحة للقراءة.";

function studioDatetimeLocal(value: Date | string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const PIN_SETUP_DISMISS_KEY = "studio:offline-pin-setup-dismissed";

/** سقف الإسناد الجماعيّ في النداء الواحد — يطابق حدّ الراوتر. */
const BULK_ASSIGN_MAX = 100;

/** الحالات التي يجوز إلغاؤها — تُطابق حارس الخادم؛ المعتمدة لها «استرجاع الأصل». */
const CANCELLABLE_STATUSES: StudioTask["status"][] = ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"];

const STATUS_LABEL: Record<StudioTask["status"], string> = {
  ASSIGNED: "مسندة",
  IN_PROGRESS: "قيد العمل",
  PENDING_REVIEW: "بانتظار المراجعة",
  APPROVED: "معتمدة",
  REJECTED: "تحتاج تعديلاً",
  FAILED: "فشلت",
  REVERTED: "استُرجع الأصل",
  CANCELLED: "ملغاة",
};

const STATUS_VARIANT: Record<StudioTask["status"], "neutral" | "info" | "warning" | "success" | "danger"> = {
  ASSIGNED: "neutral",
  IN_PROGRESS: "info",
  PENDING_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  FAILED: "danger",
  REVERTED: "neutral",
  CANCELLED: "neutral",
};

export default function ProductImageStudio() {
  const [scope, setScope] = useState<Scope>("MINE");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [productId, setProductId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [bulkProductIds, setBulkProductIds] = useState<number[]>([]);
  const [assignmentPriority, setAssignmentPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [assignmentDueAt, setAssignmentDueAt] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignStartAt, setCampaignStartAt] = useState("");
  const [campaignDueAt, setCampaignDueAt] = useState("");
  const [campaignBranchId, setCampaignBranchId] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  // ٢٨/٨: توصيلٌ من شاشة إدارة الحملات — رابط «تفاصيل» يفتح الاستوديو بـ`?campaign=N`
  // فتُنتقى الحملةُ في القائمة المنسدلة تلقائياً ويتمرّر التركيز إلى قسمها. بلا هذا،
  // كان الرابط يفتح الاستوديو على «كل المهام» فيضطرّ المدير لفتح القائمة والبحث عن اسم
  // حملةٍ اختارها للتوّ. الأثر يعمل مرّةً واحدةً على أوّل تحميلٍ يحمل المعامل، ولا يعكس
  // اختياراتِ المستخدم اللاحقة (بلا هذا، تغيير القائمة يدوياً يُلغى بأثرٍ من URL قديم).
  const searchString = useSearch();
  const campaignParamHandledRef = useRef(false);
  useEffect(() => {
    if (campaignParamHandledRef.current) return;
    const params = new URLSearchParams(searchString);
    const raw = params.get("campaign");
    if (!raw) return;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return;
    campaignParamHandledRef.current = true;
    setSelectedCampaignId(parsed);
    // نافذةٌ صغيرة كي تُركَّب القائمة أوّلاً (المدير يحتاج رؤية الأزرار مباشرة تحت البصر).
    window.setTimeout(() => {
      document.getElementById("studio-campaign-filter")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [searchString]);
  // مرساة `#new-campaign` من رابط «إنشاء حملة جديدة» في شاشة إدارة الحملات: تمرير
  // البصر إلى بطاقة منشئ الحملة كي يبدأ المدير التعبئةَ مباشرةً بلا بحثٍ يدويّ عن القسم.
  // مرّةً واحدةً فقط لكلّ تحميل — كأثرِ المعامل أعلاه (مراجعة Codex P2).
  const hashHandledRef = useRef(false);
  useEffect(() => {
    if (hashHandledRef.current) return;
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#new-campaign") return;
    hashHandledRef.current = true;
    window.setTimeout(() => {
      document.getElementById("new-campaign")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("studio-campaign-name")?.focus();
    }, 200);
  }, []);
  const [savedView, setSavedView] = useState<"ALL" | "UNASSIGNED" | "OVERDUE" | "PENDING_REVIEW" | "MISSING_IMAGE">("ALL");
  const [taskPriorityFilter, setTaskPriorityFilter] = useState<"ALL" | "LOW" | "NORMAL" | "HIGH" | "URGENT">("ALL");
  // ٢٩/٨ (بلاغ مالك): افتراضياً نخفي مهامَّ الحملات المغلقة كي لا تُشوّش القائمة بعد
  // إلغاء أو إكمال حملة. المدير يستطيع إظهارَها لمراجعةٍ أو تصريفٍ يدويٍّ حين يشاء.
  const [hideClosedCampaigns, setHideClosedCampaigns] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedPriority, setSelectedPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [selectedDueAt, setSelectedDueAt] = useState("");
  const [sourceChoice, setSourceChoice] = useState("new");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [marketingCopy, setMarketingCopy] = useState("");
  const [images, setImages] = useState<ImageItem[]>([]);
  const imageBatch = useRef<StudioCampaignImageBatchHandle>(null);
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const [originalDataUrl, setOriginalDataUrl] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [studioMode, setStudioMode] = useState<"FLATTEN" | "CUT" | "AI">("FLATTEN");
  const [processingReceipt, setProcessingReceipt] = useState<string | null>(null);
  const [isPreparingThumbnail, setIsPreparingThumbnail] = useState(false);
  const [isStudioProcessing, setIsStudioProcessing] = useState(false);
  const [editOverrideReason, setEditOverrideReason] = useState("");
  /** أحدث قيمة للسبب بلا إدراجها في اعتماديات أثر المصالحة (انظر التعليق عند الأثر). */
  const editOverrideReasonRef = useRef(editOverrideReason);
  editOverrideReasonRef.current = editOverrideReason;
  const [reviewOverrideReason, setReviewOverrideReason] = useState("");
  const [scopeInitialized, setScopeInitialized] = useState(false);
  const [taskScannerOpen, setTaskScannerOpen] = useState(false);
  const [scannedTask, setScannedTask] = useState<StudioTask | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [offlineDrafts, setOfflineDrafts] = useState<StudioDraft[]>([]);
  const [offlineSelectedDraft, setOfflineSelectedDraft] = useState<StudioDraft | null>(null);
  const [coldIdentityUserId, setColdIdentityUserId] = useState<number | null>(null);
  const [resumeRetry, setResumeRetry] = useState(0);
  const [offlineProfile, setOfflineProfile] = useState<OfflineProfile | null | undefined>(undefined);
  const [inlineAssigneeId, setInlineAssigneeId] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  // نموذجُ تعديل بيانات الحملة (اسم/عدد صور/مواعيد) — يفتحه المدير بحاجةٍ عمليّة
  // (اكتشاف أنّ منتجاتٍ تحتاج أكثر من صورة بعد بدء الحملة). حالةٌ محلّية بلا مسودةٍ
  // خادمية: يعبّئها زرّ «تعديل» من الحملة المحمّلة، ويُصفّرها الحفظ.
  const [campaignEditOpen, setCampaignEditOpen] = useState(false);
  const [editCampaignName, setEditCampaignName] = useState("");
  const [editCampaignRequired, setEditCampaignRequired] = useState("");
  const [editCampaignStartsAt, setEditCampaignStartsAt] = useState("");
  const [editCampaignDueAt, setEditCampaignDueAt] = useState("");
  // إعادةُ إسنادٍ لمهمّةٍ عالقة — القيمة الفارغة تعني «إلى الطابور المفتوح».
  const [reassignAssigneeId, setReassignAssigneeId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [backlogCancelReason, setBacklogCancelReason] = useState("");
  /** منتجاتٌ محدَّدة للإسناد الجماعيّ (بمعرّف المنتج — لأنّ عقد الخادم بالمنتجات لا بالمهام). */
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [bulkReassignAssigneeId, setBulkReassignAssigneeId] = useState("");
  const [bulkPriorityValue, setBulkPriorityValue] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [assigneeFilter, setAssigneeFilter] = useState("ALL");
  /** المنتج الذي بيد المصوّر الآن (من مسح الباركود) — يقود محطّة التصوير. */
  const [captured, setCaptured] = useState<ClaimedStudioProduct | null>(null);
  /** نطاق الحملة وفريقها وتوجيهها — يُرسَلان مع الإنشاء. */
  const [campaignScope, setCampaignScope] = useState<"ALL" | "CATEGORY" | "CATEGORIES" | "PRODUCTS">("ALL");
  const [campaignCategoryIds, setCampaignCategoryIds] = useState<number[]>([]);
  const [campaignImagesPolicy, setCampaignImagesPolicy] = useState<"ONLY_MISSING" | "ANY_REGARDLESS">("ONLY_MISSING");
  const [campaignCategoryId, setCampaignCategoryId] = useState("");
  /** تحديدٌ مستقلّ لنطاق الحملة — كان يتشارك `bulkProductIds` مع إسناد المهام، فتتسرّب منتجات حملةٍ إلى إسنادٍ لاحق. */
  const [campaignProductIds, setCampaignProductIds] = useState<number[]>([]);
  const [tempPhotographerName, setTempPhotographerName] = useState("");
  /** رمز الدخول المؤقّت — يُعرَض مرّةً واحدة ولا يُسترجَع؛ يُمسح فور إغلاق البطاقة. */
  const [issuedAccess, setIssuedAccess] = useState<{ name: string; username: string; code: string; expiresAt: Date } | null>(null);
  const [campaignRequiredImages, setCampaignRequiredImages] = useState("1");
  const [campaignAssigneeIds, setCampaignAssigneeIds] = useState<number[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [debouncedTaskSearch, setDebouncedTaskSearch] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [setupPinConfirm, setSetupPinConfirm] = useState("");
  const [setupPinError, setSetupPinError] = useState<string | null>(null);
  const [settingPin, setSettingPin] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinSetupDismissed, setPinSetupDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(PIN_SETUP_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const previousUserId = useRef<number | null>(null);

  const utils = trpc.useUtils();
  const connectivity = useConnectivity();
  const offline = isDisconnected(connectivity) || (typeof navigator !== "undefined" && !navigator.onLine);
  const dashboard = trpc.productStudio.dashboard.useQuery(undefined, {
    enabled: !offline,
  });
  const me = trpc.auth.me.useQuery(undefined, { enabled: !offline });
  const tasks = trpc.productStudio.tasks.useInfiniteQuery(
    {
      scope,
      limit: 50,
      priority: taskPriorityFilter === "ALL" ? undefined : [taskPriorityFilter],
      overdue: overdueOnly || savedView === "OVERDUE" ? true : undefined,
      unassigned: savedView === "UNASSIGNED" || savedView === "MISSING_IMAGE" ? true : undefined,
      campaignId: selectedCampaignId ?? undefined,
      search: debouncedTaskSearch || undefined,
      assigneeId: assigneeFilter === "ALL" ? undefined : Number(assigneeFilter),
      // إن انتقى المدير حملةً بعينها من dropdown، لا نُخفي حملتها حتى لو كانت مغلقة —
      // المدير طلبها صراحةً. الإخفاء الافتراضيّ يخصّ العرض العامّ فقط.
      hideClosedCampaigns: selectedCampaignId ? undefined : hideClosedCampaigns,
    },
    {
      enabled: !offline,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );
  const taskItems = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  const { selectedTaskQuery, onlineSelected } = useStudioSelectedTask(scope, selectedId, offline, taskItems, scannedTask);
  const productImages = trpc.productStudio.productImages.useQuery(
    { productId: Number(productId) || 0 },
    {
      enabled: !offline && Boolean(productId) && dashboard.data?.canManage === true,
    },
  );
  const assignees = trpc.productStudio.assignees.useQuery(undefined, {
    enabled: !offline && dashboard.data?.canManage === true,
  });
  const campaigns = trpc.productStudio.campaigns.useQuery(undefined, {
    enabled: !offline && dashboard.data?.canManage === true,
  });
  // نافذةُ المصوّر على حملاته: تُفتح متى كان له حسابٌ حيّ، ولا تُفتح للمدير (يرى كل شيء).
  // الشرط `!canManage` يمنع الازدواج بين هذه البطاقة ولوحة الحملات الإدارية أدناه.
  const myCampaigns = trpc.productStudio.myCampaigns.useQuery(undefined, {
    enabled: !offline && Boolean(me.data?.id) && dashboard.data?.canManage !== true,
    staleTime: 60_000,
  });
  const campaignPreview = trpc.productStudio.previewCampaignBacklog.useQuery(
    { campaignId: selectedCampaignId ?? 0 },
    {
      enabled: !offline && Boolean(selectedCampaignId) && dashboard.data?.canManage === true,
    },
  );
  const campaignAnalytics = trpc.productStudio.campaignAnalytics.useQuery(
    { campaignId: selectedCampaignId ?? 0 },
    {
      enabled: !offline && Boolean(selectedCampaignId) && dashboard.data?.canManage === true,
    },
  );
  const categoryOptions = trpc.catalog.categories.useQuery(undefined, {
    enabled: !offline && dashboard.data?.canManage === true,
    staleTime: 300_000,
  });
  const campaignBoard = trpc.productStudio.campaignBoard.useQuery(
    { campaignId: selectedCampaignId ?? 0 },
    {
      enabled: !offline && Boolean(selectedCampaignId) && dashboard.data?.canManage === true,
    },
  );
  const selectedCampaign = (campaigns.data ?? []).find(
    (campaign) => Number(campaign.id) === selectedCampaignId,
  );
  // فشل أي استعلام كان يُعرَض كصفرٍ أو كقائمةٍ فارغة: «لا مهام» بدل «تعذّر الجلب»،
  // وسقوط لوحة المؤشرات كان يُسقط معه canManage فتختفي أدوات المدير بلا تفسير.
  const loadFailures = (
    [
      [dashboard, "لوحة المؤشرات"],
      [tasks, "قائمة المهام"],
      [selectedTaskQuery, "المهمة المحددة"],
      [campaigns, "الحملات"],
      [assignees, "قائمة الموظفين"],
      [campaignPreview, "معاينة المهام الناقصة"],
    ] as const
  )
    .filter(([query]) => query.isError)
    .map(([, label]) => label);

  const canBulkAssign = dashboard.data?.canManage === true && !offline;
  const { queuedTaskIds, allQueuedSelected, selectedAssignedTaskIds, selectedActiveTaskIds } = studioTaskSelection(taskItems, selectedTaskIds);
  const toggleTaskSelection = (taskId: number) =>
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const toggleSelectAllQueued = () => setSelectedTaskIds(allQueuedSelected ? new Set() : new Set(queuedTaskIds));

  const selected =
    onlineSelected ??
    (offline && offlineSelectedDraft
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
  const selectedRevision = selected ? String(selected.revision) : "";
  const workflowUser = {
    userId: Number(me.data?.id ?? 0),
    role: me.data?.role ?? "",
    isOwner: me.data?.isOwner === true,
  };
  const onlineUserId = workflowUser.userId > 0 ? workflowUser.userId : null;
  const authenticatedUserId = onlineUserId ?? coldIdentityUserId;
  const editOverrideRequired = selected ? needsStudioEditOverride(selected, workflowUser) : false;
  const reviewOverrideRequired = selected ? needsStudioReviewOverride(selected, workflowUser) : false;
  const editable = selected ? (offline && offlineSelectedDraft != null ? true : canEditStudioTask(selected, workflowUser, editOverrideReason)) : false;
  const reviewable = selected ? canReviewStudioTask(selected, workflowUser, reviewOverrideReason) : false;
  const editOverrideValue = hasStudioOverrideReason(editOverrideReason) ? editOverrideReason.trim() : undefined;
  const reviewOverrideValue = hasStudioOverrideReason(reviewOverrideReason) ? reviewOverrideReason.trim() : undefined;
  const preview = trpc.productStudio.candidatePreview.useQuery(
    { taskId: selectedId ?? 0 },
    {
      enabled: !offline && Boolean(selectedId && selected?.hasCandidate && dashboard.data?.storageReady),
      staleTime: 0,
      gcTime: 0,
    },
  );
  const sourcePreview = trpc.productStudio.sourcePreview.useQuery(
    { taskId: selectedId ?? 0 },
    {
      enabled: !offline && Boolean(selectedId && selected?.hasOriginal && dashboard.data?.storageReady && editable),
      staleTime: 0,
      gcTime: 0,
    },
  );
  const taskPreviousImages = trpc.productStudio.taskPreviousImages.useQuery(
    { taskId: selectedId ?? 0 },
    {
      enabled: !offline && Boolean(selectedId && selectedId > 0),
      staleTime: 30_000,
    },
  );

  async function refresh() {
    if (offline) return;
    await Promise.all([utils.productStudio.dashboard.invalidate(), utils.productStudio.tasks.invalidate(), utils.productStudio.products.invalidate(), utils.productStudio.campaigns.invalidate(), utils.productStudio.myCampaigns.invalidate(), utils.productStudio.previewCampaignBacklog.invalidate(), utils.productStudio.campaignAnalytics.invalidate(), utils.productStudio.campaignBoard.invalidate()]);
  }

  const assign = trpc.productStudio.assign.useMutation({
    onSuccess: async () => {
      notify.ok("أُسندت المهمة");
      setInlineAssigneeId("");
      setProductId("");
      setAssigneeId("");
      setSourceChoice("new");
      setBulkProductIds([]);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const bulkAssign = trpc.productStudio.bulkAssign.useMutation({
    onSuccess: async (result) => {
      notify.ok(`أُسندت ${result.createdCount} مهام`);
      setSelectedTaskIds(new Set());
      setBulkAssigneeId("");
      setProductId("");
      setBulkProductIds([]);
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
      // إغلاق دورة المصوّر: بعد الرفع تُفرَغ المحطّة ويعود التركيز للباركود جاهزاً
      // للمنتج التالي — بلا تنقّلٍ في التبويبات ولا بحثٍ عن الصفّ التالي.
      setCaptured(null);
      setSelectedId(null);
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
  const cancelTask = trpc.productStudio.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت المهمة ونُقلت إلى السجلّ");
      setCancelReason("");
      setSelectedId(null);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const cancelCampaignBacklog = trpc.productStudio.cancelCampaignBacklog.useMutation({
    onSuccess: async (result) => {
      // «تبقّى» صريحٌ لأنّ الإلغاء يجري على دفعات، كما في التوليد.
      notify.ok(result.cancelledCount > 0 ? `أُلغيت ${result.cancelledCount} مهمة${result.remaining > 0 ? ` — تبقّى ${result.remaining}، أعد الإلغاء` : ""}` : "لا مهام غير مسندة في هذه الحملة");
      setBacklogCancelReason("");
      setSelectedId(null);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const createTemporaryPhotographer = trpc.productStudio.createTemporaryPhotographer.useMutation({
    onSuccess: async (result) => {
      setIssuedAccess(result);
      setTempPhotographerName("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const grantStudioAccess = trpc.productStudio.grantStudioAccess.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.granted ? `مُنح «${result.name}» صلاحية استوديو المنتجات` : `«${result.name}» يملك الصلاحية أصلاً`);
      await utils.productStudio.assignees.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const updateCampaignAssignees = trpc.productStudio.updateCampaignAssignees.useMutation({
    onSuccess: async (result) => {
      notify.ok(`حُدّث فريق الحملة: +${result.added} · −${result.removed} · إجماليّ ${result.total}`);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const revokeTemporaryPhotographers = trpc.productStudio.revokeTemporaryPhotographers.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.revoked > 0 ? `أُغلق وصول ${result.revoked} مصوّراً مؤقّتاً` : "لا مصوّرين مؤقّتين نشطين في هذه الحملة");
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
  const updateSchedule = trpc.productStudio.updateSchedule.useMutation({
    onSuccess: async () => {
      notify.ok("حُدّثت أولوية المهمة وموعدها");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const reassign = trpc.productStudio.reassign.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.newAssigneeId == null ? "أُعيدت المهمة إلى الطابور المفتوح" : "أُعيد إسناد المهمة");
      setReassignAssigneeId("");
      setReassignReason("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const bulkReassign = trpc.productStudio.bulkReassign.useMutation({
    onSuccess: async (result) => {
      notify.ok(`أُعيد إسناد ${result.reassignedCount} مهمة`);
      setSelectedTaskIds(new Set());
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const bulkSetPriority = trpc.productStudio.bulkSetPriority.useMutation({
    onSuccess: async (result) => {
      notify.ok(`حُدّثت أولوية ${result.updatedCount} مهمة`);
      setSelectedTaskIds(new Set());
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const createCampaign = trpc.productStudio.createCampaign.useMutation({
    onSuccess: async (campaign) => {
      setSelectedCampaignId(campaign.campaignId);
      setCampaignName("");
      setCampaignStartAt("");
      setCampaignDueAt("");
      setCampaignScope("ALL");
      setCampaignCategoryIds([]);
      setCampaignImagesPolicy("ONLY_MISSING");
      setCampaignCategoryId("");
      setCampaignRequiredImages("1");
      setCampaignAssigneeIds([]);
      setCampaignProductIds([]);
      notify.ok(`أُنشئت حملة الاستوديو وفُعّلت${campaign.assigneeIds.length > 0 ? ` — ${campaign.assigneeIds.length} مصوّراً` : ""}`);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const createCampaignBacklog = trpc.productStudio.createCampaignBacklog.useMutation({
    onSuccess: async (result) => {
      // «تبقّى» صريحٌ لأنّ التوليد يجري على دفعات: بدونه يظنّ المدير أنّ الطابور اكتمل.
      notify.ok(result.createdCount > 0 ? `أُنشئت ${result.createdCount} مهمة غير مسندة${result.remaining > 0 ? ` — تبقّى ${result.remaining} منتجاً، أعد التوليد` : ""}` : "لا توجد منتجات ناقصة جديدة");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const updateCampaignDetails = trpc.productStudio.updateCampaignDetails.useMutation({
    onSuccess: async (result) => {
      notify.ok(`حُدّثت الحملة: ${result.updated.join("، ")}`);
      setCampaignEditOpen(false);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const transitionCampaign = trpc.productStudio.transitionCampaign.useMutation({
    onSuccess: async (result) => {
      // إلغاء الحملة يجرّ طابورها؛ والعدد يُذكر صراحةً كي لا يكون المسح الجماعي صامتاً.
      notify.ok(result.status === "CANCELLED" ? `أُلغيت الحملة و${result.cancelledTasks} مهمة من طابورها${result.remainingTasks > 0 ? ` — تبقّى ${result.remainingTasks}، أكمِل بزرّ «إلغاء الطابور»` : ""}` : "حُدّثت حالة الحملة");
      setBacklogCancelReason("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const sendDueNotifications = trpc.productStudio.sendDueNotifications.useMutation({
    onSuccess: (result) => notify.ok(`أُرسل ${result.createdCount} تنبيه جديد دون تكرار`),
    onError: (error) => notify.err(error),
  });

  useEffect(() => {
    if (!dashboard.data || scopeInitialized) return;
    // ٢٩/٨: التبويبُ المحفوظ (اختيار المستخدم السابق) يعلو على `defaultStudioScope` —
    // من فتح «HISTORY» وخرج، يعود ليجده كما تركه بدل «MINE» الافتراضيّ.
    const persisted = loadPersistedStudioScope();
    setScope(persisted ?? defaultStudioScope(dashboard.data));
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
    if (offline || !me.data?.id) return;
    void saveOfflineProfile(studioOfflineProfileInput(me.data))
      .then(() => getOfflineProfile())
      .then(setOfflineProfile)
      .catch(() => setOfflineProfile(null));
  }, [offline, me.data]);

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
      // بلا هذا الالتقاط كان رفض IndexedDB (تصفّح خاص/تخزين محجوب) يهرب كوعدٍ غير معالَج:
      // يتوقّف مؤشّر الانتظار ولا يحدث شيء ولا يُقال شيء.
      setSetupPinError(error instanceof Error ? error.message : "تعذّر حفظ رمز PIN على هذا الجهاز");
    } finally {
      setSettingPin(false);
    }
  }

  function dismissPinSetup() {
    setPinSetupOpen(false);
    setPinSetupDismissed(true);
    try {
      window.localStorage.setItem(PIN_SETUP_DISMISS_KEY, "1");
    } catch {
      /* التخزين المحجوب لا يمنع الإخفاء ضمن الجلسة الحالية. */
    }
  }

  useEffect(() => {
    if (!selected) return;
    setName(selected.proposedName ?? selected.productName);
    setDescription(selected.proposedDescription ?? selected.currentDescription ?? "");
    setMarketingCopy(selected.proposedMarketingCopy ?? "");
    setRejectReason(selected.rejectionReason ?? "");
    setImages([]);
    setOriginalDataUrl("");
    setStudioMode("FLATTEN");
    setProcessingReceipt(null);
    setEditOverrideReason("");
    setReviewOverrideReason("");
    setSelectedPriority(selected.priority);
    setSelectedDueAt(studioDatetimeLocal(selected.dueAt));
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

  async function discardConflictingDraft() {
    if (!selected || !authenticatedUserId) return;
    await purgeStudioDraft(authenticatedUserId, Number(selected.id));
    setName(selected.proposedName ?? selected.productName);
    setDescription(selected.proposedDescription ?? selected.currentDescription ?? "");
    setMarketingCopy(selected.proposedMarketingCopy ?? "");
    setImages([]);
    setOriginalDataUrl("");
    setProcessingReceipt(null);
    setStudioMode("FLATTEN");
    setDraftConflict(false);
    setDraftReady(false);
    setResumeRetry((attempt) => attempt + 1);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedTaskSearch(taskSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [taskSearch]);

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
    let retryTimer: number | undefined;
    void (async () => {
      let allowDraftWrites = false;
      try {
        if (offline) {
          const draft = await loadStudioDraft(authenticatedUserId, taskId);
          if (draft && !cancelled) applyLocalDraft(draft);
          allowDraftWrites = true;
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
          userId: authenticatedUserId,
          taskId,
          taskFound: Boolean(task),
          revision: task ? String(task.revision) : null,
          editable: task ? canEditStudioTask(task, workflowUser, editOverrideReasonRef.current) : false,
        });
        if (cancelled) return;
        allowDraftWrites = studioDraftWritesAllowed(result);
        if (result.kind === "RESUME") {
          applyLocalDraft(result.draft);
        }
        if (result.kind === "ALREADY_RESUMED") {
          retryTimer = window.setTimeout(() => setResumeRetry((attempt) => attempt + 1), Math.max(0, result.retryAt - Date.now()) + 25);
        }
        if (result.kind === "CONFLICT") setDraftConflict(true);
      } catch {
        // في عدم الاتصال نسمح بالعمل المحلي. أمّا عند الاتصال فلا نفسّر فشل قراءة
        // الخادم على أنه حذفٌ للمهمة، لأن ذلك قد يمحو مسودةً صالحة بتعارضٍ وهمي.
        if (offline) allowDraftWrites = true;
        else retryTimer = window.setTimeout(() => setResumeRetry((attempt) => attempt + 1), 1_500);
      } finally {
        if (!cancelled) setDraftReady(allowDraftWrites);
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
    // Read the administrative reason from its ref; typing must not refetch the task.
  }, [authenticatedUserId, offline, scope, selectedId, selectedRevision, resumeRetry]);

  useEffect(() => {
    if (!selected || !authenticatedUserId || !editable || !draftReady || draftConflict) return;
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
  }, [authenticatedUserId, description, draftConflict, draftReady, editable, images, marketingCopy, name, originalDataUrl, processingReceipt, selected?.id, selectedRevision, studioMode]);

  useEffect(() => {
    if (!draftReady || !selectedId || !sourcePreview.data || images.length > 0) return;
    const dataUrl = `data:${sourcePreview.data.mime};base64,${sourcePreview.data.base64}`;
    setImages([
      {
        id: `studio-source-${selectedId}`,
        dataUrl,
        isPrimary: true,
        name: "صورة المصدر",
      },
    ]);
  }, [draftReady, images.length, selectedId, sourcePreview.data]);

  function selectTask(task: StudioTask) {
    setOfflineSelectedDraft(null);
    setScannedTask(null);
    setSelectedId(Number(task.id));
  }

  // إسنادُ الشريحة الرئيسيّة بعد كل مسحٍ ناجح — يُستعمل من محطّة التصوير في الأعلى
  // ومن زرّ مسح الجوّال في الأسفل. كان الزرّ الأخير يستدعي `selectScannedOwnedTask`
  // الذي يبحث في مهامّ المصوّر `MINE` فقط، فيبلغه «لا توجد مهمة مسندة» حتى وهو ضمن
  // مصوّري حملةٍ نشطة — نقيض الإسناد الأعمى الذي يعِد به هذا العقد.
  const applyStudioClaim = (claimed: ClaimedStudioProduct) => {
    setCaptured(claimed);
    setOfflineSelectedDraft(null);
    setScannedTask(null);
    setScope("MINE");
    setSavedView("ALL");
    setOverdueOnly(false);
    setTaskPriorityFilter("ALL");
    setAssigneeFilter("ALL");
    setTaskSearch("");
    setDebouncedTaskSearch("");
    setSelectedCampaignId(null);
    setSelectedTaskIds(new Set());
    setSelectedId(claimed.taskId);
    void refresh();
  };

  const mobileClaimByBarcode = trpc.productStudio.claimByBarcode.useMutation({
    onSuccess: (result) => {
      applyStudioClaim({
        taskId: result.taskId,
        productName: result.productName,
        revision: result.revision,
        approvedImages: result.approvedImages,
        requiredImages: result.requiredImages,
      });
      notify.ok(result.claimed ? `فُتح «${result.productName}» للتصوير` : `«${result.productName}» بين يديك أصلاً`);
    },
    onError: (error) => notify.err(error),
  });

  function claimScannedBarcode(barcode: string) {
    if (offline || mobileClaimByBarcode.isPending) return;
    setTaskScannerOpen(false);
    const clean = barcode.trim();
    if (!clean) return;
    mobileClaimByBarcode.mutate({ barcode: clean });
  }

  async function submitForReview() {
    if (offline || !selected || !images[0]?.dataUrl) return;
    setIsPreparingThumbnail(true);
    try {
      await imageBatch.current?.submitAdditional();
      const thumbnailDataUrl = await createProductDisplayThumbnail(images[0].dataUrl);
      await submit.mutateAsync({
        taskId: Number(selected.id),
        expectedRevision: selected.revision,
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
      if (authenticatedUserId) await purgeStudioDraft(authenticatedUserId, Number(selected.id));
    } catch (error) {
      notify.err(error);
    } finally {
      setIsPreparingThumbnail(false);
    }
  }

  const counts = dashboard.data?.counts;
  const busy = isBatchBusy || isStudioProcessing || isPreparingThumbnail || saveDraft.isPending || submit.isPending || approve.isPending || reject.isPending || revert.isPending || updateSchedule.isPending;
  const capabilities = studioOfflineCapabilities({
    offline,
    storageReady: dashboard.data?.storageReady,
  });
  const storageActionsDisabled = !capabilities.canUseProviderOrStorage;
  const localEditingDisabled = !draftReady || draftConflict || !editable || !capabilities.canEditLocalDraft;
  const mobilePanel = mobileStudioPanel(selected ? Number(selected.id) : null);

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden p-4 md:p-6">
      <PageHeader
        title="استوديو المنتجات"
        description="مركز مستقل للصور والمحتوى: إسناد، تنفيذ، مراجعة، واعتماد. لا يعرض أسعاراً أو تكلفة أو مخزوناً."
        icon={<Image aria-hidden className="size-6" />}
        actions={
          <Button variant="outline" size="sm" disabled={!capabilities.canCallServer} onClick={() => refresh()}>
            <RefreshCw aria-hidden className="size-4" /> تحديث
          </Button>
        }
      />

      {dashboard.data && storageActionsDisabled && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{STUDIO_STORAGE_DISABLED_MESSAGE}</span>
        </div>
      )}

      {loadFailures.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">تعذّر جلب: {loadFailures.join("، ")}.</p>
            <p className="text-xs">الأرقام والقوائم أدناه قد تكون ناقصة أو صفراً بسبب هذا الفشل — لا لأنّ العمل منتهٍ. أعد المحاولة قبل اتخاذ قرار.</p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => refresh()}>
            إعادة المحاولة
          </Button>
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
                    مهمة #{draft.taskId} · محفوظة محلياً حتى {new Date(draft.expiresAt).toLocaleString("ar-IQ-u-nu-latn")}
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
                    notify.ok("استُعيدت المسودة محلياً؛ سيُتحقق من المهمة عند عودة الاتصال.");
                  }}
                >
                  استعادة المسودة
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* محطّة التصوير أوّلاً للمصوّر: هو يمسك المنتج ويمسح، لا يتصفّح طوابير.
          المدير يراها أيضاً كي يجرّب المسار الذي يعمل به فريقه. */}
      {!offline && (
        <StudioCaptureStation
          active={captured}
          offline={offline}
          onClaimed={(claimed) => {
            applyStudioClaim(claimed);
            const el = document.getElementById("studio-workspace-section");
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          onJumpToWorkspace={() => {
            const el = document.getElementById("studio-workspace-section");
            if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          onClear={() => {
            setCaptured(null);
            setSelectedId(null);
          }}
        />
      )}

      {/* حملاتي — يفتحها المصوّر فيرى موعدها ونصيبه منها وما تبقّى في الحملة كلّها.
          قبلها كان يعمل «أعمى»: قوائم المهام مسجَّلة له، لكن اسم الحملة نفسه محجوبٌ عنه.
          البطاقة تختفي للمدير (يرى لوحته الأكمل أدناه) ولمن ليس في حملةٍ نشطة. */}
      {!offline && dashboard.data?.canManage !== true && (myCampaigns.data?.length ?? 0) > 0 && (
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
                    {/* الحملة المُوقَفة تُعرَض للمصوّر (٢٨/٨) لأنّ مهامه المُسنَدة عليها تبقى قابلةً
                        للإتمام — لكن شارةً صريحة تُنذره أنّ منتجاً جديداً بالمسح لن يُنشئ عملاً
                        تحتها حتى يستأنف المدير. الاختفاء الكامل كان يُوهم أنّ مهامه اختفت. */}
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
                <p className="mt-2 text-xs text-muted-foreground">
                  الحملة: أُنجز {camp.campaign.done} من {camp.campaign.totalProducts} منتجاً
                  {camp.dueAt ? ` · ينتهي ${new Date(camp.dueAt as unknown as string | Date).toLocaleDateString("ar-IQ")}` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* بلاغ المالك (٢٨/٨) «حجم البطاقات كبيرة»: خُفّضت الحشوة من p-4 إلى p-3 والرقم
          من text-2xl إلى text-xl، والفواصل من gap-3 إلى gap-2 — تكثيفٌ بصريّ يُبقي كل
          البيانات مرئيّةً بلا أن تسيطر KPI على طول الشاشة. الشبكة صارت xl:grid-cols-4
          مع تخفيض العرض الأفقي الأقصى لكل خانة. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-3">
            {/* العنوان يتبع النطاق: أرقامُ المنفّذ مهامُه هو، لا حال الفرع. */}
            <div className="text-xs text-muted-foreground">{dashboard.data?.scopeKind === "PERSONAL" ? "مهامي النشطة" : "المهام النشطة"}</div>
            <div className="mt-0.5 text-xl font-bold">{dashboard.data?.active ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{dashboard.data?.scopeKind === "PERSONAL" ? "قيد عملي" : "قيد العمل"}</div>
            {/* المسنَد لمنفّذ فقط. جمع ASSIGNED كاملةً كان يَعُدّ طابور الحملة عملاً جارياً. */}
            <div className="mt-0.5 text-xl font-bold">{dashboard.data?.inProgress ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">بانتظار المراجعة</div>
            <div className="mt-0.5 text-xl font-bold">{counts?.PENDING_REVIEW ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">المعتمدة</div>
            <div className="mt-0.5 text-xl font-bold">{counts?.APPROVED ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* مؤشّرات المدير الثانوية داخل بطاقةٍ واحدة عوض ٦ بطاقاتٍ عائمة — كانت
          تُفرّق البصرَ وتتنافس مع مؤشّرات النطاق الأربعة أعلاها. أرقامٌ مضغوطة (text-base)
          لأنّها مؤشراتُ تشخيصٍ ثانوية لا رأس الشاشة. */}
      {dashboard.data?.canManage && (
        <Card>
          <CardHeader className="pb-1 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground">صحّة الطابور الإدارية</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 pb-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["غير المسندة", dashboard.data.unassigned ?? "—"],
              ["المتأخرة", dashboard.data.overdue],
              // منها متأخّرٌ بلا منفّذ: يوضّح أنّ الخانتين تصفان المهام نفسها لا مشكلتين منفصلتين.
              ["منها بلا منفّذ", dashboard.data.overdueUnassigned ?? "—"],
              ["مرفوضة (تنتظر التصحيح)", dashboard.data.rejected],
              ["المنجزة اليوم", dashboard.data.completedToday],
              [`وسيط زمن الدورة (${dashboard.data.medianCycleWindowDays} يوماً)`, dashboard.data.medianCycleMinutes == null ? "—" : `${dashboard.data.medianCycleMinutes} د`],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md border bg-muted/20 p-2">
                <div className="truncate text-[11px] text-muted-foreground">{label}</div>
                <div className="mt-0.5 text-base font-bold">{value}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* تصدير الصور المنشورة — للمدير فقط. يجمع صور المنتجات المعتمدة (المعدَّلة
          والمرتَّبة) في ZIP واحد لتحميلها محلياً — للسوشيال ميديا أو الأرشيف. المصدر:
          `productImages.reviewStatus='APPROVED'` (لا الأصل غير المُعدَّل). التسمية: اسم
          المنتج (وبديله إن وُجد). الخدمات مستبعَدةٌ تلقائياً. */}
      {!offline && dashboard.data?.canManage && <StudioImageExportPanel categories={categoryOptions.data ?? []} />}
      {/* لوحةُ إدارة صور منتجٍ مباشرةً — بلا مهمّةٍ في القائمة. يمسح المدير باركوداً أو
          يكتب معرّف منتج، فيفتح المعرض. طلب Codex P2 (٢٦/٨): مدير بمنتجٍ إرثيّ لا يستطيع
          الوصول إلى الأدوات دون إنشاء مهمّةٍ مصطنعة. */}
      {!offline && dashboard.data?.canManage && <StudioStandaloneImageManagerCard />}
      {/* كاشفُ فجوات الصور — لوحةٌ ذكيّة تُصنّف المنتجات بحالتها وتقترح إجراءاتٍ فوريّة.
          طلب المالك ٢٦/٨: «منظومة ذكيّة تكشف المنتجات بلا صور، بكج، بدائل ناقصة …». */}
      {!offline && dashboard.data?.canManage && (
        <StudioImageDiscoveryPanel
          onCreateCampaignFromProducts={(productIds) => {
            setCampaignScope("PRODUCTS");
            setCampaignProductIds(productIds);
            // مرِّر التركيز إلى منشئ الحملة كي يبدأ المدير الإدخال مباشرةً.
            window.setTimeout(() => document.getElementById("studio-campaign-name")?.focus(), 0);
            notify.ok(`عُبِّئ منشئ الحملة بـ${productIds.length} منتجاً — أكمِل الاسم والمصوّرين ثمّ اضغط «إنشاء وتفعيل»`);
          }}
          onCreateCampaignFromCategory={(categoryId) => {
            setCampaignScope("CATEGORY");
            setCampaignCategoryId(String(categoryId));
            window.setTimeout(() => document.getElementById("studio-campaign-name")?.focus(), 0);
            notify.ok("عُبِّئ منشئ الحملة بالفئة المختارة — أكمِل الاسم والمصوّرين ثمّ اضغط «إنشاء وتفعيل»");
          }}
        />
      )}

      {/* تجهيزٌ اختياريّ لاستعادة المسودة عند الانقطاع. كان بطاقةً كاملة فوق المؤشرات
          تُعرَض لكل مستخدمٍ متصل بلا مسودات ولا مخرجَ منها؛ صار شريطاً مؤجَّلاً أسفلها. */}
      {!offline && onlineUserId != null && offlineProfile?.userId === onlineUserId && !offlineProfile.hasPin && !pinSetupDismissed && (
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
              {/* تأكيدٌ إلزاميّ: بلا هذا الحقل كان خطأٌ مطبعيّ يقفل الاستعادة خلف رمزٍ مجهول. */}
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

      {dashboard.data?.canManage && (
        <Card id="new-campaign">
          {/* المرساة `#new-campaign` هدفٌ لِمن يفتح الاستوديو من رابط «إنشاء حملة» في شاشة
              الإدارة (مراجعة Codex P2). أثرُ التمرير في الأسفل يسحب البصر إليها فتُملأ
              الحقول بلا بحثٍ يدويّ عن القسم. الـid على البطاقة ذاتها لأنّها **الحاوية**
              الفعليّة لمنشئ الحملة (لا يوجد نموذجٌ منفصلٌ لها). */}
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone aria-hidden className="size-4" /> حملات اكتمال الصور
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-1.5 xl:col-span-2">
                <Label htmlFor="studio-campaign-name">اسم حملة جديدة</Label>
                <Input id="studio-campaign-name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="مثال: اكتمال صور القرطاسية" maxLength={180} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-branch">الفرع</Label>
                <AppSelect id="studio-campaign-branch" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignBranchId || String(me.data?.branchId ?? "")} onValueChange={setCampaignBranchId}>
                  <option value="">اختر الفرع</option>
                  {Array.from(new Set((assignees.data ?? []).map((user) => user.branchId).filter((value): value is number => value != null))).map((branchId) => (
                    <option key={branchId} value={branchId}>
                      فرع {branchId}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-start">بداية الحملة</Label>
                <Input id="studio-campaign-start" type="datetime-local" value={campaignStartAt} onChange={(event) => setCampaignStartAt(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-due">موعد الحملة</Label>
                <Input id="studio-campaign-due" type="datetime-local" value={campaignDueAt} onChange={(event) => setCampaignDueAt(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-scope">نطاق الحملة</Label>
                <AppSelect id="studio-campaign-scope" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignScope} onValueChange={(value) => setCampaignScope(value as typeof campaignScope)}>
                  <option value="ALL">كل المنتجات</option>
                  <option value="CATEGORY">فئة واحدة (بشجرتها)</option>
                  <option value="CATEGORIES">عدّة فئات (بأشجارها)</option>
                  <option value="PRODUCTS">منتجات مختارة</option>
                </AppSelect>
              </div>
              {campaignScope === "CATEGORY" && (
                <div className="space-y-1.5">
                  <Label htmlFor="studio-campaign-category">الفئة</Label>
                  <AppSelect id="studio-campaign-category" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignCategoryId} onValueChange={setCampaignCategoryId} disabled={categoryOptions.isError}>
                    <option value="">اختر الفئة</option>
                    {(categoryOptions.data ?? []).map((category) => (
                      <option key={Number(category.id)} value={Number(category.id)}>
                        {category.parentId ? "— " : ""}
                        {category.name}
                      </option>
                    ))}
                  </AppSelect>
                  {categoryOptions.isError && <p className="text-xs text-destructive">تعذّر جلب الفئات.</p>}
                </div>
              )}
              {campaignScope === "CATEGORIES" && (
                <div className="space-y-1.5 md:col-span-2">
                  <Label>الفئات (عدّة — كلٌّ بشجرتها)</Label>
                  <div className="flex flex-wrap gap-2 rounded-md border p-2">
                    {(categoryOptions.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">لا فئات متاحة.</span>}
                    {(categoryOptions.data ?? []).map((category) => {
                      const id = Number(category.id);
                      const picked = campaignCategoryIds.includes(id);
                      return (
                        <Button
                          key={id}
                          type="button"
                          size="sm"
                          variant={picked ? "default" : "outline"}
                          className="min-h-11"
                          onClick={() =>
                            setCampaignCategoryIds((current) =>
                              picked ? current.filter((x) => x !== id) : [...current, id],
                            )
                          }
                        >
                          {category.parentId ? "— " : ""}
                          {category.name}
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {campaignCategoryIds.length > 0 ? `${campaignCategoryIds.length} فئةً مُختارة — كلٌّ تشمل أحفادها` : "اختر فئةً واحدةً على الأقلّ"}
                  </p>
                </div>
              )}
              {/* سياسةُ الصور — طلب المالك (٢٦/٨): «حملة تشمل حتى التي تحمل صور». */}
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="studio-campaign-policy">سياسة الصور</Label>
                <AppSelect id="studio-campaign-policy" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={campaignImagesPolicy} onValueChange={(value) => setCampaignImagesPolicy(value as typeof campaignImagesPolicy)}>
                  <option value="ONLY_MISSING">الناقصة فقط (استبعاد المكتمل تلقائياً)</option>
                  <option value="ANY_REGARDLESS">كل المنتجات (حتى المكتمل — لإضافة صور جديدة)</option>
                </AppSelect>
                <p className="text-xs text-muted-foreground">
                  {campaignImagesPolicy === "ANY_REGARDLESS"
                    ? "المنتجات التي بلغَت `صور مطلوبة` ستدخل الطابور أيضاً — استعمله لإضافة صورةٍ ثالثة لمنتجٍ بصورتين مثلاً."
                    : "المنتجات التي بلغَت `صور مطلوبة` مستبعَدةٌ من الطابور — السلوك القياسيّ."}
                </p>
              </div>
              {campaignScope === "PRODUCTS" && (
                <div className="space-y-1.5">
                  <Label>المنتجات المختارة</Label>
                  {/* يُعاد استعمال منتقي المنتجات نفسه أسفل الشاشة — التحديد يظهر هنا. */}
                  <div className="space-y-2">
                    <StudioProductPicker canManage value={null} onPick={(product) => setCampaignProductIds((current) => (current.includes(Number(product.productId)) ? current : [...current, Number(product.productId)]))} />
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                      <span>{campaignProductIds.length > 0 ? `${campaignProductIds.length} منتجاً في نطاق الحملة` : "ابحث وأضِف منتجات النطاق"}</span>
                      {campaignProductIds.length > 0 && (
                        <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setCampaignProductIds([])}>
                          مسح
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-required">صور مطلوبة لكل منتج</Label>
                <Input id="studio-campaign-required" type="number" min={1} max={10} value={campaignRequiredImages} onChange={(event) => setCampaignRequiredImages(event.target.value)} />
                <p className="text-xs text-muted-foreground">التوجيه الإداريّ — يراه المصوّر ويبقى المنتج ناقصاً حتى يبلغه.</p>
              </div>
              <div className="space-y-1.5 xl:col-span-2">
                <Label>مصوّرو الحملة</Label>
                <div className="flex flex-wrap gap-2 rounded-md border p-2">
                  {(assignees.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">لا موظفين متاحين.</span>}
                  {(assignees.data ?? []).map((user) => {
                    const picked = campaignAssigneeIds.includes(user.id);
                    // من لا يملك صلاحية الاستوديو يظهر أيضاً — إخفاؤه كان يجعل الكادر
                    // يبدو ناقصاً بلا سبب. ويُمنح بزرٍّ صريح لا بمجرّد اختياره.
                    if (!user.canStudio) {
                      return (
                        <span key={user.id} className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
                          {user.name}
                          <Button type="button" size="sm" variant="ghost" className="min-h-11 px-2 text-xs" disabled={offline || grantStudioAccess.isPending} onClick={() => grantStudioAccess.mutate({ userId: user.id })}>
                            امنح الصلاحية
                          </Button>
                        </span>
                      );
                    }
                    return (
                      <Button
                        key={user.id}
                        type="button"
                        size="sm"
                        variant={picked ? "default" : "outline"}
                        className="min-h-11"
                        onClick={() => setCampaignAssigneeIds((current) => (picked ? current.filter((id) => id !== user.id) : [...current, user.id]))}
                      >
                        {user.name}
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">هؤلاء وحدهم يفتحون منتجات الحملة بمسح الباركود. والمُحاط بخطٍّ متقطّع بلا صلاحية استوديو — امنحها له ليصير قابلاً للاختيار.</p>
              </div>
              <div className="flex items-end">
                <Button
                  className="min-h-11 w-full"
                  disabled={offline || campaignName.trim().length < 3 || createCampaign.isPending || !(campaignBranchId || me.data?.branchId) || (campaignScope === "CATEGORY" && !campaignCategoryId) || (campaignScope === "CATEGORIES" && campaignCategoryIds.length === 0) || (campaignScope === "PRODUCTS" && campaignProductIds.length === 0)}
                  onClick={() =>
                    createCampaign.mutate({
                      name: campaignName.trim(),
                      status: "ACTIVE",
                      branchId: Number(campaignBranchId || me.data?.branchId),
                      startsAt: campaignStartAt ? new Date(campaignStartAt) : null,
                      dueAt: campaignDueAt ? new Date(campaignDueAt) : null,
                      scopeKind: campaignScope,
                      scopeCategoryId: campaignScope === "CATEGORY" ? Number(campaignCategoryId) : null,
                      scopeCategoryIds: campaignScope === "CATEGORIES" ? campaignCategoryIds : undefined,
                      scopeProductIds: campaignScope === "PRODUCTS" ? campaignProductIds : undefined,
                      requiredImages: Math.max(1, Math.min(10, Number(campaignRequiredImages) || 1)),
                      imagesPolicy: campaignImagesPolicy,
                      assigneeIds: campaignAssigneeIds,
                    })
                  }
                >
                  إنشاء وتفعيل
                </Button>
              </div>
            </div>

            {selectedCampaign && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
                  {/* الحالة تُعرَض من القاموس الموحَّد لا خاماً — قبلَ كان يظهر «ACTIVE»
                      باللاتينية للمدير العربيّ، ومع إضافة PAUSED صار تعريفُ ٥ حالات
                      داخل شاشة الاستوديو مرشَّحاً للانحراف. الشارة تحمل اللون الدلاليّ. */}
                  <span className="text-sm font-medium">الحالة:</span>
                  <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[selectedCampaign.status as StudioCampaignStatus] ?? "neutral"}>
                    {STUDIO_CAMPAIGN_STATUS_AR[selectedCampaign.status as StudioCampaignStatus] ?? selectedCampaign.status}
                  </Badge>
                  {selectedCampaign.status === "DRAFT" && (
                    <Button
                      className="min-h-11"
                      disabled={offline || transitionCampaign.isPending}
                      onClick={() => transitionCampaign.mutate({
                        campaignId: Number(selectedCampaign.id),
                        status: "ACTIVE",
                        startsAt: campaignStartAt ? new Date(campaignStartAt) : null,
                        dueAt: campaignDueAt ? new Date(campaignDueAt) : selectedCampaign.dueAt,
                      })}
                    >
                      <PlayCircle aria-hidden className="size-4" /> تفعيل الحملة
                    </Button>
                  )}
                  {/* إيقافٌ مؤقّت (٢٨/٨، قرار المالك) — الحملة تختفي من مسار المصوّر لكنّ
                      المهام المُسنَدة سلفاً تبقى قابلةً للإتمام. الاستئناف زرٌّ واحد. */}
                  {selectedCampaign.status === "ACTIVE" && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={offline || transitionCampaign.isPending}
                      onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "PAUSED" })}
                      title="تجميد ذكيّ: تختفي عن مسار المصوّر لكن المهام المُسنَدة تبقى قابلةً للإتمام"
                    >
                      <PauseCircle aria-hidden className="size-4" /> إيقاف مؤقّت
                    </Button>
                  )}
                  {selectedCampaign.status === "PAUSED" && (
                    <Button
                      className="min-h-11"
                      disabled={offline || transitionCampaign.isPending}
                      onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "ACTIVE" })}
                    >
                      <PlayCircle aria-hidden className="size-4" /> استئناف الحملة
                    </Button>
                  )}
                  {(selectedCampaign.status === "ACTIVE" || selectedCampaign.status === "PAUSED") && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={offline || transitionCampaign.isPending}
                      onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "COMPLETED" })}
                    >
                      <CheckCircle2 aria-hidden className="size-4" /> إكمال الحملة
                    </Button>
                  )}
                  {(selectedCampaign.status === "DRAFT" || selectedCampaign.status === "ACTIVE" || selectedCampaign.status === "PAUSED") && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={offline || transitionCampaign.isPending || backlogCancelReason.trim().length < 5}
                      title={backlogCancelReason.trim().length < 5 ? "اكتب سبب الإلغاء في الحقل أدناه أولاً" : undefined}
                      onClick={() => transitionCampaign.mutate({ campaignId: Number(selectedCampaign.id), status: "CANCELLED", reason: backlogCancelReason })}
                    >
                      <XCircle aria-hidden className="size-4" /> إلغاء الحملة ومهام طابورها
                    </Button>
                  )}
                  {/* تعديلُ بيانات الحملة الجارية: اسم، عدد صور مطلوبة، مواعيد. مسموحٌ على
                      DRAFT وACTIVE فقط — المُغلقة (COMPLETED/CANCELLED) لا تُعدَّل. رفعُ عدد
                      الصور يُعيد منتجاتٍ كانت مكتملةً إلى الطابور — سلوكٌ مطلوب حين يكتشف
                      المدير أنّ منتجاتٍ تحتاج أكثر من صورة بعد بدء العمل. */}
                  {STUDIO_CAMPAIGN_EDITABLE.has(selectedCampaign.status as StudioCampaignStatus) && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        setEditCampaignName(selectedCampaign.name);
                        setEditCampaignRequired(String(selectedCampaign.requiredImages ?? 1));
                        setEditCampaignStartsAt(studioDatetimeLocal(selectedCampaign.startsAt));
                        setEditCampaignDueAt(studioDatetimeLocal(selectedCampaign.dueAt));
                        setCampaignEditOpen((open) => !open);
                      }}
                    >
                      {campaignEditOpen ? "إخفاء التعديل" : "تعديل بيانات الحملة"}
                    </Button>
                  )}
                </div>
                {campaignEditOpen && STUDIO_CAMPAIGN_EDITABLE.has(selectedCampaign.status as StudioCampaignStatus) && (
                  <div className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-edit-campaign-name">اسم الحملة</Label>
                      <Input id="studio-edit-campaign-name" value={editCampaignName} onChange={(event) => setEditCampaignName(event.target.value)} maxLength={180} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-edit-campaign-required">عدد الصور المطلوبة لكل منتج</Label>
                      <Input id="studio-edit-campaign-required" type="number" min={1} max={10} value={editCampaignRequired} onChange={(event) => setEditCampaignRequired(event.target.value)} />
                      <p className="text-xs text-muted-foreground">
                        رفعُه يُعيد منتجاتٍ اعتُمدت صورةٌ واحدةٌ فقط إلى الطابور — استعمله حين تكتشف الحاجة لأكثر من صورة بعد بدء العمل. تخفيضُه يُغلق مهامّاً كانت تنقص المنتج الذي بلغ العدد الجديد.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-edit-campaign-start">بدء الحملة</Label>
                      <Input id="studio-edit-campaign-start" type="datetime-local" value={editCampaignStartsAt} onChange={(event) => setEditCampaignStartsAt(event.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="studio-edit-campaign-due">موعد الإنجاز</Label>
                      <Input id="studio-edit-campaign-due" type="datetime-local" value={editCampaignDueAt} onChange={(event) => setEditCampaignDueAt(event.target.value)} />
                    </div>
                    <div className="md:col-span-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={offline || updateCampaignDetails.isPending || editCampaignName.trim().length < 3}
                        onClick={() => {
                          // نبني الحمولة الفارقيّة فقط — الحقول غير المتغيّرة تُترك.
                          const payload: {
                            campaignId: number;
                            name?: string;
                            requiredImages?: number;
                            startsAt?: Date | null;
                            dueAt?: Date | null;
                          } = { campaignId: Number(selectedCampaign.id) };
                          const nameTrimmed = editCampaignName.trim();
                          if (nameTrimmed !== selectedCampaign.name) payload.name = nameTrimmed;
                          const required = Number(editCampaignRequired);
                          if (Number.isFinite(required) && required !== Number(selectedCampaign.requiredImages ?? 1)) payload.requiredImages = required;
                          const nextStartsAt = editCampaignStartsAt ? new Date(editCampaignStartsAt) : null;
                          if (studioDatetimeLocal(nextStartsAt) !== studioDatetimeLocal(selectedCampaign.startsAt)) payload.startsAt = nextStartsAt;
                          const nextDueAt = editCampaignDueAt ? new Date(editCampaignDueAt) : null;
                          if (studioDatetimeLocal(nextDueAt) !== studioDatetimeLocal(selectedCampaign.dueAt)) payload.dueAt = nextDueAt;
                          if (Object.keys(payload).length === 1) {
                            notify.err("لا حقلَ للتعديل");
                            return;
                          }
                          updateCampaignDetails.mutate(payload);
                        }}
                      >
                        احفظ التعديلات
                      </Button>
                      <Button type="button" variant="ghost" className="min-h-11" onClick={() => setCampaignEditOpen(false)}>
                        إلغاء
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="studio-campaign-filter">الحملة المعروضة</Label>
                <AppSelect id="studio-campaign-filter" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={selectedCampaignId == null ? "ALL" : String(selectedCampaignId)} onValueChange={(value) => setSelectedCampaignId(value === "ALL" ? null : Number(value))}>
                  <option value="ALL">كل المهام دون حملة محددة</option>
                  {(campaigns.data ?? []).map((campaign) => (
                    <option key={Number(campaign.id)} value={Number(campaign.id)}>
                      {campaign.name} · {STUDIO_CAMPAIGN_STATUS_AR[campaign.status as StudioCampaignStatus] ?? campaign.status}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="flex items-end">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!selectedCampaignId || createCampaignBacklog.isPending || offline}
                  onClick={() =>
                    selectedCampaignId &&
                    createCampaignBacklog.mutate({
                      campaignId: selectedCampaignId,
                    })
                  }
                >
                  {/* الصفر الصريح كان يُطبَع أيضاً حين لا تُنفَّذ المعاينة أصلاً (بلا حملة مختارة)
                      أو حين تفشل — فيقرأ المدير «لا ناقص» بينما الطابور مليء. */}
                  توليد مهام الناقصة {backlogButtonSuffix({ campaignSelected: Boolean(selectedCampaignId), isError: campaignPreview.isError, isPending: campaignPreview.isPending, count: campaignPreview.data?.count, batchLimit: campaignPreview.data?.batchLimit })}
                </Button>
              </div>
              <div className="flex items-end">
                <Button variant="outline" className="min-h-11" disabled={offline || sendDueNotifications.isPending} onClick={() => sendDueNotifications.mutate({ horizonHours: 24 })}>
                  <Bell aria-hidden className="size-4" /> تنبيه المواعيد
                </Button>
              </div>
            </div>

            {/* التراجع عن توليدٍ خاطئ. النطاق مُضيَّق خادمياً: غير المسنَدة فقط — عملٌ بدأه
                موظف لا يُمحى بضغطةٍ جماعية، بل يُلغى فرداً فرداً من بطاقة المهمة. */}
            {selectedCampaignId && (
              <div className="space-y-2 rounded-md border p-3">
                <Label htmlFor="studio-backlog-cancel-reason">سبب الإلغاء — يلزم لإلغاء الحملة أو طابورها</Label>
                <p className="text-xs text-muted-foreground">للتراجع عن توليدٍ خاطئ. الإلغاء — سواء للحملة أو للطابور وحده — لا يمسّ مهمةً أُسنِدت أو بدأ العمل عليها، ويحرّر منتجاتها لمهام جديدة. تُلغى ٥٠٠ مهمة في كل ضغطة.</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-52 flex-1">
                    <Input id="studio-backlog-cancel-reason" value={backlogCancelReason} onChange={(event) => setBacklogCancelReason(event.target.value)} placeholder="سبب الإلغاء (٥ أحرف على الأقل)" maxLength={500} />
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    className="min-h-11"
                    disabled={offline || cancelCampaignBacklog.isPending || backlogCancelReason.trim().length < 5}
                    onClick={() =>
                      selectedCampaignId &&
                      cancelCampaignBacklog.mutate({
                        campaignId: selectedCampaignId,
                        reason: backlogCancelReason,
                      })
                    }
                  >
                    <XCircle aria-hidden className="size-4" /> إلغاء الطابور
                  </Button>
                </div>
              </div>
            )}

            {/* طابور الإنجاز والمتبقّي — و«المتبقّي» بمعانيه لا رقماً واحداً يُخفي أين يقف العمل. */}
            {selectedCampaignId && campaignBoard.data && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">طابور الحملة</span>
                  <span className="text-xs text-muted-foreground">التوجيه: {campaignBoard.data.requiredImages} صورة لكل منتج</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border bg-[var(--sem-pos-bg,transparent)] p-2">
                    <div className="text-xs text-muted-foreground">منتجات اكتملت صورها</div>
                    <div className="mt-0.5 text-lg font-bold">
                      {campaignBoard.data.done}
                      <span className="text-xs font-normal text-muted-foreground"> / {campaignBoard.data.totalProducts}</span>
                    </div>
                  </div>
                  <div className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">منتجات متبقّية</div>
                    <div className="mt-0.5 text-lg font-bold">{campaignBoard.data.remaining}</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">المهام الجارية (وحدةُ مهمّة لا منتج)</div>
                <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
                  {(
                    [
                      ["لم تُولَّد بعد", campaignBoard.data.breakdown.notGenerated],
                      ["في الطابور", campaignBoard.data.breakdown.queued],
                      ["قيد التصوير", campaignBoard.data.breakdown.inProgress],
                      ["تنتظر اعتمادك", campaignBoard.data.breakdown.awaitingReview],
                      ["تحتاج تصحيحاً", campaignBoard.data.breakdown.needsFix],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-md border p-2">
                      <div className="text-muted-foreground">{label}</div>
                      <div className="mt-0.5 font-bold">{value}</div>
                    </div>
                  ))}
                </div>
                {/* إضافة/إزالة مصوّرين على حملةٍ **قائمة** — قبل هذا كان الوحيد هو
                    إعادة إنشاء الحملة أو استعمالُ حساب مصوّرٍ مؤقّت لموظفٍ حقيقيّ. */}
                <div className="space-y-2 rounded-md border p-3">
                  <Label>تعديل مصوّري الحملة</Label>
                  <p className="text-xs text-muted-foreground">اختر القائمة النهائية: من كان محدَّداً ويُلغى اختياره يخرج، ومن يُضاف يدخل. لا يمسّ الحسابات المؤقّتة (لها زرّ إغلاقٍ خاصّ أدناه).</p>
                  <CampaignAssigneeEditor
                    campaignBoard={campaignBoard.data}
                    assignees={assignees.data ?? []}
                    disabled={offline || updateCampaignAssignees.isPending}
                    onSave={(assigneeIds) => selectedCampaignId && updateCampaignAssignees.mutate({ campaignId: selectedCampaignId, assigneeIds })}
                    onGrant={(userId) => grantStudioAccess.mutate({ userId })}
                    grantPending={grantStudioAccess.isPending}
                  />
                </div>
                {/* مصوّرٌ مؤقّت: حسابٌ بصلاحية استوديو فقط ينتهي بانتهاء الحملة. */}
                <div className="space-y-2 rounded-md border p-3">
                  <Label htmlFor="studio-temp-photographer">مصوّر مؤقّت (بلا حساب دائم)</Label>
                  <p className="text-xs text-muted-foreground">حسابٌ بصلاحية استوديو المنتجات وحدها، ينتهي وصوله تلقائياً بموعد الحملة. الرمز يُعرَض مرّةً واحدة فقط.</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-48 flex-1">
                      <Input id="studio-temp-photographer" value={tempPhotographerName} onChange={(event) => setTempPhotographerName(event.target.value)} placeholder="اسم المصوّر" maxLength={80} />
                    </div>
                    <Button
                      type="button"
                      className="min-h-11"
                      disabled={offline || createTemporaryPhotographer.isPending || tempPhotographerName.trim().length < 3}
                      onClick={() => selectedCampaignId && createTemporaryPhotographer.mutate({ campaignId: selectedCampaignId, name: tempPhotographerName })}
                    >
                      <UserCheck aria-hidden className="size-4" /> إنشاء وصول مؤقّت
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={offline || revokeTemporaryPhotographers.isPending}
                      onClick={() => selectedCampaignId && revokeTemporaryPhotographers.mutate({ campaignId: selectedCampaignId })}
                    >
                      إغلاق الوصول المؤقّت
                    </Button>
                  </div>
                  {issuedAccess && (
                    <div role="alert" className="space-y-1 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm">
                      <p className="font-medium">سلّم هذه البيانات لـ«{issuedAccess.name}» الآن — لن تظهر مرّةً أخرى.</p>
                      <p>
                        اسم الدخول: <span className="font-mono">{issuedAccess.username}</span>
                      </p>
                      <p>
                        الرمز: <span className="font-mono text-base">{issuedAccess.code}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">ينتهي: {new Date(issuedAccess.expiresAt).toLocaleString("ar-IQ-u-nu-latn")}</p>
                      <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setIssuedAccess(null)}>
                        سلّمتُه — أخفِ الرمز
                      </Button>
                    </div>
                  )}
                </div>
                {campaignBoard.data.photographers.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">المصوّرون</div>
                    {campaignBoard.data.photographers.map((person) => (
                      <div key={person.userId} className="flex items-center justify-between rounded-md border p-2 text-sm">
                        <span>{person.name}</span>
                        <span className="text-xs text-muted-foreground">
                          أنجز {person.done} · بيده {person.active}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedCampaignId && campaignAnalytics.data && (
              <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="مؤشرات الحملة">
                {[
                  ["الإجمالي", campaignAnalytics.data.total],
                  ["الإنجاز", `${campaignAnalytics.data.completionPercent}%`],
                  ["اعتماد أول مرة", campaignAnalytics.data.firstPassApprovalRate == null ? "—" : `${campaignAnalytics.data.firstPassApprovalRate}%`],
                  ["وسيط الدورة", campaignAnalytics.data.medianCycleMinutes == null ? "—" : `${campaignAnalytics.data.medianCycleMinutes} د`],
                  ["مرفوضة", campaignAnalytics.data.rejected],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="mt-0.5 text-base font-bold">{value}</div>
                  </div>
                ))}
              </div>
              {campaignAnalytics.data.rejectionReasons.length > 0 && (
                <div className="rounded-md border p-3">
                  <div className="text-sm font-medium">أسباب الرفض</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {campaignAnalytics.data.rejectionReasons.map((item) => (
                      <Badge key={item.reason} variant="warning">{item.reason} · {item.count}</Badge>
                    ))}
                  </div>
                </div>
              )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {dashboard.data?.canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">إسناد مهمة جديدة</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-1.5">
              <Label htmlFor="studio-product-search">ابحث عن المنتج</Label>
              <StudioProductPicker
                canManage={dashboard.data?.canManage === true}
                value={Number(productId) || null}
                onPick={(product) => {
                  setProductId(String(product.productId));
                  setBulkProductIds((current) => (current.includes(product.productId) ? current : [...current, product.productId]));
                  setSourceChoice("new");
                }}
              />
              {bulkProductIds.length > 0 && (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{bulkProductIds.length} منتج محدد</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11"
                    onClick={() => {
                      setBulkProductIds([]);
                      setProductId("");
                    }}
                  >
                    مسح التحديد
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-source-image">نوع المهمة</Label>
              <AppSelect id="studio-source-image" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={sourceChoice} onValueChange={setSourceChoice} disabled={!productId || bulkProductIds.length > 1}>
                <option value="new">إضافة صورة جديدة</option>
                {(productImages.data ?? []).map((image, index) => (
                  <option key={Number(image.id)} value={String(image.id)}>
                    {image.isPrimary ? "استبدال الصورة الرئيسية" : `استبدال الصورة ${index + 1}`}
                  </option>
                ))}
              </AppSelect>
              <p className="text-xs text-muted-foreground">الاستبدال يلتقط النسخة المنشورة خادمياً قبل بدء العمل.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-assignee">الموظف المصرح</Label>
              <AppSelect id="studio-assignee" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assigneeId} onValueChange={setAssigneeId} disabled={assignees.isError}>
                <option value="">اختر الموظف</option>
                {(assignees.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </AppSelect>
              <p className="text-xs text-muted-foreground">لكل منتج مهمة نشطة واحدة ومالك واحد؛ وزّع منتجات مختلفة على أكثر من موظف.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-priority">الأولوية</Label>
              <AppSelect id="studio-priority" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assignmentPriority} onValueChange={(value) => setAssignmentPriority(value as typeof assignmentPriority)}>
                <option value="LOW">منخفضة</option>
                <option value="NORMAL">عادية</option>
                <option value="HIGH">عالية</option>
                <option value="URGENT">عاجلة</option>
              </AppSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-due-at">موعد الإنجاز</Label>
              <Input id="studio-due-at" type="datetime-local" value={assignmentDueAt} onChange={(event) => setAssignmentDueAt(event.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={offline || storageActionsDisabled || !productId || !assigneeId || assign.isPending || bulkAssign.isPending}
                onClick={() => {
                  const dueAt = assignmentDueAt ? new Date(assignmentDueAt) : null;
                  if (bulkProductIds.length > 1) {
                    bulkAssign.mutate({
                      productIds: bulkProductIds,
                      assigneeId: Number(assigneeId),
                      priority: assignmentPriority,
                      dueAt,
                    });
                    return;
                  }
                  assign.mutate({
                    productId: Number(productId),
                    assigneeId: Number(assigneeId),
                    sourceImageId: sourceChoice === "new" ? null : Number(sourceChoice),
                    priority: assignmentPriority,
                    dueAt,
                  });
                }}
              >
                <UserCheck aria-hidden className="size-4" /> {assign.isPending || bulkAssign.isPending ? "جارٍ الإسناد" : bulkProductIds.length > 1 ? `إسناد ${bulkProductIds.length} مهام` : "إسناد المهمة"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs
        value={scope}
        onValueChange={(value) => {
          const next = value as Scope;
          setScope(next);
          // ٢٩/٨: نحفظ التبويب المُختار كي يعود المستخدم إليه في الجلسة التالية.
          persistStudioScope(next);
          setSelectedId(null);
          setOfflineSelectedDraft(null);
          // العرض المحفوظ يخصّ مساره؛ إبقاؤه مطبَّقاً على مسارٍ جديد يُخفي صفوفاً
          // بلا دليلٍ سوى إبراز زرٍّ في الأعلى.
          setSavedView("ALL");
          setOverdueOnly(false);
          setSelectedTaskIds(new Set());
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
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-wrap gap-2" aria-label="العروض المحفوظة">
            {/* «صور ناقصة» عرضٌ إداريّ صرف — يحتاج منتقي حملة يظهر للمدير فقط.
                إبقاؤه للمصوّر كان يقود إلى زرٍّ يُظهر خطأً «اختر حملة أولاً»
                بينما المنتقي غير مرئيّ له أصلاً. */}
            {(
              [
                ["ALL", "الكل"],
                ["UNASSIGNED", "غير المسندة"],
                ["OVERDUE", "المتأخرة"],
                ["PENDING_REVIEW", "بانتظار المراجعة"],
                ["MISSING_IMAGE", "صور ناقصة"],
              ] as const
            )
              .filter(([value]) => value !== "MISSING_IMAGE" || dashboard.data?.canManage === true)
              .map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={savedView === value ? "default" : "outline"}
                className="min-h-11"
                onClick={() => {
                  setSavedView(value);
                  if (value === "UNASSIGNED" || value === "OVERDUE") setScope("QUEUE");
                  if (value === "PENDING_REVIEW") setScope("REVIEW");
                  if (value === "MISSING_IMAGE" && !selectedCampaignId) {
                    notify.err("اختر حملة أولاً لعرض عدد المنتجات الناقصة وتوليد مهامها");
                  }
                  setSelectedId(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {dashboard.data?.canManage && (
            <div className="min-w-40 space-y-1">
              <Label htmlFor="studio-assignee-filter">الموظف</Label>
              {/* الخادم يدعم الترشيح بالمنفّذ منذ البداية بلا مدخلٍ في الشاشة،
                  فتعذّر على المدير أن يسأل «ماذا على طاولة عليّ؟». */}
              <AppSelect id="studio-assignee-filter" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assigneeFilter} onValueChange={setAssigneeFilter} disabled={assignees.isError}>
                <option value="ALL">كل الموظفين</option>
                {(assignees.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </AppSelect>
            </div>
          )}
          {/* البحث بالاسم: المخرج الوحيد العمليّ من طابورٍ بآلاف الصفوف. */}
          <div className="min-w-52 flex-1 space-y-1">
            <Label htmlFor="studio-task-search">بحث باسم المنتج</Label>
            <Input id="studio-task-search" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="اكتب جزءاً من اسم المنتج" maxLength={80} />
          </div>
          <div className="min-w-40 space-y-1">
            <Label htmlFor="studio-task-priority-filter">تصفية الأولوية</Label>
            <AppSelect id="studio-task-priority-filter" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={taskPriorityFilter} onValueChange={(value) => setTaskPriorityFilter(value as typeof taskPriorityFilter)}>
              <option value="ALL">كل الأولويات</option>
              <option value="URGENT">عاجلة</option>
              <option value="HIGH">عالية</option>
              <option value="NORMAL">عادية</option>
              <option value="LOW">منخفضة</option>
            </AppSelect>
          </div>
          <Button type="button" variant={overdueOnly ? "default" : "outline"} className="min-h-11" disabled={savedView === "OVERDUE"} onClick={() => setOverdueOnly((current) => !current)}>
            <AlertTriangle aria-hidden className="size-4" />
            المتأخرة فقط
          </Button>
          {/* ٢٩/٨ (بلاغ مالك): مهام الحملات المغلقة تُخفى افتراضياً من العرض العامّ.
              يُعطّل الزرّ إن كانت الحملةُ محدَّدةً صراحةً — الطلبُ الصريح يعلو على الإخفاء. */}
          <Button
            type="button"
            variant={hideClosedCampaigns ? "default" : "outline"}
            className="min-h-11"
            disabled={selectedCampaignId != null}
            onClick={() => setHideClosedCampaigns((v) => !v)}
            title={selectedCampaignId != null ? "الفلتر معطَّل — اخترتَ حملةً محدَّدة أعلاه" : "أخفِ مهامَّ الحملات المغلقة أو الملغاة من العرض العامّ"}
          >
            {hideClosedCampaigns ? "إخفاء الحملات المغلقة (مفعَّل)" : "إظهار كل الحملات"}
          </Button>
        </div>
        {savedView === "MISSING_IMAGE" && <div className="mt-3 rounded-md border p-3 text-sm">{selectedCampaignId ? `المنتجات النشطة بلا صورة معتمدة ولا مهمة نشطة: ${campaignPreview.data?.count ?? 0}` : "اختر حملة من لوحة الحملات لتحديد الفرع ثم عاين المنتجات الناقصة."}</div>}
        {(["QUEUE", "MINE", "REVIEW", "HISTORY"] as Scope[]).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            <div className="min-w-0 grid gap-4 lg:grid-cols-[minmax(260px,360px)_1fr]">
              <Card className={mobilePanel === "DETAIL" ? "hidden lg:block" : undefined}>
                <CardHeader>
                  <CardTitle className="text-base">المهام</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {canBulkAssign && (queuedTaskIds.length > 0 || selectedTaskIds.size > 0) && (
                    <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        {queuedTaskIds.length > 0 ? (
                          <button type="button" className="min-h-11 underline underline-offset-2" onClick={toggleSelectAllQueued}>
                            {allQueuedSelected ? "إلغاء تحديد الكل" : `تحديد كل المعروض في الطابور (${queuedTaskIds.length})`}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">حدّد المهام يدوياً بمربّعات الاختيار</span>
                        )}
                        <span className="text-muted-foreground">{selectedTaskIds.size} محدَّدة</span>
                      </div>
                      {/* إسنادُ غير المسنَد إلى موظّف. */}
                      {selectedTaskIds.size > 0 && queuedTaskIds.some((id) => selectedTaskIds.has(id)) && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-40 flex-1">
                            <AppSelect id="studio-bulk-assignee" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkAssigneeId} onValueChange={setBulkAssigneeId} disabled={assignees.isError}>
                              <option value="">اختر الموظف</option>
                              {(assignees.data ?? []).map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.name}
                                </option>
                              ))}
                            </AppSelect>
                          </div>
                          <Button
                            type="button"
                            className="min-h-11"
                            disabled={offline || bulkReassign.isPending || !bulkAssigneeId}
                            onClick={() => {
                              // نُصفّي التحديد إلى الطابور فقط — بقيّةُ التحديد تخدم الأزرار الأخرى.
                              const queuedSelected = queuedTaskIds.filter((id) => selectedTaskIds.has(id)).slice(0, BULK_ASSIGN_MAX);
                              bulkReassign.mutate({ taskIds: queuedSelected, newAssigneeId: Number(bulkAssigneeId) });
                            }}
                          >
                            <UserCheck aria-hidden className="size-4" /> إسناد {queuedTaskIds.filter((id) => selectedTaskIds.has(id)).length} من الطابور
                          </Button>
                          {queuedTaskIds.filter((id) => selectedTaskIds.has(id)).length > BULK_ASSIGN_MAX && <p className="w-full text-xs text-[var(--sem-warn)]">يُسنَد {BULK_ASSIGN_MAX} في المرّة؛ كرّر للباقي.</p>}
                        </div>
                      )}
                      {/* إعادةُ إسنادٍ جماعيّة — تعمل على المسنَد فقط، بمصوّرٍ محدَّد أو الطابور المفتوح. */}
                      {selectedAssignedTaskIds.length > 0 && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-40 flex-1">
                            <AppSelect id="studio-bulk-reassign" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkReassignAssigneeId} onValueChange={setBulkReassignAssigneeId} disabled={assignees.isError}>
                              <option value="">إلى الطابور المفتوح (blind pool)</option>
                              {(assignees.data ?? [])
                                .filter((user) => user.canStudio)
                                .map((user) => (
                                  <option key={user.id} value={user.id}>
                                    {user.name}
                                  </option>
                                ))}
                            </AppSelect>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={offline || bulkReassign.isPending}
                            onClick={() =>
                              bulkReassign.mutate({
                                taskIds: selectedAssignedTaskIds.slice(0, BULK_ASSIGN_MAX),
                                newAssigneeId: bulkReassignAssigneeId ? Number(bulkReassignAssigneeId) : null,
                              })
                            }
                          >
                            <UserCheck aria-hidden className="size-4" /> إعادة إسناد {selectedAssignedTaskIds.length} مُسنَدة
                          </Button>
                        </div>
                      )}
                      {/* ضبطُ أولويّةٍ جماعيّ — يعمل على أيّ نشط (طابور أو مُسنَد أو مراجَع). */}
                      {selectedActiveTaskIds.length > 0 && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-32">
                            <AppSelect id="studio-bulk-priority" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkPriorityValue} onValueChange={(value) => setBulkPriorityValue(value as typeof bulkPriorityValue)}>
                              <option value="LOW">منخفضة</option>
                              <option value="NORMAL">عادية</option>
                              <option value="HIGH">عالية</option>
                              <option value="URGENT">عاجلة</option>
                            </AppSelect>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={offline || bulkSetPriority.isPending}
                            onClick={() =>
                              bulkSetPriority.mutate({
                                taskIds: selectedActiveTaskIds.slice(0, BULK_ASSIGN_MAX),
                                priority: bulkPriorityValue,
                              })
                            }
                          >
                            ضبط أولوية {selectedActiveTaskIds.length} مهمّة
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {tasks.isLoading && (
                    <div className="py-8 text-center">
                      <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />
                    </div>
                  )}
                  {/* «لا مهام» و«تعذّر الجلب» ليسا الشيء نفسه: الأولى تُطمئن والثانية تُنذر. */}
                  {tasks.isError && (
                    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      <p className="font-medium">تعذّر جلب المهام — هذه ليست قائمة فارغة.</p>
                      <Button variant="outline" size="sm" onClick={() => void tasks.refetch()}>
                        إعادة المحاولة
                      </Button>
                    </div>
                  )}
                  {/* حالةٌ فارغة تشرح السبب والخطوة التالية بحسب التبويب — بدل نصٍّ عامّ صامت. */}
                  {!tasks.isLoading && !tasks.isError && taskItems.length === 0 && (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      <p>{STUDIO_EMPTY_HINTS[tab]}</p>
                    </div>
                  )}
                  {taskItems.map((task) => (
                    <div key={Number(task.id)} className="flex items-start gap-2">
                      {/* التحديد المتعدّد: يظهر على أيّ مهمّةٍ نشطة (في الطابور · قيد العمل ·
                          تنتظر مراجعةً · مرفوضة) للسماح بثلاث عمليّات جماعيّة: إسناد لغير المسنَد،
                          إعادة إسناد للمسنَد، وضبط أولوية أيّ نشط. الشريط يفرز التحديد بحسب نوع
                          العمل الممكن ويعرض العدد لكلّ زرّ. */}
                      {canBulkAssign && ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(task.status) && (
                        <input
                          type="checkbox"
                          className="mt-4 size-4 shrink-0"
                          aria-label={`تحديد ${task.productName}`}
                          checked={selectedTaskIds.has(Number(task.id))}
                          onChange={() => toggleTaskSelection(Number(task.id))}
                        />
                      )}
                    <button type="button" onClick={() => selectTask(task)} className={`min-h-11 w-full rounded-md border p-3 text-start transition-colors hover:bg-muted/50 active:bg-muted ${selectedId === Number(task.id) ? "border-primary bg-muted/40" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        {/* اسمُ المهمّة يجمع المنتج والبديل (إن وُجد) — بدونه بطاقتا بديلَين
                            من المنتج نفسه تظهران باسمٍ متطابق فيرفع المصوّرُ صورةً للبديل الخطأ. */}
                        <span className="text-sm font-medium">
                          {task.productName}
                          {task.variantName ? <span className="text-muted-foreground"> — {task.variantName}</span> : null}
                        </span>
                        {/* ASSIGNED بلا منفّذ = «في الطابور»، لا «مسندة». الوسم القديم كان يناقض
                            السطر التالي مباشرةً («المسؤول: غير مسند»). */}
                        <Badge variant={isQueuedStudioTask(task) ? "warning" : STATUS_VARIANT[task.status]}>{isQueuedStudioTask(task) ? "في الطابور" : STATUS_LABEL[task.status]}</Badge>
                        {/* ٢٩/٨: حالةُ الحملة تُبرز على البطاقة كي يفهم المدير أنّ المهمّة
                            «يتيمةٌ» من حملةٍ نهائيّة/موقوفة. المهام بلا حملة (`campaignId`
                            null على الخادم) لا تُبرز شيئاً. القاموس والألوان من المصدر
                            المشترك — تجنّبٌ لتعريفٍ محلّيٍّ يُبعده الحرّاس عن الاتّساق. */}
                        {task.campaignStatus && (task.campaignStatus === "PAUSED" || task.campaignStatus === "COMPLETED" || task.campaignStatus === "CANCELLED") && (
                          <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[task.campaignStatus]} className="text-[10px]">
                            حملة {STUDIO_CAMPAIGN_STATUS_AR[task.campaignStatus]}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">المسؤول: {task.assigneeName ?? "غير مسند"}</div>
                      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                        <span>الأولوية: {task.priority === "URGENT" ? "عاجلة" : task.priority === "HIGH" ? "عالية" : task.priority === "LOW" ? "منخفضة" : "عادية"}</span>
                        {task.dueAt && <span>الموعد: {new Date(task.dueAt).toLocaleString("ar-IQ-u-nu-latn")}</span>}
                        {task.overdue && <Badge variant="danger">متأخرة</Badge>}
                      </div>
                      {task.rejectionReason && <div className="mt-2 text-xs text-destructive">سبب الإعادة: {task.rejectionReason}</div>}
                    </button>
                    </div>
                  ))}
                  {tasks.hasNextPage && (
                    <Button type="button" variant="outline" className="min-h-11 w-full" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
                      {tasks.isFetchingNextPage ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Plus aria-hidden className="size-4" />}
                      تحميل المزيد
                    </Button>
                  )}
                </CardContent>
              </Card>

              {!selected ? (
                <Card className="hidden lg:block">
                  <CardContent className="py-16 text-center text-sm text-muted-foreground">اختر مهمة لعرض مسارها.</CardContent>
                </Card>
              ) : (
                <div id="studio-workspace-section" className="space-y-4">
                  <Card>
                    <CardHeader>
                      <Button type="button" variant="ghost" className="-mr-2 min-h-11 self-start lg:hidden" onClick={() => setSelectedId(null)}>
                        <ChevronRight aria-hidden className="size-4" /> عودة إلى المهام
                      </Button>
                      <CardTitle className="flex items-center justify-between gap-2 text-base">
                        <span>
                          {selected.productName}
                          {selected.variantName ? <span className="text-muted-foreground"> — {selected.variantName}</span> : null}
                        </span>
                        <Badge variant={STATUS_VARIANT[selected.status]}>{STATUS_LABEL[selected.status]}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* إسنادٌ من موضع المهمة نفسها. كان على المدير أن يعود لأعلى الصفحة
                          ويبحث عن المنتج بالاسم في المنتقي — فيبقى طابور الحملة بلا مخرج عمليّ. */}
                      {dashboard.data?.canManage && selected.status === "ASSIGNED" && selected.assigneeName == null && (
                        <div className="grid gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 sm:grid-cols-[1fr_auto]">
                          <div className="space-y-1">
                            <Label htmlFor="studio-inline-assignee">إسناد هذه المهمة إلى موظف</Label>
                            <AppSelect id="studio-inline-assignee" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={inlineAssigneeId} onValueChange={setInlineAssigneeId} disabled={assignees.isError}>
                              <option value="">اختر الموظف</option>
                              {(assignees.data ?? []).map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.name}
                                </option>
                              ))}
                            </AppSelect>
                            {assignees.isError && <p className="text-xs text-destructive">تعذّر جلب قائمة الموظفين — أعد المحاولة قبل الإسناد.</p>}
                          </div>
                          <Button
                            type="button"
                            className="min-h-11 self-end"
                            disabled={offline || assign.isPending || !inlineAssigneeId}
                            onClick={() =>
                              assign.mutate({
                                productId: Number(selected.productId),
                                assigneeId: Number(inlineAssigneeId),
                                priority: selectedPriority,
                                dueAt: selectedDueAt ? new Date(selectedDueAt) : null,
                              })
                            }
                          >
                            <UserCheck aria-hidden className="size-4" /> إسناد
                          </Button>
                        </div>
                      )}
                      {dashboard.data?.canManage && ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(selected.status) && (
                        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
                          <div className="space-y-1">
                            <Label htmlFor="studio-selected-priority">أولوية المهمة</Label>
                            <AppSelect id="studio-selected-priority" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedPriority} onValueChange={(value) => setSelectedPriority(value as typeof selectedPriority)}>
                              <option value="LOW">منخفضة</option>
                              <option value="NORMAL">عادية</option>
                              <option value="HIGH">عالية</option>
                              <option value="URGENT">عاجلة</option>
                            </AppSelect>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="studio-selected-due-at">موعد الإنجاز</Label>
                            <Input id="studio-selected-due-at" type="datetime-local" value={selectedDueAt} onChange={(event) => setSelectedDueAt(event.target.value)} />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 self-end"
                            disabled={offline || updateSchedule.isPending}
                            onClick={() =>
                              updateSchedule.mutate({
                                taskId: Number(selected.id),
                                expectedRevision: selected.revision,
                                priority: selectedPriority,
                                dueAt: selectedDueAt ? new Date(selectedDueAt) : null,
                              })
                            }
                          >
                            حفظ الأولوية والموعد
                          </Button>
                        </div>
                      )}
                      {/* إعادةُ الإسناد — مسارٌ حين يغيب المصوّر أو يعجز عن الإكمال، بدل
                          إلغاء المهمّة وفقدان سبب الرفض وأثر التدقيق. للطابور المفتوح شرط:
                          المهمّةُ ضمن حملة (المسح الأعمى يقصر على تلك — راجع تعليق `claimByBarcode`). */}
                      {dashboard.data?.canManage && ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(selected.status) && selected.assigneeName != null && (
                        <div className="space-y-2 rounded-md border p-3">
                          <Label htmlFor="studio-reassign-select">إعادة إسناد المهمّة (المسنَد الآن: {selected.assigneeName})</Label>
                          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                            <AppSelect id="studio-reassign-select" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={reassignAssigneeId} onValueChange={setReassignAssigneeId} disabled={assignees.isError}>
                              {selected.campaignId != null ? (
                                <option value="">إلى الطابور المفتوح (blind pool)</option>
                              ) : (
                                <option value="" disabled>
                                  اختر مصوّراً — مهمّةٌ بلا حملة لا تُسحَب بالمسح
                                </option>
                              )}
                              {(assignees.data ?? [])
                                .filter((user) => user.canStudio && user.id !== Number(selected.assignedTo))
                                .map((user) => (
                                  <option key={user.id} value={user.id}>
                                    {user.name}
                                  </option>
                                ))}
                            </AppSelect>
                            <Button
                              type="button"
                              className="min-h-11"
                              disabled={offline || reassign.isPending || (selected.campaignId == null && !reassignAssigneeId)}
                              onClick={() =>
                                reassign.mutate({
                                  taskId: Number(selected.id),
                                  expectedRevision: selected.revision,
                                  newAssigneeId: reassignAssigneeId ? Number(reassignAssigneeId) : null,
                                  reason: reassignReason.trim() || undefined,
                                })
                              }
                            >
                              <UserCheck aria-hidden className="size-4" /> إعادة إسناد
                            </Button>
                          </div>
                          <Textarea rows={1} maxLength={500} value={reassignReason} onChange={(event) => setReassignReason(event.target.value)} placeholder="سبب اختياريّ يُسجَّل في التدقيق" />
                        </div>
                      )}
                      {/* الإلغاء: كان توليدُ طابورٍ خاطئ نهائياً بلا تراجع — لا إلغاء للمهمة
                          ولا حذف للطابور، فتبقى في المؤشرات وتحتجز المنتج إلى الأبد. */}
                      {dashboard.data?.canManage && CANCELLABLE_STATUSES.includes(selected.status) && (
                        <div className="space-y-2 rounded-md border p-3">
                          <Label htmlFor="studio-cancel-reason">إلغاء المهمة نهائياً</Label>
                          <p className="text-xs text-muted-foreground">تُنقل إلى السجلّ بحالة «ملغاة»، ويعود المنتج قابلاً لمهمة جديدة. السبب يُحفَظ في أثر التدقيق.</p>
                          <Textarea id="studio-cancel-reason" rows={2} maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="سبب الإلغاء (٥ أحرف على الأقل)" />
                          <Button
                            type="button"
                            variant="destructive"
                            className="min-h-11"
                            disabled={offline || cancelTask.isPending || cancelReason.trim().length < 5}
                            onClick={() =>
                              cancelTask.mutate({
                                taskId: Number(selected.id),
                                expectedRevision: selected.revision,
                                reason: cancelReason,
                              })
                            }
                          >
                            <XCircle aria-hidden className="size-4" /> إلغاء المهمة
                          </Button>
                        </div>
                      )}
                      {selected.status === "CANCELLED" && selected.cancellationReason && (
                        <div className="rounded-md border p-3 text-sm">
                          <span className="text-muted-foreground">سبب الإلغاء: </span>
                          {selected.cancellationReason}
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <Label htmlFor="studio-name">اسم العرض</Label>
                        <Input id="studio-name" value={name} onChange={(event) => setName(event.target.value)} disabled={localEditingDisabled} maxLength={255} />
                      </div>
                      {editOverrideRequired && (
                        <div className="space-y-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
                          <Label htmlFor="studio-admin-edit-override">سبب التصحيح الإداري</Label>
                          <Textarea id="studio-admin-edit-override" rows={2} maxLength={500} value={editOverrideReason} onChange={(event) => setEditOverrideReason(event.target.value)} placeholder="سبب واضح للعمل نيابة عن مالك المهمة (يسجل في التدقيق)" />
                        </div>
                      )}
                      {!editable && !editOverrideRequired && ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(selected.status) && <p className="text-sm text-muted-foreground">المهمة للعرض فقط؛ التحرير والإرسال محصوران بالموظف المسند إليه.</p>}
                    </CardContent>
                  </Card>

                  {draftConflict && (
                    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      <p>احتُفظ بالمسودة المحلية ولم تُطبّق لأن المهمة تغيّرت أو لم تعد قابلة للتحرير بعد عودة الاتصال. راجعها أو اختر نسخة الخادم للمتابعة.</p>
                      <Button type="button" size="sm" variant="outline" onClick={() => void discardConflictingDraft()}>
                        تجاهل المسودة المحلية وفتح نسخة الخادم
                      </Button>
                    </div>
                  )}

                  {editable && capabilities.canEditLocalDraft && !draftReady && !draftConflict && (
                    <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                      جار استعادة مسودة هذه المهمة. إن كانت مفتوحة في تبويب آخر فسيعاد التحقق تلقائياً قبل السماح بالتحرير.
                    </p>
                  )}

                  {editable && capabilities.canEditLocalDraft && draftReady && !draftConflict && (
                    <>
                      {taskPreviousImages.data && taskPreviousImages.data.length > 0 && (
                        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                              <History aria-hidden className="size-3.5 text-primary" />
                              صور سابقة معتمدة لهذا المنتج ({taskPreviousImages.data.length} صور — تجنّب تكرار هذه الزوايا):
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2 pt-1">
                            {taskPreviousImages.data.map((img, idx) => (
                              <div key={img.id} className="group relative size-16 overflow-hidden rounded-md border bg-card shadow-xs">
                                {img.thumbDataUrl ? (
                                  <img
                                    src={img.thumbDataUrl}
                                    alt={`صورة معتمدة ${idx + 1}`}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-muted text-[10px] text-muted-foreground">
                                    صورة #{img.id}
                                  </div>
                                )}
                                {img.isPrimary && (
                                  <span className="absolute top-0.5 right-0.5 rounded bg-primary/90 px-1 py-0.2 text-[9px] text-primary-foreground font-medium">
                                    رئيسية
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <StudioCampaignImageBatch key={selected.id} ref={imageBatch} taskId={Number(selected.id)} userId={authenticatedUserId} productName={selected.productName} primaryImages={images} onPrimaryImage={(image) => { setImages([image]); setOriginalDataUrl(image.dataUrl); setProcessingReceipt(null); setStudioMode("FLATTEN"); }} adminOverrideReason={editOverrideValue} offline={offline} submitting={isPreparingThumbnail} onBusyChange={setIsBatchBusy}>
                      <ProductMediaContentSection title={`صورة الحملة ${selected.activeSlot ?? 1} والمحتوى`} description={description} onDescriptionChange={setDescription} marketingCopy={marketingCopy} onMarketingCopyChange={setMarketingCopy} images={images} onImagesChange={setImages} maxImages={1} onOriginalCaptured={setOriginalDataUrl} onStudioModeChange={setStudioMode} studioTaskId={Number(selected.id)} adminOverrideReason={editOverrideValue} onProcessingReceiptChange={setProcessingReceipt} onStudioBusyChange={setIsStudioProcessing} offline={offline} hint="أضف بقية الصور من قسم صور الحملة أعلاه؛ لكل صورة أصل وتعديل ومراجعة مستقلة." />
                      </StudioCampaignImageBatch>
                      {offline && (
                        <p role="status" className="text-sm text-muted-foreground">
                          تُحفظ تعديلاتك محلياً ومشفّرةً حتى 24 ساعة. الإرسال والاعتماد والرفض والنشر متوقفة إلى أن يعود الاتصال.
                        </p>
                      )}
                      <div className="sticky bottom-24 z-20 -mx-4 mt-16 flex flex-wrap gap-2 border-y bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:mt-0 lg:border-0 lg:bg-transparent lg:p-0">
                        <Button
                          className="min-h-11"
                          variant="outline"
                          disabled={offline || busy}
                          onClick={() =>
                            saveDraft.mutate({
                              taskId: Number(selected.id),
                              expectedRevision: selected.revision,
                              proposedName: name,
                              proposedDescription: description,
                              proposedMarketingCopy: marketingCopy,
                              adminOverrideReason: editOverrideValue,
                            })
                          }
                        >
                          حفظ المسودة
                        </Button>
                        <Button className="min-h-11" disabled={offline || busy || (!selected.hasOriginal && !originalDataUrl) || !images[0]?.dataUrl} onClick={() => void submitForReview()}>
                          {isPreparingThumbnail && <Loader2 aria-hidden className="size-4 animate-spin" />}
                          إرسال المحتوى والصور للمراجعة
                        </Button>
                      </div>
                    </>
                  )}

                  {selected.hasCandidate && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">المقارنة قبل الاعتماد</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {preview.isLoading && <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />}
                        {preview.data && <PreviewPair data={preview.data} />}
                        {/* اعتمادٌ بلا رؤية = نشرُ صورةٍ لم يرها المراجع. يُمنع صراحةً ويُفسَّر. */}
                        {preview.isError && (
                          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">تعذّر عرض الأصل والمرشّح.</p>
                              <p className="text-xs">الاعتماد موقوف حتى تظهر الصورتان — لا يُعتمد ما لم يُرَ.</p>
                            </div>
                            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void preview.refetch()}>
                              إعادة المحاولة
                            </Button>
                          </div>
                        )}
                        {dashboard.data?.canManage && selected.status === "PENDING_REVIEW" && (
                          <div className="space-y-3 border-t pt-4">
                            {reviewOverrideRequired && (
                              <div className="space-y-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
                                <Label htmlFor="studio-admin-review-override">سبب تجاوز فصل الواجبات</Label>
                                <Textarea id="studio-admin-review-override" rows={2} maxLength={500} value={reviewOverrideReason} onChange={(event) => setReviewOverrideReason(event.target.value)} placeholder="سبب تصحيح إداري موثق لاعتماد عمل شاركت في تنفيذه" />
                              </div>
                            )}
                            {!reviewable && !reviewOverrideRequired && <p className="text-sm text-destructive">لا يمكنك مراجعة مهمة أُسندت إليك أو كنت آخر من أرسلها.</p>}
                            <div className="rounded-md border bg-muted/30 p-3 text-xs">
                              <p className="font-medium">قائمة فحص سريعة</p>
                              <ul className="mt-2 space-y-1 text-muted-foreground">
                                <li>المنتج وتفاصيله مطابقة للأصل.</li>
                                <li>الخلفية والقصّ واضحان ولا يحجبان المنتج.</li>
                                <li>الاسم والوصف المقترحان صالحان للنشر.</li>
                              </ul>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="studio-reject-reason">سبب الرفض عند الإعادة</Label>
                              <div className="flex flex-wrap gap-2">
                                {STUDIO_REJECTION_PRESETS.map((reason) => (
                                  <Button key={reason} type="button" variant="outline" className="min-h-11 text-xs" disabled={storageActionsDisabled} onClick={() => setRejectReason(reason)}>
                                    {reason}
                                  </Button>
                                ))}
                              </div>
                              <Textarea id="studio-reject-reason" rows={2} maxLength={500} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="ملاحظة إضافية مطلوبة للتعديل" disabled={storageActionsDisabled} />
                            </div>
                            <div className="sticky bottom-24 z-20 -mx-4 mt-16 flex flex-wrap gap-2 border-y bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:mt-0 lg:border-0 lg:bg-transparent lg:p-0">
                              <Button
                                className="min-h-11"
                                disabled={!canApproveStudioCandidate({ offline, storageDisabled: storageActionsDisabled, busy, reviewable, previewLoaded: Boolean(preview.data) })}
                                onClick={() =>
                                  approve.mutate({
                                    taskId: Number(selected.id),
                                    expectedRevision: selected.revision,
                                    adminOverrideReason: reviewOverrideValue,
                                  })
                                }
                              >
                                <CheckCircle2 aria-hidden className="size-4" /> اعتماد ونشر
                              </Button>
                              <Button
                                className="min-h-11"
                                variant="destructive"
                                disabled={offline || storageActionsDisabled || busy || !reviewable || rejectReason.trim().length < 5}
                                onClick={() =>
                                  reject.mutate({
                                    taskId: Number(selected.id),
                                    expectedRevision: selected.revision,
                                    reason: rejectReason,
                                    adminOverrideReason: reviewOverrideValue,
                                  })
                                }
                              >
                                <XCircle aria-hidden className="size-4" /> إعادة للتعديل
                              </Button>
                            </div>
                          </div>
                        )}
                        {dashboard.data?.canManage && selected.status === "APPROVED" && (
                          <Button
                            variant="outline"
                            disabled={offline || storageActionsDisabled || busy}
                            onClick={() =>
                              revert.mutate({
                                taskId: Number(selected.id),
                                expectedRevision: selected.revision,
                              })
                            }
                          >
                            <RotateCcw aria-hidden className="size-4" /> استرجاع الأصل
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* معرض صور المنتج القائمة — للمدير فقط. يظهر تحت المهمّة المختارة كي
                      يرى المدير كل صور المنتج (شاملة البدائل)، ويمسّها: يحذف، يعيّن رئيسيّة،
                      يعيد ترتيب. طلب المالك ٢٦/٨: التحكم الكامل بالصور الموجودة. */}
                  {dashboard.data?.canManage && selected.productId != null && (
                    <ProductImageGallery productId={Number(selected.productId)} />
                  )}
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      {mobilePanel === "LIST" && (
        <>
          {/* زرٌّ عائم للجوّال — مسحٌ يُنشئ المهمّةَ فوراً إن كان المصوّر ضمن حملةٍ نشطة.
              كان محصوراً بنطاق `MINE` ويبحث عن مهمّةٍ **مسبقة الإسناد** فقط
              (`selectScannedOwnedTask`) فيبلغ «لا توجد مهمة مسندة إليك» — نقيض
              الإسناد الأعمى الذي يعِد به عقد `claimByBarcode`. الآن يستدعي المسار
              نفسه الذي تستدعيه محطّة التصوير في الأعلى، فيتّسق سلوك الشاشتين. */}
          <Button type="button" className="fixed bottom-24 end-4 z-30 min-h-11 rounded-full px-4 shadow-lg lg:hidden" disabled={offline || mobileClaimByBarcode.isPending} onClick={() => setTaskScannerOpen(true)}>
            {mobileClaimByBarcode.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ScanLine aria-hidden className="size-4" />} امسح لبدء التصوير
          </Button>
          {taskScannerOpen && (
            <Suspense fallback={null}>
              <CameraScanner open onClose={() => setTaskScannerOpen(false)} onDetect={(barcode) => claimScannedBarcode(barcode)} />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
