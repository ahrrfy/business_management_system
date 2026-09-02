import { moduleAccessAllowed } from "@shared/permissions";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import {
  serviceTypes,
  taskEvents,
  tasks,
  workOrderDesignApprovals,
  workOrderDesignRevisions,
  workOrderImages,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { isDupEntry } from "@shared/errorMap.ar";
import { logAuditTx } from "../auditService";
import { idempotencyHash } from "../idempotency";
import { createTask } from "../tasks/create";
import { type Actor, withTx } from "../tx";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { DESIGN_APPROVAL_SERVICE_TYPE } from "./approval";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

export const DESIGN_APPROVAL_EVIDENCE_TYPES = [
  "WHATSAPP_MESSAGE",
  "CUSTOMER_SIGNATURE",
  "EMAIL",
  "ATTACHMENT",
  "OTHER",
] as const;

export type DesignApprovalEvidenceType =
  (typeof DESIGN_APPROVAL_EVIDENCE_TYPES)[number];
export type DesignApprovalDecision = "APPROVED" | "REJECTED";
export type DesignApprovalActor = Actor & {
  role?: string;
  permissionsOverride?: unknown;
};

export interface DesignContentImage {
  url: string;
  caption?: string | null;
  sortOrder?: number | null;
}

export interface RequestWorkOrderDesignApprovalInput {
  workOrderId: number;
  requestKey: string;
  note?: string | null;
}

export interface DecideWorkOrderDesignApprovalInput {
  approvalId: number;
  decisionKey: string;
  decision: DesignApprovalDecision;
  reason: string;
  evidence: {
    type: DesignApprovalEvidenceType;
    reference: string;
  };
}

function normalizedOptionalText(
  value: string | null | undefined,
): string | null {
  return value?.trim() || null;
}

function normalizedRequiredText(
  value: string,
  label: string,
  max = 500,
): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length < 3 || normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب (3-${max} محرف)`,
    });
  }
  return normalized;
}

function normalizedKey(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 120) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} مطلوب وبحد أقصى 120 محرفاً`,
    });
  }
  return normalized;
}

