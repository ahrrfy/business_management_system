// تفاصيل مهمة — /tasks/:id (T2.3). خطّ زمني (taskEvents) + أزرار إجراءات تطابق آلة الحالات
// الخادمية بالضبط (server/services/tasks/lifecycle.ts) — تُظهَر فقط الإجراءات المتاحة فعلاً
// للحالة الحالية وللدور/نطاق المستخدم (مرآة واجهية لحرّاس assertTaskAssigneeOrElevated/
// assertTaskActorScope؛ الإنفاذ الحقيقي خادميّ دائماً).
import { useState } from "react";
import { Link, useParams } from "wouter";
import {
  Ban,
  CheckCircle2,
  Clock,
  Inbox as InboxIcon,
  MessageSquarePlus,
  Pause,
  Play,
  RotateCcw,
  UserCog,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  KindBadge,
  OverdueBadge,
  PriorityBadge,
  selectCls,
  STATUS_META,
  StatusBadge,
  TASK_MANAGER_ROLES,
  TASK_WRITE_ROLES,
  type TaskStatus,
} from "@/pages/TasksHub";

type TaskDetailData = RouterOutputs["tasks"]["get"];
type TaskEvent = TaskDetailData["events"][number];

const OPEN_STATUSES: TaskStatus[] = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"];

function eventLabel(e: TaskEvent): string {
  switch (e.eventType) {
    case "STATUS": {
      const from = e.fromStatus ? (STATUS_META[e.fromStatus as TaskStatus]?.label ?? e.fromStatus) : "—";
      const to = e.toStatus ? (STATUS_META[e.toStatus as TaskStatus]?.label ?? e.toStatus) : "—";
      return `تغيّرت الحالة من «${from}» إلى «${to}»`;
    }
    case "ASSIGN":
      return "أُسندت المهمة";
    case "COMMENT":
      return "تعليق";
    case "SYSTEM":
      return "حدث نظامي";
    case "CSAT":
      return "تقييم رضا العميل";
    default:
      return e.eventType;
  }
}

