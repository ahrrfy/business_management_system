// العروض (البطاقات/الاشتراكات) — راوتر البطاقات الرقمية والاشتراكات.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString } from "../../lib/schemas";
import { offeringService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, router } from "../../trpc";
import { actorOf, idInput, requireDb, scopedBranchOf } from "./shared";

const offeringTypeEnum = z.enum(["TELECOM_CARD", "GLOBAL_CARD", "EDUCATIONAL_SUBSCRIPTION", "OTHER"]);
const pricingModeEnum = z.enum(["FIXED_MARGIN", "PERCENT_MARGIN", "FIXED_PLUS_PERCENT", "FIXED_SELL_PRICE"]);

const offeringBranchSchema = z.object({
  branchId: z.number().int().positive(),
  walletId: z.number().int().positive().nullish(),
  isFavorite: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export const offeringsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          providerId: z.number().int().positive().optional(),
          offeringType: offeringTypeEnum.optional(),
          isActive: z.boolean().optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return offeringService.listOfferings(requireDb(), {
        ...(input ?? {}),
        ...(scoped != null ? { branchId: scoped } : {}),
      });
    }),

  get: digitalCardsAdminReadProcedure
    .input(idInput)
    .query(async ({ input }) => offeringService.getOffering(requireDb(), input.id)),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        offeringType: offeringTypeEnum,
        name: z.string().min(1).max(200),
        requiresStudentData: z.boolean().optional(),
        faceValue: nonNegMoneyString.nullish(),
        faceCurrency: z.string().length(3).nullish(),
        pricingMode: pricingModeEnum,
        fixedMargin: nonNegMoneyString.optional(),
        marginPercent: nonNegMoneyString.optional(),
        minimumMargin: nonNegMoneyString.optional(),
        roundingStep: nonNegMoneyString.optional(),
        priceValidityHours: z.number().int().positive().max(8760).nullish(),
        cardColorToken: z.string().max(30).nullish(),
        categoryId: z.number().int().positive().nullish(),
        productId: z.number().int().positive().nullish(),
        branches: z.array(offeringBranchSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.createOffering(tx, input, actorOf(ctx))),
    ),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        offeringType: offeringTypeEnum.optional(),
        requiresStudentData: z.boolean().optional(),
        faceValue: nonNegMoneyString.nullish(),
        faceCurrency: z.string().length(3).nullish(),
        pricingMode: pricingModeEnum.optional(),
        fixedMargin: nonNegMoneyString.optional(),
        marginPercent: nonNegMoneyString.optional(),
        minimumMargin: nonNegMoneyString.optional(),
        roundingStep: nonNegMoneyString.optional(),
        priceValidityHours: z.number().int().positive().max(8760).nullish(),
        cardColorToken: z.string().max(30).nullish(),
        branches: z.array(offeringBranchSchema).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.updateOffering(tx, input, actorOf(ctx))),
    ),

  toggle: digitalCardsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.updateOffering(tx, input, actorOf(ctx))),
    ),

  reorder: digitalCardsManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        order: z
          .array(
            z.object({
              offeringId: z.number().int().positive(),
              displayOrder: z.number().int().min(0).max(9999),
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (scopedBranchOf(ctx) != null && input.branchId !== scopedBranchOf(ctx)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إعادة ترتيب بطاقات فرع آخر" });
      }
      return withTx((tx) => offeringService.reorderOfferings(tx, input, actorOf(ctx)));
    }),
});
