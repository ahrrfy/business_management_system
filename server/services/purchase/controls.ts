import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import {
  branches,
  purchaseOrderControlRequests,
  purchaseOrderEvents,
  purchaseOrderItems,
  purchaseOrders,
  users,
} from "../../../drizzle/schema";
import { purchaseOrderControlTrigger } from "@shared/approvalTriggers";
import { extractInsertId } from "../../lib/insertId";
import type { Tx } from "../../db";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import {
  checkIdempotency,
  idempotencyHash,
  payloadHashMatches,
  recordIdempotencyKey,
} from "../idempotency";
import { money } from "../money";
import { restoreVariantsToActiveOpeningStocktakes } from "../stocktake/openingEligibility";
import { requireDb, withTx, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";
import {
  getPurchaseControlSettingsTx,
  hasCompleteRequisitionCoverageTx,
  releasePurchaseOrderRevisionAllocationsTx,
} from "./requisitions";
import { appendPurchaseOrderEventTx } from "./revisions";
import { postApprovedPurchaseInvoiceInTx } from "./automaticInvoicePosting";

export type PurchaseOrderControlKind =
  | "APPROVE_REVISION"
  | "CANCEL_ORDER"
  | "EMERGENCY_ORDER";

export type PurchaseOrderControlRequestInput = {
  purchaseOrderId: number;
  revisionId?: number | null;
  expectedVersion: number;
  kind: PurchaseOrderControlKind;
  requestKey: string;
  reason: string;
};

function validateReason(reasonRaw: string, label: string): string {
  const reason = reasonRaw.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} إلزامي (3–500 محرف)`,
    });
  }
  return reason;
}

function validateKey(keyRaw: string, label: string): string {
  const key = keyRaw.trim();
  if (!key || key.length > 120) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} إلزامي ولا يتجاوز 120 محرفاً`,
    });
  }
  return key;
}

async function findApprovedEmergencyTx(
  tx: Tx,
  purchaseOrderId: number,
  revisionId: number,
) {
  return (
    await tx
      .select()
      .from(purchaseOrderControlRequests)
      .where(
        and(
          eq(purchaseOrderControlRequests.purchaseOrderId, purchaseOrderId),
          eq(purchaseOrderControlRequests.revisionId, revisionId),
          eq(purchaseOrderControlRequests.kind, "EMERGENCY_ORDER"),
          eq(purchaseOrderControlRequests.status, "APPROVED"),
        ),
      )
      .orderBy(desc(purchaseOrderControlRequests.id))
      .limit(1)
  )[0];
}

async function assertRequisitionOrEmergencyTx(
  tx: Tx,
  input: { purchaseOrderId: number; revisionId: number; branchId: number },
) {
  const settings = await getPurchaseControlSettingsTx(tx, input.branchId);
  if (!settings.requireRequisition) return { emergency: null, settings };
  if (await hasCompleteRequisitionCoverageTx(tx, input.revisionId)) {
    return { emergency: null, settings };
  }
  if (!settings.allowEmergencyOrder) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "إعدادات الفرع تفرض تغطية أمر الشراء بطلبات شراء معتمدة ولا تسمح بطلب طارئ",
    });
  }
  if (!settings.requireEmergencyApproval) return { emergency: null, settings };
  const emergency = await findApprovedEmergencyTx(
    tx,
    input.purchaseOrderId,
    input.revisionId,
  );
  if (!emergency) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "المراجعة غير مغطاة بطلب شراء؛ أنشئ طلب EMERGENCY_ORDER واعتمده أولاً",
    });
  }
  return { emergency, settings };
}

