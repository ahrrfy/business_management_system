import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  deliveryCodWriteOffRequests,
  deliveryConsignments,
  deliveryParties,
  users,
} from "../../../drizzle/schema";
import { isDupEntry } from "@shared/errorMap.ar";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { requireDb, type Actor, withTx } from "../tx";
import {
  writeOffDeliveryShortfallInTx,
  type WriteOffInput,
} from "./settle";

export interface DeliveryWriteOffRequestInput extends Omit<WriteOffInput, "clientRequestId"> {
  requestKey: string;
}

export interface DeliveryWriteOffDecisionInput {
  id: number;
  expectedVersion: number;
  decisionKey: string;
  reviewNote?: string | null;
}

function normalizedText(value: string, label: string, min = 3, max = 500): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب (${min}-${max} محرف)` });
  }
  return normalized;
}

function normalizedKey(value: string, label: string): string {
  return normalizedText(value, label, 8, 120);
}

type DeliveryWriteOffReviewActor = Actor & { reviewAuthorized?: boolean };

function assertRequestWriteOffAuthority(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلبات شطب عهدة COD محصورة بالمالك/الأدمن" });
  }
}

function assertReviewWriteOffAuthority(actor: DeliveryWriteOffReviewActor): void {
  if (actor.role !== "admin" && actor.reviewAuthorized !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مراجعة شطب عهدة COD تتطلب صلاحية إدارة التوصيل" });
  }
}

function assertBranch(branchId: number, actor: Actor): void {
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "فرع طلب الشطب مطلوب" });
  }
  if (actor.role !== "admin" && Number(actor.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب الشطب لا يخص فرعك" });
  }
}

function requestPayload(input: DeliveryWriteOffRequestInput) {
  const amount = round2(money(input.amount));
  if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الشطب يجب أن يكون موجباً" });
  const reason = normalizedText(input.reason, "سبب الشطب");
  const evidenceNote = input.evidenceNote?.trim() || null;
  const attachmentUrl = input.attachmentUrl?.trim() || null;
  if (!evidenceNote && !attachmentUrl) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يلزم وصف إثبات أو رابط مرفق لطلب الشطب" });
  }
  if (evidenceNote && evidenceNote.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وصف الإثبات أطول من 500 محرف" });
  }
  if (attachmentUrl && attachmentUrl.length > 2048) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رابط المرفق أطول من 2048 محرف" });
  }
  return {
    branchId: Number(input.branchId),
    partyId: Number(input.partyId),
    consignmentId: input.consignmentId == null ? null : Number(input.consignmentId),
    amount: toDbMoney(amount),
    reason,
    evidenceNote,
    attachmentUrl,
  };
}

function exactRequestReplay(
  row: typeof deliveryCodWriteOffRequests.$inferSelect,
  payloadHash: string,
  actor: Actor,
): boolean {
  return payloadHashMatches(payloadHash, row.payloadHash) && Number(row.requestedBy) === actor.userId;
}

function decisionHash(input: DeliveryWriteOffDecisionInput, decision: "APPROVE" | "REJECT", note: string | null) {
  return idempotencyHash({
    requestId: input.id,
    expectedVersion: input.expectedVersion,
    decision,
    reviewNote: note,
  });
}

function exactDecisionReplay(
  row: typeof deliveryCodWriteOffRequests.$inferSelect,
  input: DeliveryWriteOffDecisionInput,
  hash: string,
  actor: Actor,
  status: "APPROVED" | "REJECTED",
): boolean {
  return row.status === status
    && row.decisionKey === input.decisionKey
    && row.decisionHash === hash
    && Number(row.reviewedBy) === actor.userId;
}

/** مستند نيّة فقط: لا قيد، لا تغيير فاتورة/إرسالية، ولا خفض عهدة. */
export async function requestDeliveryCodWriteOff(input: DeliveryWriteOffRequestInput, actor: Actor) {
  assertRequestWriteOffAuthority(actor);
  const requestKey = normalizedKey(input.requestKey, "مفتاح الطلب");
  const payload = requestPayload(input);
  assertBranch(payload.branchId, actor);
  const payloadHash = idempotencyHash(payload);

  return withTx(async (tx) => {
    const replay = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.requestKey, requestKey)).limit(1)
    )[0];
    if (replay) {
      assertBranch(Number(replay.branchId), actor);
      if (!exactRequestReplay(replay, payloadHash, actor)) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستخدم بحمولة مختلفة" });
      }
      return { ...replay, replayed: true as const };
    }

    const party = (
      await tx.select().from(deliveryParties)
        .where(eq(deliveryParties.id, payload.partyId)).for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    if (party.branchId == null || Number(party.branchId) !== payload.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "جهة التوصيل لا تخص فرع الطلب" });
    }
    if (money(payload.amount).gt(round2(money(party.currentBalance)))) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مبلغ الطلب يتجاوز العهدة الحالية" });
    }
    if (payload.consignmentId != null) {
      const consignment = (
        await tx.select().from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, payload.consignmentId)).for("update").limit(1)
      )[0];
      if (!consignment) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
      if (Number(consignment.partyId) !== payload.partyId || Number(consignment.branchId) !== payload.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية لا تخص الجهة/الفرع المحددين" });
      }
    }

    const pendingGuard = `PARTY:${payload.partyId}:${payload.consignmentId ?? "LOOSE"}`;
    try {
      const inserted = await tx.insert(deliveryCodWriteOffRequests).values({
        requestKey,
        partyId: payload.partyId,
        consignmentId: payload.consignmentId,
        branchId: payload.branchId,
        status: "PENDING",
        basePartyVersion: Number(party.version),
        amount: payload.amount,
        payload,
        payloadHash,
        reason: payload.reason,
        evidenceNote: payload.evidenceNote,
        attachmentUrl: payload.attachmentUrl,
        requestedBy: actor.userId,
        pendingGuard,
      });
      return {
        id: extractInsertId(inserted),
        requestKey,
        branchId: payload.branchId,
        partyId: payload.partyId,
        consignmentId: payload.consignmentId,
        basePartyVersion: Number(party.version),
        status: "PENDING" as const,
        payloadHash,
        replayed: false as const,
      };
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const raced = (
        await tx.select().from(deliveryCodWriteOffRequests)
          .where(eq(deliveryCodWriteOffRequests.requestKey, requestKey)).limit(1)
      )[0];
      if (raced && exactRequestReplay(raced, payloadHash, actor)) {
        return { ...raced, replayed: true as const };
      }
      throw new TRPCError({ code: "CONFLICT", message: "يوجد طلب شطب معلّق لنفس العهدة أو استُهلك المفتاح" });
    }
  }, { gate: "NONE" });
}

export async function approveDeliveryCodWriteOff(input: DeliveryWriteOffDecisionInput, actor: DeliveryWriteOffReviewActor) {
  assertReviewWriteOffAuthority(actor);
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const reviewNote = input.reviewNote?.trim() || null;
  if (reviewNote && reviewNote.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة القرار أطول من 500 محرف" });
  }
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "APPROVE", reviewNote);
  const result = await withTx(async (tx) => {
    const preview = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).limit(1)
    )[0];
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الشطب غير موجود" });
    assertBranch(Number(preview.branchId), actor);
    if (exactDecisionReplay(preview, normalizedInput, hash, actor, "APPROVED")) {
      return { request: preview, replayed: true as const };
    }
    if (preview.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب الشطب محسوم بالحالة ${preview.status}` });
    }

    // ترتيب الأقفال: جهة التوصيل ← طلب الحوكمة ← الإرسالية/الفاتورة داخل نواة الشطب.
    const party = (
      await tx.select().from(deliveryParties)
        .where(eq(deliveryParties.id, Number(preview.partyId))).for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    const lockedRequest = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!lockedRequest) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الشطب غير موجود" });
    if (exactDecisionReplay(lockedRequest, normalizedInput, hash, actor, "APPROVED")) {
      return { request: lockedRequest, replayed: true as const };
    }
    if (lockedRequest.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب الشطب محسوم بالحالة ${lockedRequest.status}` });
    }
    if (Number(lockedRequest.requestedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد منشئ طلب الشطب طلبه بنفسه" });
    }
    if (Number(lockedRequest.basePartyVersion) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "نسخة الطلب المتوقعة لا تطابق النسخة المحفوظة" });
    }
    if (idempotencyHash(lockedRequest.payload) !== lockedRequest.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: "حمولة طلب الشطب لا تطابق بصمتها" });
    }
    if (Number(party.version) !== Number(lockedRequest.basePartyVersion)) {
      const reviewedAt = new Date();
      await tx.update(deliveryCodWriteOffRequests).set({
        status: "STALE",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt,
        reviewNote: "تغيّرت عهدة جهة التوصيل بعد إنشاء الطلب",
        decisionKey,
        decisionHash: hash,
      }).where(and(
        eq(deliveryCodWriteOffRequests.id, input.id),
        eq(deliveryCodWriteOffRequests.status, "PENDING"),
      ));
      return { stale: true as const };
    }

    const storedPayload = lockedRequest.payload as unknown as ReturnType<typeof requestPayload>;
    const effect = await writeOffDeliveryShortfallInTx(tx, {
      ...storedPayload,
      clientRequestId: `delivery-writeoff-control-${input.id}`,
    }, { ...actor, branchId: Number(lockedRequest.branchId) }, { controlRequestAuthorized: true });
    const reviewedAt = new Date();
    const updated = await tx.update(deliveryCodWriteOffRequests).set({
      status: "APPROVED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote,
      decisionKey,
      decisionHash: hash,
      appliedAt: reviewedAt,
    }).where(and(
      eq(deliveryCodWriteOffRequests.id, input.id),
      eq(deliveryCodWriteOffRequests.status, "PENDING"),
    ));
    if (extractAffectedRows(updated) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة طلب الشطب أثناء الاعتماد" });
    }
    return { request: { ...lockedRequest, status: "APPROVED" as const }, effect, replayed: false as const };
  });
  if ("stale" in result) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت العهدة منذ إنشاء الطلب؛ افتح طلباً جديداً" });
  }
  return result;
}

export async function rejectDeliveryCodWriteOff(
  input: DeliveryWriteOffDecisionInput & { reason: string },
  actor: DeliveryWriteOffReviewActor,
) {
  assertReviewWriteOffAuthority(actor);
  const decisionKey = normalizedKey(input.decisionKey, "مفتاح القرار");
  const note = normalizedText(input.reason, "سبب الرفض");
  const normalizedInput = { ...input, decisionKey };
  const hash = decisionHash(normalizedInput, "REJECT", note);
  return withTx(async (tx) => {
    const request = (
      await tx.select().from(deliveryCodWriteOffRequests)
        .where(eq(deliveryCodWriteOffRequests.id, input.id)).for("update").limit(1)
    )[0];
    if (!request) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الشطب غير موجود" });
    assertBranch(Number(request.branchId), actor);
    if (exactDecisionReplay(request, normalizedInput, hash, actor, "REJECTED")) {
      return { request, replayed: true as const };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `طلب الشطب محسوم بالحالة ${request.status}` });
    }
    if (Number(request.requestedBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يراجع منشئ طلب الشطب طلبه بنفسه" });
    }
    if (Number(request.basePartyVersion) !== input.expectedVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "نسخة الطلب المتوقعة لا تطابق النسخة المحفوظة" });
    }
    if (idempotencyHash(request.payload) !== request.payloadHash) {
      throw new TRPCError({ code: "CONFLICT", message: "حمولة طلب الشطب لا تطابق بصمتها" });
    }
    const reviewedAt = new Date();
    await tx.update(deliveryCodWriteOffRequests).set({
      status: "REJECTED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt,
      reviewNote: note,
      decisionKey,
      decisionHash: hash,
    }).where(and(
      eq(deliveryCodWriteOffRequests.id, input.id),
      eq(deliveryCodWriteOffRequests.status, "PENDING"),
    ));
    return { request: { ...request, status: "REJECTED" as const, reviewNote: note }, replayed: false as const };
  }, { gate: "NONE" });
}

export async function listDeliveryCodWriteOffRequests(
  actor: DeliveryWriteOffReviewActor,
  options?: { status?: "PENDING" | "APPROVED" | "REJECTED" | "STALE"; branchId?: number | null },
) {
  assertReviewWriteOffAuthority(actor);
  if (options?.branchId != null) assertBranch(Number(options.branchId), actor);
  const effectiveBranchId = actor.role === "admin"
    ? (options?.branchId == null ? null : Number(options.branchId))
    : Number(actor.branchId);
  if (effectiveBranchId != null) assertBranch(effectiveBranchId, actor);
  const db = requireDb();
  return db.select({
    id: deliveryCodWriteOffRequests.id,
    requestKey: deliveryCodWriteOffRequests.requestKey,
    partyId: deliveryCodWriteOffRequests.partyId,
    partyName: deliveryParties.name,
    consignmentId: deliveryCodWriteOffRequests.consignmentId,
    consignmentNumber: deliveryConsignments.consignmentNumber,
    branchId: deliveryCodWriteOffRequests.branchId,
    status: deliveryCodWriteOffRequests.status,
    basePartyVersion: deliveryCodWriteOffRequests.basePartyVersion,
    amount: deliveryCodWriteOffRequests.amount,
    reason: deliveryCodWriteOffRequests.reason,
    evidenceNote: deliveryCodWriteOffRequests.evidenceNote,
    attachmentUrl: deliveryCodWriteOffRequests.attachmentUrl,
    requestedBy: deliveryCodWriteOffRequests.requestedBy,
    requesterName: users.name,
    reviewedBy: deliveryCodWriteOffRequests.reviewedBy,
    reviewedAt: deliveryCodWriteOffRequests.reviewedAt,
    reviewNote: deliveryCodWriteOffRequests.reviewNote,
    appliedAt: deliveryCodWriteOffRequests.appliedAt,
    createdAt: deliveryCodWriteOffRequests.createdAt,
  }).from(deliveryCodWriteOffRequests)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryCodWriteOffRequests.partyId))
    .leftJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryCodWriteOffRequests.consignmentId))
    .innerJoin(users, eq(users.id, deliveryCodWriteOffRequests.requestedBy))
    .where(and(
      options?.status ? eq(deliveryCodWriteOffRequests.status, options.status) : undefined,
      effectiveBranchId != null ? eq(deliveryCodWriteOffRequests.branchId, effectiveBranchId) : undefined,
    ))
    .orderBy(desc(deliveryCodWriteOffRequests.id))
    .limit(300);
}
