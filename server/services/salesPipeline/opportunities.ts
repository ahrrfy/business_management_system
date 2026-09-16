import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, lt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  canTransitionOpportunity,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import {
  customers,
  salesLeadEvents,
  salesLeads,
  salesOpportunities,
  salesOpportunityEvents,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { escLike } from "../../lib/sqlLike";
import { idempotencyHash, payloadHashMatches } from "../idempotency";
import { requireDb, withTx, type Actor } from "../tx";
import {
  assertExactReplay,
  assertQuotationTx,
  assertWinningInvoiceTx,
  normalizeExpectedCloseDate,
  normalizeExpectedValue,
  normalizePipelineKey,
  normalizePipelineReason,
  normalizeProbability,
  normalizeRequiredText,
} from "./common";
import {
  assertActiveBranchTx,
  assertCustomerTx,
  assertPipelineRowWritable,
  resolvePipelineBranch,
  resolvePipelineOwnerTx,
} from "./scope";
import { loadLeadForUpdate } from "./leads";
import type {
  ConvertLeadInput,
  CreateOpportunityInput,
  OpportunityFilters,
  PipelineReadScope,
  TransitionOpportunityInput,
  UpdateOpportunityInput,
} from "./types";

const opportunityOwner = alias(users, "salesOpportunityOwner");

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة الفرصة غير صالحة",
    });
  }
}

async function loadOpportunityForUpdate(tx: Tx, opportunityId: number) {
  const [opportunity] = await tx
    .select()
    .from(salesOpportunities)
    .where(eq(salesOpportunities.id, opportunityId))
    .for("update")
    .limit(1);
  if (!opportunity)
    throw new TRPCError({ code: "NOT_FOUND", message: "الفرصة غير موجودة" });
  return opportunity;
}

async function loadOpportunityEventForUpdate(tx: Tx, requestKey: string) {
  return (
    await tx
      .select()
      .from(salesOpportunityEvents)
      .where(eq(salesOpportunityEvents.eventKey, requestKey))
      .for("update")
      .limit(1)
  )[0];
}

function assertOpportunityEventReplay(
  event: typeof salesOpportunityEvents.$inferSelect,
  opportunityId: number,
  payloadHash: string,
  actor: Actor,
): void {
  assertExactReplay(event, payloadHash, actor.userId);
  if (Number(event.opportunityId) !== opportunityId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح الطلب مستخدم لفرصة أخرى",
    });
  }
}

function normalizeOpportunityDraft(input: {
  title: string;
  expectedValue: string;
  probability: string;
  expectedCloseDate: string;
  quotationId?: number | null;
}) {
  return {
    title: normalizeRequiredText(input.title, "عنوان الفرصة"),
    expectedValue: normalizeExpectedValue(input.expectedValue),
    probability: normalizeProbability(input.probability),
    expectedCloseDate: normalizeExpectedCloseDate(input.expectedCloseDate),
    quotationId: input.quotationId ?? null,
  };
}

async function insertOpportunityTx(
  tx: Tx,
  input: {
    branchId: number;
    leadId: number | null;
    customerId: number | null;
    ownerId: number;
    title: string;
    expectedValue: string;
    probability: string;
    expectedCloseDate: string;
    quotationId: number | null;
    createKey: string;
    createHash: string;
    reason: string;
  },
  actor: Actor,
) {
  const inserted = await tx.insert(salesOpportunities).values({
    opportunityNumber: `TMP-O-${randomUUID()}`,
    branchId: input.branchId,
    leadId: input.leadId,
    customerId: input.customerId,
    ownerId: input.ownerId,
    title: input.title,
    stage: "DISCOVERY",
    expectedValue: input.expectedValue,
    probability: input.probability,
    expectedCloseDate: input.expectedCloseDate,
    quotationId: input.quotationId,
    invoiceId: null,
    lastReason: null,
    version: 1,
    createKey: input.createKey,
    createHash: input.createHash,
    createdBy: actor.userId,
  });
  const opportunityId = extractInsertId(inserted);
  const opportunityNumber = `OP-${input.branchId}-${String(opportunityId).padStart(7, "0")}`;
  await tx
    .update(salesOpportunities)
    .set({ opportunityNumber })
    .where(eq(salesOpportunities.id, opportunityId));
  await tx.insert(salesOpportunityEvents).values({
    eventKey: input.createKey,
    opportunityId,
    branchId: input.branchId,
    eventType: "CREATED",
    fromStage: null,
    toStage: "DISCOVERY",
    baseVersion: 1,
    resultVersion: 1,
    reason: input.reason,
    payload: {
      leadId: input.leadId,
      customerId: input.customerId,
      ownerId: input.ownerId,
      title: input.title,
      expectedValue: input.expectedValue,
      probability: input.probability,
      expectedCloseDate: input.expectedCloseDate,
      quotationId: input.quotationId,
    },
    payloadHash: input.createHash,
    actorUserId: actor.userId,
  });
  return { opportunityId, opportunityNumber };
}

