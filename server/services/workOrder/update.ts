import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { appliedCollectionsForWorkOrder } from "../deposits";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

export interface UpdateWorkOrderInput {
  workOrderId: number;
  expectedVersion?: number;
  reason?: string;
  title?: string;
  customizationText?: string | null;
  salePrice?: string;
  dueDate?: string | null;
  priority?: "LOW" | "NORMAL" | "URGENT" | null;
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  receptionChannel?: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER" | null;
  channelHandle?: string | null;
}

export interface ApprovedWorkOrderControl {
  /** لا يمرّ من الراوتر؛ يمرره controlRequests بعد قفل صف الطلب ومطابقة نسخته فقط. */
  approvedControlRequestId?: number;
}

function requiredReason(reason: string | undefined): string {
  const normalized = reason?.trim() ?? "";
  if (normalized.length < 3 || normalized.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب التعديل مطلوب (3-500 محرف)" });
  }
  return normalized;
}

export async function updateWorkOrderInTx(
  tx: Tx,
  input: UpdateWorkOrderInput,
  actor: Actor & { role?: string },
  control: ApprovedWorkOrderControl = {},
) {
  const reason = requiredReason(input.reason);
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة أمر الشغل المتوقعة مطلوبة" });
  }
  const wo = await loadWorkOrder(tx, input.workOrderId);
  assertWorkOrderBranch(wo, actor);
  if (Number(wo.version) !== Number(input.expectedVersion)) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّر أمر الشغل منذ فتحه — حدّث الصفحة ثم أعد المحاولة" });
  }
  if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: wo.status === "DELIVERED" ? "الأمر مُسلَّم بالفعل — لا يمكن تعديله" : "لا يمكن تعديل أمرٍ ملغى",
    });
  }
  if (wo.invoiceId != null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "صدرت فاتورة لهذا الأمر — عالج التغيير بتصحيح/مرتجع الفاتورة" });
  }

  // التعديل المباشر مسموح فقط لمسودة تشغيلية لم يبدأ أثرها ولم يُقبض عليها شيء. بعد العربون
  // أو بدء التنفيذ يصبح COMMERCIAL_EDIT طلباً صفري الأثر يطبقه مراجع مستقل. إبقاء هذا الحارس
  // في الخدمة يمنع أي عميل API من تجاوز مسار التحكم الذي تعرضه الواجهة.
  const appliedDeposits = await appliedCollectionsForWorkOrder(tx, input.workOrderId);
  const controlledEdit =
    wo.status !== "RECEIVED" ||
    money(wo.deposit ?? "0").gt(0) ||
    appliedDeposits.length > 0;
  if (controlledEdit && control.approvedControlRequestId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "التعديل بعد القبض أو بدء التشغيل يتطلب طلباً واعتماد مديرٍ مستقل",
    });
  }

  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان الطلب مطلوب" });
    patch.title = title;
  }
  if (input.customizationText !== undefined) patch.customizationText = input.customizationText?.trim() || null;
  if (input.salePrice !== undefined) {
    const newPrice = round2(money(input.salePrice));
    if (newPrice.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "السعر يجب أن يكون أكبر من صفر" });
    const deposit = round2(money(wo.deposit ?? "0"));
    if (newPrice.lt(deposit)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `السعر الجديد (${newPrice.toFixed(2)}) أقلّ من العربون المقبوض سلفاً (${deposit.toFixed(2)}) — عدّل العربون أولاً`,
      });
    }
    patch.salePrice = toDbMoney(newPrice);
  }
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.priority !== undefined) patch.priority = input.priority ?? "NORMAL";
  if (input.customerId !== undefined) {
    const changingCustomer = Number(input.customerId ?? 0) !== Number(wo.customerId ?? 0);
    if (changingCustomer && (money(wo.deposit ?? "0").gt(0) || appliedDeposits.length > 0 || wo.status !== "RECEIVED")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يتغيّر عميل الأمر بعد قبض عربون أو بدء التنفيذ — أنشئ معالجة تصحيح مستقلة",
      });
    }
    patch.customerId = input.customerId;
  }
  if (input.contactName !== undefined) patch.contactName = input.contactName?.trim() || null;
  if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone?.trim() || null;
  if (input.receptionChannel !== undefined) patch.receptionChannel = input.receptionChannel ?? "WALK_IN";
  if (input.channelHandle !== undefined) patch.channelHandle = input.channelHandle?.trim() || null;
  if (Object.keys(patch).length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا تعديلات لحفظها" });
  }
  for (const key of Object.keys(patch)) before[key] = (wo as Record<string, unknown>)[key];

  await tx.update(workOrders).set(patch).where(eq(workOrders.id, input.workOrderId));
  await recordWorkOrderEvent(tx, {
    workOrderId: input.workOrderId,
    eventType: "COMMERCIAL_UPDATED",
    payload: { before, patch, reason, controlRequestId: control.approvedControlRequestId ?? null },
    actorUserId: actor.userId,
    branchId: Number(wo.branchId),
    seq: control.approvedControlRequestId != null
      ? `control-${control.approvedControlRequestId}`
      : `v${Number(input.expectedVersion)}`,
  });
  return { workOrderId: input.workOrderId, before, patch, version: Number(input.expectedVersion) + 1 };
}

export async function updateWorkOrder(input: UpdateWorkOrderInput, actor: Actor & { role?: string }) {
  return withTx((tx) => updateWorkOrderInTx(tx, input, actor));
}
