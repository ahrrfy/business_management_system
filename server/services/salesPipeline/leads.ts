import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, lt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { isDupEntry } from "@shared/errorMap.ar";
import { canTransitionLead, type SalesLeadStatus } from "@shared/salesPipeline";
import {
  customers,
  salesLeadEvents,
  salesLeads,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { escLike } from "../../lib/sqlLike";
import { idempotencyHash } from "../idempotency";
import { requireDb, withTx, type Actor } from "../tx";
import {
  assertExactReplay,
  normalizeOptionalText,
  normalizePipelineKey,
  normalizePipelineReason,
  normalizeRequiredText,
} from "./common";
import {
  assertActiveBranchTx,
  assertCustomerTx,
  assertPipelineRowWritable,
  resolvePipelineBranch,
  resolvePipelineOwnerTx,
} from "./scope";
import type {
  CreateLeadInput,
  LeadFilters,
  PipelineReadScope,
  TransitionLeadInput,
  UpdateLeadInput,
} from "./types";

const leadOwner = alias(users, "salesLeadOwner");

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة العميل المحتمل غير صالحة",
    });
  }
}

async function loadLeadForUpdate(tx: Tx, leadId: number) {
  const [lead] = await tx
    .select()
    .from(salesLeads)
    .where(eq(salesLeads.id, leadId))
    .for("update")
    .limit(1);
  if (!lead)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "العميل المحتمل غير موجود",
    });
  return lead;
}

async function loadLeadEventForUpdate(tx: Tx, requestKey: string) {
  return (
    await tx
      .select()
      .from(salesLeadEvents)
      .where(eq(salesLeadEvents.eventKey, requestKey))
      .for("update")
      .limit(1)
  )[0];
}

function assertLeadEventReplay(
  event: typeof salesLeadEvents.$inferSelect,
  leadId: number,
  payloadHash: string,
  actor: Actor,
): void {
  assertExactReplay(event, payloadHash, actor.userId);
  if (Number(event.leadId) !== leadId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح الطلب مستخدم لعميل محتمل آخر",
    });
  }
}

function normalizeCreateLead(input: CreateLeadInput) {
  return {
    source: input.source,
    contactName: normalizeRequiredText(input.contactName, "اسم جهة الاتصال"),
    companyName: normalizeOptionalText(input.companyName),
    phone: normalizeOptionalText(input.phone),
    email: normalizeOptionalText(input.email)?.toLowerCase() ?? null,
    customerId: input.customerId ?? null,
    ownerId: input.ownerId ?? null,
    nextFollowUpAt: input.nextFollowUpAt?.toISOString() ?? null,
  };
}

export async function createSalesLead(input: CreateLeadInput, actor: Actor) {
  const createKey = normalizePipelineKey(
    input.clientRequestId,
    "معرّف إنشاء العميل المحتمل",
  );
  const branchId = resolvePipelineBranch(input.branchId, actor);
  const payload = { branchId, ...normalizeCreateLead(input) };
  const payloadHash = idempotencyHash(payload);

  return withTx(
    async (tx) => {
      const [replay] = await tx
        .select()
        .from(salesLeads)
        .where(eq(salesLeads.createKey, createKey))
        .for("update")
        .limit(1);
      if (replay) {
        if (
          replay.createHash !== payloadHash ||
          Number(replay.createdBy) !== actor.userId
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "معرّف الإنشاء مستخدم لحمولة مختلفة",
          });
        }
        assertPipelineRowWritable(replay, actor);
        return {
          leadId: Number(replay.id),
          leadNumber: replay.leadNumber,
          version: Number(replay.version),
          replayed: true as const,
        };
      }

      await assertActiveBranchTx(tx, branchId);
      const ownerId = await resolvePipelineOwnerTx(
        tx,
        input.ownerId,
        branchId,
        actor,
      );
      await assertCustomerTx(tx, input.customerId);
      let leadId: number;
      try {
        const inserted = await tx.insert(salesLeads).values({
          leadNumber: `TMP-L-${randomUUID()}`,
          branchId,
          source: payload.source,
          contactName: payload.contactName,
          companyName: payload.companyName,
          phone: payload.phone,
          email: payload.email,
          customerId: payload.customerId,
          ownerId,
          nextFollowUpAt: input.nextFollowUpAt ?? null,
          status: "NEW",
          lastReason: null,
          version: 1,
          createKey,
          createHash: payloadHash,
          createdBy: actor.userId,
        });
        leadId = extractInsertId(inserted);
      } catch (error) {
        if (!isDupEntry(error)) throw error;
        const [raced] = await tx
          .select()
          .from(salesLeads)
          .where(eq(salesLeads.createKey, createKey))
          .for("update")
          .limit(1);
        if (
          !raced ||
          raced.createHash !== payloadHash ||
          Number(raced.createdBy) !== actor.userId
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض معرّف إنشاء العميل المحتمل",
          });
        }
        assertPipelineRowWritable(raced, actor);
        return {
          leadId: Number(raced.id),
          leadNumber: raced.leadNumber,
          version: Number(raced.version),
          replayed: true as const,
        };
      }
      const leadNumber = `LD-${branchId}-${String(leadId).padStart(7, "0")}`;
      await tx
        .update(salesLeads)
        .set({ leadNumber })
        .where(eq(salesLeads.id, leadId));
      await tx.insert(salesLeadEvents).values({
        eventKey: createKey,
        leadId,
        branchId,
        eventType: "CREATED",
        fromStatus: null,
        toStatus: "NEW",
        baseVersion: 1,
        resultVersion: 1,
        reason: "إنشاء العميل المحتمل",
        payload,
        payloadHash,
        actorUserId: actor.userId,
      });
      return { leadId, leadNumber, version: 1, replayed: false as const };
    },
    { gate: "NONE" },
  );
}