async function requestPurchaseOrderControlTx(
  tx: Tx,
  input: PurchaseOrderControlRequestInput,
  actor: Actor,
) {
  const reason = validateReason(input.reason, "سبب طلب التحكم");
  const requestKey = validateKey(input.requestKey, "مفتاح طلب التحكم");
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .for("update")
    .limit(1);
  if (!po)
    throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  assertPurchaseBranch(po, actor);

  const revisionId = input.revisionId ?? po.currentRevisionId;
  const payloadHash = idempotencyHash({
    purchaseOrderId: input.purchaseOrderId,
    revisionId: revisionId == null ? null : Number(revisionId),
    expectedVersion: input.expectedVersion,
    kind: input.kind,
    reason,
  });
  const [existing] = await tx
    .select()
    .from(purchaseOrderControlRequests)
    .where(eq(purchaseOrderControlRequests.requestKey, requestKey))
    .limit(1);
  if (existing) {
    if (
      !payloadHashMatches(payloadHash, existing.payloadHash) ||
      Number(existing.purchaseOrderId) !== input.purchaseOrderId ||
      existing.kind !== input.kind
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح طلب التحكم مستعمل بحمولة مختلفة",
      });
    }
    return {
      requestId: Number(existing.id),
      status: existing.status,
      idempotent: true as const,
    };
  }
  if (Number(po.version) !== input.expectedVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّر أمر الشراء؛ حدّث الصفحة ثم أعد المحاولة",
    });
  }
  if (
    revisionId == null ||
    Number(revisionId) !== Number(po.currentRevisionId)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "المراجعة المطلوبة ليست المراجعة الحالية لأمر الشراء",
    });
  }
  if (input.kind === "APPROVE_REVISION") {
    if (po.status !== "SENT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يُطلب اعتماد إلا لأمر شراء مُرسَل",
      });
    }
    await assertRequisitionOrEmergencyTx(tx, {
      purchaseOrderId: input.purchaseOrderId,
      revisionId: Number(revisionId),
      branchId: Number(po.branchId),
    });
  } else if (input.kind === "EMERGENCY_ORDER") {
    if (!["DRAFT", "SENT"].includes(po.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "طلب الشراء الطارئ يسبق اعتماد الأمر",
      });
    }
    const settings = await getPurchaseControlSettingsTx(
      tx,
      Number(po.branchId),
    );
    if (!settings.requireRequisition || !settings.allowEmergencyOrder) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "إعدادات الفرع لا تسمح بطلب شراء طارئ لهذا الأمر",
      });
    }
    if (await hasCompleteRequisitionCoverageTx(tx, Number(revisionId))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المراجعة مغطاة بالكامل بطلبات شراء؛ لا حاجة لاستثناء طارئ",
      });
    }
  } else if (!["DRAFT", "SENT", "CONFIRMED"].includes(po.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حالة أمر الشراء لا تقبل طلب الإلغاء",
    });
  }

  const pendingGuard = `${input.purchaseOrderId}:${input.kind}:${Number(revisionId)}`;
  const result = await tx.insert(purchaseOrderControlRequests).values({
    requestKey,
    purchaseOrderId: input.purchaseOrderId,
    revisionId: Number(revisionId),
    branchId: po.branchId,
    kind: input.kind,
    baseOrderVersion: input.expectedVersion,
    payloadHash,
    reason,
    pendingGuard,
    requestedBy: actor.userId,
  });
  const requestId = extractInsertId(result);
  await appendPurchaseOrderEventTx(tx, {
    eventKey: `PO-CONTROL-REQUEST:${requestKey}`,
    purchaseOrderId: input.purchaseOrderId,
    revisionId: Number(revisionId),
    requestId,
    branchId: Number(po.branchId),
    eventType: `${input.kind}_REQUESTED`,
    reason,
    actorUserId: actor.userId,
    payload: { baseOrderVersion: input.expectedVersion, payloadHash },
  });
  return { requestId, status: "PENDING" as const, idempotent: false as const };
}