/** الترتيب والصورة والعنوان كلّها جزء من مستند التصميم الذي يوافق عليه العميل. */
export function normalizeDesignContentImages(images: DesignContentImage[]) {
  return images
    .map((image, index) => ({
      url: image.url.trim(),
      caption: normalizedOptionalText(image.caption),
      sortOrder: image.sortOrder ?? index,
      ordinal: index,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.ordinal - b.ordinal)
    .map(({ ordinal: _ordinal, ...image }) => image);
}

/** بصمة قانونية ثابتة لنسخة التصميم، وتشمل النسخة النصية حتى حين يكون عدد الصور صفراً. */
export function workOrderDesignContentHash(
  customizationSnapshot: string | null,
  images: DesignContentImage[],
): string {
  return idempotencyHash({
    customizationSnapshot,
    images: normalizeDesignContentImages(images),
  });
}

async function currentRevisionHead(tx: Tx, workOrderId: number, lock = false) {
  let query = tx
    .select()
    .from(workOrderDesignRevisions)
    .where(eq(workOrderDesignRevisions.workOrderId, workOrderId))
    .orderBy(desc(workOrderDesignRevisions.revision))
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  return (await query)[0] ?? null;
}

async function revisionImages(
  tx: Tx,
  workOrderId: number,
  revision: number,
  lock = false,
) {
  let query = tx
    .select({
      url: workOrderImages.url,
      caption: workOrderImages.caption,
      sortOrder: workOrderImages.sortOrder,
    })
    .from(workOrderImages)
    .where(
      and(
        eq(workOrderImages.workOrderId, workOrderId),
        eq(workOrderImages.revision, revision),
      ),
    )
    .orderBy(asc(workOrderImages.sortOrder), asc(workOrderImages.id));
  if (lock) query = query.for("update") as typeof query;
  return query;
}

export async function createWorkOrderDesignRevisionTx(
  tx: Tx,
  input: {
    workOrderId: number;
    branchId: number;
    revision: number;
    customizationSnapshot: string | null;
    images: DesignContentImage[];
    reason: string;
    createdBy: number;
  },
) {
  const normalizedImages = normalizeDesignContentImages(input.images);
  const contentHash = workOrderDesignContentHash(
    input.customizationSnapshot,
    normalizedImages,
  );
  const result = await tx.insert(workOrderDesignRevisions).values({
    workOrderId: input.workOrderId,
    branchId: input.branchId,
    revision: input.revision,
    customizationSnapshot: input.customizationSnapshot,
    contentHash,
    reason: normalizedRequiredText(input.reason, "سبب إنشاء نسخة التصميم"),
    createdBy: input.createdBy,
  });
  return {
    id: extractInsertId(result),
    revision: input.revision,
    customizationSnapshot: input.customizationSnapshot,
    contentHash,
    createdBy: input.createdBy,
  };
}

/**
 * تهيئةٌ انتقالية للأوامر السابقة للهجرة 0299. لا تُستعمل في القراءة؛ فقط داخل مسار كتابة
 * مقفول (حفظ تصميم أو طلب اعتماد) كي لا يحوّل GET إلى طفرة خفية.
 */
export async function ensureCurrentDesignRevisionTx(
  tx: Tx,
  wo: typeof workOrders.$inferSelect,
  fallbackActorUserId: number,
) {
  const existing = await currentRevisionHead(tx, Number(wo.id), true);
  if (existing) return existing;

  const maxRow = (
    await tx
      .select({
        value: sql<number>`COALESCE(MAX(${workOrderImages.revision}), 0)`,
      })
      .from(workOrderImages)
      .where(eq(workOrderImages.workOrderId, Number(wo.id)))
  )[0];
  const revision = Math.max(1, Number(maxRow?.value ?? 0));
  const images = await revisionImages(tx, Number(wo.id), revision, true);
  const created = await createWorkOrderDesignRevisionTx(tx, {
    workOrderId: Number(wo.id),
    branchId: Number(wo.branchId),
    revision,
    customizationSnapshot: wo.customizationText ?? null,
    images,
    reason: "تهيئة نسخة التصميم الحالية قبل الاعتماد",
    // الأمر التاريخي قد لا يحمل createdBy؛ طالب الكتابة الحالي هو منشئ النسخة الانتقالية فعلياً.
    createdBy:
      wo.createdBy == null ? fallbackActorUserId : Number(wo.createdBy),
  });
  return {
    ...created,
    workOrderId: Number(wo.id),
    branchId: Number(wo.branchId),
    reason: "تهيئة نسخة التصميم الحالية قبل الاعتماد",
    createdAt: new Date(),
  } as typeof workOrderDesignRevisions.$inferSelect;
}

async function assertRevisionHashIsCurrent(
  tx: Tx,
  wo: typeof workOrders.$inferSelect,
  revision: typeof workOrderDesignRevisions.$inferSelect,
) {
  const images = await revisionImages(
    tx,
    Number(wo.id),
    Number(revision.revision),
    true,
  );
  const liveHash = workOrderDesignContentHash(
    wo.customizationText ?? null,
    images,
  );
  const storedSnapshotHash = workOrderDesignContentHash(
    revision.customizationSnapshot ?? null,
    images,
  );
  if (
    liveHash !== revision.contentHash ||
    storedSnapshotHash !== revision.contentHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "تغيّر محتوى التصميم بعد إنشاء نسخته — احفظ نسخة جديدة ثم اطلب اعتمادها",
    });
  }
}

function assertApprovalBranch(
  row: { branchId: number | string },
  actor: DesignApprovalActor,
) {
  if (actor.role !== "admin" && Number(row.branchId) !== actor.branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "اعتماد التصميم لا يخصّ فرعك",
    });
  }
}

function assertReviewerAuthority(actor: DesignApprovalActor) {
  const allowed = moduleAccessAllowed(
    actor.role ?? "",
    (actor.permissionsOverride as never) ?? null,
    "workorders",
    "FULL",
    ["manager"],
  );
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "قرار اعتماد التصميم محصور بمدير الوحدة أو بمن مُنح صلاحيتها الكاملة صراحةً",
    });
  }
}

