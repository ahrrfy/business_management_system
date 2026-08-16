import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  financialPeriods,
  monthCloseEvents,
  monthCloseSequence as monthCloseSequenceTable,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { lockCompanyMonthCloseGate } from "./monthCloseGate";

export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthCloseSequenceStatus = "NEEDS_BOOTSTRAP" | "READY";

export interface MonthCloseSequenceState {
  id: number;
  status: MonthCloseSequenceStatus;
  sequenceStartMonth: string | null;
  activeThroughMonth: string | null;
  nextRequiredMonth: string | null;
  activePeriodId: number | null;
  activeCertificateId: number | null;
  lastEventId: number | null;
  lastEventHash: string | null;
  version: number;
  bootstrappedAt: Date | null;
  bootstrappedBy: number | null;
  bootstrapReason: string | null;
  bootstrapReference: string | null;
}

export interface MonthCloseEventInput {
  eventKey: string;
  eventType: "BOOTSTRAP" | "CLOSE" | "UNLOCK";
  month: string | null;
  requestId?: number | null;
  periodId?: number | null;
  certificateId?: number | null;
  actorId: number;
  occurredAt: Date;
  reason?: string | null;
  payload: Record<string, unknown>;
}

function canonicalJsonValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${path}: canonical numbers must be safe integers`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) {
    throw new Error(
      `${path}: convert Date to an explicit ISO string before sealing`,
    );
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((child, index) => canonicalJsonValue(child, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    return `{${keys
      .map((key) => {
        if (row[key] === undefined) {
          throw new Error(`${path}.${key}: undefined is not canonical JSON`);
        }
        return `${JSON.stringify(key)}:${canonicalJsonValue(row[key], `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`${path}: unsupported canonical value (${typeof value})`);
}

/** Stable UTF-8 JSON used by close events and certificates. */
export function canonicalCloseJson(value: unknown): string {
  return canonicalJsonValue(value, "$");
}

export function closeSha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function assertMonthKey(month: string): void {
  if (!MONTH_KEY_RE.test(month)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "صيغة الشهر غير صالحة (YYYY-MM).",
    });
  }
}

export function monthCutoff(month: string): string {
  assertMonthKey(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  assertMonthKey(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthOfCutoff(cutoffDate: string): string {
  const month = cutoffDate.slice(0, 7);
  if (monthCutoff(month) !== cutoffDate) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `القفل الإرثي ${cutoffDate} لا يقع في آخر يوم من شهر؛ يلزم تصحيح إداري صريح قبل تهيئة التسلسل.`,
    });
  }
  return month;
}

function mapState(
  row: typeof monthCloseSequenceTable.$inferSelect,
): MonthCloseSequenceState {
  return {
    id: Number(row.id),
    status: row.status,
    sequenceStartMonth: row.sequenceStartMonth,
    activeThroughMonth: row.activeThroughMonth,
    nextRequiredMonth: row.nextRequiredMonth,
    activePeriodId:
      row.activePeriodId == null ? null : Number(row.activePeriodId),
    activeCertificateId:
      row.activeCertificateId == null ? null : Number(row.activeCertificateId),
    lastEventId: row.lastEventId == null ? null : Number(row.lastEventId),
    lastEventHash: row.lastEventHash,
    version: Number(row.version),
    bootstrappedAt: row.bootstrappedAt,
    bootstrappedBy:
      row.bootstrappedBy == null ? null : Number(row.bootstrappedBy),
    bootstrapReason: row.bootstrapReason,
    bootstrapReference: row.bootstrapReference,
  };
}

async function ensureSequenceRow(tx: Tx): Promise<void> {
  await tx
    .insert(monthCloseSequenceTable)
    .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
}

export async function getMonthCloseSequence(
  tx: Tx,
  options: { forUpdate?: boolean } = {},
): Promise<MonthCloseSequenceState> {
  if (options.forUpdate) await ensureSequenceRow(tx);
  const base = tx
    .select()
    .from(monthCloseSequenceTable)
    .where(eq(monthCloseSequenceTable.id, 1));
  const rows = options.forUpdate
    ? await base.for("update").limit(1)
    : await base.limit(1);
  if (!rows[0]) {
    return {
      id: 1,
      status: "NEEDS_BOOTSTRAP",
      sequenceStartMonth: null,
      activeThroughMonth: null,
      nextRequiredMonth: null,
      activePeriodId: null,
      activeCertificateId: null,
      lastEventId: null,
      lastEventHash: null,
      version: 0,
      bootstrappedAt: null,
      bootstrappedBy: null,
      bootstrapReason: null,
      bootstrapReference: null,
    };
  }
  return mapState(rows[0]);
}

