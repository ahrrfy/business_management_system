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
  FileCheck2,
  ImageIcon,
  Inbox as InboxIcon,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  UserCog,
  XCircle,
} from "lucide-react";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_LABELS } from "@shared/actionLabels";
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
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage } from "@/lib/whatsapp";

type TaskDetailData = RouterOutputs["tasks"]["get"];
type TaskEvent = TaskDetailData["events"][number];
type DesignApprovalByTask = RouterOutputs["workOrderDesignApproval"]["getByTask"];
type DesignDecisionInput = RouterInputs["workOrderDesignApproval"]["decide"];

type DesignDecision = DesignDecisionInput["decision"];
type EvidenceType = DesignDecisionInput["evidence"]["type"];

const EVIDENCE_LABELS: Record<EvidenceType, string> = {
  WHATSAPP_MESSAGE: "رسالة واتساب",
  CUSTOMER_SIGNATURE: "توقيع العميل",
  EMAIL: "بريد إلكتروني",
  ATTACHMENT: "مرفق محفوظ",
  OTHER: "دليل آخر",
};

export function designApprovalSelfReviewBlocked(
  currentUserId: number | undefined,
  participants: Array<number | string | null | undefined>,
): boolean {
  if (currentUserId == null) return false;
  return participants.some((participant) => participant != null && Number(participant) === currentUserId);
}

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

function newDecisionKey(approvalId: number): string {
  return `wo-design-decision-${approvalId}-${crypto.randomUUID()}`;
}