export async function createSalesOpportunity(
  input: CreateOpportunityInput,
  actor: Actor,
) {
  const createKey = normalizePipelineKey(
    input.clientRequestId,
    "معرّف إنشاء الفرصة",
  );
  const branchId = resolvePipelineBranch(input.branchId, actor);
  const draft = normalizeOpportunityDraft(input);
  const payload = {
    branchId,
    customerId: input.customerId,
    ownerId: input.ownerId ?? null,
    ...draft,
  };
  const payloadHash = idempotencyHash(payload);

  return withTx(
    async (tx) => {
      const [replay] = await tx
        .select()
        .from(salesOpportunities)
        .where(eq(salesOpportunities.createKey, createKey))
        .for("update")
        .limit(1);
      if (replay) {
        if (
          !payloadHashMatches(payloadHash, replay.createHash) ||
          Number(replay.createdBy) !== actor.userId
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "معرّف إنشاء الفرصة مستخدم لحمولة مختلفة",
          });
        }
        assertPipelineRowWritable(replay, actor);
        return {
          opportunityId: Number(replay.id),
          opportunityNumber: replay.opportunityNumber,
          version: Number(replay.version),
          replayed: true as const,
        };
      }
      await assertActiveBranchTx(tx, branchId);
      await assertCustomerTx(tx, input.customerId);
      const ownerId = await resolvePipelineOwnerTx(
        tx,
        input.ownerId,
        branchId,
        actor,
      );
      await assertQuotationTx(
        tx,
        draft.quotationId,
        branchId,
        input.customerId,
      );
      try {
        const result = await insertOpportunityTx(
          tx,
          {
            branchId,
            leadId: null,
            customerId: input.customerId,
            ownerId,
            ...draft,
            createKey,
            createHash: payloadHash,
            reason: "إنشاء فرصة لعميل قائم",
          },
          actor,
        );
        return { ...result, version: 1, replayed: false as const };
      } catch (error) {
        if (!isDupEntry(error)) throw error;
        const [raced] = await tx
          .select()
          .from(salesOpportunities)
          .where(eq(salesOpportunities.createKey, createKey))
          .for("update")
          .limit(1);
        if (
          !raced ||
          !payloadHashMatches(payloadHash, raced.createHash) ||
          Number(raced.createdBy) !== actor.userId
        )
          throw error;
        assertPipelineRowWritable(raced, actor);
        return {
          opportunityId: Number(raced.id),
          opportunityNumber: raced.opportunityNumber,
          version: Number(raced.version),
          replayed: true as const,
        };
      }
    },
    { gate: "NONE" },
  );
}