export async function updateSalesLead(input: UpdateLeadInput, actor: Actor) {
  assertVersion(input.expectedVersion);
  const requestKey = normalizePipelineKey(input.requestKey);
  const reason = normalizePipelineReason(
    input.reason,
    "سبب تعديل العميل المحتمل",
  );
  const payload = {
    leadId: input.leadId,
    expectedVersion: input.expectedVersion,
    source: input.source,
    contactName: input.contactName?.trim(),
    companyName:
      input.companyName === undefined
        ? undefined
        : normalizeOptionalText(input.companyName),
    phone:
      input.phone === undefined
        ? undefined
        : normalizeOptionalText(input.phone),
    email:
      input.email === undefined
        ? undefined
        : (normalizeOptionalText(input.email)?.toLowerCase() ?? null),
    customerId: input.customerId,
    ownerId: input.ownerId,
    nextFollowUpAt:
      input.nextFollowUpAt === undefined
        ? undefined
        : (input.nextFollowUpAt?.toISOString() ?? null),
    reason,
  };
  const payloadHash = idempotencyHash(payload);

  return withTx(
    async (tx) => {
      const lead = await loadLeadForUpdate(tx, input.leadId);
      assertPipelineRowWritable(lead, actor);
      const event = await loadLeadEventForUpdate(tx, requestKey);
      if (event) {
        assertLeadEventReplay(event, input.leadId, payloadHash, actor);
        return {
          leadId: input.leadId,
          version: Number(event.resultVersion),
          replayed: true as const,
        };
      }
      if (Number(lead.version) !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر العميل المحتمل؛ حدّث الصفحة ثم أعد المحاولة",
        });
      }
      if (lead.status === "CONVERTED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "العميل المحتمل المحوّل لا يُعدّل",
        });
      }

      const patch: Partial<typeof salesLeads.$inferInsert> = {};
      if (input.source !== undefined) patch.source = input.source;
      if (input.contactName !== undefined)
        patch.contactName = normalizeRequiredText(
          input.contactName,
          "اسم جهة الاتصال",
        );
      if (input.companyName !== undefined)
        patch.companyName = normalizeOptionalText(input.companyName);
      if (input.phone !== undefined)
        patch.phone = normalizeOptionalText(input.phone);
      if (input.email !== undefined)
        patch.email = normalizeOptionalText(input.email)?.toLowerCase() ?? null;
      if (input.customerId !== undefined) {
        await assertCustomerTx(tx, input.customerId);
        patch.customerId = input.customerId;
      }
      if (input.ownerId !== undefined)
        patch.ownerId = await resolvePipelineOwnerTx(
          tx,
          input.ownerId,
          Number(lead.branchId),
          actor,
        );
      if (input.nextFollowUpAt !== undefined)
        patch.nextFollowUpAt = input.nextFollowUpAt;
      if (Object.keys(patch).length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لم تُرسل تعديلات على العميل المحتمل",
        });
      }
      const resultVersion = input.expectedVersion + 1;
      patch.version = resultVersion;
      patch.lastReason = reason;
      await tx
        .update(salesLeads)
        .set(patch)
        .where(eq(salesLeads.id, input.leadId));
      await tx.insert(salesLeadEvents).values({
        eventKey: requestKey,
        leadId: input.leadId,
        branchId: Number(lead.branchId),
        eventType: "UPDATED",
        fromStatus: lead.status,
        toStatus: lead.status,
        baseVersion: input.expectedVersion,
        resultVersion,
        reason,
        payload,
        payloadHash,
        actorUserId: actor.userId,
      });
      return {
        leadId: input.leadId,
        version: resultVersion,
        replayed: false as const,
      };
    },
    { gate: "NONE" },
  );
}

