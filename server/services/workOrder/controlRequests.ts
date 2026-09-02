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
import { money, round2, toDbMoney } from "../money";
import { computeDrawerCashBalance, computeTreasuryCashBalance } from "../cash/cashAvailability";
import {
  hasWorkOrderCommercialAuthority,
  maySeeDrawerCash,
  mayRequestWorkOrderControl,
  workOrderControlDeniedMessage,
  type WorkOrderControlTypeKey,
} from "@shared/workOrderControlAuthority";
import {
  REFUND_RAILS,
  refundRailNeedsReference,
  refundRailNeedsShift,
  type RefundRail,
} from "@shared/refundRail";
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

/** فاعلُ التحكّم — يحمل قالبَ دوره وتجاوزَه معاً كي تُقرأ سلطتُه من القاموس المشترك. */
export type WorkOrderControlActor = Actor & {
  role?: string;
  permissionsOverride?: unknown;
};

/**
 * بوّابةُ نوع الطلب (١/٩/٢٦): الإلغاءُ وحده مفتوحٌ لفنّي المطبعة، وما سواه على كاشير/مدير.
 * تُفرَض هنا لا في الراوتر وحده — الخدمةُ قد تُستدعى من قناةٍ أخرى (أوفلاين/أندرويد).
 */
function assertControlRequestAuthority(
  requestType: WorkOrderControlTypeKey,
  actor: WorkOrderControlActor,
): void {
  if (!mayRequestWorkOrderControl(requestType, actor.role ?? "", (actor.permissionsOverride ?? null) as never)) {
    throw new TRPCError({ code: "FORBIDDEN", message: workOrderControlDeniedMessage(requestType) });
  }
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
  actor: WorkOrderControlActor,
) {
  assertControlRequestAuthority(input.requestType, actor);
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
    if (input.requestType === "CANCEL") {
      // **رفضُ البطاقة عند وجود جزءٍ نقديٍّ لا يقبلها** (مراجعة Codex P2 على #930): حصصٌ
      // مطبَّقة أو أمانةُ أجرة تُردّان نقداً حتماً، فطلبُ البطاقة يُنشئ تحكّماً يستحيل اعتمادُه
      // (التنفيذُ يرفضه فيبقى معلّقاً للأبد). نرفضه هنا فلا يُخزَّن أصلاً.
      const cancelPayload = input.payload as unknown as CancelControlPayload;
      if ((cancelPayload.refundRail ?? "DRAWER") === "CARD") {
        const appliedCash = (await appliedCollectionsForWorkOrder(tx, input.workOrderId)).some(
          (part) => (part.method === "CASH" || part.method === "TELECOM") && money(part.amount).gt(0),
        );
        const feeHeld = await workOrderFeeHeldNet(tx, input.workOrderId);
        if (appliedCash || feeHeld.gt(0)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "هذا الأمر يحمل مالاً نقدياً محتجزاً (حصص عربون أو أمانة أجرة) لا يُردّ على البطاقة — اختر الدرج أو الخزينة الإدارية.",
          });
        }
      }
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

/**
 * **رافدُ الردّ قرارُ المُعتمِد لا الطالب** (بلاغ المالك ٢/٩/٢٦).
 *
 * الطالبُ يختار الرافدَ ساعةَ الطلب، والمعتمِدُ يُطبّقه ساعةَ الاعتماد — وبينهما ساعات:
 * يُفرَّغ الدرجُ بالبيع، فيجد المديرُ «رصيد الدرج 25٬000 أقل من المطلوب 70٬000» وحمولةَ الطلب
 * **مبصومةً لا تُعدَّل**. بابٌ مسدود: لا يعتمد ولا يُغيّر، ورسالةُ الرفض لا تقول ما العمل.
 *
 * ⛔ **والشروطُ المادّية تبقى مبصومةً كما هي**: أيُّ أمرٍ، ومصيرُ الخامة، والسبب، ونسخةُ
 * الأساس — كلُّها من الطالب ويحرسها `payloadHash`. المتغيّرُ **من أين يخرج المال** وحده،
 * وهو ليس جزءاً ممّا طلبه الطالب أصلاً: المعتمِدُ صاحبُ الدرج والمسؤولُ عن الصرف.
 * ويُسجَّل الفارقُ في حدث الاعتماد فلا يضيع أنّ الرافد تبدّل ولا مَن بدّله.
 */
export interface ControlApprovalRefundOverride {
  refundRail?: RefundRail | null;
  refundShiftId?: number | null;
  refundReference?: string | null;
}