export async function convertLeadToOpportunity(
  input: ConvertLeadInput,
  actor: Actor,
) {
  assertVersion(input.expectedVersion);
  const requestKey = normalizePipelineKey(
    input.requestKey,
    "معرّف تحويل العميل المحتمل",
  );
  const reason = normalizePipelineReason(
    input.reason,
    "سبب تحويل العميل المحتمل",
  );
  const draft = normalizeOpportunityDraft(input);
  const payload = {
    leadId: input.leadId,
    expectedVersion: input.expectedVersion,
    customerId: input.customerId ?? null,
    ownerId: input.ownerId ?? null,
    ...draft,
    reason,
  };
  const payloadHash = idempotencyHash(payload);

  return withTx(
    async (tx) => {
      const lead = await loadLeadForUpdate(tx, input.leadId);
      assertPipelineRowWritable(lead, actor);
      const [replay] = await tx
        .select()
        .from(salesOpportunities)
        .where(eq(salesOpportunities.createKey, requestKey))
        .for("update")
        .limit(1);
      if (replay) {
        if (
          !payloadHashMatches(payloadHash, replay.createHash) ||
          Number(replay.createdBy) !== actor.userId ||
          Number(replay.leadId) !== input.leadId
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "معرّف التحويل مستخدم لحمولة مختلفة",
          });
        }
        return {
          opportunityId: Number(replay.id),
          opportunityNumber: replay.opportunityNumber,
          leadVersion: Number(lead.version),
          replayed: true as const,
        };
      }
      if (Number(lead.version) !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر العميل المحتمل؛ حدّث الصفحة قبل التحويل",
        });
      }
      if (lead.status !== "QUALIFIED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يتحوّل إلى فرصة إلا عميل محتمل مؤهل",
        });
      }
      const customerId = input.customerId ?? lead.customerId ?? null;
      if (
        lead.customerId != null &&
        input.customerId != null &&
        Number(lead.customerId) !== input.customerId
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تحويل العميل المحتمل إلى عميل مختلف عن المرتبط به",
        });
      }
      await assertCustomerTx(tx, customerId);
      const ownerId = await resolvePipelineOwnerTx(
        tx,
        input.ownerId ?? Number(lead.ownerId),
        Number(lead.branchId),
        actor,
      );
      await assertQuotationTx(
        tx,
        draft.quotationId,
        Number(lead.branchId),
        customerId,
      );
      const result = await insertOpportunityTx(
        tx,
        {
          branchId: Number(lead.branchId),
          leadId: input.leadId,
          customerId,
          ownerId,
          ...draft,
          createKey: requestKey,
          createHash: payloadHash,
          reason,
        },
        actor,
      );
      const resultVersion = input.expectedVersion + 1;
      await tx
        .update(salesLeads)
        .set({
          status: "CONVERTED",
          version: resultVersion,
          lastReason: reason,
          nextFollowUpAt: null,
        })
        .where(eq(salesLeads.id, input.leadId));
      const leadEventPayload = {
        ...payload,
        opportunityId: result.opportunityId,
      };
      await tx.insert(salesLeadEvents).values({
        eventKey: requestKey,
        leadId: input.leadId,
        branchId: Number(lead.branchId),
        eventType: "CONVERTED",
        fromStatus: "QUALIFIED",
        toStatus: "CONVERTED",
        baseVersion: input.expectedVersion,
        resultVersion,
        reason,
        payload: leadEventPayload,
        payloadHash: idempotencyHash(leadEventPayload),
        actorUserId: actor.userId,
      });
      return {
        ...result,
        leadVersion: resultVersion,
        replayed: false as const,
      };
    },
    { gate: "NONE" },
  );
}