/** إنشاء الطلب صفري الأثر: لا يغيّر status أو أي حقل مالي/مخزني. */
export async function requestPurchaseOrderControl(
  input: PurchaseOrderControlRequestInput,
  actor: Actor,
) {
  const result = await withTx((tx) => requestPurchaseOrderControlTx(tx, input, actor));
  // اعتماد المراجعة يثبت واقعةً مستقلة: وصول البضاعة كاملة ومطابقتها. إنشاء الطلب وحده
  // لا يحمل هذا الإقرار، لذلك يبقى بانتظار تأكيد صريح حتى لو كان المنشئ هو المالك.
  if (input.kind === "APPROVE_REVISION") return result;
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "purchase.order.control",
    id: result.requestId,
    reason: input.reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

/** DRAFT → SENT وإنشاء طلب اعتماد المراجعة في معاملة واحدة. */
export async function submitPurchaseOrderForApproval(
  input: {
    purchaseOrderId: number;
    expectedVersion: number;
    reason: string;
    requestKey: string;
  },
  actor: Actor,
) {
  const reason = validateReason(input.reason, "سبب الإرسال للاعتماد");
  const requestKey = validateKey(input.requestKey, "مفتاح إرسال أمر الشراء");
  const submitHash = idempotencyHash({
    purchaseOrderId: input.purchaseOrderId,
    expectedVersion: input.expectedVersion,
    reason,
  });
  const result = await withTx(async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
      .limit(1);
    if (!po)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "أمر الشراء غير موجود",
      });
    assertPurchaseBranch(po, actor);
    const replay = await checkIdempotency(
      tx,
      "purchase.order.submit",
      requestKey,
      submitHash,
      { requireStoredHash: true },
    );
    if (replay != null) {
      const [request] = await tx
        .select()
        .from(purchaseOrderControlRequests)
        .where(eq(purchaseOrderControlRequests.id, replay))
        .limit(1);
      if (
        !request ||
        Number(request.purchaseOrderId) !== input.purchaseOrderId
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سجل إرسال أمر الشراء غير متسق",
        });
      }
      return {
        purchaseOrderId: input.purchaseOrderId,
        requestId: replay,
        status: request.status,
        idempotent: true as const,
      };
    }
    if (po.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يُرسل إلا أمر شراء مسودة",
      });
    }
    if (Number(po.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر أمر الشراء؛ حدّث الصفحة ثم أعد المحاولة",
      });
    }
    if (po.currentRevisionId == null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "أمر الشراء بلا مراجعة ثابتة حالية",
      });
    }
    // يفشل الإرسال كله إن كانت سياسة الفرع تتطلب استثناءً طارئاً لم يُعتمد بعد.
    await assertRequisitionOrEmergencyTx(tx, {
      purchaseOrderId: input.purchaseOrderId,
      revisionId: Number(po.currentRevisionId),
      branchId: Number(po.branchId),
    });
    await tx
      .update(purchaseOrders)
      .set({
        status: "SENT",
        submittedBy: actor.userId,
        submittedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, input.purchaseOrderId));
    const [updated] = await tx
      .select({ version: purchaseOrders.version })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .limit(1);
    const request = await requestPurchaseOrderControlTx(
      tx,
      {
        purchaseOrderId: input.purchaseOrderId,
        revisionId: Number(po.currentRevisionId),
        expectedVersion: Number(updated.version),
        kind: "APPROVE_REVISION",
        requestKey,
        reason,
      },
      actor,
    );
    await appendPurchaseOrderEventTx(tx, {
      eventKey: `PO-SUBMITTED:${requestKey}`,
      purchaseOrderId: input.purchaseOrderId,
      revisionId: Number(po.currentRevisionId),
      requestId: request.requestId,
      branchId: Number(po.branchId),
      eventType: "ORDER_SUBMITTED",
      reason,
      actorUserId: actor.userId,
      payload: {
        previousVersion: input.expectedVersion,
        version: Number(updated.version),
      },
    });
    await recordIdempotencyKey(
      tx,
      "purchase.order.submit",
      requestKey,
      request.requestId,
      submitHash,
    );
    return {
      purchaseOrderId: input.purchaseOrderId,
      requestId: request.requestId,
      status: "PENDING" as const,
      version: Number(updated.version),
      idempotent: false as const,
    };
  });
  // لا نختلق إقرار استلام كامل من فعل «إرسال للاعتماد»؛ يظل هذا الطلب حتى يدخل
  // المالك تأكيد الاستلام الصريح من شاشة القرار.
  return result;
}

