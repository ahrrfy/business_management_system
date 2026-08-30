// الموجة ١ (٣٠/٨/٢٦) — تعيين إشارةِ الفنّيّ داخل المرحلة (NORMAL/READY/BLOCKED).
// إشارةٌ متعامدةٌ على `workOrders.status` — لا أثر ماليّ ولا مخزنيّ إطلاقاً.
// القاموس الحاكم: `shared/workOrderKanban.ts`.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import {
  isKanbanStateApplicable,
  isWorkOrderKanbanState,
  type WorkOrderKanbanState,
} from "@shared/workOrderKanban";
import { logAuditTx } from "../auditService";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { type Actor, withTx } from "../tx";
import { assertOperatorOwns, assertWorkOrderBranch, loadWorkOrder } from "./helpers";

export async function setWorkOrderKanbanState(
  input: {
    workOrderId: number;
    kanbanState: WorkOrderKanbanState;
    blockedReason?: string | null;
  },
  actor: Actor & { role?: string },
) {
  const { workOrderId, kanbanState } = input;
  if (!isWorkOrderKanbanState(kanbanState)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "قيمةُ حالة الكانبان غير صالحة" });
  }
  // سببٌ إلزاميّ للـBLOCKED — بدونه الإشارةُ تصير علامةً خاويةً لا تُساعد المدير.
  const reason = kanbanState === "BLOCKED" ? (input.blockedReason ?? "").trim() : null;
  if (kanbanState === "BLOCKED" && !reason) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الإشارة «معطَّل» تحتاج سبباً موجزاً — اكتب سبب التعطيل",
    });
  }
  if (kanbanState === "BLOCKED" && reason && reason.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب التعطيل طويل جدّاً — أقصاه 255 حرفاً",
    });
  }

  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    assertOperatorOwns(wo, actor);
    // الإشارةُ ذاتُ معنى في الحالات النشطة فقط — الأمرُ المُسلَّم/الملغى نهايةٌ.
    if (!isKanbanStateApplicable(wo.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا تُوضَع إشارةُ كانبان على أمرٍ خارج دورة العمل",
      });
    }
    // Idempotency: لم تتغيّر الإشارة ولا السبب ⇒ لا سجلَّ جديدٌ.
    const currentReason = (wo.blockedReason as string | null) ?? null;
    const noChange =
      wo.kanbanState === kanbanState &&
      (kanbanState !== "BLOCKED" || currentReason === reason);
    if (noChange) return { workOrderId, kanbanState, blockedReason: reason };

    await tx
      .update(workOrders)
      .set({
        kanbanState,
        // BLOCKED يُخزَّن مع سببه؛ الخروجُ من BLOCKED يمسحه — لا سبب معلَّق.
        blockedReason: kanbanState === "BLOCKED" ? reason : null,
      })
      .where(eq(workOrders.id, workOrderId));

    await logAuditTx(
      tx,
      { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
      {
        action: "workOrder.setKanbanState",
        entityType: "workOrder",
        entityId: workOrderId,
        oldValue: { kanbanState: wo.kanbanState, blockedReason: currentReason },
        newValue: { kanbanState, blockedReason: reason },
      },
    );
    // مرآةٌ في `workOrderEvents` — سجلٌّ منظَّم بأعمدة مُنمَّطة (نمط CLAIMED نفسه).
    // `eventKey` بعدّاد وقتيّ (Date.now) لأنّه قد يتكرّر لنفس الأمر (فنّيّ يبدّل ثم يُعيد).
    await recordWorkOrderEvent(tx, {
      workOrderId,
      eventType: "KANBAN_STATE_CHANGED",
      fromStatus: wo.status,
      toStatus: wo.status,
      actorUserId: actor.userId,
      branchId: actor.branchId ?? Number(wo.branchId),
      payload: {
        from: wo.kanbanState,
        to: kanbanState,
        blockedReason: reason,
      },
      seq: Date.now(),
    });

    return { workOrderId, kanbanState, blockedReason: reason };
  });
}
