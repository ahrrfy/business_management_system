/**
 * إقفال الفترات المالية — يمنع كتابة قيود تاريخية صامتاً.
 *
 * المنطق:
 * - مدير عمليات (admin/manager) يُنشئ صفّاً في financialPeriods بـcutoffDate و status=LOCKED.
 * - أي قيد محاسبي بـentryDate ≤ cutoffDate (من أحدث صفّ LOCKED) ⇒ مرفوض بـTRPC FORBIDDEN.
 * - حذف الصفّ = فتح الفترة (لا حذف بـsoft؛ DELETE حرفي).
 *
 * نقطة الإنفاذ الوحيدة: ledgerService.postEntry.assertPeriodOpen قبل INSERT.
 * نقطة التهيئة: periodRouter.lock/unlock بـadminProcedure.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  financialPeriods,
  monthCloseCertificates,
  monthCloseRequests,
  monthCloseSequence,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { lockCompanyMonthCloseGate } from "./reports/monthCloseGate";
import {
  appendMonthCloseEvent,
  assertSequenceReady,
  getMonthCloseSequence,
} from "./reports/monthCloseSequence";

export interface ActiveLock {
  id: number;
  cutoffDate: string; // YYYY-MM-DD
  lockedAt: Date;
  lockedBy: number;
  notes: string | null;
  closeMonth: string | null;
  closeRevision: number | null;
  predecessorPeriodId: number | null;
}

/** أحدث قفل نشِط (LOCKED). null = لا قفل ⇒ الكل مفتوح. */
export async function getActiveLock(
  tx: Tx,
  options: { forUpdate?: boolean } = {},
): Promise<ActiveLock | null> {
  const base = tx
    .select({
      id: financialPeriods.id,
      cutoffDate: financialPeriods.cutoffDate,
      lockedAt: financialPeriods.lockedAt,
      lockedBy: financialPeriods.lockedBy,
      notes: financialPeriods.notes,
      closeMonth: financialPeriods.closeMonth,
      closeRevision: financialPeriods.closeRevision,
      predecessorPeriodId: financialPeriods.predecessorPeriodId,
    })
    .from(financialPeriods)
    .where(eq(financialPeriods.status, "LOCKED"))
    .orderBy(desc(financialPeriods.cutoffDate), desc(financialPeriods.id));
  const rows = options.forUpdate
    ? await base.for("update").limit(1)
    : await base.limit(1);
  const row = rows[0];
  return row
    ? {
        ...row,
        id: Number(row.id),
        closeRevision:
          row.closeRevision == null ? null : Number(row.closeRevision),
        predecessorPeriodId:
          row.predecessorPeriodId == null
            ? null
            : Number(row.predecessorPeriodId),
      }
    : null;
}

/**
 * يرمي TRPCError FORBIDDEN لو entryDate ≤ cutoffDate لأحدث قفل LOCKED.
 * يُستدعى داخل postEntry قبل INSERT.
 */
export async function assertPeriodOpen(tx: Tx, entryDate: Date): Promise<void> {
  const lock = await getActiveLock(tx);
  if (!lock) return; // لا قفل نشِط

  // المقارنة تتم على مستوى التاريخ فقط (يوم) — entryDate timestamp ⇒ نأخذ YYYY-MM-DD
  const entryDay = entryDate.toISOString().slice(0, 10); // UTC date
  if (entryDay <= lock.cutoffDate) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `الفترة المالية مُقفَلة حتى ${lock.cutoffDate} — لا يُسمح بقيد بتاريخ ${entryDay}. يلزم فتح الفترة (admin).`,
    });
  }
}

/** إنشاء قفل جديد (admin only — تُفرض على مستوى router). */
export interface LockPeriodInput {
  cutoffDate: string; // YYYY-MM-DD
  lockedBy: number;
  notes?: string | null;
  closeMonth?: string | null;
  closeRevision?: number | null;
  predecessorPeriodId?: number | null;
  lockedAt?: Date;
}