async function closeApprovalTaskTx(
  tx: Tx,
  taskId: number | null,
  status: "RESOLVED" | "CANCELLED",
  note: string,
  actorUserId: number,
) {
  if (taskId == null) return;
  const task = (
    await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update")
      .limit(1)
  )[0];
  if (!task)
    throw new TRPCError({
      code: "CONFLICT",
      message: "مهمة اعتماد التصميم المرتبطة غير موجودة",
    });
  if (task.taskStatus === status) return;
  if (!["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"].includes(task.taskStatus)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "حالة مهمة اعتماد التصميم لا تطابق حالة طلب الاعتماد — راجع سجل المهمة",
    });
  }
  await tx
    .update(tasks)
    .set({
      taskStatus: status,
      resolvedAt: status === "RESOLVED" ? sql`NOW()` : null,
      resolutionNote: note,
      waitingSince: null,
    })
    .where(eq(tasks.id, taskId));
  await tx.insert(taskEvents).values({
    taskId,
    eventType: "STATUS",
    fromStatus: task.taskStatus,
    toStatus: status,
    note,
    userId: actorUserId,
  });
}

/** النسخة الجديدة تُبطل أي طلب سابق وتغلق مهمته داخلياً؛ المسارات العامة تبقى ممنوعة. */
export async function supersedePendingDesignApprovalsTx(
  tx: Tx,
  workOrderId: number,
  actorUserId: number,
  exceptRevisionId?: number | null,
) {
  const conditions = [
    eq(workOrderDesignApprovals.workOrderId, workOrderId),
    eq(workOrderDesignApprovals.status, "PENDING"),
  ];
  if (exceptRevisionId != null)
    conditions.push(ne(workOrderDesignApprovals.revisionId, exceptRevisionId));
  const pending = await tx
    .select()
    .from(workOrderDesignApprovals)
    .where(and(...conditions))
    .for("update");
  for (const approval of pending) {
    await closeApprovalTaskTx(
      tx,
      approval.taskId == null ? null : Number(approval.taskId),
      "CANCELLED",
      "أُبطل طلب الاعتماد لأن نسخة تصميم أحدث حُفظت",
      actorUserId,
    );
    await tx
      .update(workOrderDesignApprovals)
      .set({ status: "SUPERSEDED" })
      .where(eq(workOrderDesignApprovals.id, Number(approval.id)));
  }
}

function exactRequestReplay(
  row: typeof workOrderDesignApprovals.$inferSelect,
  input: RequestWorkOrderDesignApprovalInput,
  requestKey: string,
  note: string | null,
  actor: DesignApprovalActor,
) {
  return (
    row.requestKey === requestKey &&
    Number(row.workOrderId) === input.workOrderId &&
    Number(row.requestedBy) === actor.userId &&
    (row.requestNote ?? null) === note
  );
}

async function approvalByRequestKey(tx: Tx, requestKey: string) {
  return (
    (
      await tx
        .select()
        .from(workOrderDesignApprovals)
        .where(eq(workOrderDesignApprovals.requestKey, requestKey))
        .for("update")
        .limit(1)
    )[0] ?? null
  );
}