export async function transitionSalesLead(
  input: TransitionLeadInput,
  actor: Actor,
) {
  assertVersion(input.expectedVersion);
  const requestKey = normalizePipelineKey(input.requestKey);
  const reason = normalizePipelineReason(
    input.reason,
    "سبب انتقال العميل المحتمل",
  );
  if (input.toStatus === "CONVERTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "التحويل إلى فرصة يتم من إجراء التحويل الذري فقط",
    });
  }
  const payload = { ...input, requestKey: undefined, reason };
  const payloadHash = idempotencyHash(payload);

  return withTx(
    async (tx) => {
      const lead = await loadLeadForUpdate(tx, input.leadId);
      assertPipelineRowWritable(lead, actor);
      const event = await loadLeadEventForUpdate(tx, requestKey);
      if (event) {
        assertLeadEventReplay(event, input.leadId, payloadHash, actor);
        return {
          leadId: input.leadId,
          status: event.toStatus,
          version: Number(event.resultVersion),
          replayed: true as const,
        };
      }
      if (Number(lead.version) !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت حالة العميل المحتمل؛ حدّث الصفحة",
        });
      }
      const fromStatus = lead.status as SalesLeadStatus;
      if (!canTransitionLead(fromStatus, input.toStatus)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `الانتقال من ${fromStatus} إلى ${input.toStatus} غير مسموح`,
        });
      }
      const resultVersion = input.expectedVersion + 1;
      await tx
        .update(salesLeads)
        .set({
          status: input.toStatus,
          version: resultVersion,
          lastReason: reason,
          ...(input.toStatus === "DISQUALIFIED"
            ? { nextFollowUpAt: null }
            : {}),
        })
        .where(eq(salesLeads.id, input.leadId));
      await tx.insert(salesLeadEvents).values({
        eventKey: requestKey,
        leadId: input.leadId,
        branchId: Number(lead.branchId),
        eventType: "STATUS_CHANGED",
        fromStatus,
        toStatus: input.toStatus,
        baseVersion: input.expectedVersion,
        resultVersion,
        reason,
        payload,
        payloadHash,
        actorUserId: actor.userId,
      });
      return {
        leadId: input.leadId,
        status: input.toStatus,
        version: resultVersion,
        replayed: false as const,
      };
    },
    { gate: "NONE" },
  );
}

function leadConditions(filters: LeadFilters, scope: PipelineReadScope) {
  const conditions = [];
  if (scope.scopedBranchId != null)
    conditions.push(eq(salesLeads.branchId, scope.scopedBranchId));
  if (scope.scopedOwnerId != null)
    conditions.push(eq(salesLeads.ownerId, scope.scopedOwnerId));
  if (filters.status) conditions.push(eq(salesLeads.status, filters.status));
  if (filters.ownerId != null)
    conditions.push(eq(salesLeads.ownerId, filters.ownerId));
  if (filters.overdueOnly) {
    conditions.push(
      inArray(salesLeads.status, ["NEW", "CONTACTED", "QUALIFIED"]),
    );
    conditions.push(lt(salesLeads.nextFollowUpAt, new Date()));
  }
  const q = filters.q?.trim();
  if (q) {
    const needle = `%${escLike(q)}%`;
    conditions.push(
      or(
        like(salesLeads.leadNumber, needle),
        like(salesLeads.contactName, needle),
        like(salesLeads.companyName, needle),
        like(salesLeads.phone, needle),
        like(salesLeads.email, needle),
      ),
    );
  }
  return conditions;
}

