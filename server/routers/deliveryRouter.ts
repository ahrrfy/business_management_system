import { z } from "zod";
import { branchScopedProcedure, managerProcedure, router } from "../trpc";
import {
  createDeliveryParty,
  getDeliveryParty,
  listDeliveryParties,
  setDeliveryPartyActive,
  updateDeliveryParty,
} from "../services/deliveryService";
import { logAudit } from "../services/auditService";

const partyKind = z.enum(["INDIVIDUAL", "COMPANY"]);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح");

function actorOf(ctx: { user: { id: number; branchId?: number | null } }) {
  return { userId: ctx.user.id, branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined };
}

export const deliveryRouter = router({
  // قائمة جهات التوصيل + عهدتها (branch-scoped: غير المرتفعين يَرون فرعهم فقط).
  listParties: branchScopedProcedure
    .input(z.object({ activeOnly: z.boolean().optional(), search: z.string().optional() }).optional())
    .query(({ input, ctx }) =>
      listDeliveryParties({ branchId: ctx.scopedBranchId, activeOnly: input?.activeOnly, search: input?.search }),
    ),

  getParty: branchScopedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => getDeliveryParty(input.id)),

  createParty: managerProcedure
    .input(
      z.object({
        partyType: partyKind,
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        branchId: z.number().int().positive().nullish(),
        nationalId: z.string().max(40).nullish(),
        vehicleInfo: z.string().max(120).nullish(),
        defaultFee: moneyStr.nullish(),
        floatLimit: moneyStr.nullish(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createDeliveryParty(input, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.create", entityType: "deliveryParty", entityId: res.id, newValue: { name: input.name, partyType: input.partyType } });
      return res;
    }),

  updateParty: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        partyType: partyKind.optional(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        branchId: z.number().int().positive().nullish(),
        nationalId: z.string().max(40).nullish(),
        vehicleInfo: z.string().max(120).nullish(),
        defaultFee: moneyStr.nullish(),
        floatLimit: moneyStr.nullish(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateDeliveryParty(input, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.update", entityType: "deliveryParty", entityId: input.id, newValue: { id: input.id } });
      return res;
    }),

  setPartyActive: managerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setDeliveryPartyActive(input.id, input.isActive, actorOf(ctx));
      await logAudit(ctx, { action: "delivery.party.setActive", entityType: "deliveryParty", entityId: input.id, newValue: { isActive: input.isActive } });
      return res;
    }),
});
