import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  receipts,
  shifts,
  users,
  workOrderControlRequests,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { retryOnDeadlock } from "../../lib/retryDeadlock";
import { isDupEntry } from "@shared/errorMap.ar";
import { idempotencyHash } from "../idempotency";
import { money, round2 } from "../money";
import type { RefundRail } from "@shared/refundRail";
import { type Actor, requireDb, withTx } from "../tx";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { workOrderFeeHeldNet } from "./deliveryFeeRefund";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import { cancelWorkOrderInTx, type WorkOrderCancelMaterialDecision } from "./cancel";
import { setWorkOrderMaterialsInTx } from "./materials";
import { updateWorkOrderInTx, type UpdateWorkOrderInput } from "./update";
import type { WorkOrderMaterialInput } from "./types";
import { appliedCollectionsForWorkOrder } from "../reception/deposits";
import {
  getWorkOrderReverseDeliveryPreflightInTx,
  lockReverseDeliveryApprovalResourcesInTx,
  reverseWorkOrderDeliveryInTx,
  type WorkOrderRefundSourcePlan,
} from "./reverseDelivery";

export const WORK_ORDER_CONTROL_TYPES = ["COMMERCIAL_EDIT", "MATERIAL_ADJUST", "CANCEL", "REVERSE_DELIVERY"] as const;
export type WorkOrderControlType = (typeof WORK_ORDER_CONTROL_TYPES)[number];

export type CommercialEditPayload = Omit<UpdateWorkOrderInput, "workOrderId" | "expectedVersion" | "reason">;
export interface MaterialAdjustPayload { materials: WorkOrderMaterialInput[] }
export interface CancelControlPayload {
  refundShiftId?: number | null;
  /**
   * **رافدُ ردّ العربون** — يعبر مسارَ الاعتماد كاملاً (مراجعة Codex P1 على #928).
   *
   * ⚠️ بدونه كانت الميزةُ **غائبةً حيث تلزم بالضبط**: `controlRequired.cancel` صحيحٌ لأيّ أمرٍ
   * بعربونٍ أو حصصٍ أو أمانةٍ أو خامةٍ مستهلَكة — أي لكلّ إلغاءٍ يحتاج ردّاً أصلاً. فحصرُ
   * الروافد في المسار المباشر يجعلها غيرَ قابلةٍ للبلوغ عملياً.
   */
  refundRail?: RefundRail | null;
  /** مرجعُ التنفيذ الخارجيّ — لرافد البطاقة وحده. */
  refundReference?: string | null;
  materials?: WorkOrderCancelMaterialDecision[] | null;
}
export interface ReverseDeliveryControlPayload {
  expectedVersion: number;
  reopen: boolean;
  refundShiftId?: number | null;
  refundSources: WorkOrderRefundSourcePlan[];
}
export type WorkOrderControlPayload = CommercialEditPayload | MaterialAdjustPayload | CancelControlPayload | ReverseDeliveryControlPayload;

const controlRequestCreator = alias(users, "workOrderControlCreator");
const controlRequestAssignee = alias(users, "workOrderControlAssignee");

interface RequestWorkOrderControlBase {
  requestKey: string;
  workOrderId: number;
  baseVersion: number;
  reason: string;
}

export type RequestWorkOrderControlInput = RequestWorkOrderControlBase & (
  | { requestType: "COMMERCIAL_EDIT"; payload: CommercialEditPayload }
  | { requestType: "MATERIAL_ADJUST"; payload: MaterialAdjustPayload }
  | { requestType: "CANCEL"; payload: CancelControlPayload }
  | { requestType: "REVERSE_DELIVERY"; payload: ReverseDeliveryControlPayload }
);

function normalizedReason(reason: string, label = "الطلب"): string {
  const normalized = reason.trim();
  if (normalized.length < 3 || normalized.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `سبب ${label} مطلوب (3-500 محرف)` });
  }
  return normalized;
}