/** يتحقّق من الرافد البديل **قبل** أيّ أثر — الرفضُ يترك الطلبَ معلّقاً كما كان. */
function normalizedRefundOverride(
  override: ControlApprovalRefundOverride | undefined,
  requestType: WorkOrderControlType,
): ControlApprovalRefundOverride | null {
  if (!override) return null;
  const rail = override.refundRail ?? null;
  const shiftId = override.refundShiftId ?? null;
  const reference = override.refundReference?.trim() || null;
  if (rail == null && shiftId == null && reference == null) return null;

  /**
   * ⛔ **الإلغاء وحده.** عكسُ التسليم يحمل خطّةَ `refundSources` موزَّعةً على الإيصالات
   * ومقفولةً في تمهيدٍ سابق؛ تبديلُ رافدٍ واحدٍ فوقها يُفكّ تطابقَها بلا أن يُعيد بناءها.
   * توسيعُه يحتاج شريحتَه، ولا يُقحَم هنا لأنّ الاسم يسمح.
   */
  if (requestType !== "CANCEL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تبديلُ رافد الردّ عند الاعتماد متاحٌ لطلبات الإلغاء وحدها",
    });
  }
  if (rail != null) {
    if (!(REFUND_RAILS as readonly string[]).includes(rail)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رافدُ ردٍّ غير معروف" });
    }
    if (refundRailNeedsShift(rail) && shiftId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رافدُ الدرج يلزمه تحديد وردية الصرف" });
    }
    if (refundRailNeedsReference(rail) && (reference == null || reference.length < 3)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الردّ على البطاقة يلزمه مرجعُ تنفيذٍ خارجيّ (٣ محارف على الأقل)",
      });
    }
  }
  return { refundRail: rail, refundShiftId: shiftId, refundReference: reference };
}