export async function listSalesLeads(
  filters: LeadFilters,
  scope: PipelineReadScope,
) {
  const db = requireDb();
  const conditions = leadConditions(filters, scope);
  if (filters.cursor) {
    conditions.push(
      or(
        lt(salesLeads.updatedAt, filters.cursor.updatedAt),
        and(
          eq(salesLeads.updatedAt, filters.cursor.updatedAt),
          lt(salesLeads.id, filters.cursor.id),
        ),
      )!,
    );
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
  const raw = await db
    .select({
      id: salesLeads.id,
      leadNumber: salesLeads.leadNumber,
      branchId: salesLeads.branchId,
      source: salesLeads.source,
      contactName: salesLeads.contactName,
      companyName: salesLeads.companyName,
      phone: salesLeads.phone,
      email: salesLeads.email,
      customerId: salesLeads.customerId,
      customerName: customers.name,
      ownerId: salesLeads.ownerId,
      ownerName: leadOwner.name,
      nextFollowUpAt: salesLeads.nextFollowUpAt,
      status: salesLeads.status,
      lastReason: salesLeads.lastReason,
      version: salesLeads.version,
      createdAt: salesLeads.createdAt,
      updatedAt: salesLeads.updatedAt,
    })
    .from(salesLeads)
    .innerJoin(leadOwner, eq(leadOwner.id, salesLeads.ownerId))
    .leftJoin(customers, eq(customers.id, salesLeads.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(salesLeads.updatedAt), desc(salesLeads.id))
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

export async function getSalesLeadDetail(
  leadId: number,
  scope: PipelineReadScope,
) {
  const db = requireDb();
  const conditions = [eq(salesLeads.id, leadId)];
  if (scope.scopedBranchId != null)
    conditions.push(eq(salesLeads.branchId, scope.scopedBranchId));
  if (scope.scopedOwnerId != null)
    conditions.push(eq(salesLeads.ownerId, scope.scopedOwnerId));
  const [lead] = await db
    .select({
      id: salesLeads.id,
      leadNumber: salesLeads.leadNumber,
      branchId: salesLeads.branchId,
      source: salesLeads.source,
      contactName: salesLeads.contactName,
      companyName: salesLeads.companyName,
      phone: salesLeads.phone,
      email: salesLeads.email,
      customerId: salesLeads.customerId,
      customerName: customers.name,
      ownerId: salesLeads.ownerId,
      ownerName: leadOwner.name,
      nextFollowUpAt: salesLeads.nextFollowUpAt,
      status: salesLeads.status,
      lastReason: salesLeads.lastReason,
      version: salesLeads.version,
      createdAt: salesLeads.createdAt,
      updatedAt: salesLeads.updatedAt,
    })
    .from(salesLeads)
    .innerJoin(leadOwner, eq(leadOwner.id, salesLeads.ownerId))
    .leftJoin(customers, eq(customers.id, salesLeads.customerId))
    .where(and(...conditions))
    .limit(1);
  if (!lead)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "العميل المحتمل غير موجود",
    });
  const events = await db
    .select({
      id: salesLeadEvents.id,
      eventType: salesLeadEvents.eventType,
      fromStatus: salesLeadEvents.fromStatus,
      toStatus: salesLeadEvents.toStatus,
      reason: salesLeadEvents.reason,
      actorUserId: salesLeadEvents.actorUserId,
      actorName: users.name,
      baseVersion: salesLeadEvents.baseVersion,
      resultVersion: salesLeadEvents.resultVersion,
      occurredAt: salesLeadEvents.occurredAt,
    })
    .from(salesLeadEvents)
    .innerJoin(users, eq(users.id, salesLeadEvents.actorUserId))
    .where(eq(salesLeadEvents.leadId, leadId))
    .orderBy(desc(salesLeadEvents.id));
  return { lead, events };
}

export {
  leadConditions,
  loadLeadEventForUpdate,
  loadLeadForUpdate,
  assertLeadEventReplay,
};
