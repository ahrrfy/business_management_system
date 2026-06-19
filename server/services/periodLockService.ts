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
import { desc, eq } from "drizzle-orm";
import { financialPeriods } from "../../drizzle/schema";
import type { Tx } from "../db";

export interface ActiveLock {
  cutoffDate: string; // YYYY-MM-DD
  lockedAt: Date;
  lockedBy: number;
  notes: string | null;
}

/** أحدث قفل نشِط (LOCKED). null = لا قفل ⇒ الكل مفتوح. */
export async function getActiveLock(tx: Tx): Promise<ActiveLock | null> {
  const rows = await tx
    .select({
      cutoffDate: financialPeriods.cutoffDate,
      lockedAt: financialPeriods.lockedAt,
      lockedBy: financialPeriods.lockedBy,
      notes: financialPeriods.notes,
    })
    .from(financialPeriods)
    .where(eq(financialPeriods.status, "LOCKED"))
    .orderBy(desc(financialPeriods.cutoffDate))
    .limit(1);
  return rows[0] ?? null;
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
}

export async function lockPeriod(tx: Tx, input: LockPeriodInput): Promise<{ id: number }> {
  // لو cutoffDate أصغر من قفل سابق ⇒ ارفض (لا تراجع زمني)
  const existing = await getActiveLock(tx);
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
  });
  // mysql2 يعيد insertId على header
  const insertId = Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  return { id: insertId };
}

/** فتح أحدث قفل LOCKED (DELETE — لا soft delete، السجلات الأخرى تبقى ARCHIVED للأرشفة). */
export async function unlockLatestPeriod(tx: Tx): Promise<{ unlocked: boolean }> {
  const existing = await getActiveLock(tx);
  if (!existing) return { unlocked: false };

  await tx
    .delete(financialPeriods)
    .where(eq(financialPeriods.cutoffDate, existing.cutoffDate));
  return { unlocked: true };
}

/** أرشفة قفل (لا فتح، لكن لا يُعتبر active بعد الآن — لو احتجنا متعدّد). */
export async function archivePeriod(tx: Tx, periodId: number): Promise<void> {
  await tx
    .update(financialPeriods)
    .set({ status: "ARCHIVED" })
    .where(eq(financialPeriods.id, periodId));
}
