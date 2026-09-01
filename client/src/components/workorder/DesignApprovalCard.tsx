/**
 * **بطاقةُ اعتماد التصميم — بلا رفعِ ملفّ، وبلا مغادرةِ الشاشة** (قرار المالك ١/٩/٢٦).
 *
 * كانت البطاقةُ تقف عند حائطَين لا وجودَ لهما في الخادم أصلاً:
 *
 * ١) **«احفظ ملف التصميم أولاً»** — الشرطُ `revision != null` كان يُخفي زرَّ الطلب حتى تُرفَع
 *    صورةٌ وتُحفَظ نسخة. والخادمُ لا يشترط ذلك إطلاقاً: `ensureCurrentDesignRevisionTx` يُثبّت
 *    النسخةَ الأولى تلقائياً من نصّ التخصيص القائم ولو بلا صورةٍ واحدة. فالحجبُ كان في الشاشة
 *    وحدها — نمطُ «الشاشة تحجب ما يملكه الخادم» (#911). والرفعُ نفسه كان يملأ القاعدةَ بصور
 *    base64 (حتى ٢م × ١٠ لكلّ أمر) بلا فائدةٍ تشغيليّة. الملفُّ صار **اختيارياً** صراحةً.
 *
 * ٢) **القرارُ في شاشةٍ أخرى** — «افتح مهمة القرار الموثّق» تنقل المديرَ إلى `/tasks/:id`
 *    ليكتب سبباً ونوعَ دليلٍ ومرجعاً ثمّ يعود. صار القرارُ هنا بنقرةٍ أو نقرتين: أسبابٌ جاهزة
 *    ومرجعُ دليلٍ مبنيٌّ من سياق الأمر (**قابلٌ للتحرير**) — والمهمّةُ تبقى سجلّاً كما هي.
 *
 * ⛔ ما لم يتغيّر: فصلُ الواجبات (الطالبُ/منشئُ النسخة/الفنّيُّ المسنَد لا يعتمدون)، وإلزامُ
 * السبب والدليل، وبصمةُ المحتوى، والإنفاذُ الخادميُّ كاملاً. البطاقةُ لا تُخفّف حارساً — تُزيل
 * حاجزاً كان في الواجهة فقط.
 */
import { useState } from "react";
import {
  CheckCircle2,
  Clock,
  FileCheck2,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  DESIGN_APPROVAL_EVIDENCE_LABELS,
  DESIGN_APPROVAL_REASONS,
  DESIGN_REJECTION_REASONS,
  designApprovalEvidenceLabel,
  designApprovalEvidenceReference,
  type DesignApprovalEvidenceTypeKey,
} from "@shared/designApprovalEvidence";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { canDecideDesignApproval, designApprovalSelfReviewBlocked } from "@/lib/designApprovalPolicy";
import { notify } from "@/lib/notify";
import { trpc, type RouterInputs } from "@/lib/trpc";

type RequestInput = RouterInputs["workOrderDesignApproval"]["request"];
type DecideInput = RouterInputs["workOrderDesignApproval"]["decide"];
type Decision = DecideInput["decision"];

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

function newDecisionKey(approvalId: number): string {
  return `wo-design-decision-${approvalId}-${crypto.randomUUID()}`;
}

