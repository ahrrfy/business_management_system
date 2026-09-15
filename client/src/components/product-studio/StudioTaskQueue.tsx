import { useState, useMemo, useEffect, lazy, Suspense } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, ClipboardList, UserCheck, CheckCircle2, History, Loader2, Plus, ChevronRight, XCircle, RotateCcw, ScanLine } from "lucide-react";
import { getStudioTaskStatusDisplay, studioTaskSelection, canApproveStudioCandidate } from "@/lib/productStudio/studioBoardLabels";
import { STUDIO_CAMPAIGN_STATUS_AR, STUDIO_CAMPAIGN_STATUS_VARIANT } from "@shared/studioCampaignStatus";
import { StudioPreviewPair } from "@/components/product-studio/StudioPreviewPair";
import { ProductImageGallery } from "@/components/product-studio/ProductImageGallery";
import { defaultStudioScope, mobileStudioPanel, STUDIO_EMPTY_HINTS } from "@/lib/productStudio/mobileStudioUi";

const STUDIO_LAST_TAB_KEY = "overhaul:studio:lastTab";
function persistStudioScope(scope: Scope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STUDIO_LAST_TAB_KEY, scope);
  } catch {}
}

type Scope = "QUEUE" | "MINE" | "REVIEW" | "HISTORY";
const BULK_ASSIGN_MAX = 20;
const CANCELLABLE_STATUSES = ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"];

const CameraScanner = lazy(() => import("@/components/scan/CameraScanner").then((module) => ({ default: module.CameraScanner })));

