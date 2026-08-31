import { useState } from "react";
import {
  CheckCircle2,
  Clock,
  FileCheck2,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { trpc, type RouterInputs } from "@/lib/trpc";

type RequestInput = RouterInputs["workOrderDesignApproval"]["request"];

const STATUS_META = {
  PENDING: {
    label: "بانتظار قرار موثّق",
    className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    icon: Clock,
  },
  APPROVED: {
    label: "معتمد",
    className: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
    icon: CheckCircle2,
  },
  REJECTED: {
    label: "مرفوض",
    className: "bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]",
    icon: XCircle,
  },
  SUPERSEDED: {
    label: "مستبدل بنسخة أحدث",
    className: "bg-muted text-muted-foreground",
    icon: RefreshCcw,
  },
} as const;

function newRequestKey(workOrderId: number): string {
  return `wo-design-request-${workOrderId}-${crypto.randomUUID()}`;
}

export default function DesignApprovalCard({
  workOrderId,
  status,
  canManage,
  onChanged,
}: {
  workOrderId: number;
  status: string;
  /** صلاحية طلب الاعتماد؛ القرار نفسه محصور بشاشة المهمة وبفصل الواجبات. */
  canManage: boolean;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const current = trpc.workOrderDesignApproval.getCurrent.useQuery({ workOrderId });
  const [showRequest, setShowRequest] = useState(false);
  const [note, setNote] = useState("");
  const [requestInput, setRequestInput] = useState<RequestInput | null>(null);

  const refresh = async () => {
    await Promise.all([
      utils.workOrderDesignApproval.getCurrent.invalidate({ workOrderId }),
      utils.workOrders.get.invalidate({ workOrderId }),
    ]);
    onChanged?.();
  };

  const request = trpc.workOrderDesignApproval.request.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.replayed
          ? "أُعيدت نتيجة طلب الاعتماد نفسه دون تكرار"
          : "أُرسل طلب اعتماد النسخة للمراجعة دون تغيير أمر الشغل",
      );
      setShowRequest(false);
      setNote("");
      setRequestInput(null);
      await refresh();
    },
    onError: (error) => notify.err(error),
  });

  const submitRequest = () => {
    const input =
      requestInput ??
      ({
        workOrderId,
        requestKey: newRequestKey(workOrderId),
        note: note.trim() || null,
      } satisfies RequestInput);
    setRequestInput(input);
    request.mutate(input);
  };

  if (current.isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm" aria-busy="true">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {ACTION_LABELS.loading}
        </div>
      </div>
    );
  }

  if (current.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm">
        <p className="font-bold text-destructive">تعذّر تحميل سجل اعتماد التصميم.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          لا تبدأ التنفيذ قبل ظهور النسخة وقرارها من السجل المتخصص.
        </p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => current.refetch()}>
          <RefreshCcw aria-hidden className="me-1 size-3.5" /> {ACTION_LABELS.retry}
        </Button>
      </div>
    );
  }

  const revision = current.data?.revision ?? null;
  const approval = current.data?.approval ?? null;
  const task = current.data?.task ?? null;
  const approvalStatus = approval?.status as keyof typeof STATUS_META | undefined;
  const meta = approvalStatus ? STATUS_META[approvalStatus] : null;
  const StatusIcon = meta?.icon ?? ShieldCheck;
  const terminal = status === "DELIVERED" || status === "CANCELLED";
  const mayRequest = canManage && !terminal && revision != null && approval == null;

  return (
    <div className="rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 aria-hidden className="size-4" />
        <span className="font-bold">حوكمة اعتماد التصميم</span>
        {meta && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-extrabold ${meta.className}`}>
            <StatusIcon aria-hidden className="size-3" /> {meta.label}
          </span>
        )}
      </div>

      {revision ? (
        <div className="mt-3 grid gap-2 rounded-md bg-muted/30 p-3 text-xs sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">النسخة: </span>
            <strong dir="ltr">{Number(revision.revision)}</strong>
          </div>
          <div>
            <span className="text-muted-foreground">سبب النسخة: </span>
            <span>{revision.reason}</span>
          </div>
          <div className="sm:col-span-2">
            <span className="text-muted-foreground">بصمة المحتوى: </span>
            <code className="break-all font-mono text-[11px]" dir="ltr">{revision.contentHash}</code>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-md bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]">
          لا توجد نسخة تصميم مثبتة بعد. احفظ ملف التصميم أولاً؛ الطلب لا ينشئ موافقة وهمية بلا نسخة.
        </div>
      )}

      {approval ? (
        <div className="mt-3 space-y-2 text-xs">
          {approval.requestNote && (
            <p><span className="text-muted-foreground">ملاحظة الطلب: </span>{approval.requestNote}</p>
          )}
          <p>
            <span className="text-muted-foreground">طالب الاعتماد: </span>
            <span dir="ltr">#{Number(approval.requestedBy)}</span>
          </p>
          {approval.decisionReason && (
            <p><span className="text-muted-foreground">سبب القرار: </span>{approval.decisionReason}</p>
          )}
          {approval.evidenceType && approval.evidenceReference && (
            <div className="rounded-md border p-2">
              <div className="font-bold">دليل قرار العميل</div>
              <div className="mt-1 text-muted-foreground">{approval.evidenceType}</div>
              <div className="mt-1 break-words" dir="auto">{approval.evidenceReference}</div>
            </div>
          )}
          {task && (
            <Button asChild size="sm" variant="outline">
              <a href={`/tasks/${Number(task.id)}`}>افتح مهمة القرار الموثّق</a>
            </Button>
          )}
        </div>
      ) : mayRequest ? (
        showRequest ? (
          <div className="mt-3 space-y-2 rounded-md border p-3">
            <label htmlFor={`design-approval-note-${workOrderId}`} className="text-xs font-bold">
              ملاحظة للمراجع (اختيارية)
            </label>
            <Textarea
              id={`design-approval-note-${workOrderId}`}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setRequestInput(null);
              }}
              maxLength={500}
              rows={2}
              placeholder="مثال: وافق العميل مبدئياً عبر واتساب وننتظر توثيق المرجع"
            />
            <p className="text-2xs text-muted-foreground">
              الطلب لا يغيّر حالة أمر الشغل ولا يفتح التنفيذ؛ القرار يحتاج مديراً آخر ودليلاً منظماً.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={request.isPending} onClick={submitRequest}>
                {request.isPending ? ACTION_LABELS.sending : "أرسل طلب الاعتماد"}
              </Button>
              <Button size="sm" variant="ghost" disabled={request.isPending} onClick={() => setShowRequest(false)}>
                {ACTION_LABELS.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button className="mt-3" size="sm" onClick={() => setShowRequest(true)}>
            <FileCheck2 aria-hidden className="me-1 size-3.5" /> طلب اعتماد هذه النسخة
          </Button>
        )
      ) : revision && !approval && !canManage ? (
        <p className="mt-3 text-xs text-muted-foreground">هذه النسخة لم تُرسل للاعتماد بعد.</p>
      ) : null}
    </div>
  );
}