export async function requestWorkOrderDesignApproval(
  input: RequestWorkOrderDesignApprovalInput,
  actor: DesignApprovalActor,
) {
  const requestKey = normalizedKey(
    input.requestKey,
    "مفتاح طلب اعتماد التصميم",
  );
  const note = normalizedOptionalText(input.note);
  if (note && note.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ملاحظة طلب الاعتماد أطول من 500 محرف",
    });
  }

  return withTx(
    async (tx) => {
      const keyed = await approvalByRequestKey(tx, requestKey);
      if (keyed) {
        assertApprovalBranch(keyed, actor);
        if (!exactRequestReplay(keyed, input, requestKey, note, actor)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "مفتاح طلب الاعتماد مستخدم لنسخة أو حمولة مختلفة",
          });
        }
        return { approval: keyed, replayed: true as const };
      }

      const wo = await loadWorkOrder(tx, input.workOrderId);
      assertWorkOrderBranch(wo, actor);
      if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يُطلب اعتماد تصميم لأمر منتهٍ",
        });
      }
      const revision = await ensureCurrentDesignRevisionTx(
        tx,
        wo,
        actor.userId,
      );
      await assertRevisionHashIsCurrent(tx, wo, revision);
      await supersedePendingDesignApprovalsTx(
        tx,
        input.workOrderId,
        actor.userId,
        Number(revision.id),
      );

      const already = (
        await tx
          .select()
          .from(workOrderDesignApprovals)
          .where(eq(workOrderDesignApprovals.revisionId, Number(revision.id)))
          .for("update")
          .limit(1)
      )[0];
      if (already) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `نسخة التصميم ${revision.revision} لها طلب اعتماد قائم أو محسوم بالفعل`,
        });
      }

      const serviceType = (
        await tx
          .select({ id: serviceTypes.id })
          .from(serviceTypes)
          .where(
            and(
              eq(serviceTypes.name, DESIGN_APPROVAL_SERVICE_TYPE),
              eq(serviceTypes.isActive, true),
              eq(serviceTypes.blocksExecution, true),
            ),
          )
          .limit(1)
      )[0];
      if (!serviceType) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `نوع الخدمة «${DESIGN_APPROVAL_SERVICE_TYPE}» غير موجود أو غير حاجز`,
        });
      }

      let approvalId: number;
      try {
        const inserted = await tx.insert(workOrderDesignApprovals).values({
          requestKey,
          workOrderId: Number(wo.id),
          branchId: Number(wo.branchId),
          revisionId: Number(revision.id),
          taskId: null,
          status: "PENDING",
          requestedBy: actor.userId,
          requestNote: note,
        });
        approvalId = extractInsertId(inserted);
      } catch (error) {
        if (!isDupEntry(error)) throw error;
        const raced = await approvalByRequestKey(tx, requestKey);
        if (
          !raced ||
          !exactRequestReplay(raced, input, requestKey, note, actor)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "طُلب اعتماد هذه النسخة بالتزامن بطلب مختلف",
          });
        }
        return { approval: raced, replayed: true as const };
      }

      // نُنشئ المهمة بعد حجز صف الطلب وقيديه الفريدين. لو تسابق مفتاحان على النسخة لا تترك
      // المعاملة الخاسرة مهمةً يتيمة، ولو فشل إنشاء المهمة تتراجع المعاملة فيختفي الطلب أيضاً.
      const task = await createTask(
        {
          branchId: Number(wo.branchId),
          kind: "SERVICE_REQUEST",
          title: `اعتماد تصميم ${wo.orderNumber} — نسخة ${revision.revision}`,
          description: note ?? `بصمة التصميم: ${revision.contentHash}`,
          customerId: wo.customerId == null ? null : Number(wo.customerId),
          linkedWorkOrderId: Number(wo.id),
          serviceTypeId: Number(serviceType.id),
          sourceChannel: (wo.receptionChannel as never) ?? null,
          creationNote: `طُلب اعتماد نسخة التصميم ${revision.revision}`,
        },
        {
          userId: actor.userId,
          branchId: Number(wo.branchId),
          role: actor.role,
        },
        tx,
      );
      await tx
        .update(workOrderDesignApprovals)
        .set({ taskId: Number(task.taskId) })
        .where(eq(workOrderDesignApprovals.id, approvalId));

      await logAuditTx(
        tx,
        {
          user: { id: actor.userId, branchId: actor.branchId ?? null } as never,
          req: undefined as never,
        },
        {
          action: "workOrder.designApproval.request",
          entityType: "workOrder",
          entityId: Number(wo.id),
          branchId: Number(wo.branchId),
          newValue: {
            approvalId,
            revisionId: Number(revision.id),
            revision: Number(revision.revision),
            contentHash: revision.contentHash,
            taskId: Number(task.taskId),
            requestKey,
            note,
          },
        },
      );
      const approval = await approvalByRequestKey(tx, requestKey);
      return {
        approval: approval!,
        replayed: false as const,
        taskNumber: task.taskNumber,
      };
    },
    { gate: "NONE" },
  );
}

