// المزوّدون — راوتر البطاقات الرقمية والاشتراكات (ش٣).
import { z } from "zod";
import { nonNegMoneyString } from "../../lib/schemas";
import { providerService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, router } from "../../trpc";
import { actorOf, idInput, requireDb } from "./shared";

const providerTypeEnum = z.enum(["TELECOM", "GLOBAL_CARDS", "EDUCATIONAL", "OTHER"]);
const settlementModeEnum = z.enum(["PREPAID", "POSTPAID"]);
const recognitionModeEnum = z.enum(["PRINCIPAL_GROSS"]);
const referencePolicyEnum = z.enum(["REQUIRED", "OPTIONAL", "NONE"]);
const settlementCycleEnum = z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "ON_DEMAND"]);

export const providersRouter = router({
  list: digitalCardsAdminReadProcedure.query(async () => providerService.listProviders(requireDb())),

  get: digitalCardsAdminReadProcedure
    .input(idInput)
    .query(async ({ input }) => providerService.getProvider(requireDb(), input.id)),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        providerType: providerTypeEnum,
        settlementMode: settlementModeEnum,
        recognitionMode: recognitionModeEnum.default("PRINCIPAL_GROSS"),
        referencePolicy: referencePolicyEnum.default("OPTIONAL"),
        settlementCycle: settlementCycleEnum.default("ON_DEMAND"),
        lowBalanceThreshold: nonNegMoneyString.optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.createProvider(tx, input, actorOf(ctx))),
    ),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        providerType: providerTypeEnum.optional(),
        settlementMode: settlementModeEnum.optional(),
        recognitionMode: recognitionModeEnum.optional(),
        referencePolicy: referencePolicyEnum.optional(),
        settlementCycle: settlementCycleEnum.optional(),
        lowBalanceThreshold: nonNegMoneyString.optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.updateProvider(tx, input, actorOf(ctx))),
    ),

  toggle: digitalCardsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.updateProvider(tx, input, actorOf(ctx))),
    ),
});
