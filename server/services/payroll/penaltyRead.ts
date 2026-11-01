import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { inArray } from "drizzle-orm";
import { payrollItems, payrollRuns } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { verifyApprovalSnapshotIfPresentTx } from "./obligations";
import { assertZeroNetEvidenceIfPaymentExistsTx, readPenaltyBreakdownsTx, type PenaltyBreakdown } from "./penaltyAllocations";

/** The caller holds the run locks and reads every displayed field in this transaction. */
export async function readLockedPenaltyBreakdownsTx(tx: Tx, runs: Array<typeof payrollRuns.$inferSelect>, itemIds: number[]): Promise<Map<number, PenaltyBreakdown>> {
  try {
    for (const run of runs) {
      if (run.status !== "draft") {
        await verifyApprovalSnapshotIfPresentTx(tx, run, { readOnly: true });
        await assertZeroNetEvidenceIfPaymentExistsTx(tx, run);
      }
    }
    return await readPenaltyBreakdownsTx(tx, itemIds);
  } catch (cause) {
    if (!(cause instanceof TRPCError)) throw cause;
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر التحقق من تفاصيل الراتب", why: "لم تتطابق لقطة الاعتماد أو تخصيص العقوبة",
      doThis: "راجع الموارد البشرية قبل الاعتماد على التفاصيل",
    }) });
  }
}

/** Verify the run once in a consistent read before exposing any employee's allocation. */
export async function readPenaltyBreakdowns(db: DB, itemIds: number[]): Promise<Map<number, PenaltyBreakdown>> {
  if (!itemIds.length) return new Map<number, PenaltyBreakdown>();
  try {
    return await db.transaction(async (tx) => {
      const preview = await tx.select({ id: payrollItems.id, runId: payrollItems.runId }).from(payrollItems)
        .where(inArray(payrollItems.id, itemIds)).orderBy(payrollItems.id);
      const runIds = Array.from(new Set(preview.map((row) => Number(row.runId)))).sort((a, b) => a - b);
      const runs = runIds.length ? await tx.select().from(payrollRuns)
        .where(inArray(payrollRuns.id, runIds)).orderBy(payrollRuns.id).for("share") : [];
      const current = await tx.select({ id: payrollItems.id, runId: payrollItems.runId }).from(payrollItems)
        .where(inArray(payrollItems.id, itemIds)).orderBy(payrollItems.id).for("share");
      if (current.length !== new Set(itemIds).size || runs.length !== runIds.length ||
          current.some((row, index) => Number(row.id) !== Number(preview[index]?.id) || Number(row.runId) !== Number(preview[index]?.runId))) {
        throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر قراءة بند الراتب", why: "تغيّر البند أثناء القراءة", doThis: "حدّث الصفحة وأعد المحاولة" }) });
      }
      return readLockedPenaltyBreakdownsTx(tx, runs, itemIds);
    });
  } catch (cause) {
    if (!(cause instanceof TRPCError)) throw cause;
    // Self-service must not expose another employee's item identifier on a run-wide mismatch.
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تعذّر التحقق من تفاصيل الراتب", why: "لم تتطابق لقطة الاعتماد أو تخصيص العقوبة",
      doThis: "راجع الموارد البشرية قبل الاعتماد على التفاصيل",
    }) });
  }
}