export async function updateSalesOpportunity(
  input: UpdateOpportunityInput,
  actor: Actor,
) {
  assertVersion(input.expectedVersion);
  const requestKey = normalizePipelineKey(input.requestKey);
  const reason = normalizePipelineReason(input.reason, "سبب تعديل الفرصة");
  const payload = { ...input, requestKey: undefined, reason };
  const payloadHash = idempotencyHash(payload);
  return withTx(
    async (tx) => {
      const opportunity = await loadOpportunityForUpdate(
        tx,
        input.opportunityId,
      );
      assertPipelineRowWritable(opportunity, actor);
      const event = await loadOpportunityEventForUpdate(tx, requestKey);
      if (event) {
        assertOpportunityEventReplay(
          event,
          input.opportunityId,
          payloadHash,
          actor,
        );
        return {
          opportunityId: input.opportunityId,
          version: Number(event.resultVersion),
          replayed: true as const,
        };
      }
      if (Number(opportunity.version) !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت الفرصة؛ حدّث الصفحة ثم أعد المحاولة",
        });
      }
      if (opportunity.stage === "WON" || opportunity.stage === "LOST") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "أعد فتح الفرصة الخاسرة قبل تعديلها، والفرصة الرابحة نهائية",
        });
      }
      const patch: Partial<typeof salesOpportunities.$inferInsert> = {};
      const customerId =
        input.customerId === undefined
          ? opportunity.customerId
          : input.customerId;
      if (input.customerId !== undefined) {
        if (input.customerId == null && opportunity.leadId == null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "الفرصة يجب أن تبقى مرتبطة بعميل أو عميل محتمل",
          });
        }
        await assertCustomerTx(tx, input.customerId);
        patch.customerId = input.customerId;
      }
      if (input.ownerId !== undefined)
        patch.ownerId = await resolvePipelineOwnerTx(
          tx,
          input.ownerId,
          Number(opportunity.branchId),
          actor,
        );
      if (input.title !== undefined)
        patch.title = normalizeRequiredText(input.title, "عنوان الفرصة");
      if (input.expectedValue !== undefined)
        patch.expectedValue = normalizeExpectedValue(input.expectedValue);
      if (input.probability !== undefined)
        patch.probability = normalizeProbability(input.probability);
      if (input.expectedCloseDate !== undefined)
        patch.expectedCloseDate = normalizeExpectedCloseDate(
          input.expectedCloseDate,
        );
      if (input.quotationId !== undefined) {
        await assertQuotationTx(
          tx,
          input.quotationId,
          Number(opportunity.branchId),
          customerId == null ? null : Number(customerId),
        );
        patch.quotationId = input.quotationId;
      }
      if (Object.keys(patch).length === 0)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لم تُرسل تعديلات على الفرصة",
        });
      const resultVersion = input.expectedVersion + 1;
      patch.version = resultVersion;
      patch.lastReason = reason;
      await tx
        .update(salesOpportunities)
        .set(patch)
        .where(eq(salesOpportunities.id, input.opportunityId));
      await tx.insert(salesOpportunityEvents).values({
        eventKey: requestKey,
        opportunityId: input.opportunityId,
        branchId: Number(opportunity.branchId),
        eventType: "UPDATED",
        fromStage: opportunity.stage,
        toStage: opportunity.stage,
        baseVersion: input.expectedVersion,
        resultVersion,
        reason,
        payload,
        payloadHash,
        actorUserId: actor.userId,
      });
      return {
        opportunityId: input.opportunityId,
        version: resultVersion,
        replayed: false as const,
      };
    },
    { gate: "NONE" },
  );
}