async function assertCancellationSafeTx(tx: Tx, purchaseOrderId: number) {
  const items = await tx
    .select({
      variantId: purchaseOrderItems.variantId,
      receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity,
    })
    .from(purchaseOrderItems)
    .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId));
  if (items.some((item) => Number(item.receivedBaseQuantity ?? 0) > 0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن إلغاء أمر استُلمت منه بضاعة؛ استعمل مرتجع شراء",
    });
  }
  return items;
}

export async function decidePurchaseOrderControl(
  input: {
    requestId: number;
    decisionKey: string;
    approve: boolean;
    reason: string;
    confirmedFullReceipt?: boolean;
  },
  actor: Actor,
  options: { legacyConfirmOnly?: true } = {},
) {
  const preview = (
    await requireDb()
      .select({
        purchaseOrderId: purchaseOrderControlRequests.purchaseOrderId,
        branchId: purchaseOrderControlRequests.branchId,
        kind: purchaseOrderControlRequests.kind,
      })
      .from(purchaseOrderControlRequests)
      .where(eq(purchaseOrderControlRequests.id, input.requestId))
      .limit(1)
  )[0];
  if (!preview)
    throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
  const reason = validateReason(input.reason, "سبب القرار");
  const decisionKey = validateKey(input.decisionKey, "مفتاح القرار");
  const decisionHash = idempotencyHash({
    requestId: input.requestId,
    approve: input.approve,
    reason,
    confirmedFullReceipt: input.confirmedFullReceipt ?? false,
    legacyConfirmOnly: options.legacyConfirmOnly ?? false,
  });
  return withTx(async (tx) => {
    // استعادة أهلية الصنف للجرد الافتتاحي تعتمد على رؤية كل أوامر الشراء غير الملغاة.
    // لذلك يتشارك الإلغاء المحكوم ترتيب الأقفال نفسه مع إنشاء/تعديل الأمر والجرد:
    // الفرع أولاً ثم أمر الشراء. القفل هو أول قراءة داخل المعاملة كي لا تسبق الانتظارَ
    // لقطةُ REPEATABLE READ قديمة فتُعيد صنفاً بينما يُنشأ له أمر آخر بالتزامن.
    if (preview.kind === "CANCEL_ORDER") {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, Number(preview.branchId)))
        .for("update")
        .limit(1);
      if (!branch)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الفرع غير موجود",
        });
    }
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, preview.purchaseOrderId))
      .for("update")
      .limit(1);
    if (!po)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "أمر الشراء غير موجود",
      });
    assertPurchaseBranch(po, actor);
    const [request] = await tx
      .select()
      .from(purchaseOrderControlRequests)
      .where(eq(purchaseOrderControlRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب التحكم غير موجود",
      });
    if (
      Number(request.purchaseOrderId) !== Number(po.id) ||
      Number(request.branchId) !== Number(po.branchId) ||
      Number(request.branchId) !== Number(preview.branchId) ||
      request.kind !== preview.kind
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "بيانات طلب التحكم لا تطابق أمر الشراء",
      });
    }
    const replay = await checkIdempotency(
      tx,
      "purchase.order.control.decide",
      decisionKey,
      decisionHash,
      { requireStoredHash: true },
    );
    if (replay != null) {
      if (replay !== input.requestId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح القرار يعود لطلب آخر",
        });
      return {
        requestId: input.requestId,
        status: request.status,
        idempotent: true as const,
      };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حُسم طلب التحكم مسبقاً",
      });
    }
    // سياسةُ الاعتماد (shared/approvalPolicy.ts): البوّابة **بالفعل لا بالإجراء**. اعتمادُ
    // المراجعة والاستثناءُ الطارئ والرفضُ بلا بوّابة؛ و**إلغاءُ الأمر** وحده محوُ أثر —
    // لأنّه يمحو توقيعَ الجرد الافتتاحيّ (openingEligibility.ts:426). التفصيل ودليلُه في
    // `shared/approvalTriggers.ts`.
    const resolvedActor = await resolveApprovalActor(tx, actor);
    assertApprover({
      actor: resolvedActor,
      trigger: purchaseOrderControlTrigger(request.kind, input.approve),
      subject: `أمر الشراء ${po.poNumber}`,
      legacy: () => {
        if (
          actor.userId === Number(request.requestedBy) ||
          actor.userId === Number(po.createdBy) ||
          actor.userId === Number(po.lastEditedBy)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "يلزم معتمد مستقل عن المنشئ وآخر محرر وصاحب الطلب",
          });
        }
      },
    });
    if (Number(request.baseOrderVersion) !== Number(po.version)) {
      await tx
        .update(purchaseOrderControlRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: "تغيّر أمر الشراء بعد إنشاء طلب التحكم",
        })
        .where(eq(purchaseOrderControlRequests.id, input.requestId));
      await appendPurchaseOrderEventTx(tx, {
        eventKey: `PO-CONTROL-STALE:${decisionKey}`,
        purchaseOrderId: Number(po.id),
        revisionId:
          request.revisionId == null ? null : Number(request.revisionId),
        requestId: input.requestId,
        branchId: Number(po.branchId),
        eventType: `${request.kind}_STALE`,
        reason,
        actorUserId: actor.userId,
        payload: {
          baseOrderVersion: request.baseOrderVersion,
          currentVersion: po.version,
        },
      });
      await recordIdempotencyKey(
        tx,
        "purchase.order.control.decide",
        decisionKey,
        input.requestId,
        decisionHash,
      );
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        idempotent: false as const,
      };
    }
    if (!input.approve) {
      if (request.kind === "APPROVE_REVISION" && po.status === "SENT") {
        // الرفض يعيد المستند إلى منطقة التعديل؛ إبقاؤه SENT سيخلق طريقاً مسدوداً لا يمكن
        // فيه تعديل المراجعة المرفوضة ولا إعادة إرسالها بصدق.
        await tx
          .update(purchaseOrders)
          .set({ status: "DRAFT", submittedBy: null, submittedAt: null })
          .where(eq(purchaseOrders.id, po.id));
      }
      await tx
        .update(purchaseOrderControlRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: reason,
        })
        .where(eq(purchaseOrderControlRequests.id, input.requestId));
      const [afterRejection] = await tx
        .select({
          status: purchaseOrders.status,
          version: purchaseOrders.version,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, po.id))
        .limit(1);
      await appendPurchaseOrderEventTx(tx, {
        eventKey: `PO-CONTROL-REJECTED:${decisionKey}`,
        purchaseOrderId: Number(po.id),
        revisionId:
          request.revisionId == null ? null : Number(request.revisionId),
        requestId: input.requestId,
        branchId: Number(po.branchId),
        eventType: `${request.kind}_REJECTED`,
        reason,
        actorUserId: actor.userId,
        payload: {
          status: afterRejection.status,
          version: afterRejection.version,
        },
      });
      await recordIdempotencyKey(
        tx,
        "purchase.order.control.decide",
        decisionKey,
        input.requestId,
        decisionHash,
      );
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        idempotent: false as const,
      };
    }

    let applicationEvidence: Record<string, unknown> = {};
    if (request.kind === "APPROVE_REVISION") {
      if (!options.legacyConfirmOnly && !input.confirmedFullReceipt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "يلزم تأكيد وصول كامل كميات الفاتورة قبل الاعتماد والترحيل",
        });
      }
      if (
        po.status !== "SENT" ||
        po.currentRevisionId == null ||
        Number(request.revisionId) !== Number(po.currentRevisionId)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "حالة الأمر أو مراجعته لم تعد صالحة للاعتماد",
        });
      }
      const gate = await assertRequisitionOrEmergencyTx(tx, {
        purchaseOrderId: Number(po.id),
        revisionId: Number(po.currentRevisionId),
        branchId: Number(po.branchId),
      });
      if (
        gate.emergency?.reviewedBy != null &&
        Number(gate.emergency.reviewedBy) === actor.userId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "معتمد الاستثناء الطارئ لا يعتمد أمر الشراء نفسه؛ يلزم اعتماد ثانٍ مستقل",
        });
      }
      await tx
        .update(purchaseOrders)
        .set({
          status: "CONFIRMED",
          approvedRevisionId: Number(po.currentRevisionId),
          approvedBy: actor.userId,
          approvedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, po.id));
      if (options.legacyConfirmOnly) {
        // Internal migration/test seam for historical partial-receipt records.
        // It is intentionally absent from every router and UI contract.
        applicationEvidence = { legacyConfirmOnly: true };
      } else {
        const posting = await postApprovedPurchaseInvoiceInTx(
          tx,
          Number(po.id),
          resolvedActor,
          decisionKey,
        );
        applicationEvidence = {
          automaticInvoicePosting: true,
          fullyReceived: true,
          goodsReceiptId: posting.goodsReceiptId,
          supplierInvoiceId: posting.supplierInvoiceId,
          matchRunId: posting.matchRunId,
          accountingEntryId: posting.accountingEntryId,
          shippingPaymentRequestReceiptId:
            posting.shippingPaymentRequestReceiptId,
        };
      }
    } else if (request.kind === "CANCEL_ORDER") {
      if (!["DRAFT", "SENT", "CONFIRMED"].includes(po.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "حالة أمر الشراء لا تقبل الإلغاء",
        });
      }
      if (money(po.paidAmount).gt(0) || money(po.paidUsd ?? "0").gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "أمر الشراء عليه دفعة مسجلة؛ لا يمكن إلغاؤه",
        });
      }
      const items = await assertCancellationSafeTx(tx, Number(po.id));
      const releasedAllocations =
        po.currentRevisionId == null
          ? []
          : await releasePurchaseOrderRevisionAllocationsTx(
              tx,
              Number(po.currentRevisionId),
            );
      await tx
        .update(purchaseOrders)
        .set({ status: "CANCELLED" })
        .where(eq(purchaseOrders.id, po.id));
      await restoreVariantsToActiveOpeningStocktakes(
        tx,
        Number(po.branchId),
        items.map((item) => Number(item.variantId)),
      );
      applicationEvidence = {
        releasedRequisitionAllocations: releasedAllocations,
      };
    } else {
      const settings = await getPurchaseControlSettingsTx(
        tx,
        Number(po.branchId),
      );
      if (!settings.requireRequisition || !settings.allowEmergencyOrder) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "إعدادات الفرع لم تعد تسمح بالاستثناء الطارئ",
        });
      }
      if (
        request.revisionId == null ||
        Number(request.revisionId) !== Number(po.currentRevisionId)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت مراجعة الأمر بعد طلب الاستثناء",
        });
      }
    }
    await tx
      .update(purchaseOrderControlRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason: reason,
        appliedAt: new Date(),
      })
      .where(eq(purchaseOrderControlRequests.id, input.requestId));
    const [updated] = await tx
      .select({
        status: purchaseOrders.status,
        version: purchaseOrders.version,
      })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, po.id))
      .limit(1);
    await appendPurchaseOrderEventTx(tx, {
      eventKey: `PO-CONTROL-APPROVED:${decisionKey}`,
      purchaseOrderId: Number(po.id),
      revisionId:
        request.revisionId == null ? null : Number(request.revisionId),
      requestId: input.requestId,
      branchId: Number(po.branchId),
      eventType: `${request.kind}_APPROVED`,
      reason,
      actorUserId: actor.userId,
      payload: {
        status: updated.status,
        version: updated.version,
        ...applicationEvidence,
      },
    });
    await recordIdempotencyKey(
      tx,
      "purchase.order.control.decide",
      decisionKey,
      input.requestId,
      decisionHash,
    );
    return {
      requestId: input.requestId,
      status: "APPROVED" as const,
      orderStatus: updated.status,
      version: Number(updated.version),
      idempotent: false as const,
    };
  });
}