function DesignDecisionDialog({
  record,
  decision,
  onClose,
  onDecided,
}: {
  record: DesignApprovalByTask;
  decision: DesignDecision;
  onClose: () => void;
  onDecided: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("WHATSAPP_MESSAGE");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [replayInput, setReplayInput] = useState<DesignDecisionInput | null>(null);
  const approvalId = Number(record.approval.id);

  const decide = trpc.workOrderDesignApproval.decide.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.replayed
          ? "أُعيدت نتيجة القرار نفسه دون تكرار"
          : decision === "APPROVED"
            ? "اعتمد التصميم مع حفظ الدليل"
            : "رُفض التصميم مع حفظ الدليل",
      );
      await onDecided();
      onClose();
    },
    onError: (error) => notify.err(error),
  });

  const clearReplay = () => setReplayInput(null);
  const valid = reason.trim().length >= 3 && evidenceReference.trim().length >= 3;

  const submit = () => {
    const input =
      replayInput ??
      ({
        approvalId,
        decisionKey: newDecisionKey(approvalId),
        decision,
        reason: reason.trim(),
        evidence: {
          type: evidenceType,
          reference: evidenceReference.trim(),
        },
      } satisfies DesignDecisionInput);
    setReplayInput(input);
    decide.mutate(input);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !decide.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === "APPROVED" ? "اعتماد نسخة التصميم" : "رفض نسخة التصميم"}</DialogTitle>
          <DialogDescription>
            القرار يخص النسخة {Number(record.revision?.revision ?? 0)} وبصمتها المعروضة. الدليل وسبب القرار إلزاميان ولا يُستبدلان بتعليق عام.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="design-decision-reason" className="text-xs font-bold">سبب القرار</label>
            <Textarea
              id="design-decision-reason"
              value={reason}
              onChange={(event) => { setReason(event.target.value); clearReplay(); }}
              rows={3}
              maxLength={500}
              aria-invalid={reason.length > 0 && reason.trim().length < 3}
              placeholder={decision === "APPROVED" ? "مثال: أكد العميل مطابقة الأسماء والمقاسات" : "مثال: طلب العميل تغيير اللون والمقاس"}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="design-evidence-type" className="text-xs font-bold">نوع الدليل</label>
            <AppSelect
              id="design-evidence-type"
              value={evidenceType}
              onValueChange={(value) => { setEvidenceType(value as EvidenceType); clearReplay(); }}
            >
              {Object.entries(EVIDENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="design-evidence-reference" className="text-xs font-bold">مرجع الدليل</label>
            <Textarea
              id="design-evidence-reference"
              value={evidenceReference}
              onChange={(event) => { setEvidenceReference(event.target.value); clearReplay(); }}
              rows={2}
              maxLength={500}
              aria-invalid={evidenceReference.length > 0 && evidenceReference.trim().length < 3}
              placeholder="رقم الرسالة أو رابط المرفق أو وصف مكان التوقيع المؤرشف"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={decide.isPending}>{ACTION_LABELS.cancel}</Button>
          <Button
            variant={decision === "REJECTED" ? "destructive" : "default"}
            onClick={submit}
            disabled={decide.isPending || !valid}
          >
            {decide.isPending ? ACTION_LABELS.submitting : decision === "APPROVED" ? "اعتماد موثّق" : "رفض موثّق"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DesignApprovalPanel({
  record,
  canReview,
  myId,
  onChanged,
}: {
  record: DesignApprovalByTask;
  canReview: boolean;
  myId?: number;
  onChanged: () => Promise<void>;
}) {
  const [decision, setDecision] = useState<DesignDecision | null>(null);
  const approval = record.approval;
  const revision = record.revision;
  const task = record.task;
  const selfApprovalBlocked = designApprovalSelfReviewBlocked(myId, [
    approval.requestedBy,
    revision?.createdBy,
    record.workOrder.assignedTo,
    task?.assignedTo,
  ]);
  const pending = approval.status === "PENDING";

  const statusMeta = approval.status === "APPROVED"
    ? { label: "معتمد", icon: CheckCircle2, className: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" }
    : approval.status === "REJECTED"
      ? { label: "مرفوض", icon: XCircle, className: "bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]" }
      : approval.status === "SUPERSEDED"
        ? { label: "مستبدل", icon: RefreshCcw, className: "bg-muted text-muted-foreground" }
        : { label: "بانتظار القرار", icon: Clock, className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" };
  const StatusIcon = statusMeta.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ShieldCheck aria-hidden className="size-4" /> قرار اعتماد التصميم
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs ${statusMeta.className}`}>
            <StatusIcon aria-hidden className="size-3" /> {statusMeta.label}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-3 rounded-md bg-muted/30 p-3 sm:grid-cols-2">
          <div><span className="text-muted-foreground">أمر الشغل: </span><Link href={`/work-orders/${record.workOrder.id}`} className="font-bold text-primary hover:underline">{record.workOrder.orderNumber}</Link></div>
          <div><span className="text-muted-foreground">نسخة التصميم: </span><strong dir="ltr">{Number(revision?.revision ?? 0)}</strong></div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">بصمة المحتوى: </span>
            <code className="break-all font-mono text-[11px]" dir="ltr">{revision?.contentHash ?? "—"}</code>
          </div>
          {revision?.customizationSnapshot && (
            <div className="whitespace-pre-wrap sm:col-span-2">
              <span className="text-muted-foreground">نص التخصيص المثبت: </span>{revision.customizationSnapshot}
            </div>
          )}
        </div>

        {record.images.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center gap-1 text-xs font-bold"><ImageIcon aria-hidden className="size-3.5" /> صور النسخة المثبتة</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {record.images.map((image, index) => (
                <a key={`${image.url}-${index}`} href={image.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-md border">
                  <img src={image.url} alt={image.caption ?? `صورة التصميم ${index + 1}`} className="aspect-square w-full object-cover" />
                  {image.caption && <div className="truncate p-1 text-2xs">{image.caption}</div>}
                </a>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">هذه نسخة نصية بلا صور؛ البصمة تشمل نص التخصيص أعلاه.</p>
        )}

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div><span className="text-muted-foreground">طالب الاعتماد: </span><span dir="ltr">#{Number(approval.requestedBy)}</span></div>
          <div><span className="text-muted-foreground">منشئ النسخة: </span><span dir="ltr">#{Number(revision?.createdBy ?? 0)}</span></div>
          {approval.requestNote && <div className="sm:col-span-2"><span className="text-muted-foreground">ملاحظة الطلب: </span>{approval.requestNote}</div>}
          {approval.decisionReason && <div className="sm:col-span-2"><span className="text-muted-foreground">سبب القرار: </span>{approval.decisionReason}</div>}
        </div>

        {approval.evidenceType && approval.evidenceReference && (
          <div className="rounded-md border p-3 text-xs">
            <div className="font-bold">الدليل المنظم</div>
            <div className="mt-1 text-muted-foreground">{EVIDENCE_LABELS[approval.evidenceType as EvidenceType] ?? approval.evidenceType}</div>
            <div className="mt-1 whitespace-pre-wrap break-words" dir="auto">{approval.evidenceReference}</div>
            {approval.reviewedBy != null && <div className="mt-2 text-muted-foreground">المراجع: <span dir="ltr">#{Number(approval.reviewedBy)}</span></div>}
          </div>
        )}

        {pending && canReview && selfApprovalBlocked && (
          <div className="rounded-md bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]">
            فصل الواجبات يمنعك من حسم هذا الطلب لأنك طالب الاعتماد أو منشئ النسخة أو الفني/المكلّف المرتبط بها. يلزم مدير آخر.
          </div>
        )}

        {pending && canReview && !selfApprovalBlocked && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDecision("APPROVED")}>
              <CheckCircle2 aria-hidden className="me-1 size-3.5" /> اعتماد موثّق
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setDecision("REJECTED")}>
              <XCircle aria-hidden className="me-1 size-3.5" /> رفض موثّق
            </Button>
          </div>
        )}
        {pending && !canReview && (
          <p className="text-xs text-muted-foreground">يمكنك مراجعة المستند؛ حسمه محصور بمدير يملك صلاحية أوامر الشغل.</p>
        )}
      </CardContent>

      {decision && (
        <DesignDecisionDialog
          record={record}
          decision={decision}
          onClose={() => setDecision(null)}
          onDecided={onChanged}
        />
      )}
    </Card>
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
  const canReviewDesign = !!role && moduleAccessAllowed(role, override, "workorders", "FULL", ["manager"]);
  const myId = me.data?.id != null ? Number(me.data.id) : undefined;

  const task = trpc.tasks.get.useQuery({ taskId }, { enabled: Number.isFinite(taskId) });
  const designApproval = trpc.workOrderDesignApproval.getByTask.useQuery(
    { taskId },
    {
      enabled: Number.isFinite(taskId) && task.data?.linkedWorkOrderId != null,
      retry: false,
    },
  );

  const refreshAll = async () => {
    await Promise.all([
      utils.tasks.get.invalidate({ taskId }),
      utils.tasks.list.invalidate(),
      utils.workOrderDesignApproval.getByTask.invalidate({ taskId }),
    ]);
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
  const looksLikeDesignApproval =
    data.linkedWorkOrderId != null && data.title.includes("اعتماد تصميم");
  const isDesignApprovalTask = looksLikeDesignApproval || designApproval.data != null;
  const isAssignee = data.assignedTo != null && myId != null && Number(data.assignedTo) === myId;
  const isCreator = data.createdBy != null && myId != null && Number(data.createdBy) === myId;

  const canClaim = !isDesignApprovalTask && canWrite && data.taskStatus === "NEW" && (data.assignedTo == null || isAssignee);
  const canSetWaiting = !isDesignApprovalTask && canWrite && (isAssignee || isElevated) && (data.taskStatus === "NEW" || data.taskStatus === "IN_PROGRESS");
  const canResume = !isDesignApprovalTask && canWrite && (isAssignee || isElevated) && data.taskStatus === "WAITING_CUSTOMER";
  const canResolve = !isDesignApprovalTask && canWrite && (isAssignee || isElevated) && (data.taskStatus === "IN_PROGRESS" || data.taskStatus === "WAITING_CUSTOMER");
  const canComment = canWrite && (isAssignee || isCreator || isElevated);
  const canCancel = !isDesignApprovalTask && canManage && OPEN_STATUSES.includes(data.taskStatus as TaskStatus);
  const canAssign = !isDesignApprovalTask && canManage && OPEN_STATUSES.includes(data.taskStatus as TaskStatus);
  const canReopen = !isDesignApprovalTask && canManage && data.taskStatus === "RESOLVED";
  const reopenWithinWindow =
    data.resolvedAt != null && Date.now() - new Date(data.resolvedAt).getTime() <= 7 * 24 * 3600_000;

  const requireResolutionNote = data.taskKind === "SUPPORT";

  // ترتيب زمنيّ تصاعديّ من الخادم (asc id) — نعرضه تنازلياً (الأحدث أعلى، نمط شريط نشاط).
  const events = [...data.events].reverse();
  const partyName = data.customerName ?? data.supplierName ?? null;
  const partyPhone = data.customerPhone ?? data.supplierPhone ?? null;
  const contactMessage = buildOperationalContactMessage({
    partyName,
    entityLabel: "المهمة",
    reference: data.taskNumber,
    title: data.title,
    status: STATUS_META[data.taskStatus as TaskStatus]?.label ?? data.taskStatus,
    dueAt: data.effectiveDueAt,
    nextAction: data.taskStatus === "WAITING_CUSTOMER" ? "نحتاج ردّكم للمتابعة وإكمال الطلب." : null,
  });

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
            {data.taskKind !== "INTERNAL" && (
              <WhatsAppShare
                phone={partyPhone}
                message={contactMessage}
                label={`واتساب ${partyName ?? "الطرف"}`}
              />
            )}
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
          {data.supplierId != null && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">المورّد</div>
              <Link href={`/suppliers/${data.supplierId}/edit`} className="font-medium text-primary hover:underline">
                {data.supplierName ?? `#${data.supplierId}`}
              </Link>
            </div>
          )}
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">الاستحقاق الفعلي</div>
            <div className="font-medium" dir="ltr">{data.effectiveDueAt ? fmtDateTime(data.effectiveDueAt) : "—"}</div>
          </div>
          {data.conversationId != null && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">المحادثة المرتبطة</div>
              {/* يحمل معرّف المحادثة في الرابط (لا صفحة الوارد العامة فقط) — بانتظار Inbox.tsx (خارج
                  ملفات هذه المهمة) ليقرأ conversationId من الرابط ويفتح المحادثة نفسها مباشرةً. */}
              <Link
                href={`/crm?tab=inbox&conversationId=${data.conversationId}`}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                <InboxIcon aria-hidden className="size-3.5" /> فتح المحادثة في صندوق الوارد
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

      {isDesignApprovalTask && designApproval.isLoading && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground" aria-busy="true">
            <FileCheck2 aria-hidden className="size-4" /> {ACTION_LABELS.loading}
          </CardContent>
        </Card>
      )}
      {isDesignApprovalTask && designApproval.isError && (
        <Card>
          <CardContent className="pt-6">
            <p className="font-bold text-destructive">تعذّر تحميل مستند اعتماد التصميم المتخصص.</p>
            <p className="mt-1 text-xs text-muted-foreground">حُجبت إجراءات المهمة العامة كي لا تتجاوز سجل القرار والدليل.</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => designApproval.refetch()}>
              <RefreshCcw aria-hidden className="me-1 size-3.5" /> {ACTION_LABELS.retry}
            </Button>
          </CardContent>
        </Card>
      )}
      {designApproval.data && (
        <DesignApprovalPanel
          record={designApproval.data}
          canReview={canReviewDesign}
          myId={myId}
          onChanged={refreshAll}
        />
      )}

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