export async function transitionSalesOpportunity(
  input: TransitionOpportunityInput,
  actor: Actor,
) {
  assertVersion(input.expectedVersion);
  const requestKey = normalizePipelineKey(input.requestKey);
  const reason = normalizePipelineReason(input.reason, "سبب انتقال الفرصة");
  const payload = {
    ...input,
    requestKey: undefined,
    invoiceId: input.invoiceId ?? null,
    reason,
  };
  const payloadHash = idempotencyHash(payload);
  return withTx(
    async (tx) => {
      const opportunity = await loadOpportunityForUpdate(
        tx,
        input.opportunityId,
      );
      assertPipelineRowWritable(opportunity, actor);
      const event = await loadOpportunityEventForUpdate(tx, requestKey);
      if (event) {
        assertOpportunityEventReplay(
          event,
          input.opportunityId,
          payloadHash,
          actor,
        );
        return {
          opportunityId: input.opportunityId,
          stage: event.toStage,
          version: Number(event.resultVersion),
          replayed: true as const,
        };
      }
      if (Number(opportunity.version) !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت مرحلة الفرصة؛ حدّث الصفحة",
        });
      }
      const fromStage = opportunity.stage as SalesOpportunityStage;
      if (!canTransitionOpportunity(fromStage, input.toStage)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `الانتقال من ${fromStage} إلى ${input.toStage} غير مسموح`,
        });
      }
      let invoiceId: number | null = null;
      if (input.toStage === "WON") {
        if (
          !Number.isInteger(input.invoiceId) ||
          Number(input.invoiceId) <= 0
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "الفاتورة إلزامية عند إغلاق الفرصة رابحة",
          });
        }
        invoiceId = Number(input.invoiceId);
        await assertWinningInvoiceTx(tx, {
          invoiceId,
          branchId: Number(opportunity.branchId),
          customerId:
            opportunity.customerId == null
              ? null
              : Number(opportunity.customerId),
          quotationId:
            opportunity.quotationId == null
              ? null
              : Number(opportunity.quotationId),
        });
      } else if (input.invoiceId != null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تُربط الفاتورة عند الإغلاق الرابح فقط",
        });
      }
      const resultVersion = input.expectedVersion + 1;
      await tx
        .update(salesOpportunities)
        .set({
          stage: input.toStage,
          invoiceId,
          version: resultVersion,
          lastReason: reason,
        })
        .where(eq(salesOpportunities.id, input.opportunityId));
      await tx.insert(salesOpportunityEvents).values({
        eventKey: requestKey,
        opportunityId: input.opportunityId,
        branchId: Number(opportunity.branchId),
        eventType: "STAGE_CHANGED",
        fromStage,
        toStage: input.toStage,
        baseVersion: input.expectedVersion,
        resultVersion,
        reason,
        payload,
        payloadHash,
        actorUserId: actor.userId,
      });
      return {
        opportunityId: input.opportunityId,
        stage: input.toStage,
        version: resultVersion,
        replayed: false as const,
      };
    },
    { gate: "NONE" },
  );
}

function opportunityConditions(
  filters: OpportunityFilters,
  scope: PipelineReadScope,
) {
  const conditions = [];
  if (scope.scopedBranchId != null)
    conditions.push(eq(salesOpportunities.branchId, scope.scopedBranchId));
  if (scope.scopedOwnerId != null)
    conditions.push(eq(salesOpportunities.ownerId, scope.scopedOwnerId));
  if (filters.stage)
    conditions.push(eq(salesOpportunities.stage, filters.stage));
  if (filters.ownerId != null)
    conditions.push(eq(salesOpportunities.ownerId, filters.ownerId));
  if (filters.overdueOnly) {
    conditions.push(
      inArray(salesOpportunities.stage, [
        "DISCOVERY",
        "PROPOSAL",
        "NEGOTIATION",
      ]),
    );
    conditions.push(
      lt(
        salesOpportunities.expectedCloseDate,
        new Date().toISOString().slice(0, 10),
      ),
    );
  }
  const q = filters.q?.trim();
  if (q) {
    const needle = `%${escLike(q)}%`;
    conditions.push(
      or(
        like(salesOpportunities.opportunityNumber, needle),
        like(salesOpportunities.title, needle),
        like(customers.name, needle),
        like(salesLeads.contactName, needle),
      ),
    );
  }
  return conditions;
}

