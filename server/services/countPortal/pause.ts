// End-of-shift marker for a multi-day shared stocktake. It deliberately does
// not change assignment/session status: all saved counts remain editable when
// the worker returns.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { stocktakeAssignments, stocktakeSessions } from "../../../drizzle/schema";
import { withTx } from "../tx";
import type { PortalIdentity } from "./identity";
import { COUNTING_ENDED_MSG, IDENTITY_EXPIRED_MSG, SESSION_UNAVAILABLE_MSG } from "./shared";

export async function pauseAssignment(identity: PortalIdentity): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const session = (
      await tx.select().from(stocktakeSessions).where(eq(stocktakeSessions.id, identity.session.id)).for("update").limit(1)
    )[0];
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });
    if (session.status !== "COUNTING") throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });

    const assignment = (
      await tx.select().from(stocktakeAssignments).where(eq(stocktakeAssignments.id, identity.assignment.id)).for("update").limit(1)
    )[0];
    if (!assignment || Number(assignment.sessionId) !== Number(session.id)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
    }
    if (assignment.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });

    await tx.update(stocktakeAssignments).set({ lastActivityAt: new Date() }).where(eq(stocktakeAssignments.id, assignment.id));
    return { ok: true as const };
  });
}
