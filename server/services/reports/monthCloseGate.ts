import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { branches, monthCloseSequence } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * صفوف الفروع هي بوابة التسلسل الثابتة للإقفال العام على الشركة.
 *
 * INSERT إلى shifts/receipts يتحقق من FK الفرع ويحتاج قفلاً مشتركاً على صفّه. اعتماد
 * الإقفال يقفل كل صفوف الفروع حصرياً قبل إعادة فحص الحواجز؛ لذا يحدث واحد فقط من:
 *  - الكاتب يلتزم أولاً، فيراه فحص الجاهزية ويرفض الإقفال.
 *  - الإقفال يلتزم أولاً، ثم يعيد الكاتب فحص period lock ويرفض التاريخ المقفَل.
 *
 * هذا قفل صفوف عادي مرتبط بالمعاملة (يُحرَّر بعد COMMIT/ROLLBACK)، لا GET_LOCK مربوطاً
 * بالاتصال يمكن أن يتسرّب إلى تجمّع الاتصالات.
 */
/**
 * Shared company-wide writer gate. Every ledger writer acquires it before
 * checking the active period or reading double-entry mode. The gate also
 * covers branchless postings, which cannot be serialized through a branch FK.
 */
export async function lockFinancialPostingGate(tx: Tx): Promise<void> {
  let rows = await tx
    .select({ id: monthCloseSequence.id })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .for("share")
    .limit(1);
  if (rows[0]) return;

  await tx
    .insert(monthCloseSequence)
    .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  rows = await tx
    .select({ id: monthCloseSequence.id })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .for("share")
    .limit(1);
  if (!rows[0]) {
    throw new Error("MONTH_CLOSE_GATE_MISSING");
  }
}

/**
 * Exclusive company close gate. Close/unlock operations take this before
 * settings, branch rows, requests, periods, readiness evidence, or journals.
 */
export async function lockCompanyMonthCloseGate(tx: Tx): Promise<void> {
  let rows = await tx
    .select({ id: monthCloseSequence.id })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .for("update")
    .limit(1);
  if (!rows[0]) {
    await tx
      .insert(monthCloseSequence)
      .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    rows = await tx
      .select({ id: monthCloseSequence.id })
      .from(monthCloseSequence)
      .where(eq(monthCloseSequence.id, 1))
      .for("update")
      .limit(1);
  }
  if (!rows[0]) {
    throw new Error("MONTH_CLOSE_GATE_MISSING");
  }
  await tx
    .select({ id: branches.id })
    .from(branches)
    .orderBy(asc(branches.id))
    .for("update");
}

/** يقفل بوابة فرع الكاتب قبل فحص الفترة وأي INSERT ماليّ تابع لذلك الفرع. */
export async function lockBranchMonthCloseGate(
  tx: Tx,
  branchId: number,
): Promise<void> {
  await lockFinancialPostingGate(tx);
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, branchId))
    .for("update")
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود." });
  }
}