function assertManager(actor: Actor): void {
  if (actor.role !== "manager" && actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "مراجعة طلبات التحكم محصورة بمدير أو أدمن" });
  }
}

function assertRequestBranch(row: { branchId: number | string }, actor: Actor): void {
  if (actor.role !== "admin" && Number(row.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب التحكم لا يخصّ فرعك" });
  }
}

function exactRequestReplay(
  row: typeof workOrderControlRequests.$inferSelect,
  input: RequestWorkOrderControlInput,
  reason: string,
  payloadHash: string,
  actor: Actor,
): boolean {
  return Number(row.workOrderId) === input.workOrderId
    && row.requestType === input.requestType
    && Number(row.baseVersion) === input.baseVersion
    && row.payloadHash === payloadHash
    && row.reason === reason
    && Number(row.requestedBy) === actor.userId;
}

async function loadExistingByKey(tx: Tx, requestKey: string) {
  return (
    await tx.select().from(workOrderControlRequests)
      // current/locking read: يحسم سباق مفتاحٍ واحد؛ القراءة العادية تحت REPEATABLE READ قد
      // تبقى على snapshot لا ترى الصف الذي التزم بعد انتظار INSERT المنافس.
      .where(eq(workOrderControlRequests.requestKey, requestKey)).for("update").limit(1)
  )[0];
}

export async function requestWorkOrderControl(
  input: RequestWorkOrderControlInput,
  actor: Actor & { role?: string },
) {
  const requestKey = input.requestKey.trim();
  if (!requestKey || requestKey.length > 120) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح طلب التحكم مطلوب وبحد أقصى 120 محرفاً" });
  }
  if (!Number.isInteger(input.baseVersion) || input.baseVersion <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة أمر الشغل الأساس غير صالحة" });
  }
  const reason = normalizedReason(input.reason, "الإجراء");
  const payloadHash = idempotencyHash(input.payload);
  return retryOnDeadlock(() => withTx(async (tx) => {
    const replay = await loadExistingByKey(tx, requestKey);
    if (replay) {
      assertRequestBranch(replay, actor);
      if (!exactRequestReplay(replay, input, reason, payloadHash, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستخدم لإجراء أو حمولة مختلفة" });
      }
      return { ...replay, replayed: true as const };
    }

    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (Number(wo.version) !== input.baseVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر أمر الشغل منذ فتحه — حدّث الصفحة قبل إرسال الطلب" });
    }
    if (input.requestType === "REVERSE_DELIVERY") {
      if (wo.status !== "DELIVERED" || wo.invoiceId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "طلب عكس التسليم لأمرٍ مُسلَّم ذي فاتورة فقط" });
      }
      const payload = input.payload as ReverseDeliveryControlPayload;
      if (Number(payload.expectedVersion) !== input.baseVersion) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة حمولة العكس لا تطابق نسخة طلب التحكم" });
      }
      const preflight = await getWorkOrderReverseDeliveryPreflightInTx(tx, input.workOrderId, actor);
      if (!preflight.eligible) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: preflight.ineligibleReason });
      }
      if (idempotencyHash(payload.refundSources) !== idempotencyHash(preflight.refundSources)) {
        throw new TRPCError({ code: "CONFLICT", message: "خطة مصادر الرد لا تطابق المقبوضات الحالية؛ أعد المعاينة" });
      }
      const cashRequired = preflight.refundSources.some((source) => source.refundMethod === "CASH");
      const selectedShift = payload.refundShiftId ?? null;
      if (cashRequired && preflight.openReceptionShifts.length > 1 && selectedShift == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "توجد عدة ورديات استقبال؛ اختر درج الرد النقدي" });
      }
      if (selectedShift != null && !preflight.openReceptionShifts.some((shift) => shift.id === selectedShift)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وردية الرد المحددة ليست RECEPTION مفتوحة في فرع الأمر" });
      }
    } else if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يُفتح طلب تحكم لأمرٍ نهائي" });
    }
    if ((input.requestType === "COMMERCIAL_EDIT" || input.requestType === "MATERIAL_ADJUST") && wo.invoiceId != null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "صدرت فاتورة لهذا الأمر — لا تعديل تجاري أو مادي بعد الفوترة" });
    }
    if (input.requestType === "COMMERCIAL_EDIT") {
      const payload = input.payload as CommercialEditPayload;
      const changingCustomer = payload.customerId !== undefined
        && Number(payload.customerId ?? 0) !== Number(wo.customerId ?? 0);
      const appliedDeposits = changingCustomer
        ? await appliedCollectionsForWorkOrder(tx, input.workOrderId)
        : [];
      if (changingCustomer
        && (money(wo.deposit ?? "0").gt(0) || appliedDeposits.length > 0 || wo.status !== "RECEIVED")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "عميل الأمر مجمّد بعد العربون أو بدء التنفيذ" });
      }
    }

    let id: number;
    try {
      const inserted = await tx.insert(workOrderControlRequests).values({
        requestKey,
        workOrderId: input.workOrderId,
        branchId: Number(wo.branchId),
        requestType: input.requestType,
        status: "PENDING",
        baseVersion: input.baseVersion,
        payload: input.payload as never,
        payloadHash,
        reason,
        requestedBy: actor.userId,
      });
      id = extractInsertId(inserted);
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const raced = await loadExistingByKey(tx, requestKey);
      if (raced) assertRequestBranch(raced, actor);
      if (!raced || !exactRequestReplay(raced, input, reason, payloadHash, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب استُهلك بالتزامن لحمولة مختلفة" });
      }
      return { ...raced, replayed: true as const };
    }
    await recordWorkOrderEvent(tx, {
      workOrderId: input.workOrderId,
      eventType: "CONTROL_REQUESTED",
      payload: { controlRequestId: id, requestType: input.requestType, baseVersion: input.baseVersion, payloadHash, reason },
      actorUserId: actor.userId,
      branchId: Number(wo.branchId),
      seq: id,
    });
    const row = await loadExistingByKey(tx, requestKey);
    return { ...row!, replayed: false as const };
  }, { gate: "NONE" }));
}