export async function lockPeriod(
  tx: Tx,
  input: LockPeriodInput,
): Promise<{ id: number }> {
  // لو cutoffDate أصغر من قفل سابق ⇒ ارفض (لا تراجع زمني)
  const existing = await getActiveLock(tx, { forUpdate: true });
  if (existing && input.cutoffDate <= existing.cutoffDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `قفل سابق موجود حتى ${existing.cutoffDate} — لا يُسمح بقفل أقدم منه. لفتح الفترة استعمل unlockPeriod أوّلاً.`,
    });
  }

  const res = await tx.insert(financialPeriods).values({
    cutoffDate: input.cutoffDate,
    status: "LOCKED",
    notes: input.notes ?? null,
    lockedBy: input.lockedBy,
    lockedAt: input.lockedAt,
    closeMonth: input.closeMonth ?? null,
    closeRevision: input.closeRevision ?? null,
    predecessorPeriodId: input.predecessorPeriodId ?? null,
  });
  // mysql2 يعيد insertId على header
  return { id: extractInsertId(res) };
}

/** فتح أحدث قفل: FIN-03 (تدقيق ٢٠/٦) — append-only لا DELETE. نُحوّل الصفّ إلى ARCHIVED بدل حذفه
 *  ⇒ getActiveLock (يُرشّح LOCKED) يَتجاوزه فتُفتَح الفترة، والسجلّ يَبقى للأثر التدقيقي. كان DELETE
 *  الحرفي يَمحو القفل بلا أثر ⇒ فتحٌ خفيّ + قيدٌ بأثر رجعي بلا كشف (مناعة الإقفال قابلة للعكس بصمت). */