async function readApprovalViewByWorkOrder(tx: Tx, workOrderId: number) {
  const revision = await currentRevisionHead(tx, workOrderId, false);
  if (!revision)
    return { revision: null, approval: null, task: null, images: [] };
  const approval =
    (
      await tx
        .select()
        .from(workOrderDesignApprovals)
        .where(eq(workOrderDesignApprovals.revisionId, Number(revision.id)))
        .limit(1)
    )[0] ?? null;
  const task =
    approval?.taskId == null
      ? null
      : ((
          await tx
            .select()
            .from(tasks)
            .where(eq(tasks.id, Number(approval.taskId)))
            .limit(1)
        )[0] ?? null);
  const images = await revisionImages(
    tx,
    workOrderId,
    Number(revision.revision),
    false,
  );
  return {
    revision,
    approval,
    task: task ? designApprovalTaskContext(task) : null,
    images,
  };
}

/** سياق تشغيلي للتصميم فقط؛ لا نعيد تكاليف/هوامش أمر الشغل عبر بوابة READ. */
function designWorkOrderContext(wo: typeof workOrders.$inferSelect) {
  return {
    id: Number(wo.id),
    orderNumber: wo.orderNumber,
    branchId: Number(wo.branchId),
    status: wo.status,
    version: Number(wo.version),
    title: wo.title,
    customerId: wo.customerId == null ? null : Number(wo.customerId),
    assignedTo: wo.assignedTo == null ? null : Number(wo.assignedTo),
    customizationText: wo.customizationText ?? null,
  };
}

function designApprovalTaskContext(task: typeof tasks.$inferSelect) {
  return {
    id: Number(task.id),
    taskNumber: task.taskNumber,
    status: task.taskStatus,
    assignedTo: task.assignedTo == null ? null : Number(task.assignedTo),
    dueAt: task.dueAt,
    resolvedAt: task.resolvedAt,
    resolutionNote: task.resolutionNote,
    createdAt: task.createdAt,
  };
}

export async function getCurrentWorkOrderDesignApproval(
  workOrderId: number,
  actor: DesignApprovalActor,
) {
  return withTx(
    async (tx) => {
      const wo = await loadWorkOrder(tx, workOrderId);
      assertWorkOrderBranch(wo, actor);
      return {
        workOrder: designWorkOrderContext(wo),
        ...(await readApprovalViewByWorkOrder(tx, workOrderId)),
      };
    },
    { gate: "NONE" },
  );
}

export async function getWorkOrderDesignApprovalByTask(
  taskId: number,
  actor: DesignApprovalActor,
) {
  return withTx(
    async (tx) => {
      const approval = (
        await tx
          .select()
          .from(workOrderDesignApprovals)
          .where(eq(workOrderDesignApprovals.taskId, taskId))
          .limit(1)
      )[0];
      if (!approval)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "المهمة ليست طلب اعتماد تصميم متخصصاً",
        });
      assertApprovalBranch(approval, actor);
      const wo = await loadWorkOrder(tx, Number(approval.workOrderId));
      assertWorkOrderBranch(wo, actor);
      const revision = (
        await tx
          .select()
          .from(workOrderDesignRevisions)
          .where(eq(workOrderDesignRevisions.id, Number(approval.revisionId)))
          .limit(1)
      )[0];
      const task =
        (
          await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
        )[0] ?? null;
      const images = revision
        ? await revisionImages(
            tx,
            Number(wo.id),
            Number(revision.revision),
            false,
          )
        : [];
      return {
        workOrder: designWorkOrderContext(wo),
        revision: revision ?? null,
        approval,
        task: task ? designApprovalTaskContext(task) : null,
        images,
      };
    },
    { gate: "NONE" },
  );
}

function decisionPayloadHash(
  input: DecideWorkOrderDesignApprovalInput,
  reason: string,
  evidenceReference: string,
) {
  return idempotencyHash({
    approvalId: input.approvalId,
    decision: input.decision,
    reason,
    evidence: { type: input.evidence.type, reference: evidenceReference },
  });
}

function exactDecisionReplay(
  row: typeof workOrderDesignApprovals.$inferSelect,
  decisionKey: string,
  decisionHash: string,
  decision: DesignApprovalDecision,
  actor: DesignApprovalActor,
) {
  return (
    row.decisionKey === decisionKey &&
    row.decisionHash === decisionHash &&
    row.status === decision &&
    Number(row.reviewedBy) === actor.userId
  );
}