export async function listPendingPurchaseOrderControls(
  actor: Actor,
  /**
   * `order: "ASC"` = الأقدم أوّلاً (صندوق القرارات): القصّ بالأحدث يُسقط أكثر الطلبات
   * تأخّراً بالضبط حين يكثر المعلَّق (Codex على #1004). المؤشّر `cursor` يخصّ النزول فقط.
   */
  page: { limit: number; cursor?: number | null; order?: "ASC" | "DESC" },
) {
  const db = requireDb();
  const branchCondition =
    actor.role === "admin"
      ? undefined
      : eq(purchaseOrderControlRequests.branchId, actor.branchId);
  return db
    .select({
      id: purchaseOrderControlRequests.id,
      requestKey: purchaseOrderControlRequests.requestKey,
      purchaseOrderId: purchaseOrderControlRequests.purchaseOrderId,
      poNumber: purchaseOrders.poNumber,
      revisionId: purchaseOrderControlRequests.revisionId,
      branchId: purchaseOrderControlRequests.branchId,
      kind: purchaseOrderControlRequests.kind,
      status: purchaseOrderControlRequests.status,
      reason: purchaseOrderControlRequests.reason,
      baseOrderVersion: purchaseOrderControlRequests.baseOrderVersion,
      requestedBy: purchaseOrderControlRequests.requestedBy,
      requestedByName: users.name,
      requestedAt: purchaseOrderControlRequests.requestedAt,
      creatorId: purchaseOrders.createdBy,
      lastEditedBy: purchaseOrders.lastEditedBy,
      orderVersion: purchaseOrders.version,
      orderStatus: purchaseOrders.status,
      shippingCost: purchaseOrders.shippingCost,
      customsCost: purchaseOrders.customsCost,
    })
    .from(purchaseOrderControlRequests)
    .innerJoin(
      purchaseOrders,
      eq(purchaseOrderControlRequests.purchaseOrderId, purchaseOrders.id),
    )
    .leftJoin(users, eq(purchaseOrderControlRequests.requestedBy, users.id))
    .where(
      and(
        eq(purchaseOrderControlRequests.status, "PENDING"),
        branchCondition,
        page.cursor == null
          ? undefined
          : lt(purchaseOrderControlRequests.id, page.cursor),
      ),
    )
    .orderBy(page.order === "ASC" ? asc(purchaseOrderControlRequests.id) : desc(purchaseOrderControlRequests.id))
    .limit(page.limit + 1);
}

export async function getPurchaseOrderControlRequest(
  requestId: number,
  actor: Actor,
) {
  const db = requireDb();
  const [request] = await db
    .select()
    .from(purchaseOrderControlRequests)
    .where(eq(purchaseOrderControlRequests.id, requestId))
    .limit(1);
  if (!request)
    throw new TRPCError({ code: "NOT_FOUND", message: "طلب التحكم غير موجود" });
  assertPurchaseBranch(request, actor);
  return request;
}

export async function listPurchaseOrderEvents(
  purchaseOrderId: number,
  actor: Actor,
) {
  const [po] = await requireDb()
    .select({ branchId: purchaseOrders.branchId })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .limit(1);
  if (!po)
    throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  assertPurchaseBranch(po, actor);
  return requireDb()
    .select()
    .from(purchaseOrderEvents)
    .where(eq(purchaseOrderEvents.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(purchaseOrderEvents.id));
}
