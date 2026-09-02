import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { branches, monthCloseSequence } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { retryOnDeadlock } from "../../lib/retryDeadlock";

const MISSING_GATE = "MONTH_CLOSE_GATE_MISSING";

export function isMonthCloseGateMissing(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_GATE;
}

/**
 * يُستدعى خارج معاملة الأعمال فقط (auto-commit) فلا gap locks متبادلة مع فحص البوّابة.
 *
 * لكنّ عدّة بادئين يتسابقون على bootstrap البوّابة يُدرجون نفس المفتاح الأساسيّ (id=1)
 * معاً، وInnoDB يقفل التكرار بقفلٍ مشترك (S) ثمّ يرقّيه إلى حصريّ (X) للتحديث ⇒
 * ER_LOCK_DEADLOCK بين البادئين المتزامنين. العملية idempotent تماماً (تُدرج الصفّ
 * المفرد أو no-op على تحديثٍ لا يغيّر شيئاً) فإعادتها آمنة حتماً — نفس نمط بقيّة كتّاب
 * النظام. وبعد أوّل فوزٍ يوجد الصفّ، فتتسلسل الإعادات على قفل X للمفتاح الأساسيّ بلا
 * deadlock جديد.
 */
export async function ensureFinancialPostingGate(db: DB): Promise<void> {
  await retryOnDeadlock(async () => {
    await db
      .insert(monthCloseSequence)
      .values({ id: 1, status: "NEEDS_BOOTSTRAP", version: 0 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
  });
}

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
  const rows = await tx
    .select({ id: monthCloseSequence.id })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .for("share")
    .limit(1);
  if (!rows[0]) {
    // الإدراج داخل هذه المعاملة بعد gap lock مشترك يسبب deadlock بين بادئين.
    // withTx يتراجع أولاً، يهيّئ الصف خارج معاملة الأعمال، ثم يعيدها من بدايتها.
    throw new Error(MISSING_GATE);
  }
}

/**
 * Exclusive company close gate. Close/unlock operations take this before
 * settings, branch rows, requests, periods, readiness evidence, or journals.
 */
export async function lockCompanyMonthCloseGate(tx: Tx): Promise<void> {
  const rows = await tx
    .select({ id: monthCloseSequence.id })
    .from(monthCloseSequence)
    .where(eq(monthCloseSequence.id, 1))
    .for("update")
    .limit(1);
  if (!rows[0]) {
    throw new Error(MISSING_GATE);
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
