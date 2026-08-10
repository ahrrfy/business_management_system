// تسليم التكليف (finish) — تنتقل الجلسة آلياً لـREVIEW عند تسليم آخر تكليف.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { stocktakeAssignments, stocktakeSessions } from "../../../drizzle/schema";
import { withTx } from "../tx";
import { loadStocktakeProgress } from "../stocktake/internal";
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
  return withTx(async (tx) => {
    // قفل الجلسة أولاً ثم تكليفاتها — نفس ترتيب الأقفال في approve لتجنّب deadlock.
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

    // مسلَّم مسبقاً (أو عبر forceReview) ⇒ نجاح بلا أثر.
    if (me.status === "SUBMITTED") {
      return { ok: true as const, sessionMovedToReview: false, alreadySubmitted: true };
    }
    if (me.status !== "ACTIVE") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
    }
    if (session.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });
    }

    // The shared session only moves to review after every scoped product has a
    // first/recount value. Worker hand-off alone must never close it early.
    const { total, counted } = await loadStocktakeProgress(tx, Number(session.id));
    if (counted < total) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا يمكن رفع الجرد للمراجعة قبل عدّ كل المنتجات (${counted}/${total})`,
      });
    }

    const now = new Date();
    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now, lastActivityAt: now })
      .where(eq(stocktakeAssignments.id, me.id));

    // آخر تكليف يُسلَّم ⇒ الجلسة تنتقل آلياً لقيد المراجعة.
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
}
