import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { branches } from "../../../drizzle/schema";
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
export async function lockCompanyMonthCloseGate(tx: Tx): Promise<void> {
  await tx
    .select({ id: branches.id })
    .from(branches)
    .orderBy(asc(branches.id))
    .for("update");
}

/** يقفل بوابة فرع الكاتب قبل فحص الفترة وأي INSERT ماليّ تابع لذلك الفرع. */
export async function lockBranchMonthCloseGate(tx: Tx, branchId: number): Promise<void> {
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