export async function decideWorkOrderDesignApproval(
  input: DecideWorkOrderDesignApprovalInput,
  actor: DesignApprovalActor,
) {
  assertReviewerAuthority(actor);
  const decisionKey = normalizedKey(
    input.decisionKey,
    "مفتاح قرار اعتماد التصميم",
  );
  const reason = normalizedRequiredText(input.reason, "سبب القرار");
  const evidenceReference = normalizedRequiredText(
    input.evidence.reference,
    "مرجع الدليل",
  );
  if (!DESIGN_APPROVAL_EVIDENCE_TYPES.includes(input.evidence.type)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نوع دليل اعتماد التصميم غير صالح",
    });
  }
  const decisionHash = decisionPayloadHash(input, reason, evidenceReference);

  return withTx(
    async (tx) => {
      const keyOwner = (
        await tx
          .select()
          .from(workOrderDesignApprovals)
          .where(eq(workOrderDesignApprovals.decisionKey, decisionKey))
          .for("update")
          .limit(1)
      )[0];
      if (keyOwner && Number(keyOwner.id) !== input.approvalId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح القرار مستخدم لاعتماد تصميم آخر",
        });
      }

      const approval = (
        await tx
          .select()
          .from(workOrderDesignApprovals)
          .where(eq(workOrderDesignApprovals.id, input.approvalId))
          .for("update")
          .limit(1)
      )[0];
      if (!approval)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "طلب اعتماد التصميم غير موجود",
        });
      assertApprovalBranch(approval, actor);
      if (approval.status !== "PENDING") {
        if (
          exactDecisionReplay(
            approval,
            decisionKey,
            decisionHash,
            input.decision,
            actor,
          )
        ) {
          return { approval, replayed: true as const };
        }
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب الاعتماد محسوم بمفتاح أو قرار مختلف",
        });
      }

      const wo = await loadWorkOrder(tx, Number(approval.workOrderId));
      assertWorkOrderBranch(wo, actor);
      const revision = (
        await tx
          .select()
          .from(workOrderDesignRevisions)
          .where(eq(workOrderDesignRevisions.id, Number(approval.revisionId)))
          .for("update")
          .limit(1)
      )[0];
      if (!revision)
        throw new TRPCError({
          code: "CONFLICT",
          message: "نسخة التصميم المرتبطة غير موجودة",
        });
      const current = await currentRevisionHead(tx, Number(wo.id), true);
      if (!current || Number(current.id) !== Number(revision.id)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب الاعتماد قديم؛ توجد نسخة تصميم أحدث",
        });
      }
      await assertRevisionHashIsCurrent(tx, wo, revision);

      const task =
        approval.taskId == null
          ? null
          : ((
              await tx
                .select()
                .from(tasks)
                .where(eq(tasks.id, Number(approval.taskId)))
                .for("update")
                .limit(1)
            )[0] ?? null);
      const forbiddenActors = new Set([
        Number(approval.requestedBy),
        Number(revision.createdBy),
        wo.assignedTo == null ? 0 : Number(wo.assignedTo),
        task?.assignedTo == null ? 0 : Number(task.assignedTo),
      ]);
      if (forbiddenActors.has(actor.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "فصل الواجبات يمنع طالب الاعتماد أو منشئ النسخة أو الفنّي المسند من مراجعتها",
        });
      }

      const reviewedAt = new Date();
      try {
        await tx
          .update(workOrderDesignApprovals)
          .set({
            status: input.decision,
            decisionKey,
            decisionHash,
            decisionReason: reason,
            evidenceType: input.evidence.type,
            evidenceReference,
            reviewedBy: actor.userId,
            reviewedAt,
          })
          .where(
            and(
              eq(workOrderDesignApprovals.id, input.approvalId),
              eq(workOrderDesignApprovals.status, "PENDING"),
            ),
          );
      } catch (error) {
        if (!isDupEntry(error)) throw error;
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح القرار استُهلك بالتزامن لاعتماد آخر",
        });
      }
      await closeApprovalTaskTx(
        tx,
        approval.taskId == null ? null : Number(approval.taskId),
        "RESOLVED",
        `${input.decision === "APPROVED" ? "اعتمد" : "رفض"} العميل التصميم — ${reason} — الدليل: ${input.evidence.type}:${evidenceReference}`,
        actor.userId,
      );
      await recordWorkOrderEvent(tx, {
        workOrderId: Number(wo.id),
        eventType:
          input.decision === "APPROVED" ? "DESIGN_APPROVED" : "DESIGN_REJECTED",
        payload: {
          approvalId: input.approvalId,
          revisionId: Number(revision.id),
          revision: Number(revision.revision),
          contentHash: revision.contentHash,
          reason,
          evidenceType: input.evidence.type,
          evidenceReference,
        },
        actorUserId: actor.userId,
        branchId: Number(wo.branchId),
        seq: input.approvalId,
      });
      await logAuditTx(
        tx,
        {
          user: { id: actor.userId, branchId: actor.branchId ?? null } as never,
          req: undefined as never,
        },
        {
          action: `workOrder.designApproval.${input.decision.toLowerCase()}`,
          entityType: "workOrder",
          entityId: Number(wo.id),
          branchId: Number(wo.branchId),
          oldValue: { approvalId: input.approvalId, status: "PENDING" },
          newValue: {
            approvalId: input.approvalId,
            status: input.decision,
            revision: Number(revision.revision),
            contentHash: revision.contentHash,
            reason,
            evidenceType: input.evidence.type,
            evidenceReference,
          },
        },
      );
      const decided = (
        await tx
          .select()
          .from(workOrderDesignApprovals)
          .where(eq(workOrderDesignApprovals.id, input.approvalId))
          .limit(1)
      )[0];
      return { approval: decided!, replayed: false as const };
    },
    { gate: "NONE" },
  );
}

