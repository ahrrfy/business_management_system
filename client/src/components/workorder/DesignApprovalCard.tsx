/**
 * **بطاقة موافقة العميل على التصميم** (ش٢، ١٩/٨).
 *
 * الحالةُ **مشتقّةٌ من الواقع** لا من عَلَم: «هل ثمّة مهمّةٌ حاجزة مفتوحة؟». فلا تكذب البطاقة
 * على الموظّف حين تُفتَح نسخةٌ جديدة — تعود «بانتظار الموافقة» تلقائياً.
 *
 * وثلاثةُ أفعالٍ صريحة لا قائمةَ حالات: **اطلب** · **سجّل الموافقة** · **بانتظار ردّ العميل**
 * (الأخيرة تجمّد عدّاد SLA فلا يُحسَب الأمرُ متأخّراً وهو ينتظر الزبون).
 *
 * ⛔ لا مخرجَ مسدود (قرار المالك ق١): «أغلقها بسبب» متاحةٌ للمدير حين لا يردّ العميل — أمرٌ
 * يبقى محجوزاً أبداً يدفع الموظّف إلى الالتفاف (إلغاءٍ وإعادةِ إنشاء يمسّان العربون والذمّة).
 */
import { useState } from "react";
import { CheckCircle2, Clock, FileCheck2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export default function DesignApprovalCard({
  workOrderId,
  /** الحالة الحاليّة لأمر الشغل — البطاقة تُخفى على المُسلَّم/الملغى. */
  status,
  /** المهمّة الحاجزة كما يقولها `workOrders.get` — مشتقّةٌ من الواقع لا من عَلَم. */
  blockingTask,
  canManage,
  onChanged,
}: {
  workOrderId: number;
  status: string;
  blockingTask: TaskRow | null;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const open = blockingTask;

  const request = trpc.workOrders.requestDesignApproval.useMutation({
    onSuccess: (r) => {
      notify.ok(r.created ? `فُتح طلب موافقة ${r.taskNumber}` : `الطلب مفتوحٌ سلفاً (${r.taskNumber})`);
      void utils.workOrders.get.invalidate({ workOrderId });
      onChanged?.();
    },
    onError: (e) => notify.err(e),
    onSettled: () => setBusy(false),
  });

  if (status === "DELIVERED" || status === "CANCELLED") return null;

  return (
    <div className="rounded-lg border p-4 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <FileCheck2 aria-hidden className="size-4" />
        <span className="font-bold">موافقة العميل على التصميم</span>
      </div>

      {open ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-2xs font-extrabold text-[var(--sem-warn)]">
              {open.status === "WAITING_CUSTOMER" ? "بانتظار ردّ العميل" : "بانتظار الموافقة"}
            </span>
            <span className="font-mono text-2xs text-muted-foreground" dir="ltr">{open.taskNumber}</span>
            {open.dueAt && (
              <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                <Clock aria-hidden className="size-3" /> {String(open.dueAt).slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            التنفيذ محجوزٌ حتى تُغلَق هذه المهمّة — لا تُستهلك الخامة على تصميمٍ لم يُقرَّ.
            سجّل الموافقة أو أغلقها بسبب من شاشة المهام.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href={`/tasks/${open.id}`}>
                <CheckCircle2 aria-hidden className="size-3.5 me-1" /> افتح المهمّة وسجّل الموافقة
              </a>
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            لا طلبَ موافقةٍ مفتوح — التنفيذ متاح. اطلب الموافقة إن كان التصميم يحتاج إقرار العميل
            قبل استهلاك الخامة.
          </p>
          {canManage && (
            <Button
              size="sm"
              className="mt-3"
              disabled={busy || request.isPending}
              onClick={() => {
                setBusy(true);
                request.mutate({ workOrderId });
              }}
            >
              {request.isPending ? (
                <><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> جارٍ الفتح…</>
              ) : (
                <><FileCheck2 aria-hidden className="size-3.5 me-1" /> اطلب موافقة العميل</>
              )}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export interface TaskRow {
  id: number;
  taskNumber: string;
  title: string;
  status: string;
  dueAt: string | Date | null;
}