export function StudioTaskQueue({
  offline,
  canManage,
  initialSelectedCampaignId,
  onCampaignSelect,
}: {
  offline: boolean;
  canManage: boolean;
  initialSelectedCampaignId: number | null;
  onCampaignSelect?: (id: number | null) => void;
}) {
  const utils = trpc.useUtils();
  
  // Tabs and Filters
  const [scope, setScope] = useState<Scope>(defaultStudioScope({ canManage, canAudit: false }));
  const [savedView, setSavedView] = useState<string>("ALL");
  const [assigneeFilter, setAssigneeFilter] = useState("ALL");
  const [taskSearch, setTaskSearch] = useState("");
  const [debouncedTaskSearch, setDebouncedTaskSearch] = useState("");
  const [taskPriorityFilter, setTaskPriorityFilter] = useState("ALL");
  const [overdue, setOverdue] = useState(false);
  const [hideClosedCampaigns, setHideClosedCampaigns] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(initialSelectedCampaignId);

  useEffect(() => {
    if (initialSelectedCampaignId !== selectedCampaignId) {
      setSelectedCampaignId(initialSelectedCampaignId);
    }
  }, [initialSelectedCampaignId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTaskSearch(taskSearch), 500);
    return () => clearTimeout(timer);
  }, [taskSearch]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set());
  
  // Bulk actions state
  const [bulkAssigneeId, setBulkAssigneeId] = useState("");
  const [bulkReassignAssigneeId, setBulkReassignAssigneeId] = useState("");
  const [bulkPriorityValue, setBulkPriorityValue] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");

  // Single task action state
  const [inlineAssigneeId, setInlineAssigneeId] = useState("");
  const [selectedPriority, setSelectedPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [selectedDueAt, setSelectedDueAt] = useState("");
  const [reassignAssigneeId, setReassignAssigneeId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [taskScannerOpen, setTaskScannerOpen] = useState(false);

  // Queries
  const assignees = trpc.productStudio.assignees.useQuery(undefined, { enabled: !offline });
  const tasks = trpc.productStudio.tasks.useInfiniteQuery(
    {
      scope,
      campaignId: selectedCampaignId ?? undefined,
      assigneeId: assigneeFilter === "ALL" ? undefined : Number(assigneeFilter),
      search: debouncedTaskSearch.trim() || undefined,
      priority: taskPriorityFilter === "ALL" ? undefined : (taskPriorityFilter as any),
      overdue: overdue || undefined,
      hideClosedCampaigns,
    },
    {
      enabled: !offline,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const selected = useMemo(() => {
    if (!selectedId) return null;
    for (const page of tasks.data?.pages ?? []) {
      const task = page.items.find((t) => Number(t.id) === selectedId);
      if (task) return task;
    }
    return null;
  }, [selectedId, tasks.data]);

  const preview = trpc.productStudio.candidatePreview.useQuery({ taskId: selectedId ?? 0 }, {
    enabled: !offline && selectedId != null && selected?.hasCandidate === true,
  });

  const mobilePanel = mobileStudioPanel(selectedId);

  // Mutations
  const assign = trpc.productStudio.assign.useMutation({
    onSuccess: async () => {
      notify.ok("أُسندت المهمة");
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  
  const bulkReassign = trpc.productStudio.bulkReassign.useMutation({
    onSuccess: async () => {
      notify.ok("نُفِّذت إعادة الإسناد الجماعية");
      setSelectedTaskIds(new Set());
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const bulkSetPriority = trpc.productStudio.bulkSetPriority.useMutation({
    onSuccess: async () => {
      notify.ok("حُدِّثت الأولوية المهام المختارة");
      setSelectedTaskIds(new Set());
      if (!offline) await utils.productStudio.tasks.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  
  const updateSchedule = trpc.productStudio.updateSchedule.useMutation({
    onSuccess: async () => {
      notify.ok("حُدّثت بيانات المهمة");
      if (!offline) await utils.productStudio.tasks.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const reassign = trpc.productStudio.reassign.useMutation({
    onSuccess: async () => {
      notify.ok("أُعيد إسناد المهمة");
      setReassignReason("");
      setSelectedId(null);
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const cancelTask = trpc.productStudio.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت المهمة");
      setCancelReason("");
      setSelectedId(null);
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const approve = trpc.productStudio.approve.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمدت صور المنتج ومحتواه — تُنشر في المتجر");
      setSelectedId(null);
      if (!offline) {
        await utils.productStudio.invalidate();
      }
    },
    onError: (error) => notify.err(error),
  });

  const reject = trpc.productStudio.reject.useMutation({
    onSuccess: async () => {
      notify.ok("أُعيدت المهمة للتعديل");
      setRejectReason("");
      setSelectedId(null);
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const revert = trpc.productStudio.revert.useMutation({
    onSuccess: async () => {
      notify.ok("استُرجعت النسخة الأصلية — المحتوى مرفوض");
      setSelectedId(null);
      if (!offline) {
        await utils.productStudio.invalidate();
      }
    },
    onError: (error) => notify.err(error),
  });

  const mobileClaimByBarcode = trpc.productStudio.claimByBarcode.useMutation({
    onSuccess: async (data) => {
      notify.ok(`التُقط المنتج`);
      setSelectedId(Number(data.taskId));
      if (!offline) await utils.productStudio.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  // Derived arrays
  const taskItems = useMemo(() => tasks.data?.pages.flatMap((p) => p.items) ?? [], [tasks.data]);
  const canBulkAssign = canManage && ["QUEUE", "MINE", "REVIEW"].includes(scope);
  const queuedTaskIds = useMemo(() => (canBulkAssign ? taskItems.filter((t) => t.status === "ASSIGNED" && t.assigneeName == null).map((t) => Number(t.id)) : []), [taskItems, canBulkAssign]);
  const allQueuedSelected = queuedTaskIds.length > 0 && queuedTaskIds.every((id) => selectedTaskIds.has(id));
  const selectedAssignedTaskIds = useMemo(() => taskItems.filter((t) => selectedTaskIds.has(Number(t.id)) && t.status !== "APPROVED" && t.status !== "CANCELLED" && t.assigneeName != null).map((t) => Number(t.id)), [taskItems, selectedTaskIds]);
  const selectedActiveTaskIds = useMemo(() => taskItems.filter((t) => selectedTaskIds.has(Number(t.id)) && t.status !== "APPROVED" && t.status !== "CANCELLED").map((t) => Number(t.id)), [taskItems, selectedTaskIds]);

  const toggleTaskSelection = (id: number) => {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllQueued = () => {
    setSelectedTaskIds((current) => {
      if (allQueuedSelected) {
        const next = new Set(current);
        queuedTaskIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...Array.from(current), ...queuedTaskIds]);
    });
  };

  return (
    <>
      <Tabs
        value={scope}
        onValueChange={(value) => {
          const next = value as Scope;
          setScope(next);
          persistStudioScope(next);
          setSelectedId(null);
          setSavedView("ALL");
          setOverdue(false);
          setSelectedTaskIds(new Set());
        }}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="QUEUE"><ClipboardList aria-hidden className="size-4" /> طابور العمل</TabsTrigger>
          <TabsTrigger value="MINE"><UserCheck aria-hidden className="size-4" /> عملي</TabsTrigger>
          <TabsTrigger value="REVIEW"><CheckCircle2 aria-hidden className="size-4" /> المراجعة</TabsTrigger>
          <TabsTrigger value="HISTORY"><History aria-hidden className="size-4" /> السجل</TabsTrigger>
        </TabsList>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["ALL", "الكل"],
                ["UNASSIGNED", "غير المسندة"],
                ["OVERDUE", "المتأخرة"],
                ["PENDING_REVIEW", "بانتظار المراجعة"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value} type="button"
                variant={savedView === value ? "default" : "outline"}
                className="min-h-11"
                onClick={() => {
                  setSavedView(value);
                  if (value === "UNASSIGNED" || value === "OVERDUE") setScope("QUEUE");
                  if (value === "PENDING_REVIEW") setScope("REVIEW");
                  setSelectedId(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          {canManage && (
            <div className="min-w-40 space-y-1">
              <Label htmlFor="studio-assignee-filter">الموظف</Label>
              <AppSelect id="studio-assignee-filter" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={assigneeFilter} onValueChange={setAssigneeFilter} disabled={assignees.isError}>
                <option value="ALL">كل الموظفين</option>
                {(assignees.data ?? []).map((user: any) => (
                  <option key={user.id} value={String(user.id)}>{user.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
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
          <Button type="button" variant={overdue ? "default" : "outline"} className="min-h-11" disabled={savedView === "OVERDUE"} onClick={() => setOverdue((current) => !current)}>
            <AlertTriangle aria-hidden className="size-4" /> المتأخرة فقط
          </Button>
          <Button
            type="button" variant={hideClosedCampaigns ? "default" : "outline"} className="min-h-11" disabled={selectedCampaignId != null} onClick={() => setHideClosedCampaigns((v) => !v)}
          >
            {hideClosedCampaigns ? "إخفاء الحملات المغلقة (مفعَّل)" : "إظهار كل الحملات"}
          </Button>
        </div>
        
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
                      
                      {selectedTaskIds.size > 0 && queuedTaskIds.some((id) => selectedTaskIds.has(id)) && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-40 flex-1">
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkAssigneeId} onValueChange={setBulkAssigneeId} disabled={assignees.isError}>
                              <option value="">اختر الموظف</option>
                              {(assignees.data ?? []).map((user: any) => (
                                <option key={user.id} value={String(user.id)}>{user.name}</option>
                              ))}
                            </AppSelect>
                          </div>
                          <Button
                            type="button" className="min-h-11" disabled={offline || bulkReassign.isPending || !bulkAssigneeId}
                            onClick={() => {
                              const queuedSelected = queuedTaskIds.filter((id) => selectedTaskIds.has(id)).slice(0, BULK_ASSIGN_MAX);
                              bulkReassign.mutate({ taskIds: queuedSelected, newAssigneeId: Number(bulkAssigneeId) });
                            }}
                          >
                            <UserCheck aria-hidden className="size-4" /> إسناد {queuedTaskIds.filter((id) => selectedTaskIds.has(id)).length} من الطابور
                          </Button>
                        </div>
                      )}
                      
                      {selectedAssignedTaskIds.length > 0 && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-40 flex-1">
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkReassignAssigneeId} onValueChange={setBulkReassignAssigneeId} disabled={assignees.isError}>
                              <option value="">إلى الطابور المفتوح</option>
                              {(assignees.data ?? []).filter((u: any) => u.canStudio).map((user: any) => (
                                <option key={user.id} value={String(user.id)}>{user.name}</option>
                              ))}
                            </AppSelect>
                          </div>
                          <Button
                            type="button" variant="outline" className="min-h-11" disabled={offline || bulkReassign.isPending}
                            onClick={() => {
                              bulkReassign.mutate({
                                taskIds: selectedAssignedTaskIds.slice(0, BULK_ASSIGN_MAX),
                                newAssigneeId: bulkReassignAssigneeId ? Number(bulkReassignAssigneeId) : null,
                              });
                            }}
                          >
                            إعادة إسناد {selectedAssignedTaskIds.length} مُسنَدة
                          </Button>
                        </div>
                      )}
                      
                      {selectedActiveTaskIds.length > 0 && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-32">
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={bulkPriorityValue} onValueChange={(value) => setBulkPriorityValue(value as typeof bulkPriorityValue)}>
                              <option value="LOW">منخفضة</option>
                              <option value="NORMAL">عادية</option>
                              <option value="HIGH">عالية</option>
                              <option value="URGENT">عاجلة</option>
                            </AppSelect>
                          </div>
                          <Button
                            type="button" variant="outline" className="min-h-11" disabled={offline || bulkSetPriority.isPending}
                            onClick={() => bulkSetPriority.mutate({ taskIds: selectedActiveTaskIds.slice(0, BULK_ASSIGN_MAX), priority: bulkPriorityValue })}
                          >
                            ضبط أولوية {selectedActiveTaskIds.length} مهمّة
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {tasks.isLoading && <div className="py-8 text-center"><Loader2 aria-hidden className="mx-auto size-6 animate-spin" /></div>}
                  {tasks.isError && (
                    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      <p className="font-medium">تعذّر جلب المهام — هذه ليست قائمة فارغة.</p>
                      <Button variant="outline" size="sm" onClick={() => void tasks.refetch()}>إعادة المحاولة</Button>
                    </div>
                  )}
                  {!tasks.isLoading && !tasks.isError && taskItems.length === 0 && (
                    <div className="py-8 text-center text-sm text-muted-foreground"><p>{STUDIO_EMPTY_HINTS[tab]}</p></div>
                  )}
                  
                  {taskItems.map((task) => (
                    <div key={Number(task.id)} className="flex items-start gap-2">
                      {canBulkAssign && ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(task.status) && (
                        <input
                          type="checkbox" className="mt-4 size-4 shrink-0"
                          checked={selectedTaskIds.has(Number(task.id))}
                          onChange={() => toggleTaskSelection(Number(task.id))}
                        />
                      )}
                      <button type="button" onClick={() => { setSelectedId(Number(task.id)); setSelectedPriority(task.priority); setSelectedDueAt(task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 16) : ""); }} className={`min-h-11 w-full rounded-md border p-3 text-start transition-colors hover:bg-muted/50 active:bg-muted ${selectedId === Number(task.id) ? "border-primary bg-muted/40" : ""}`}>
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium">
                            {task.productName}
                            {task.variantName ? <span className="text-muted-foreground"> — {task.variantName}</span> : null}
                          </span>
                          <Badge variant={getStudioTaskStatusDisplay(task).variant}>{getStudioTaskStatusDisplay(task).label}</Badge>
                          {task.campaignStatus && ["PAUSED", "COMPLETED", "CANCELLED"].includes(task.campaignStatus) && (
                            <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[task.campaignStatus] as any} className="text-[10px]">
                              حملة {STUDIO_CAMPAIGN_STATUS_AR[task.campaignStatus as keyof typeof STUDIO_CAMPAIGN_STATUS_AR]}
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

              {/* Task Details Right Panel (Manager View) */}
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
                        <span>{selected.productName}{selected.variantName ? <span className="text-muted-foreground"> — {selected.variantName}</span> : null}</span>
                        <Badge variant={getStudioTaskStatusDisplay(selected).variant}>{getStudioTaskStatusDisplay(selected).label}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {canManage && selected.status === "ASSIGNED" && selected.assigneeName == null && (
                        <div className="grid gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 sm:grid-cols-[1fr_auto]">
                          <div className="space-y-1">
                            <Label>إسناد هذه المهمة إلى موظف</Label>
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={inlineAssigneeId} onValueChange={setInlineAssigneeId}>
                              <option value="">اختر الموظف</option>
                              {(assignees.data ?? []).map((user: any) => <option key={user.id} value={String(user.id)}>{user.name}</option>)}
                            </AppSelect>
                          </div>
                          <Button
                            type="button" className="min-h-11 self-end" disabled={offline || assign.isPending || !inlineAssigneeId}
                            onClick={() => assign.mutate({ productId: Number(selected.productId), assigneeId: Number(inlineAssigneeId), priority: selectedPriority, dueAt: selectedDueAt ? new Date(selectedDueAt) : null })}
                          >
                            <UserCheck aria-hidden className="size-4" /> إسناد
                          </Button>
                        </div>
                      )}
                      
                      {canManage && ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(selected.status) && (
                        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
                          <div className="space-y-1">
                            <Label>أولوية المهمة</Label>
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedPriority} onValueChange={(value) => setSelectedPriority(value as typeof selectedPriority)}>
                              <option value="LOW">منخفضة</option>
                              <option value="NORMAL">عادية</option>
                              <option value="HIGH">عالية</option>
                              <option value="URGENT">عاجلة</option>
                            </AppSelect>
                          </div>
                          <div className="space-y-1">
                            <Label>موعد الإنجاز</Label>
                            <Input type="datetime-local" value={selectedDueAt} onChange={(event) => setSelectedDueAt(event.target.value)} />
                          </div>
                          <Button
                            type="button" variant="outline" className="min-h-11 self-end" disabled={offline || updateSchedule.isPending}
                            onClick={() => updateSchedule.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision, priority: selectedPriority, dueAt: selectedDueAt ? new Date(selectedDueAt) : null })}
                          >
                            حفظ الأولوية والموعد
                          </Button>
                        </div>
                      )}
                      
                      {canManage && ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(selected.status) && selected.assigneeName != null && (
                        <div className="space-y-2 rounded-md border p-3">
                          <Label>إعادة إسناد المهمّة (المسنَد الآن: {selected.assigneeName})</Label>
                          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                            <AppSelect className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={reassignAssigneeId} onValueChange={setReassignAssigneeId}>
                              {selected.campaignId != null ? <option value="">إلى الطابور المفتوح</option> : <option value="" disabled>اختر مصوّراً (المهمة المستقلة تحتاج مصور)</option>}
                              {(assignees.data ?? []).filter((user: any) => user.canStudio && user.id !== Number(selected.assignedTo)).map((user: any) => (
                                <option key={user.id} value={String(user.id)}>{user.name}</option>
                              ))}
                            </AppSelect>
                            <Button
                              type="button" className="min-h-11" disabled={offline || reassign.isPending || (selected.campaignId == null && !reassignAssigneeId)}
                              onClick={() => reassign.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision, newAssigneeId: reassignAssigneeId ? Number(reassignAssigneeId) : null, reason: reassignReason.trim() || undefined })}
                            >
                              <UserCheck aria-hidden className="size-4" /> إعادة إسناد
                            </Button>
                          </div>
                          <Textarea rows={1} maxLength={500} value={reassignReason} onChange={(event) => setReassignReason(event.target.value)} placeholder="سبب اختياريّ يُسجَّل في التدقيق" />
                        </div>
                      )}
                      
                      {canManage && CANCELLABLE_STATUSES.includes(selected.status) && (
                        <div className="space-y-2 rounded-md border p-3">
                          <Label>إلغاء المهمة نهائياً</Label>
                          <p className="text-xs text-muted-foreground">تُنقل إلى السجلّ بحالة «ملغاة»، ويعود المنتج قابلاً لمهمة جديدة.</p>
                          <Textarea rows={2} maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="سبب الإلغاء (٥ أحرف على الأقل)" />
                          <Button
                            type="button" variant="destructive" className="min-h-11" disabled={offline || cancelTask.isPending || cancelReason.trim().length < 5}
                            onClick={() => cancelTask.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision, reason: cancelReason })}
                          >
                            <XCircle aria-hidden className="size-4" /> إلغاء المهمة
                          </Button>
                        </div>
                      )}
                      
                      {selected.status === "CANCELLED" && selected.cancellationReason && (
                        <div className="rounded-md border p-3 text-sm">
                          <span className="text-muted-foreground">سبب الإلغاء: </span>{selected.cancellationReason}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* APPROVAL & REVIEW Section (Manager Only here) */}
                  {selected.hasCandidate && (
                    <Card>
                      <CardHeader><CardTitle className="text-base">المقارنة قبل الاعتماد</CardTitle></CardHeader>
                      <CardContent className="space-y-4">
                        {preview.isLoading && <Loader2 aria-hidden className="mx-auto size-6 animate-spin" />}
                        {preview.data && <StudioPreviewPair data={preview.data} />}
                        {preview.isError && (
                          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">تعذّر عرض الأصل والمرشّح.</p>
                            </div>
                            <Button variant="outline" size="sm" className="shrink-0" onClick={() => void preview.refetch()}>إعادة المحاولة</Button>
                          </div>
                        )}
                        
                        {canManage && selected.status === "PENDING_REVIEW" && (
                          <div className="space-y-3 border-t pt-4">
                            <div className="rounded-md border bg-muted/30 p-3 text-xs">
                              <p className="font-medium">قائمة فحص سريعة</p>
                              <ul className="mt-2 space-y-1 text-muted-foreground">
                                <li>المنتج وتفاصيله مطابقة للأصل.</li>
                                <li>الخلفية والقصّ واضحان ولا يحجبان المنتج.</li>
                              </ul>
                            </div>
                            <div className="space-y-1.5">
                              <Label>سبب الرفض عند الإعادة</Label>
                              <div className="flex flex-wrap gap-2">
                                {STUDIO_EMPTY_HINTS && ["صورة باهتة", "المنتج غير مطابق", "إضاءة سيئة"].map((reason) => (
                                  <Button key={reason} type="button" variant="outline" className="min-h-11 text-xs" onClick={() => setRejectReason(reason)}>{reason}</Button>
                                ))}
                              </div>
                              <Textarea rows={2} maxLength={500} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="ملاحظة إضافية مطلوبة للتعديل" />
                            </div>
                            <div className="flex flex-wrap gap-2 pt-2">
                              <Button
                                className="min-h-11 flex-1"
                                disabled={offline || approve.isPending || reject.isPending || !preview.data}
                                onClick={() => approve.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision })}
                              >
                                <CheckCircle2 aria-hidden className="size-4" /> اعتماد ونشر
                              </Button>
                              <Button
                                className="min-h-11 flex-1" variant="destructive"
                                disabled={offline || approve.isPending || reject.isPending || rejectReason.trim().length < 5}
                                onClick={() => reject.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision, reason: rejectReason })}
                              >
                                <XCircle aria-hidden className="size-4" /> إعادة للتعديل
                              </Button>
                            </div>
                          </div>
                        )}
                        
                        {canManage && selected.status === "APPROVED" && (
                          <Button variant="outline" disabled={offline || revert.isPending} onClick={() => revert.mutate({ taskId: Number(selected.id), expectedRevision: selected.revision })}>
                            <RotateCcw aria-hidden className="size-4" /> استرجاع الأصل
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  )}
                  
                  {/* Gallery */}
                  {canManage && selected.productId != null && <ProductImageGallery productId={Number(selected.productId)} />}
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      
      {/* Mobile Scanner */}
      {mobilePanel === "LIST" && (
        <>
          <Button type="button" className="fixed bottom-24 end-4 z-30 min-h-11 rounded-full px-4 shadow-lg lg:hidden" disabled={offline || mobileClaimByBarcode.isPending} onClick={() => setTaskScannerOpen(true)}>
            {mobileClaimByBarcode.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <ScanLine aria-hidden className="size-4" />} امسح لبدء التصوير
          </Button>
          {taskScannerOpen && (
            <Suspense fallback={null}>
              <CameraScanner open={taskScannerOpen} onClose={() => setTaskScannerOpen(false)} onDetect={(barcode: string) => mobileClaimByBarcode.mutate({ barcode })} />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}