/** الحارس الجديد: النسخة الأعلى نفسها، وبصمتها الحيّة، وقرارها الموافق، ومهمتها المغلقة. */
export async function assertCurrentDesignApproved(
  tx: Tx,
  workOrderId: number,
  action: "start" | "ready" | "deliver",
) {
  const wo = (
    await tx
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, workOrderId))
      .for("update")
      .limit(1)
  )[0];
  if (!wo)
    throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  const revision = await currentRevisionHead(tx, workOrderId, true);
  const actionLabel = action === "start"
    ? "بدء التنفيذ"
    : action === "deliver"
      ? "تسليم الأمر"
      : "وسم الأمر جاهزاً";
  if (!revision) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يمكن ${actionLabel}: لا توجد نسخة تصميم مسجّلة — احفظ التصميم واطلب اعتماده`,
    });
  }
  await assertRevisionHashIsCurrent(tx, wo, revision);
  const approval = (
    await tx
      .select()
      .from(workOrderDesignApprovals)
      .where(eq(workOrderDesignApprovals.revisionId, Number(revision.id)))
      .for("update")
      .limit(1)
  )[0];
  if (!approval || approval.status !== "APPROVED") {
    const state =
      approval?.status === "REJECTED"
        ? "رفض العميل هذه النسخة"
        : approval?.status === "PENDING"
          ? "طلب الاعتماد ما زال معلقاً"
          : "لم تُعتمد النسخة الحالية";
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يمكن ${actionLabel}: ${state}`,
    });
  }
  if (approval.taskId == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "الاعتماد الموافق بلا مهمة إثبات مرتبطة",
    });
  }
  const task = (
    await tx
      .select({ status: tasks.taskStatus })
      .from(tasks)
      .where(eq(tasks.id, Number(approval.taskId)))
      .for("update")
      .limit(1)
  )[0];
  if (!task || task.status !== "RESOLVED") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "قرار الاعتماد ومهمته غير متطابقين — راجع سجل المهمة",
    });
  }
  return { revision, approval };
}

/** تستعملها آلة المهام العامة كي لا تتجاوز عقد القرار المتخصص. */
export async function assertNotDesignApprovalTask(tx: Tx, taskId: number) {
  const linked = (
    await tx
      .select({ id: workOrderDesignApprovals.id })
      .from(workOrderDesignApprovals)
      .where(eq(workOrderDesignApprovals.taskId, taskId))
      .limit(1)
  )[0];
  if (linked) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "مهمة اعتماد التصميم لا تُحسم أو تُلغى أو تُعاد من مسار المهام العام — استخدم قرار اعتماد التصميم مع الدليل",
    });
  }
}