export async function unlockLatestPeriod(
  tx: Tx,
  input: {
    expectedPeriodId: number;
    actorId: number;
    reason: string;
    now?: Date;
  },
): Promise<{
  unlocked: boolean;
  periodId: number | null;
  reopenedMonth: string | null;
  nextRequiredMonth: string;
}> {
  await lockCompanyMonthCloseGate(tx);
  const state = await getMonthCloseSequence(tx, { forUpdate: true });
  assertSequenceReady(state);

  const existing = await getActiveLock(tx, { forUpdate: true });
  if (!existing) {
    return {
      unlocked: false,
      periodId: null,
      reopenedMonth: null,
      nextRequiredMonth: state.nextRequiredMonth,
    };
  }
  if (
    existing.id !== input.expectedPeriodId ||
    state.activePeriodId !== existing.id
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "طھط؛ظٹط± ط¢ط®ط± ط¥ظ‚ظپط§ظ„ ظ…ظ†ط° ظپطھط­ ط§ظ„ط´ط§ط´ط©ط› ط£ط¹ط¯ ط§ظ„طھط­ظ…ظٹظ„ ظ‚ط¨ظ„ ط§ظ„ظپطھط­.",
    });
  }
  if (!existing.closeMonth || !existing.closeRevision) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "ط£ط­ط¯ط« ظ‚ظپظ„ ظ„ط§ ظٹط­ظ…ظ„ ظ‡ظˆظٹط© ط§ظ„طھط³ظ„ط³ظ„ط› ط£ط¹ط¯ طھظ‡ظٹط¦ط© ط§ظ„ط£ظ‚ظپط§ظ„ ط§ظ„ط¥ط±ط«ظٹط©.",
    });
  }

  const pendingRequests = await tx
    .select({ id: monthCloseRequests.id })
    .from(monthCloseRequests)
    .where(
      and(
        eq(monthCloseRequests.month, existing.closeMonth),
        eq(monthCloseRequests.status, "PENDING_APPROVAL"),
      ),
    )
    .for("update")
    .limit(1);
  if (pendingRequests[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "ظٹظˆط¬ط¯ ط·ظ„ط¨ ط¥ظ‚ظپط§ظ„ ظ…ط¹ظ„ظ‚ ظ„ظ‡ط°ط§ ط§ظ„ط´ظ‡ط±ط› ط­ط³ظ…ظ‡ ط£ظˆظ„ط§ظ‹.",
    });
  }

  const certificateRows = await tx
    .select({
      id: monthCloseCertificates.id,
      kind: monthCloseCertificates.kind,
    })
    .from(monthCloseCertificates)
    .where(eq(monthCloseCertificates.periodId, existing.id))
    .for("update")
    .limit(1);
  const certificate = certificateRows[0] ?? null;
  if (certificate?.kind === "YEAR_END") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "ط¥ط¹ط§ط¯ط© ظپطھط­ ط¥ظ‚ظپط§ظ„ ظ†ظ‡ط§ظٹط© ط³ظ†ط© طھطھط·ظ„ط¨ ظ…ط³ط§ط± ط¹ظƒط³ ط³ظ†ظˆظٹ طµط±ظٹط­طŒ ظˆظ„ط§ طھظ†ظپط° ظƒظپطھط­ ط´ظ‡ط±ظٹ ط¹ط§ط¯ظٹ.",
      cause: "YEAR_END_REOPEN_REQUIRES_REVERSAL",
    });
  }

  const predecessorRows = existing.predecessorPeriodId
    ? await tx
        .select({
          id: financialPeriods.id,
          closeMonth: financialPeriods.closeMonth,
        })
        .from(financialPeriods)
        .where(eq(financialPeriods.id, existing.predecessorPeriodId))
        .for("update")
        .limit(1)
    : [];
  const predecessor = predecessorRows[0] ?? null;
  const predecessorCertificateRows = predecessor
    ? await tx
        .select({ id: monthCloseCertificates.id })
        .from(monthCloseCertificates)
        .where(eq(monthCloseCertificates.periodId, Number(predecessor.id)))
        .for("update")
        .limit(1)
    : [];

  await tx
    .update(financialPeriods)
    .set({ status: "ARCHIVED" })
    .where(
      and(
        eq(financialPeriods.id, existing.id),
        eq(financialPeriods.status, "LOCKED"),
      ),
    );

  const nextRequiredMonth = existing.closeMonth;
  const activeThroughMonth = predecessor?.closeMonth ?? null;
  const activePeriodId = predecessor ? Number(predecessor.id) : null;
  const activeCertificateId = predecessorCertificateRows[0]
    ? Number(predecessorCertificateRows[0].id)
    : null;
  const version = state.version + 1;
  await tx
    .update(monthCloseSequence)
    .set({
      activeThroughMonth,
      nextRequiredMonth,
      activePeriodId,
      activeCertificateId,
      version,
    })
    .where(eq(monthCloseSequence.id, 1));

  const now = input.now ?? new Date();
  await appendMonthCloseEvent(
    tx,
    {
      ...state,
      activeThroughMonth,
      nextRequiredMonth,
      activePeriodId,
      activeCertificateId,
      version,
    },
    {
      eventKey: `MONTH_CLOSE:UNLOCK:${existing.id}`,
      eventType: "UNLOCK",
      month: existing.closeMonth,
      periodId: existing.id,
      certificateId: certificate ? Number(certificate.id) : null,
      actorId: input.actorId,
      occurredAt: now,
      reason: input.reason,
      payload: {
        revision: existing.closeRevision,
        predecessorPeriodId: activePeriodId,
        predecessorMonth: activeThroughMonth,
        nextRequiredMonth,
        openedCertificateId: certificate ? Number(certificate.id) : null,
      },
    },
  );

  return {
    unlocked: true,
    periodId: existing.id,
    reopenedMonth: existing.closeMonth,
    nextRequiredMonth,
  };
}

/** أرشفة قفل (لا فتح، لكن لا يُعتبر active بعد الآن — لو احتجنا متعدّد). */
export async function archivePeriod(tx: Tx, periodId: number): Promise<void> {
  await tx
    .update(financialPeriods)
    .set({ status: "ARCHIVED" })
    .where(eq(financialPeriods.id, periodId));
}
