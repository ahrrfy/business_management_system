/**
 * **موافقة العميل على التصميم** (ش٢ من المرحلة ٢، ١٩/٨).
 *
 * لا كيانَ جديد ولا عَلَم: الموافقة **مهمّةٌ** في `tasks` نوعُها حاجز (`blocksExecution`).
 * وثلاثةُ مكاسب تأتي من ذلك بلا كود:
 *   · الأولوية والمهلة يشتقّهما `createTask` من `slaHours` الخاصّ بالنوع.
 *   · «بانتظار ردّ العميل» = `tasks.setWaiting` — يجمّد عدّاد SLA فلا يُحسَب الأمرُ متأخّراً ظلماً.
 *   · التسجيل والسبب والفاعل والزمن كلّها في `taskEvents` القائمة — لا `approvedAt/By`.
 *
 * و**الإبطالُ بنيويّ**: الحارس معرَّفٌ بـ«لا مهمّةَ حاجزة مفتوحة» لا بعَلَمِ `approved`. فنسخةُ
 * تصميمٍ جديدة تفتح مهمّةً جديدة ⇒ الموافقة السابقة تبطل **بحكم البناء** لا بكاتبٍ ثانٍ ينجرف.
 *
 * ⛔ لا مخرجَ مسدود (قرار المالك ق١): المهمّة تُغلَق بـ`tasks.resolve` المديريّ بسببٍ إلزاميّ
 * حين لا يردّ العميل — أمرٌ يبقى محجوزاً أبداً أسوأ من غياب الحارس، لأنّه يدفع الموظّف إلى
 * الالتفاف (إلغاءٍ وإعادةِ إنشاءٍ يمسّان العربون والذمّة والترقيم).
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { serviceTypes, tasks } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { createTask } from "../tasks/create";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

/** اسمُ نوع الخدمة الحاجز المبذور في هجرة 0217 — مصدرُ الحقيقة الوحيد لاسمه. */
export const DESIGN_APPROVAL_SERVICE_TYPE = "موافقة تصميم";

/** المهمّة الحاجزة المفتوحة لهذا الأمر (إن وُجدت) — نفس تعريف الحارس حرفياً. */
export async function findOpenBlockingTask(tx: Tx, workOrderId: number) {
  const rows = await tx
    .select({
      id: tasks.id,
      taskNumber: tasks.taskNumber,
      title: tasks.title,
      status: tasks.taskStatus,
      dueAt: tasks.dueAt,
      assignedTo: tasks.assignedTo,
    })
    .from(tasks)
    .innerJoin(serviceTypes, eq(serviceTypes.id, tasks.serviceTypeId))
    .where(
      and(
        eq(tasks.linkedWorkOrderId, workOrderId),
        inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
        eq(serviceTypes.blocksExecution, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface RequestDesignApprovalInput {
  workOrderId: number;
  /** ملاحظةٌ تُرسَل مع الطلب (تظهر في وصف المهمّة وسجلّها). */
  note?: string | null;
  /** المسؤول عن متابعة الموافقة — غيابُه يترك المهمّة في الطابور العامّ. */
  assignedTo?: number | null;
}

/**
 * يفتح مهمّةَ موافقةٍ حاجزة — **داخل معاملةٍ قائمة أو جديدة** (نمط `createTask` نفسه).
 *
 * **idempotent**: مهمّةٌ حاجزة مفتوحة تُعاد كما هي بلا فتح ثانية. وهذا ما يعطي
 * `setWorkOrderDesign` سلوكَها الصحيح مجّاناً: حفظُ نسخةٍ والأمرُ محجوزٌ سلفاً لا يضاعف
 * المهام، وحفظُها بعد إقرارٍ يفتح مهمّةً جديدة فيعود الحجز.
 */
export async function requestDesignApprovalTx(
  tx: Tx,
  input: RequestDesignApprovalInput,
  actor: Actor & { role?: string },
) {
  const wo = await loadWorkOrder(tx, input.workOrderId);
  assertWorkOrderBranch(wo, actor);

  const existing = await findOpenBlockingTask(tx, input.workOrderId);
  if (existing) {
    return { taskId: Number(existing.id), taskNumber: existing.taskNumber, created: false as const };
  }

  const st = (
    await tx
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.name, DESIGN_APPROVAL_SERVICE_TYPE), eq(serviceTypes.isActive, true)))
      .limit(1)
  )[0];
  if (!st) {
    // النوع مبذورٌ في الهجرة؛ غيابُه يعني بيئةً لم تُهاجَر — نقولها صراحةً بدل فتح مهمّةٍ
    // غيرِ حاجزة تُعطي إحساساً كاذباً بالحماية.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `نوع الخدمة «${DESIGN_APPROVAL_SERVICE_TYPE}» غير موجود أو معطَّل — فعّله من إعدادات أنواع الخدمات أو طبّق الهجرة 0217.`,
    });
  }

  const created = await createTask(
    {
      branchId: Number(wo.branchId),
      title: `موافقة العميل على تصميم ${wo.orderNumber}`,
      description: input.note?.trim() || null,
      serviceTypeId: Number(st.id),
      linkedWorkOrderId: Number(wo.id),
      customerId: wo.customerId != null ? Number(wo.customerId) : null,
      // القناة تتبع الطلب — فيَعرف من يتابع أين يردّ الزبون.
      sourceChannel: (wo.receptionChannel as never) ?? null,
      assignedTo: input.assignedTo ?? null,
      // الأولوية والمهلة تُشتقّان من `slaHours` للنوع — لا تُمرَّران (undefined لا null).
    },
    { userId: actor.userId, branchId: Number(wo.branchId), role: actor.role },
    tx,
  );
  return { taskId: Number(created.taskId), taskNumber: created.taskNumber, created: true as const };
}

export async function requestDesignApproval(
  input: RequestDesignApprovalInput,
  actor: Actor & { role?: string },
) {
  return withTx((tx) => requestDesignApprovalTx(tx, input, actor));
}