export async function listSalesOpportunities(
  filters: OpportunityFilters,
  scope: PipelineReadScope,
) {
  const db = requireDb();
  const conditions = opportunityConditions(filters, scope);
  if (filters.cursor) {
    conditions.push(
      or(
        lt(salesOpportunities.updatedAt, filters.cursor.updatedAt),
        and(
          eq(salesOpportunities.updatedAt, filters.cursor.updatedAt),
          lt(salesOpportunities.id, filters.cursor.id),
        ),
      )!,
    );
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
  const raw = await db
    .select({
      id: salesOpportunities.id,
      opportunityNumber: salesOpportunities.opportunityNumber,
      branchId: salesOpportunities.branchId,
      leadId: salesOpportunities.leadId,
      leadName: salesLeads.contactName,
      customerId: salesOpportunities.customerId,
      customerName: customers.name,
      ownerId: salesOpportunities.ownerId,
      ownerName: opportunityOwner.name,
      title: salesOpportunities.title,
      stage: salesOpportunities.stage,
      expectedValue: salesOpportunities.expectedValue,
      probability: salesOpportunities.probability,
      expectedCloseDate: salesOpportunities.expectedCloseDate,
      quotationId: salesOpportunities.quotationId,
      invoiceId: salesOpportunities.invoiceId,
      lastReason: salesOpportunities.lastReason,
      version: salesOpportunities.version,
      createdAt: salesOpportunities.createdAt,
      updatedAt: salesOpportunities.updatedAt,
    })
    .from(salesOpportunities)
    .innerJoin(
      opportunityOwner,
      eq(opportunityOwner.id, salesOpportunities.ownerId),
    )
    .leftJoin(salesLeads, eq(salesLeads.id, salesOpportunities.leadId))
    .leftJoin(customers, eq(customers.id, salesOpportunities.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(salesOpportunities.updatedAt), desc(salesOpportunities.id))
    .limit(limit + 1);
  const hasMore = raw.length > limit;
  const rows = hasMore ? raw.slice(0, limit) : raw;
  const last = rows.at(-1);
  return {
    rows,
    hasMore,
    nextCursor:
      hasMore && last
        ? { updatedAt: last.updatedAt, id: Number(last.id) }
        : null,
  };
}

export async function getSalesOpportunityDetail(
  opportunityId: number,
  scope: PipelineReadScope,
) {
  const db = requireDb();
  const conditions = [eq(salesOpportunities.id, opportunityId)];
  if (scope.scopedBranchId != null)
    conditions.push(eq(salesOpportunities.branchId, scope.scopedBranchId));
  if (scope.scopedOwnerId != null)
    conditions.push(eq(salesOpportunities.ownerId, scope.scopedOwnerId));
  const [opportunity] = await db
    .select({
      id: salesOpportunities.id,
      opportunityNumber: salesOpportunities.opportunityNumber,
      branchId: salesOpportunities.branchId,
      leadId: salesOpportunities.leadId,
      leadName: salesLeads.contactName,
      customerId: salesOpportunities.customerId,
      customerName: customers.name,
      ownerId: salesOpportunities.ownerId,
      ownerName: opportunityOwner.name,
      title: salesOpportunities.title,
      stage: salesOpportunities.stage,
      expectedValue: salesOpportunities.expectedValue,
      probability: salesOpportunities.probability,
      expectedCloseDate: salesOpportunities.expectedCloseDate,
      quotationId: salesOpportunities.quotationId,
      invoiceId: salesOpportunities.invoiceId,
      lastReason: salesOpportunities.lastReason,
      version: salesOpportunities.version,
      createdAt: salesOpportunities.createdAt,
      updatedAt: salesOpportunities.updatedAt,
    })
    .from(salesOpportunities)
    .innerJoin(
      opportunityOwner,
      eq(opportunityOwner.id, salesOpportunities.ownerId),
    )
    .leftJoin(salesLeads, eq(salesLeads.id, salesOpportunities.leadId))
    .leftJoin(customers, eq(customers.id, salesOpportunities.customerId))
    .where(and(...conditions))
    .limit(1);
  if (!opportunity)
    throw new TRPCError({ code: "NOT_FOUND", message: "الفرصة غير موجودة" });
  const events = await db
    .select({
      id: salesOpportunityEvents.id,
      eventType: salesOpportunityEvents.eventType,
      fromStage: salesOpportunityEvents.fromStage,
      toStage: salesOpportunityEvents.toStage,
      reason: salesOpportunityEvents.reason,
      actorUserId: salesOpportunityEvents.actorUserId,
      actorName: users.name,
      baseVersion: salesOpportunityEvents.baseVersion,
      resultVersion: salesOpportunityEvents.resultVersion,
      occurredAt: salesOpportunityEvents.occurredAt,
    })
    .from(salesOpportunityEvents)
    .innerJoin(users, eq(users.id, salesOpportunityEvents.actorUserId))
    .where(eq(salesOpportunityEvents.opportunityId, opportunityId))
    .orderBy(desc(salesOpportunityEvents.id));
  return { opportunity, events };
}

export { opportunityConditions };
