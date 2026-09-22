/** حفظ ملف تصميم أمر الشغل كنسخٍ غير قابلة للمحو، مستقلة عن عدد الصور. */
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { workOrderImages, workOrders } from "../../../drizzle/schema";
import { assertValidImageDataUrl } from "../../lib/imageValidation";
import { logAuditTx } from "../auditService";
import { type Actor, withTx } from "../tx";
import { recordWorkOrderEvent } from "../workOrderEvents";
import {
  createWorkOrderDesignRevisionTx,
  ensureCurrentDesignRevisionTx,
  normalizeDesignContentImages,
  supersedePendingDesignApprovalsTx,
  workOrderDesignContentHash,
} from "./designApproval";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

const MAX_IMAGES = 10;

export interface DesignImageInput {
  url: string;
  caption?: string | null;
  sortOrder?: number | null;
}

export interface SetWorkOrderDesignInput {
  workOrderId: number;
  /** القائمة الكاملة للنسخة؛ القائمة الفارغة نسخة صحيحة تعني حذف جميع الصور. */
  images: DesignImageInput[];
  /** undefined = لا تغيّر النص؛ null = امسحه صراحةً. */
  customizationText?: string | null;
  note?: string | null;
}

export async function setWorkOrderDesign(
  input: SetWorkOrderDesignInput,
  actor: Actor & { role?: string },
) {
  const images = normalizeDesignContentImages(
    (input.images ?? [])
      .filter((image) => image.url?.trim())
      .slice(0, MAX_IMAGES),
  );
  for (const image of images)
    assertValidImageDataUrl(image.url, 2_000_000, true);

  return withTx(
    async (tx) => {
      const wo = await loadWorkOrder(tx, input.workOrderId);
      assertWorkOrderBranch(wo, actor);
      if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "لا يُعدَّل تصميم أمرٍ مُسلَّم أو ملغى — أنشئ أمراً جديداً أو اعكس التسليم أولاً",
        });
      }

      const current = await ensureCurrentDesignRevisionTx(
        tx,
        wo,
        actor.userId,
      );
      const customizationSnapshot =
        input.customizationText === undefined
          ? (wo.customizationText ?? null)
          : input.customizationText?.trim() || null;
      const desiredHash = workOrderDesignContentHash(
        customizationSnapshot,
        images,
      );
      const currentRevisionImages = await tx
        .select({
          url: workOrderImages.url,
          caption: workOrderImages.caption,
          sortOrder: workOrderImages.sortOrder,
        })
        .from(workOrderImages)
        .where(
          and(
            eq(workOrderImages.workOrderId, input.workOrderId),
            eq(workOrderImages.revision, Number(current.revision)),
          ),
        )
        .orderBy(asc(workOrderImages.sortOrder), asc(workOrderImages.id))
        .for("update");
      const liveHash = workOrderDesignContentHash(
        wo.customizationText ?? null,
        currentRevisionImages,
      );
      const storedSnapshotHash = workOrderDesignContentHash(
        current.customizationSnapshot ?? null,
        currentRevisionImages,
      );

      if (
        current.contentHash === desiredHash &&
        liveHash === current.contentHash &&
        storedSnapshotHash === current.contentHash
      ) {
        return {
          workOrderId: Number(wo.id),
          revision: Number(current.revision),
          changed: false as const,
          taskNumber: null as string | null,
        };
      }

      const nextRevision = Number(current.revision) + 1;
      if (images.length > 0) {
        await tx.insert(workOrderImages).values(
          images.map((image) => ({
            workOrderId: Number(wo.id),
            url: image.url,
            caption: image.caption,
            sortOrder: image.sortOrder,
            revision: nextRevision,
          })),
        );
      }
      const revision = await createWorkOrderDesignRevisionTx(tx, {
        workOrderId: Number(wo.id),
        branchId: Number(wo.branchId),
        revision: nextRevision,
        customizationSnapshot,
        images,
        reason: input.note?.trim() || `حفظ نسخة التصميم ${nextRevision}`,
        createdBy: actor.userId,
      });

      // أي تغيير بعد بدء الإنتاج يفتح دورة rework صريحة. الجاهز يعود قيد التنفيذ،
      // والحالة الداخلية تصبح BLOCKED حتى يعتمد العميل النسخة ثم يقرّ الفنّي استئنافها.
      // نكتب رأس الأمر دائماً حتى لو تغيّرت الصور وحدها: trigger النسخة يجعل طلبات التحكم
      // المفتوحة stale ولا يسمح لطلب قديم بتطبيق أثر على تصميم أحدث.
      const productionRework = wo.status === "IN_PROGRESS" || wo.status === "READY";
      const reworkReason = `تغيير التصميم إلى النسخة ${nextRevision} — يلزم اعتمادها وإقرار إعادة التنفيذ`;
      await tx
        .update(workOrders)
        .set({
          customizationText: customizationSnapshot,
          ...(productionRework
            ? {
                status: "IN_PROGRESS" as const,
                kanbanState: "BLOCKED" as const,
                blockedReason: reworkReason,
              }
            : {}),
        })
        .where(eq(workOrders.id, Number(wo.id)));
      await supersedePendingDesignApprovalsTx(
        tx,
        Number(wo.id),
        actor.userId,
        revision.id,
      );

      await recordWorkOrderEvent(tx, {
        workOrderId: Number(wo.id),
        eventType: "DESIGN_CHANGED",
        fromStatus: wo.status,
        toStatus: productionRework ? "IN_PROGRESS" : wo.status,
        payload: {
          previousRevision: Number(current.revision),
          revision: nextRevision,
          contentHash: revision.contentHash,
          reworkRequired: productionRework,
          blockedReason: productionRework ? reworkReason : null,
        },
        actorUserId: actor.userId,
        branchId: Number(wo.branchId),
        seq: nextRevision,
      });

      await logAuditTx(
        tx,
        {
          user: { id: actor.userId, branchId: actor.branchId ?? null } as never,
          req: undefined as never,
        },
        {
          action: "workOrder.setDesign",
          entityType: "workOrder",
          entityId: Number(wo.id),
          branchId: Number(wo.branchId),
          oldValue: {
            revision: Number(current.revision),
            contentHash: current.contentHash,
          },
          newValue: {
            revision: nextRevision,
            imageCount: images.length,
            customizationSnapshot,
            contentHash: revision.contentHash,
            note: input.note?.trim() || null,
            status: productionRework ? "IN_PROGRESS" : wo.status,
            kanbanState: productionRework ? "BLOCKED" : wo.kanbanState,
          },
        },
      );

      return {
        workOrderId: Number(wo.id),
        revision: nextRevision,
        changed: true as const,
        taskNumber: null as string | null,
      };
    },
    { gate: "NONE" },
  );
}
