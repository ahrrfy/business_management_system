// مساعد Idempotency للعمليات المالية الحسّاسة (دفعات/مرتجعات/استلام).
// النمط: داخل withTx، فحص (operation, clientRequestId) — إن وُجد ⇒ نُعيد refId المخزّن (replay)؛
// وإلّا فالعملية تكتب البيانات الفعلية ثم تسجّل المفتاح. القيد الفريد على (operation, key) يمنع
// تسابق طلبَين متزامنين بنفس المفتاح (الثاني يتلقّى ER_DUP_ENTRY فيراه المستدعي).
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "../../drizzle/schema";
import type { Tx } from "../db";

/** إن كان clientRequestId مُستهلَكاً سابقاً يُرجع refId الأول؛ وإلّا null. */
export async function findIdempotentRefId(
  tx: Tx,
  operation: string,
  clientRequestId: string | null | undefined,
): Promise<number | null> {
  if (!clientRequestId) return null;
  const rows = await tx
    .select({ refId: idempotencyKeys.refId })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.operation, operation), eq(idempotencyKeys.clientRequestId, clientRequestId)))
    .limit(1);
  return rows[0] ? Number(rows[0].refId) : null;
}

/** يسجّل مفتاح الـidempotency بعد نجاح الكتابة. يرمي ER_DUP_ENTRY عند سباق طلبَين متزامنين بنفس المفتاح. */
export async function recordIdempotencyKey(
  tx: Tx,
  operation: string,
  clientRequestId: string,
  refId: number,
): Promise<void> {
  await tx.insert(idempotencyKeys).values({ operation, clientRequestId, refId });
}