export default function DesignApprovalCard({
  workOrderId,
  status,
  canManage,
  onChanged,
}: {
  workOrderId: number;
  status: string;
  /** صلاحية طلب الاعتماد (تنفيذ طلبات الخدمة)؛ القرارُ محكومٌ بسلطة المدير وفصل الواجبات. */
  canManage: boolean;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const current = trpc.workOrderDesignApproval.getCurrent.useQuery({ workOrderId });
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");
  const [requestInput, setRequestInput] = useState<RequestInput | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);

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
      setShowNote(false);
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
  const order = current.data?.workOrder ?? null;
  const approvalStatus = approval?.status as keyof typeof STATUS_META | undefined;
  const meta = approvalStatus ? STATUS_META[approvalStatus] : null;
  const StatusIcon = meta?.icon ?? ShieldCheck;
  const terminal = status === "DELIVERED" || status === "CANCELLED";
  /**
   * ⚠️ **لا شرطَ `revision != null` بعد اليوم.** الخادمُ يُثبّت النسخةَ عند أوّل طلب، فاشتراطُ
   * وجودها مسبقاً كان يُلزم برفعِ ملفٍّ لا يطلبه أحد.
   */
  const mayRequest = canManage && !terminal && approval == null;

  const myId = me.data?.id == null ? undefined : Number(me.data.id);
  const reviewerAuthority = canDecideDesignApproval(
    me.data?.role,
    me.data?.permissionsOverride ?? null,
  );
  const selfReviewBlocked = designApprovalSelfReviewBlocked(myId, [
    approval?.requestedBy,
    revision?.createdBy,
    order?.assignedTo,
    task?.assignedTo,
  ]);
  const mayDecide =
    approval != null && approval.status === "PENDING" && !terminal && reviewerAuthority && !selfReviewBlocked;

  return (
    <div className="rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 aria-hidden className="size-4" />
        <span className="font-bold">اعتماد التصميم</span>
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
        <p className="mt-3 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          رفعُ ملفّ التصميم غير مطلوب. عند إرسال الطلب يُثبّت النظام النسخة الحالية (نصّ التخصيص
          كما هو) ويبصمها، فتصير الموافقة موثّقةً بلا أيّ مرفق.
        </p>
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
              <div className="mt-1 text-muted-foreground">{designApprovalEvidenceLabel(approval.evidenceType)}</div>
              <div className="mt-1 break-words" dir="auto">{approval.evidenceReference}</div>
            </div>
          )}

          {mayDecide && decision == null && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={() => setDecision("APPROVED")}>
                <ThumbsUp aria-hidden className="me-1 size-3.5" /> موافق — اعتمد التصميم
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDecision("REJECTED")}>
                <ThumbsDown aria-hidden className="me-1 size-3.5" /> رفض العميل
              </Button>
            </div>
          )}

          {mayDecide && decision != null && (
            <DesignDecisionInline
              approvalId={Number(approval.id)}
              decision={decision}
              orderNumber={order?.orderNumber ?? ""}
              revision={Number(revision?.revision ?? 1)}
              onCancel={() => setDecision(null)}
              onDecided={async () => {
                setDecision(null);
                await refresh();
              }}
            />
          )}

          {approval.status === "PENDING" && !mayDecide && (
            <p className="text-2xs text-muted-foreground">
              {!reviewerAuthority
                ? "بانتظار قرار مديرٍ مخوَّل — الطلب مسجّل ولا يغيّر حالة الأمر."
                : "فصل الواجبات يمنعك من مراجعة هذا الطلب (أنت طالبه أو منشئ نسخته أو الفنّي المسنَد)."}
            </p>
          )}

          {task && (
            <Button asChild size="sm" variant="ghost">
              <a href={`/tasks/${Number(task.id)}`}>سجلّ المهمة الكامل</a>
            </Button>
          )}
        </div>
      ) : mayRequest ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={request.isPending} onClick={submitRequest}>
              {request.isPending ? ACTION_LABELS.sending : (
                <><FileCheck2 aria-hidden className="me-1 size-3.5" /> اطلب اعتماد التصميم</>
              )}
            </Button>
            {!showNote && (
              <Button size="sm" variant="ghost" disabled={request.isPending} onClick={() => setShowNote(true)}>
                أضف ملاحظة للمراجع
              </Button>
            )}
          </div>
          {showNote && (
            <div className="space-y-2 rounded-md border p-3">
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
              <Button
                size="sm"
                variant="ghost"
                disabled={request.isPending}
                onClick={() => { setShowNote(false); setNote(""); setRequestInput(null); }}
              >
                {ACTION_LABELS.cancel}
              </Button>
            </div>
          )}
          <p className="text-2xs text-muted-foreground">
            الطلب لا يغيّر حالة أمر الشغل ولا يفتح التنفيذ؛ القرار يحتاج مديراً آخر ودليلاً منظماً.
          </p>
        </div>
      ) : !canManage ? (
        <p className="mt-3 text-xs text-muted-foreground">هذه النسخة لم تُرسل للاعتماد بعد.</p>
      ) : null}
    </div>
  );
}