export async function approveWorkOrderControlRequest(
  id: number,
  actor: Actor & { role?: string },
  reviewNote?: string | null,
  refundOverride?: ControlApprovalRefundOverride,
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

    // التحقّقُ من الرافد البديل بعد معرفة نوع الطلب وقبل أيّ كتابة.
    const override = normalizedRefundOverride(refundOverride, request.requestType);
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
        // الرافدُ والدرجُ والمرجع: اختيارُ المعتمِد يسبق اقتراحَ الطالب حين يقدّمه صراحةً.
        // ومصيرُ الخامة والسببُ والنسخة تبقى من الطالب حرفياً — مبصومةً بـ`payloadHash`.
        refundShiftId: override?.refundShiftId ?? payload.refundShiftId ?? null,
        refundRail: override?.refundRail ?? payload.refundRail ?? null,
        refundReference: override?.refundReference ?? payload.refundReference ?? null,
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
      payload: {
        controlRequestId: id,
        requestType: request.requestType,
        payloadHash: request.payloadHash,
        reviewNote: note,
        // §٥: لا يضيع أنّ رافدَ المال تبدّل بين الطلب والاعتماد — ولا مَن بدّله.
        ...(override
          ? {
              refundOverride: override,
              refundRailAsRequested:
                (request.payload as unknown as CancelControlPayload).refundRail ?? null,
            }
          : {}),
      },
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
  actor: WorkOrderControlActor,
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
    const openReceptionShiftRows = await tx.select({
      id: shifts.id,
      userId: shifts.userId,
      userName: users.name,
      openingBalance: shifts.openingBalance,
    }).from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(and(eq(shifts.branchId, Number(wo.branchId)), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
    /**
     * ⛔ **`reverseDelivery` لمن يملك طلبَ العكس وحده** (مراجعة Codex P1 على #929).
     *
     * لمّا وُسِّعت هذه النقطة إلى `workordersExecProcedure` (ليطلب فنّي المطبعة الإلغاء) صار
     * مجرّدُ فتح صفحة أمرٍ **مُسلَّم** يُسلّمه هذا الكائنَ المتشعّب: صافي المدفوع، ومصادرُ الردّ
     * على مستوى الإيصال بطرقها، وحالةُ تسوية الإرسالية، وأرصدةُ أدراج الاستقبال — وهو **لا
     * يملك طلبَ العكس أصلاً** (`mayRequestWorkOrderControl` يرفضه). سطحٌ ماليٌّ كامل بلا فعلٍ
     * يبرّره. والحسبةُ نفسها تُوفَّر: لا استعلامَ لمن لا يستفيد.
     */
    const mayReverse = hasWorkOrderCommercialAuthority(
      actor.role ?? "",
      (actor.permissionsOverride ?? null) as never,
    );
    const reverseDelivery = mayReverse && wo.status === "DELIVERED" && wo.invoiceId != null
      ? await getWorkOrderReverseDeliveryPreflightInTx(tx, workOrderId, actor)
      : null;
    /**
     * أرصدةُ الأدراج تتبع سياسةَ الإفصاح الواحدة (`treasury:READ`) كما في `refundPreflight`:
     * القائمةُ تُعرَض ليُختار الدرج، والرقمُ الحسّاس يُحجَب عمّن لا يملكها (يكفيه علَمُ `sufficient`).
     */
    const exposeDrawerCash = maySeeDrawerCash(
      actor.role ?? "",
      (actor.permissionsOverride ?? null) as never,
    );
    /**
     * ⚠️ **النقدُ المتاح يُحسَب حيّاً لا من عمود `shifts.expectedCash`** (بلاغ المالك بالصورة ١/٩،
     * ومراجعة Codex على #930): ذلك العمودُ لقطةٌ تُكتب **عند إغلاق الوردية** فيكون `NULL` لكلّ
     * وردية مفتوحة، فتعرض الشاشةُ «0 د.ع» على درجٍ يحمل ٥٦٬٠٠٠. `computeDrawerCashBalance` يقيسه
     * بنفس صيغة `assertCashOutAvailable` — فما تعرضه الشاشة هو ما يقبله الحارسُ عند التنفيذ.
     */
    const expectedCashRefundAmt = round2(cashRefund.plus(appliedCashRefund).plus(feeHeld));
    const openReceptionShifts = await Promise.all(
      openReceptionShiftRows.map(async (shift) => {
        const available = round2(await computeDrawerCashBalance(tx, Number(shift.id), shift.openingBalance ?? "0"));
        return {
          id: Number(shift.id),
          userId: Number(shift.userId),
          userName: shift.userName,
          expectedCash: exposeDrawerCash ? toDbMoney(available) : null,
          sufficient: available.gte(expectedCashRefundAmt),
        };
      }),
    );
    const treasuryAvailable = round2(await computeTreasuryCashBalance(tx, Number(wo.branchId)));
    return {
      workOrderId,
      branchId: Number(wo.branchId),
      status: wo.status,
      version: Number(wo.version),
      invoiceId: wo.invoiceId == null ? null : Number(wo.invoiceId),
      materialLineCount: materialRows.length,
      feeHeld: feeHeld.toFixed(2),
      cashRefundRequired: cashRefund.gt(0) || appliedCashRefund.gt(0) || feeHeld.gt(0),
      expectedCashRefund: expectedCashRefundAmt.toFixed(2),
      // البطاقةُ ممنوعةٌ حين يوجد جزءٌ نقديٌّ لا يقبلها (حصصٌ مطبَّقة أو أمانةُ أجرة تُردّان
      // نقداً حتماً) — فاختيارُها يُنشئ طلبَ تحكّمٍ يستحيل اعتمادُه (مراجعة Codex P2 على #930).
      cardRefundAllowed: !(appliedCashRefund.gt(0) || feeHeld.gt(0)),
      /**
       * **هل في الإلغاء مالٌ فعلاً؟** (قرار المالك ١/٩/٢٦) — هذا وحده ما يستدعي مديراً حين
       * يطلب فنّي المطبعة الإلغاء. متعمَّدٌ **ألّا** يكون مرادفاً لـ`controlRequired.cancel`:
       * تلك تشترط زيادةً خلوَّ الأمر من أسطر خامةٍ ولو لم تُستهلَك بعد، وهو تشدّدٌ بلا أثرٍ
       * في `RECEIVED` (الإلغاء لا يمسّ المخزون إلّا من `IN_PROGRESS`/`READY`). فصلُهما يُبقي
       * بوّابةَ المدير كما هي حرفياً بينما يصير شرطُ الفنّي هو شرطَ المالك نصّاً.
       */
      cancelMoneyAtStake:
        money(wo.deposit ?? "0").gt(0) ||
        appliedDeposits.length > 0 ||
        cashRefund.gt(0) ||
        feeHeld.gt(0),
      controlRequired: {
        commercial:
          wo.status !== "RECEIVED" ||
          money(wo.deposit ?? "0").gt(0) ||
          appliedDeposits.length > 0,
        materials: wo.status === "IN_PROGRESS" || wo.status === "READY",
        cancel: wo.status !== "RECEIVED" || money(wo.deposit ?? "0").gt(0) || appliedDeposits.length > 0 || materialRows.length > 0 || feeHeld.gt(0),
      },
      reverseDelivery,
      openReceptionShifts,
      // نقدُ الخزينة الإدارية — محجوبُ الرقم عمّن لا يملك treasury:READ، مع علَمِ كفايةٍ باقٍ.
      treasuryCash: exposeDrawerCash ? toDbMoney(treasuryAvailable) : null,
      treasurySufficient: treasuryAvailable.gte(expectedCashRefundAmt),
    };
  }, { gate: "NONE" });
}