export function assertSequenceReady(
  state: MonthCloseSequenceState,
): asserts state is MonthCloseSequenceState & {
  status: "READY";
  sequenceStartMonth: string;
  nextRequiredMonth: string;
} {
  if (
    state.status !== "READY" ||
    !state.sequenceStartMonth ||
    !state.nextRequiredMonth
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "تسلسل الإقفال الشهري غير مهيأ. يجب على المالك اعتماد نقطة البدء الإرثية قبل أي طلب أو اعتماد.",
      cause: "MONTH_CLOSE_BOOTSTRAP_REQUIRED",
    });
  }
}

export function assertExpectedCloseMonth(
  state: MonthCloseSequenceState,
  month: string,
): void {
  assertMonthKey(month);
  assertSequenceReady(state);
  if (month !== state.nextRequiredMonth) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `لا يجوز القفز في الإقفال: الشهر المطلوب الآن هو ${state.nextRequiredMonth} وليس ${month}.`,
      cause: "MONTH_CLOSE_OUT_OF_SEQUENCE",
    });
  }
}

export async function appendMonthCloseEvent(
  tx: Tx,
  state: MonthCloseSequenceState,
  input: MonthCloseEventInput,
): Promise<{ id: number; hash: string }> {
  const payloadCanonical = canonicalCloseJson({
    version: 1,
    eventKey: input.eventKey,
    eventType: input.eventType,
    month: input.month,
    requestId: input.requestId ?? null,
    periodId: input.periodId ?? null,
    certificateId: input.certificateId ?? null,
    actorId: input.actorId,
    occurredAt: input.occurredAt.toISOString(),
    reason: input.reason ?? null,
    previousEventHash: state.lastEventHash,
    payload: input.payload,
  });
  const eventHash = closeSha256(payloadCanonical);
  const result = await tx.insert(monthCloseEvents).values({
    eventKey: input.eventKey,
    eventType: input.eventType,
    month: input.month,
    requestId: input.requestId ?? null,
    periodId: input.periodId ?? null,
    certificateId: input.certificateId ?? null,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    reason: input.reason ?? null,
    payloadCanonical,
    previousEventHash: state.lastEventHash,
    eventHash,
  });
  const id = extractInsertId(result);
  await tx
    .update(monthCloseSequenceTable)
    .set({ lastEventId: id, lastEventHash: eventHash })
    .where(eq(monthCloseSequenceTable.id, 1));
  return { id, hash: eventHash };
}

export type BootstrapMonthCloseSequenceInput =
  | {
      mode: "START_FRESH";
      firstCloseMonth: string;
      actorId: number;
      reason: string;
      reference: string;
      now?: Date;
    }
  | {
      mode: "ACKNOWLEDGE_LEGACY_LOCK";
      expectedPeriodId: number;
      actorId: number;
      reason: string;
      reference: string;
      now?: Date;
    };