export async function listPendingWorkOrderControls(actor: Actor & { role?: string }) {
  const db = requireDb();
  const where = actor.role === "admin"
    ? eq(workOrderControlRequests.status, "PENDING")
    : and(eq(workOrderControlRequests.status, "PENDING"), eq(workOrderControlRequests.branchId, actor.branchId));
  return db
    .select({
      ...getTableColumns(workOrderControlRequests),
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      workOrderStatus: workOrders.status,
      workOrderVersion: workOrders.version,
      createdBy: workOrders.createdBy,
      createdByName: controlRequestCreator.name,
      assignedTo: workOrders.assignedTo,
      assignedToName: controlRequestAssignee.name,
      requestedByName: users.name,
    })
    .from(workOrderControlRequests)
    .innerJoin(workOrders, eq(workOrders.id, workOrderControlRequests.workOrderId))
    .innerJoin(users, eq(users.id, workOrderControlRequests.requestedBy))
    .leftJoin(controlRequestCreator, eq(controlRequestCreator.id, workOrders.createdBy))
    .leftJoin(controlRequestAssignee, eq(controlRequestAssignee.id, workOrders.assignedTo))
    .where(where)
    .orderBy(desc(workOrderControlRequests.id));
}

export async function getWorkOrderControlRequest(id: number, actor: Actor & { role?: string }) {
  const db = requireDb();
  const row = (
    await db.select().from(workOrderControlRequests)
      .where(eq(workOrderControlRequests.id, id)).limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
  assertRequestBranch(row, actor);
  return row;
}

export async function approveWorkOrderControlRequest(
  id: number,
  actor: Actor & { role?: string },
  reviewNote?: string | null,
) {
  assertManager(actor);
  const note = reviewNote?.trim() || null;
  if (note && note.length > 500) throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة الاعتماد أطول من 500 محرف" });

  // الاعتماد ذرّي ومُعرَّف بمفتاح الطلب نفسه؛ إذا اختاره InnoDB ضحيةً لتعارضٍ
  // مؤقت، فإعادة المعاملة كاملةً آمنة: إمّا تطبق مرةً، أو ترى APPROVED وتعيد replay.
  const result = await retryOnDeadlock(() => withTx(async (tx) => {
    const requestSnapshot = (
      await tx.select().from(workOrderControlRequests)
        .where(eq(workOrderControlRequests.id, id)).limit(1)
    )[0];
    if (!requestSnapshot) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    assertRequestBranch(requestSnapshot, actor);

    let reverseLocks: Awaited<ReturnType<typeof lockReverseDeliveryApprovalResourcesInTx>> | undefined;
    // REVERSE_DELIVERY: لا نقفل مستند الطلب قبل مصدر النقد. الطلب النهائي لا يحتاج مورداً
    // مالياً؛ أما PENDING فيقفل cash/receipts → workOrder ثم يعيد قفل الطلب والتحقق منه.
    if (requestSnapshot.requestType === "REVERSE_DELIVERY" && requestSnapshot.status === "PENDING") {
      const payload = requestSnapshot.payload as unknown as ReverseDeliveryControlPayload;
      reverseLocks = await lockReverseDeliveryApprovalResourcesInTx(tx, {
        workOrderId: Number(requestSnapshot.workOrderId),
        expectedVersion: payload.expectedVersion,
        reason: requestSnapshot.reason,
        reopen: payload.reopen === true,
        refundShiftId: payload.refundShiftId ?? null,
        refundSources: payload.refundSources,
        clientRequestId: `wo-control-reverse-${id}`,
      }, actor);
    }
    const request = (
      await tx.select().from(workOrderControlRequests)
        .where(eq(workOrderControlRequests.id, id)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    assertRequestBranch(request, actor);
    if (requestSnapshot.requestKey !== request.requestKey
      || requestSnapshot.requestType !== request.requestType
      || Number(requestSnapshot.workOrderId) !== Number(request.workOrderId)
      || Number(requestSnapshot.baseVersion) !== Number(request.baseVersion)
      || requestSnapshot.payloadHash !== request.payloadHash
      || requestSnapshot.reason !== request.reason
      || Number(requestSnapshot.requestedBy) !== Number(request.requestedBy)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر طلب التحكم أثناء الاعتماد" });
    }
    if (Number(request.requestedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد منشئ الطلب طلبه بنفسه" });
    }
    if (request.status === "APPROVED") return { request, replayed: true as const };
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب التحكم محسوم بالحالة ${request.status}` });
    }

    // عكس التسليم يقفل مصادر النقد والإيصالات قبل المستند. لذلك نقرأ هنا لقطةً بلا قفل
    // للفصل الوظيفي/النسخة، ثم يعيد reverseWorkOrderDeliveryInTx التحقق تحت ترتيب الأقفال
    // القانوني. بقية المسارات لا تكتب نقداً بهذا الاتجاه وتحتفظ بقفل الأمر المباشر.
    const wo = request.requestType === "REVERSE_DELIVERY"
      ? reverseLocks?.workOrder ?? (await tx.select().from(workOrders).where(eq(workOrders.id, Number(request.workOrderId))).limit(1))[0]
      : await loadWorkOrder(tx, Number(request.workOrderId));
    if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
    assertWorkOrderBranch(wo, actor);
    if ((request.requestType === "CANCEL" || request.requestType === "MATERIAL_ADJUST" || request.requestType === "REVERSE_DELIVERY")
      && (Number(wo.createdBy ?? 0) === actor.userId || Number(wo.assignedTo ?? 0) === actor.userId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "منشئ الأمر أو الفنّي المسند إليه لا يعتمد إلغاءه أو تعديل مواده أو عكس تسليمه",
      });
    }
    if (Number(wo.version) !== Number(request.baseVersion)) {
      await tx.update(workOrderControlRequests).set({
        status: "STALE",
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewNote: note ?? "تغيّرت نسخة أمر الشغل قبل الاعتماد",
      }).where(eq(workOrderControlRequests.id, id));
      return { stale: true as const };
    }
    if ((request.requestType === "COMMERCIAL_EDIT" || request.requestType === "MATERIAL_ADJUST") && wo.invoiceId != null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "صدرت فاتورة لهذا الأمر — لا يمكن اعتماد التعديل" });
    }

    const control = { approvedControlRequestId: id };
    if (request.requestType === "COMMERCIAL_EDIT") {
      await updateWorkOrderInTx(tx, {
        ...(request.payload as CommercialEditPayload),
        workOrderId: Number(request.workOrderId),
        expectedVersion: Number(request.baseVersion),
        reason: request.reason,
      }, actor, control);
    } else if (request.requestType === "MATERIAL_ADJUST") {
      const payload = request.payload as unknown as MaterialAdjustPayload;
      await setWorkOrderMaterialsInTx(tx, {
        workOrderId: Number(request.workOrderId),
        expectedVersion: Number(request.baseVersion),
        reason: request.reason,
        materials: payload.materials,
      }, actor, control);
    } else if (request.requestType === "CANCEL") {
      const payload = request.payload as unknown as CancelControlPayload;
      await cancelWorkOrderInTx(tx, Number(request.workOrderId), actor, {
        expectedVersion: Number(request.baseVersion),
        reason: request.reason,
        refundShiftId: payload.refundShiftId ?? null,
        // الرافدُ والمرجعُ يُنفَّذان كما أقرّهما الطالبُ واعتمدهما المدير — لا يُسقَطان بينهما.
        refundRail: payload.refundRail ?? null,
        refundReference: payload.refundReference ?? null,
        materials: payload.materials ?? null,
        clientRequestId: `wo-control-cancel-${id}`,
      }, control);
    } else {
      const payload = request.payload as unknown as ReverseDeliveryControlPayload;
      await reverseWorkOrderDeliveryInTx(tx, {
        workOrderId: Number(request.workOrderId),
        expectedVersion: payload.expectedVersion,
        reason: request.reason,
        reopen: payload.reopen === true,
        refundShiftId: payload.refundShiftId ?? null,
        refundSources: payload.refundSources,
        clientRequestId: `wo-control-reverse-${id}`,
      }, actor, control, reverseLocks);
    }

    const reviewedAt = new Date();
    await tx.update(workOrderControlRequests).set({
      status: "APPROVED",
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
      appliedAt: reviewedAt,
    }).where(eq(workOrderControlRequests.id, id));
    await recordWorkOrderEvent(tx, {
      workOrderId: Number(request.workOrderId),
      eventType: "CONTROL_APPROVED",
      payload: { controlRequestId: id, requestType: request.requestType, payloadHash: request.payloadHash, reviewNote: note },
      actorUserId: actor.userId,
      branchId: Number(request.branchId),
      seq: id,
    });
    return { request: { ...request, status: "APPROVED" as const, reviewedBy: actor.userId, reviewedAt, appliedAt: reviewedAt }, replayed: false as const };
  }));
  if ("stale" in result) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت نسخة أمر الشغل؛ وُسم الطلب قديماً وافتح طلباً جديداً" });
  }
  return result;
}

export async function rejectWorkOrderControlRequest(
  id: number,
  actor: Actor & { role?: string },
  reason: string,
) {
  assertManager(actor);
  const note = normalizedReason(reason, "الرفض");
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(workOrderControlRequests)
        .where(eq(workOrderControlRequests.id, id)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
    assertRequestBranch(request, actor);
    if (Number(request.requestedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يرفض منشئ الطلب طلبه بنفسه" });
    }
    if (request.status === "REJECTED" && request.reviewNote === note) return { request, replayed: true as const };
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب التحكم محسوم بالحالة ${request.status}` });
    }
    const reviewedAt = new Date();
    await tx.update(workOrderControlRequests).set({
      status: "REJECTED",
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
    }).where(eq(workOrderControlRequests.id, id));
    await recordWorkOrderEvent(tx, {
      workOrderId: Number(request.workOrderId),
      eventType: "CONTROL_REJECTED",
      payload: { controlRequestId: id, requestType: request.requestType, reason: note },
      actorUserId: actor.userId,
      branchId: Number(request.branchId),
      seq: id,
    });
    return { request: { ...request, status: "REJECTED" as const, reviewedBy: actor.userId, reviewedAt, reviewNote: note }, replayed: false as const };
  }, { gate: "NONE" });
}

export async function getWorkOrderControlPreflight(
  workOrderId: number,
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const wo = (
      await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1)
    )[0];
    if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
    assertWorkOrderBranch(wo, actor);
    const materialRows = await tx.select({ id: workOrderMaterials.id })
      .from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
    const feeHeld = await workOrderFeeHeldNet(tx, workOrderId);
    const appliedDeposits = await appliedCollectionsForWorkOrder(tx, workOrderId);
    const appliedCashRefund = appliedDeposits.reduce(
      (sum, part) => (part.method === "CASH" || part.method === "TELECOM")
        ? sum.plus(money(part.amount))
        : sum,
      money(0),
    );
    const cashReceipt = (
      await tx.select({ value: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
        .from(receipts)
        .where(and(
          eq(receipts.workOrderId, workOrderId),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.status, "COMPLETED"),
          sql`(${receipts.referenceNumber} IS NULL OR ${receipts.referenceNumber} <> ${`DLV-FEE-WO-${workOrderId}`})`,
        ))
    )[0];
    const cashRefund = round2(money(cashReceipt?.value ?? "0"));
    const openReceptionShifts = await tx.select({
      id: shifts.id,
      userId: shifts.userId,
      userName: users.name,
      expectedCash: shifts.expectedCash,
    }).from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(and(eq(shifts.branchId, Number(wo.branchId)), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
    const reverseDelivery = wo.status === "DELIVERED" && wo.invoiceId != null
      ? await getWorkOrderReverseDeliveryPreflightInTx(tx, workOrderId, actor)
      : null;
    return {
      workOrderId,
      branchId: Number(wo.branchId),
      status: wo.status,
      version: Number(wo.version),
      invoiceId: wo.invoiceId == null ? null : Number(wo.invoiceId),
      materialLineCount: materialRows.length,
      feeHeld: feeHeld.toFixed(2),
      cashRefundRequired: cashRefund.gt(0) || appliedCashRefund.gt(0) || feeHeld.gt(0),
      expectedCashRefund: round2(cashRefund.plus(appliedCashRefund).plus(feeHeld)).toFixed(2),
      controlRequired: {
        commercial:
          wo.status !== "RECEIVED" ||
          money(wo.deposit ?? "0").gt(0) ||
          appliedDeposits.length > 0,
        materials: wo.status === "IN_PROGRESS" || wo.status === "READY",
        cancel: wo.status !== "RECEIVED" || money(wo.deposit ?? "0").gt(0) || appliedDeposits.length > 0 || materialRows.length > 0 || feeHeld.gt(0),
      },
      reverseDelivery,
      openReceptionShifts: openReceptionShifts.map((shift) => ({
        id: Number(shift.id),
        userId: Number(shift.userId),
        userName: shift.userName,
        expectedCash: shift.expectedCash == null ? null : round2(money(shift.expectedCash)).toFixed(2),
      })),
    };
  }, { gate: "NONE" });
}
