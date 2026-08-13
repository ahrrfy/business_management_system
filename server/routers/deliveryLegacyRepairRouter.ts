import { z } from "zod";
import { router, reportsAdminProcedure } from "../trpc";
import {
  DELIVERY_LEGACY_REPAIR_ACTIONS,
  getDeliveryLegacyFindings,
  repairDeliveryLegacyRow,
} from "../services/deliveryLegacyRepairService";

const nullablePositiveId = z.number().int().positive().nullish();

/** أداة إدارية محصورة بالأدمن: تقرير قراءة أولاً، ثم إصلاح صفّي مؤكد ومدقّق. */
export const deliveryLegacyRepairRouter = router({
  report: reportsAdminProcedure
    .input(
      z
        .object({
          branchId: nullablePositiveId,
        })
        .default({}),
    )
    .query(({ input }) => getDeliveryLegacyFindings(input)),

  repair: reportsAdminProcedure
    .input(
      z.object({
        action: z.enum(DELIVERY_LEGACY_REPAIR_ACTIONS),
        targetId: z.number().int().positive(),
        confirmation: z.string().min(1).max(255),
        note: z.string().trim().min(5, "دوّن سبب القرار أو مصدره").max(500),
        partyId: nullablePositiveId,
        deliveryFee: z.string().regex(/^\d+(?:\.\d{1,2})?$/).nullish(),
        gatewayUserId: nullablePositiveId,
        deliveredAt: z.string().datetime({ offset: true }).nullish(),
        evidenceRef: z.string().trim().min(3).max(255).nullish(),
        feeSettlementAction: z.enum(["EARN_ONLY", "EARN_AND_DIRECT_PAID"]).nullish(),
        customerBalanceAction: z.enum(["IDENTITY_ONLY", "ADD_OUTSTANDING"]).nullish(),
      }),
    )
    .mutation(({ input, ctx }) => repairDeliveryLegacyRow(input, ctx)),
});
