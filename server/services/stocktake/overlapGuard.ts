import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  branches,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";
import { requireDb, withTx } from "../tx";
import { chunk, lockSession, type DbLike } from "./internal";

/** All scope writers take branch -> session, including creation and approval. */
export async function lockStocktakeBranch(
  tx: Tx,
  branchId: number,
): Promise<void> {
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, branchId))
    .for("update")
    .limit(1);
  if (!branch)
    throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "تعذّر فتح نطاق الجرد", why: "الفرع غير موجود", doThis: "حدّث الصفحة واختر فرعاً مسجلاً قبل إنشاء الجرد" }) });
}

/** Branch is immutable. Resolve it before opening the transaction/snapshot. */
export async function withStocktakeScopeTx<T>(
  sessionId: number,
  fn: (tx: Tx, session: Awaited<ReturnType<typeof lockSession>>) => Promise<T>,
): Promise<T> {
  const [header] = await requireDb()
    .select({ branchId: stocktakeSessions.branchId })
    .from(stocktakeSessions)
    .where(eq(stocktakeSessions.id, sessionId))
    .limit(1);
  if (!header)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({ what: "تعذّر فتح الجرد", why: "جلسة الجرد غير موجودة", doThis: "ارجع إلى قائمة الجرد وافتح جلسة موجودة" }),
    });
  return withTx(async (tx) => {
    await lockStocktakeBranch(tx, Number(header.branchId));
    const session = await lockSession(tx, sessionId);
    if (Number(session.branchId) !== Number(header.branchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({ what: "تعذّر تنفيذ الجرد", why: "تغيّر فرع الجلسة أثناء فتحها", doThis: "حدّث الجلسة وتحقق من الفرع ثم أعد المحاولة" }),
      });
    }
    return fn(tx, session);
  });
}

export async function loadActiveStocktakeOverlaps(
  db: DbLike,
  branchId: number,
  variantIds: number[],
  excludeSessionId = 0,
  currentRead = false,
): Promise<Map<number, { sessionId: number; code: string }>> {
  const found = new Map<number, { sessionId: number; code: string }>();
  for (const ids of chunk(Array.from(new Set(variantIds)), 500)) {
    const query = db
      .select({
        variantId: stocktakeItems.variantId,
        sessionId: stocktakeSessions.id,
        code: stocktakeSessions.code,
      })
      .from(stocktakeItems)
      .innerJoin(
        stocktakeSessions,
        eq(stocktakeSessions.id, stocktakeItems.sessionId),
      )
      .where(
        and(
          eq(stocktakeSessions.branchId, branchId),
          ne(stocktakeSessions.id, excludeSessionId),
          inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]),
          inArray(stocktakeItems.variantId, ids),
        ),
      )
      .orderBy(asc(stocktakeSessions.id));
    // A current read is essential after waiting for the branch mutex under MySQL RR.
    const rows = currentRead ? await query.for("share") : await query;
    for (const row of rows)
      if (!found.has(Number(row.variantId))) {
        found.set(Number(row.variantId), {
          sessionId: Number(row.sessionId),
          code: row.code,
        });
      }
  }
  return found;
}

/** Caller holds the branch mutex; no gap between the check and scope mutation. */
export async function assertNoActiveStocktakeOverlap(
  tx: Tx,
  branchId: number,
  variantIds: number[],
  excludeSessionId = 0,
): Promise<void> {
  const conflicts = await loadActiveStocktakeOverlaps(
    tx,
    branchId,
    variantIds,
    excludeSessionId,
    true,
  );
  if (!conflicts.size) return;
  const first = conflicts.values().next().value!;
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر تنفيذ الجرد بسبب تداخل الأصناف",
      why: `${conflicts.size} صنف مرتبط بجرد نشط آخر (${first.code}) في الفرع نفسه`,
      doThis:
        "أكمل أو ألغِ الجرد الآخر، أو اختر أصنافاً غير متداخلة؛ وعند تغيّر رصيد الجرد بجرد آخر أعد العدّ قبل الاعتماد",
    }),
  });
}