/**
 * **القرارُ في مكانه** — سببٌ بنقرة، ومرجعُ دليلٍ مبنيٌّ من سياق الأمر يبقى قابلاً للتحرير.
 * المرجعُ المُهيَّأ ليس حشواً: يحمل رقم الأمر والنسخة والتاريخ، فيُعيد بناءَ الواقعة بلا مرفق.
 */
function DesignDecisionInline({
  approvalId,
  decision,
  orderNumber,
  revision,
  onCancel,
  onDecided,
}: {
  approvalId: number;
  decision: Decision;
  orderNumber: string;
  revision: number;
  onCancel: () => void;
  onDecided: () => Promise<void>;
}) {
  const presets = decision === "APPROVED" ? DESIGN_APPROVAL_REASONS : DESIGN_REJECTION_REASONS;
  const [reason, setReason] = useState<string>(presets[0]);
  const [evidenceType, setEvidenceType] = useState<DesignApprovalEvidenceTypeKey>("OTHER");
  // المرجعُ المُهيَّأ يتبع القرارَ نصّاً — «رفض» لا يُوثَّق بعبارة «موافقة» (مراجعة Codex P1).
  const [evidenceReference, setEvidenceReference] = useState(() =>
    designApprovalEvidenceReference(decision, {
      orderNumber,
      revision,
      stampedAt: new Date().toLocaleDateString("ar-IQ-u-nu-latn"),
    }),
  );
  const [replayInput, setReplayInput] = useState<DecideInput | null>(null);

  const decide = trpc.workOrderDesignApproval.decide.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.replayed
          ? "أُعيدت نتيجة القرار نفسه دون تكرار"
          : decision === "APPROVED"
            ? "اعتُمد التصميم — التنفيذ مفتوح الآن"
            : "سُجّل رفض العميل للنسخة الحالية",
      );
      await onDecided();
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
        evidence: { type: evidenceType, reference: evidenceReference.trim() },
      } satisfies DecideInput);
    setReplayInput(input);
    decide.mutate(input);
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1.5">
        <span className="text-xs font-bold">سبب القرار</span>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => { setReason(preset); clearReplay(); }}
              className={`rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                reason === preset ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>
        <Input
          value={reason}
          onChange={(event) => { setReason(event.target.value); clearReplay(); }}
          maxLength={500}
          aria-invalid={reason.length > 0 && reason.trim().length < 3}
          placeholder="أو اكتب السبب…"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`design-evidence-type-${approvalId}`} className="text-xs font-bold">نوع الدليل</label>
          <AppSelect
            id={`design-evidence-type-${approvalId}`}
            value={evidenceType}
            onValueChange={(value) => { setEvidenceType(value as DesignApprovalEvidenceTypeKey); clearReplay(); }}
          >
            {Object.entries(DESIGN_APPROVAL_EVIDENCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </AppSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor={`design-evidence-reference-${approvalId}`} className="text-xs font-bold">مرجع الدليل</label>
          <Input
            id={`design-evidence-reference-${approvalId}`}
            value={evidenceReference}
            onChange={(event) => { setEvidenceReference(event.target.value); clearReplay(); }}
            maxLength={500}
            aria-invalid={evidenceReference.length > 0 && evidenceReference.trim().length < 3}
            placeholder="رقم الرسالة أو وصف الموافقة الشفهية"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={decision === "REJECTED" ? "destructive" : "default"}
          disabled={decide.isPending || !valid}
          onClick={submit}
        >
          {decide.isPending
            ? ACTION_LABELS.submitting
            : decision === "APPROVED" ? "تأكيد الاعتماد" : "تأكيد الرفض"}
        </Button>
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={onCancel}>
          {ACTION_LABELS.cancel}
        </Button>
        {!valid && (
          <span className="text-2xs font-bold text-[var(--sem-warn)]">
            السبب ومرجع الدليل: ٣ محارف على الأقل لكلٍّ منهما.
          </span>
        )}
      </div>
    </div>
  );
}