function TimelineItem({ e, isLast }: { e: TaskEvent; isLast: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="size-2.5 rounded-full bg-primary mt-1.5 shrink-0" />
        {!isLast && <div className="flex-1 w-px bg-border" />}
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <div className="text-sm font-medium">{eventLabel(e)}</div>
        {e.note && <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">{e.note}</div>}
        <div className="text-[11px] text-muted-foreground/70 mt-1">
          {e.userName ?? "النظام"} — <span dir="ltr">{fmtDateTime(e.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** حوار «الانتقال للانتظار» — ملاحظة اختيارية (السبب: بانتظار مواد/تأكيد من العميل…). */
function WaitingDialog({ onClose, onConfirm, pending }: { onClose: () => void; onConfirm: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>وضع المهمة بانتظار العميل</DialogTitle>
          <DialogDescription>يتوقّف عدّاد الاستحقاق (SLA) حتى الاستئناف. ملاحظة اختيارية للسبب.</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="مثال: بانتظار تأكيد التصميم من العميل" maxLength={2000} autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={pending}>{pending ? "جارٍ…" : "تأكيد الانتظار"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** حوار «حلّ المهمة» — resolutionNote إلزامي لمهام SUPPORT (تحقّق واجهي مطابق للخادم). */
function ResolveDialog({
  requireNote, onClose, onConfirm, pending,
}: { requireNote: boolean; onClose: () => void; onConfirm: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState("");
  const invalid = requireNote && !note.trim();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>حلّ المهمة</DialogTitle>
          <DialogDescription>
            {requireNote ? "ملاحظة الحلّ إلزامية لمهام الدعم (SUPPORT)." : "ملاحظة الحلّ اختيارية."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            ملاحظة الحلّ{requireNote && <span className="text-destructive"> *</span>}
          </label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={4000} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={pending || invalid}>{pending ? "جارٍ…" : "حلّ المهمة"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** حوار «إسناد» مديريّ — منتقٍ من assignableStaff + خيار «بلا إسناد» (تحرير). */
function AssignDialog({
  branchId, currentAssignee, onClose, onConfirm, pending,
}: { branchId: number; currentAssignee: number | null; onClose: () => void; onConfirm: (assignedTo: number | null) => void; pending: boolean }) {
  const staff = trpc.tasks.assignableStaff.useQuery({ branchId });
  const [value, setValue] = useState(currentAssignee != null ? String(currentAssignee) : "");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إسناد المهمة</DialogTitle>
          <DialogDescription>يمكن إعادة الإسناد أو تفريغه في أي حالة مفتوحة.</DialogDescription>
        </DialogHeader>
        <select className={`${selectCls} w-full`} value={value} onChange={(e) => setValue(e.target.value)} disabled={staff.isLoading}>
          <option value="">بلا إسناد</option>
          {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => onConfirm(value ? Number(value) : null)} disabled={pending}>{pending ? "جارٍ…" : "حفظ الإسناد"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** حوار «إلغاء» — سبب إلزامي + بوّابة تأكيد ثانية عبر lib/confirm (عملية خطرة لا رجعة فيها). */
function CancelDialog({ onClose, onConfirmed, pending }: { onClose: () => void; onConfirmed: (note: string) => void; pending: boolean }) {
  const [note, setNote] = useState("");
  async function handle() {
    if (!note.trim()) { notify.err("سبب الإلغاء مطلوب"); return; }
    if (!(await confirm({
      variant: "danger",
      title: "إلغاء المهمة",
      description: "لا يمكن التراجع عن الإلغاء. تأكّد من صحّة القرار.",
      confirmText: "إلغاء المهمة",
    }))) return;
    onConfirmed(note.trim());
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إلغاء المهمة</DialogTitle>
          <DialogDescription>سبب الإلغاء إلزامي ويظهر في الخطّ الزمني.</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="سبب الإلغاء" maxLength={2000} autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>تراجع</Button>
          <Button variant="destructive" onClick={handle} disabled={pending || !note.trim()}>{pending ? "جارٍ…" : "إلغاء المهمة"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TaskDetail() {
  const params = useParams();
  const taskId = Number(params.id);
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const isElevated = role === "admin" || role === "manager";
  const canWrite = !!role && moduleAccessAllowed(role, override, "tasks", "FULL", TASK_WRITE_ROLES);
  const canManage = !!role && moduleAccessAllowed(role, override, "tasks", "FULL", TASK_MANAGER_ROLES);
  const myId = me.data?.id != null ? Number(me.data.id) : undefined;

  const task = trpc.tasks.get.useQuery({ taskId }, { enabled: Number.isFinite(taskId) });

  const refreshAll = async () => {
    await Promise.all([utils.tasks.get.invalidate({ taskId }), utils.tasks.list.invalidate()]);
  };

  const [commentText, setCommentText] = useState("");
  const [showWaiting, setShowWaiting] = useState(false);
  const [showResolve, setShowResolve] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  const claim = trpc.tasks.claim.useMutation({
    onSuccess: async () => { notify.ok("سُحبت المهمة إليك"); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const setWaiting = trpc.tasks.setWaiting.useMutation({
    onSuccess: async () => { notify.ok("انتقلت المهمة لحالة الانتظار"); setShowWaiting(false); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const resume = trpc.tasks.resume.useMutation({
    onSuccess: async () => { notify.ok("استُؤنف العمل على المهمة"); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const resolve = trpc.tasks.resolve.useMutation({
    onSuccess: async () => { notify.ok("حُلّت المهمة"); setShowResolve(false); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const addComment = trpc.tasks.addComment.useMutation({
    onSuccess: async () => { setCommentText(""); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const assign = trpc.tasks.assign.useMutation({
    onSuccess: async () => { notify.ok("حُدِّث الإسناد"); setShowAssign(false); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const reopen = trpc.tasks.reopen.useMutation({
    onSuccess: async () => { notify.ok("أُعيد فتح المهمة"); await refreshAll(); },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.tasks.cancel.useMutation({
    onSuccess: async () => { notify.ok("أُلغيت المهمة"); setShowCancel(false); await refreshAll(); },
    onError: (e) => notify.err(e),
  });

  if (!Number.isFinite(taskId)) return <ErrorState message="رقم مهمة غير صالح." />;
  if (task.isLoading) return <LoadingState />;
  if (task.isError) return <ErrorState message="تعذّر تحميل المهمة." onRetry={() => task.refetch()} />;
  if (!task.data) return <ErrorState message="المهمة غير موجودة." />;

  const data = task.data;
  const isAssignee = data.assignedTo != null && myId != null && Number(data.assignedTo) === myId;
  const isCreator = data.createdBy != null && myId != null && Number(data.createdBy) === myId;

  const canClaim = canWrite && data.taskStatus === "NEW" && (data.assignedTo == null || isAssignee);
  const canSetWaiting = canWrite && (isAssignee || isElevated) && (data.taskStatus === "NEW" || data.taskStatus === "IN_PROGRESS");
  const canResume = canWrite && (isAssignee || isElevated) && data.taskStatus === "WAITING_CUSTOMER";
  const canResolve = canWrite && (isAssignee || isElevated) && (data.taskStatus === "IN_PROGRESS" || data.taskStatus === "WAITING_CUSTOMER");
  const canComment = canWrite && (isAssignee || isCreator || isElevated);
  const canCancel = canManage && OPEN_STATUSES.includes(data.taskStatus as TaskStatus);
  const canAssign = canManage && OPEN_STATUSES.includes(data.taskStatus as TaskStatus);
  const canReopen = canManage && data.taskStatus === "RESOLVED";
  const reopenWithinWindow =
    data.resolvedAt != null && Date.now() - new Date(data.resolvedAt).getTime() <= 7 * 24 * 3600_000;

  const requireResolutionNote = data.taskKind === "SUPPORT";

  // ترتيب زمنيّ تصاعديّ من الخادم (asc id) — نعرضه تنازلياً (الأحدث أعلى، نمط شريط نشاط).
  const events = [...data.events].reverse();

  return (
    <div className="space-y-4 p-4 max-w-4xl">
      <PageHeader
        breadcrumbs={[{ label: "المهام والتذاكر", href: "/tasks" }, { label: data.taskNumber }]}
        title={data.title}
        description={data.description || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.taskStatus} />
            {data.isOverdue && <OverdueBadge />}
          </div>
        }
      />

      <Card>
        <CardContent className="pt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">النوع</div>
            <KindBadge kind={data.taskKind} />
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">الأولوية</div>
            <PriorityBadge priority={data.priority} />
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">المسنَد إليه</div>
            <div className="font-medium">{data.assigneeName ?? "بلا إسناد"}</div>
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">العميل</div>
            {data.customerId != null ? (
              <Link href={`/customers/${data.customerId}/edit`} className="font-medium text-primary hover:underline">
                {data.customerName ?? `#${data.customerId}`}
              </Link>
            ) : (
              <div className="font-medium">—</div>
            )}
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">الاستحقاق الفعلي</div>
            <div className="font-medium" dir="ltr">{data.effectiveDueAt ? fmtDateTime(data.effectiveDueAt) : "—"}</div>
          </div>
          {data.conversationId != null && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">المحادثة المرتبطة</div>
              <Link href="/crm?tab=inbox" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                <InboxIcon aria-hidden className="size-3.5" /> فتح صندوق الوارد
              </Link>
            </div>
          )}
          {data.resolutionNote && (
            <div className="space-y-0.5 sm:col-span-2 lg:col-span-3">
              <div className="text-xs text-muted-foreground">ملاحظة الحلّ</div>
              <div className="whitespace-pre-wrap">{data.resolutionNote}</div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* أزرار الإجراءات — تُظهَر فقط المتاح للحالة الحالية وللدور/نطاق المستخدم. */}
      <div className="flex flex-wrap gap-2">
        {canClaim && (
          <Button
            size="sm"
            onClick={async () => {
              if (!(await confirm({ variant: "info", title: "سحب المهمة", description: "ستُسنَد هذه المهمة إليك وتنتقل لحالة قيد التنفيذ.", confirmText: "سحب المهمة" }))) return;
              claim.mutate({ taskId });
            }}
            disabled={claim.isPending}
            className="gap-1.5"
          >
            <Play aria-hidden className="size-3.5" /> سحب المهمة
          </Button>
        )}
        {canSetWaiting && (
          <Button size="sm" variant="outline" onClick={() => setShowWaiting(true)} className="gap-1.5">
            <Pause aria-hidden className="size-3.5" /> بانتظار العميل
          </Button>
        )}
        {canResume && (
          <Button
            size="sm"
            onClick={async () => {
              if (!(await confirm({ variant: "info", title: "استئناف العمل", description: "ستعود المهمة لحالة قيد التنفيذ.", confirmText: "استئناف" }))) return;
              resume.mutate({ taskId });
            }}
            disabled={resume.isPending}
            className="gap-1.5"
          >
            <Play aria-hidden className="size-3.5" /> استئناف
          </Button>
        )}
        {canResolve && (
          <Button size="sm" onClick={() => setShowResolve(true)} className="gap-1.5">
            <CheckCircle2 aria-hidden className="size-3.5" /> حلّ المهمة
          </Button>
        )}
        {canAssign && (
          <Button size="sm" variant="outline" onClick={() => setShowAssign(true)} className="gap-1.5">
            <UserCog aria-hidden className="size-3.5" /> إسناد
          </Button>
        )}
        {canReopen && (
          <Button
            size="sm"
            variant="outline"
            title={reopenWithinWindow ? undefined : "تجاوزت ٧ أيام من الحلّ — الخادم سيرفض إعادة الفتح"}
            onClick={async () => {
              if (!(await confirm({ variant: "warning", title: "إعادة فتح المهمة", description: "ستعود المهمة لحالة قيد التنفيذ (مسموح خلال ٧ أيام من الحلّ فقط).", confirmText: "إعادة فتح" }))) return;
              reopen.mutate({ taskId });
            }}
            disabled={reopen.isPending}
            className="gap-1.5"
          >
            <RotateCcw aria-hidden className="size-3.5" /> إعادة فتح
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setShowCancel(true)}>
            <Ban aria-hidden className="size-3.5" /> إلغاء
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock aria-hidden className="size-4" /> الخطّ الزمني
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا أحداث بعد.</p>
          ) : (
            <div>
              {events.map((e, i) => (
                <TimelineItem key={e.id} e={e} isLast={i === events.length - 1} />
              ))}
            </div>
          )}

          {canComment && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <Textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={2}
                placeholder="أضف تعليقاً…"
                maxLength={4000}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={!commentText.trim() || addComment.isPending}
                  onClick={() => addComment.mutate({ taskId, note: commentText.trim() })}
                >
                  <MessageSquarePlus aria-hidden className="size-3.5" />
                  {addComment.isPending ? "جارٍ…" : "إضافة تعليق"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {showWaiting && (
        <WaitingDialog
          pending={setWaiting.isPending}
          onClose={() => setShowWaiting(false)}
          onConfirm={(note) => setWaiting.mutate({ taskId, note: note || null })}
        />
      )}
      {showResolve && (
        <ResolveDialog
          requireNote={requireResolutionNote}
          pending={resolve.isPending}
          onClose={() => setShowResolve(false)}
          onConfirm={(note) => {
            if (requireResolutionNote && !note) { notify.err("ملاحظة الحلّ إلزامية لمهام الدعم (SUPPORT)"); return; }
            resolve.mutate({ taskId, resolutionNote: note || null });
          }}
        />
      )}
      {showAssign && (
        <AssignDialog
          branchId={Number(data.branchId)}
          currentAssignee={data.assignedTo != null ? Number(data.assignedTo) : null}
          pending={assign.isPending}
          onClose={() => setShowAssign(false)}
          onConfirm={(assignedTo) => assign.mutate({ taskId, assignedTo })}
        />
      )}
      {showCancel && (
        <CancelDialog
          pending={cancel.isPending}
          onClose={() => setShowCancel(false)}
          onConfirmed={(note) => cancel.mutate({ taskId, note })}
        />
      )}
    </div>
  );
}