export async function bootstrapMonthCloseSequence(
  tx: Tx,
  input: BootstrapMonthCloseSequenceInput,
): Promise<MonthCloseSequenceState> {
  await lockCompanyMonthCloseGate(tx);
  const state = await getMonthCloseSequence(tx, { forUpdate: true });
  if (state.status !== "NEEDS_BOOTSTRAP") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تسلسل الإقفال مهيأ سابقاً ولا يجوز إعادة تهيئته.",
    });
  }

  const activeLocks = await tx
    .select({
      id: financialPeriods.id,
      cutoffDate: financialPeriods.cutoffDate,
    })
    .from(financialPeriods)
    .where(eq(financialPeriods.status, "LOCKED"))
    .orderBy(asc(financialPeriods.cutoffDate), asc(financialPeriods.id))
    .for("update");

  let sequenceStartMonth: string;
  let activeThroughMonth: string | null = null;
  let nextRequiredMonth: string;
  let activePeriodId: number | null = null;
  const legacyPeriods: Array<{
    id: number;
    month: string;
    revision: number;
    predecessorPeriodId: number | null;
  }> = [];

  if (input.mode === "START_FRESH") {
    assertMonthKey(input.firstCloseMonth);
    if (activeLocks.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "يوجد قفل إرثي نشط؛ استعمل مسار الإقرار بالقفل الإرثي بدلاً من بدء تسلسل فارغ.",
      });
    }
    sequenceStartMonth = input.firstCloseMonth;
    nextRequiredMonth = input.firstCloseMonth;
  } else {
    if (activeLocks.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يوجد قفل إرثي نشط لاعتماده.",
      });
    }
    const latest = activeLocks[activeLocks.length - 1];
    if (Number(latest.id) !== input.expectedPeriodId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغير أحدث قفل منذ فتح الشاشة؛ أعد التحميل قبل التهيئة.",
      });
    }
    const revisionByMonth = new Map<string, number>();
    let predecessorPeriodId: number | null = null;
    for (const row of activeLocks) {
      const month = monthOfCutoff(row.cutoffDate);
      const revision = (revisionByMonth.get(month) ?? 0) + 1;
      revisionByMonth.set(month, revision);
      legacyPeriods.push({
        id: Number(row.id),
        month,
        revision,
        predecessorPeriodId,
      });
      predecessorPeriodId = Number(row.id);
    }
    for (const row of legacyPeriods) {
      await tx
        .update(financialPeriods)
        .set({
          closeMonth: row.month,
          closeRevision: row.revision,
          predecessorPeriodId: row.predecessorPeriodId,
        })
        .where(eq(financialPeriods.id, row.id));
    }
    sequenceStartMonth = legacyPeriods[0].month;
    activeThroughMonth = legacyPeriods[legacyPeriods.length - 1].month;
    nextRequiredMonth = nextMonth(activeThroughMonth);
    activePeriodId = legacyPeriods[legacyPeriods.length - 1].id;
  }

  const now = input.now ?? new Date();
  await tx
    .update(monthCloseSequenceTable)
    .set({
      status: "READY",
      sequenceStartMonth,
      activeThroughMonth,
      nextRequiredMonth,
      activePeriodId,
      activeCertificateId: null,
      version: 1,
      bootstrappedAt: now,
      bootstrappedBy: input.actorId,
      bootstrapReason: input.reason,
      bootstrapReference: input.reference,
    })
    .where(eq(monthCloseSequenceTable.id, 1));

  const ready = {
    ...state,
    status: "READY" as const,
    sequenceStartMonth,
    activeThroughMonth,
    nextRequiredMonth,
    activePeriodId,
    activeCertificateId: null,
    version: 1,
    bootstrappedAt: now,
    bootstrappedBy: input.actorId,
    bootstrapReason: input.reason,
    bootstrapReference: input.reference,
  };
  const event = await appendMonthCloseEvent(tx, ready, {
    eventKey: "MONTH_CLOSE:BOOTSTRAP:1",
    eventType: "BOOTSTRAP",
    month: activeThroughMonth,
    periodId: activePeriodId,
    actorId: input.actorId,
    occurredAt: now,
    reason: input.reason,
    payload: {
      mode: input.mode,
      sequenceStartMonth,
      activeThroughMonth,
      nextRequiredMonth,
      reference: input.reference,
      legacyPeriods,
      certificationClaim: "NONE",
    },
  });
  return { ...ready, lastEventId: event.id, lastEventHash: event.hash };
}

export async function nextCloseRevision(
  tx: Tx,
  month: string,
): Promise<number> {
  assertMonthKey(month);
  const rows = await tx
    .select({
      revision: sql<number>`COALESCE(MAX(${financialPeriods.closeRevision}), 0)`,
    })
    .from(financialPeriods)
    .where(eq(financialPeriods.closeMonth, month));
  return Number(rows[0]?.revision ?? 0) + 1;
}

export async function advanceMonthCloseSequence(
  tx: Tx,
  input: {
    state: MonthCloseSequenceState;
    month: string;
    revision: number;
    periodId: number;
    requestId: number;
    certificateId?: number | null;
    actorId: number;
    occurredAt: Date;
  },
): Promise<MonthCloseSequenceState> {
  assertExpectedCloseMonth(input.state, input.month);
  const nextRequiredMonth = nextMonth(input.month);
  const version = input.state.version + 1;
  await tx
    .update(monthCloseSequenceTable)
    .set({
      activeThroughMonth: input.month,
      nextRequiredMonth,
      activePeriodId: input.periodId,
      activeCertificateId: input.certificateId ?? null,
      version,
    })
    .where(eq(monthCloseSequenceTable.id, 1));
  const advanced = {
    ...input.state,
    activeThroughMonth: input.month,
    nextRequiredMonth,
    activePeriodId: input.periodId,
    activeCertificateId: input.certificateId ?? null,
    version,
  };
  const event = await appendMonthCloseEvent(tx, advanced, {
    eventKey: `MONTH_CLOSE:CLOSE:${input.periodId}`,
    eventType: "CLOSE",
    month: input.month,
    requestId: input.requestId,
    periodId: input.periodId,
    certificateId: input.certificateId ?? null,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    payload: {
      revision: input.revision,
      previousPeriodId: input.state.activePeriodId,
      previousMonth: input.state.activeThroughMonth,
      nextRequiredMonth,
    },
  });
  return { ...advanced, lastEventId: event.id, lastEventHash: event.hash };
}

export async function listSequenceEvents(tx: Tx, limit = 100) {
  return tx
    .select()
    .from(monthCloseEvents)
    .orderBy(desc(monthCloseEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}
