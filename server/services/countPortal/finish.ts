// تسليم التكليف (finish) — تنتقل الجلسة آلياً لـREVIEW عند تسليم آخر تكليف.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { stocktakeAssignments, stocktakeSessions } from "../../../drizzle/schema";
import { withTx } from "../tx";
import { loadStocktakeProgress } from "../stocktake/internal";
import { syncSingleFullStocktakeSessionTx } from "../stocktake/liveScope";
import { lockStocktakeBranch } from "../stocktake/overlapGuard";
import type { PortalIdentity } from "./identity";
import { SESSION_UNAVAILABLE_MSG, IDENTITY_EXPIRED_MSG, COUNTING_ENDED_MSG } from "./shared";

export type FinishAssignmentResult = {
  ok: true;
  /** true إن كان هذا آخر تكليف ⇒ الجلسة انتقلت آلياً إلى REVIEW. */
  sessionMovedToReview: boolean;
  /** true إن كان التكليف مسلَّماً مسبقاً (إعادة استدعاء — نجاح بلا أثر). */
  alreadySubmitted: boolean;
};

/**
 * تسليم العدّ (العقد §٥ — `finish`): التكليف ⇒ SUBMITTED، وعند تسليم آخر تكليف
 * تنتقل الجلسة آلياً إلى REVIEW مع submittedAt. idempotent عند إعادة الاستدعاء.
 */
export async function finishAssignment(identity: PortalIdentity): Promise<FinishAssignmentResult> {
  const outcome = await withTx(async (tx) => {
    // ترتيب الأقفال الحاكم لنطاق الجرد: الفرع -> الجلسة -> التكليفات.
    await lockStocktakeBranch(tx, Number(identity.session.branchId));
    const sessionRows = await tx
      .select()
      .from(stocktakeSessions)
      .where(eq(stocktakeSessions.id, identity.session.id))
      .for("update")
      .limit(1);
    const session = sessionRows[0];
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });

    const assignments = await tx
      .select()
      .from(stocktakeAssignments)
      .where(eq(stocktakeAssignments.sessionId, session.id))
      .for("update");
    const me = assignments.find((a) => Number(a.id) === Number(identity.assignment.id));
    if (!me) throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });

    if (me.status === "SUBMITTED") {
      return { ok: true as const, sessionMovedToReview: false, alreadySubmitted: true };
    }
    if (me.status !== "ACTIVE") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
    }
    if (session.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });
    }

    if (session.scopeType === "FULL") {
      await syncSingleFullStocktakeSessionTx(tx, session);
    }

    const { total, counted } = await loadStocktakeProgress(tx, Number(session.id));
    if (counted < total) {
      // نلتزم بالسطور الملحقة حديثاً كي تظهر للعدّاد فوراً قبل رفع خطأ عدم الاكتمال.
      return { ok: false as const, counted, total };
    }

    const now = new Date();
    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now, lastActivityAt: now })
      .where(eq(stocktakeAssignments.id, me.id));

    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now, lastActivityAt: now })
      .where(and(eq(stocktakeAssignments.sessionId, session.id), eq(stocktakeAssignments.status, "ACTIVE")));
    await tx
      .update(stocktakeSessions)
      .set({ status: "REVIEW", submittedAt: now })
      .where(eq(stocktakeSessions.id, session.id));

    return { ok: true as const, sessionMovedToReview: true, alreadySubmitted: false };
  });
  if (!outcome.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يمكن رفع الجرد للمراجعة قبل عدّ كل المنتجات (${outcome.counted}/${outcome.total})`,
    });
  }
  return outcome;
}
