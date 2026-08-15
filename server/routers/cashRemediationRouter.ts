import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { canCrossBranches } from "../lib/branchAuthority";
import { getCashRemediationDryRun } from "../services/cashRemediation/reportService";
import { REMEDIATION_CLASSIFICATIONS } from "../services/cashRemediation/types";
import { reportViewerProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");
const positiveIds = z.array(z.number().int().positive()).min(1).max(100);

const dryRunInput = z
  .object({
    from: ymd,
    to: ymd,
    branchId: z.number().int().positive().optional(),
    shiftIds: positiveIds.optional(),
    userIds: positiveIds.optional(),
    simulations: z
      .array(
        z.object({
          receiptId: z.number().int().positive(),
          classification: z.enum(REMEDIATION_CLASSIFICATIONS),
        }),
      )
      .max(500)
      .optional(),
  })
  .superRefine((input, context) => {
    if (input.from > input.to) {
      context.addIssue({ code: "custom", path: ["to"], message: "نهاية الفترة تسبق بدايتها" });
    }
    const duplicateSimulation = input.simulations?.find(
      (item, index, all) => all.findIndex((other) => other.receiptId === item.receiptId) !== index,
    );
    if (duplicateSimulation) {
      context.addIssue({
        code: "custom",
        path: ["simulations"],
        message: `الإيصال #${duplicateSimulation.receiptId} مكرر في المحاكاة`,
      });
    }
  });

/** S1: مسار قراءة واحد فقط. لا mutation ولا endpoint اعتماد/ترحيل في هذه الشريحة. */
export const cashRemediationRouter = router({
  dryRun: reportViewerProcedure.input(dryRunInput).query(async ({ input, ctx }) => {
    let branchId = input.branchId;
    if (!canCrossBranches(ctx.user)) {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      branchId = Number(ctx.user.branchId);
    }
    return getCashRemediationDryRun({ ...input, branchId });
  }),
});
