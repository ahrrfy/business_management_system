// promotions v2 router (٨/٧/٢٦): إدارة العروض بعد gstack-review PR #163.
//
// RBAC:
//   list/getById/create/deactivate — productsManagerProcedure (يكشف حالة/أولوية/تكلفة أثر مُجمَّع).
//   نقطة البيع تحلّ العرض ضمن catalog.pos وتعيد خدمة البيع التحقق منه؛ لا endpoint قائمة موازية.
//
// Branch scoping: non-admin manager يُقصر على `ctx.user.branchId` (لا يستطيع إنشاء عرضٍ عامّ NULL
// ولا لفرع آخر). admin يختار بحرية (بما فيه NULL=عامّ).
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { crmCampaigns, promotions } from "../../drizzle/schema";
import { MAX_PROMOTION_TARGETS } from "../../shared/promotionEngine";
import { todayYmdBaghdad } from "../../shared/promotionScheduling";
import { logAudit } from "../services/auditService";
import {
  createPromotion,
  deactivatePromotion,
  duplicatePromotion,
  getPromotionWithTargets,
  loadPromotionPerformance,
  searchPromotionProducts,
  updatePromotion,
} from "../services/salesPromotionService";
import { getDb } from "../db";
import { withTx } from "../services/tx";
import {
  campaignsManagerProcedure,
  campaignsReadProcedure,
  canSeeCostForUser,
  router,
} from "../trpc";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح");
const percentStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة غير صالحة");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

const targetSchema = z.object({
  categoryId: z.number().int().positive().nullish(),
  productId: z.number().int().positive().nullish(),
  variantId: z.number().int().positive().nullish(),
  productUnitId: z.number().int().positive().nullish(),
});

const tierSchema = z.object({
  minQuantity: moneyStr,
  tierType: z.enum(["PERCENT", "AMOUNT", "FIXED_PRICE"]),
  discountPercent: percentStr.optional(),
  discountAmount: moneyStr.optional(),
  fixedPrice: moneyStr.optional(),
});

const promoTypeEnum = z.enum([
  "PERCENT",
  "AMOUNT",
  "FIXED_PRICE",
  "BUNDLE_PRICE",
  "BOGO",
  "TIERED_QTY",
  "FREE_SHIPPING",
]);

const additionalRuleSchema = z.object({
  ruleLabel: z.string().max(120).nullish(),
  type: promoTypeEnum,
  discountPercent: percentStr.optional(),
  discountAmount: moneyStr.optional(),
  maxDiscountAmount: moneyStr.nullish(),
  fixedPrice: moneyStr.optional(),
  bundlePrice: moneyStr.optional(),
  bundleMode: z.enum(["ALL_REQUIRED", "PICK_ANY_N"]).optional(),
  bundleQuantity: z.number().int().positive().optional(),
  bogoBuyQuantity: z.number().int().positive().optional(),
  bogoGetQuantity: z.number().int().positive().optional(),
  bogoGetDiscountPercent: percentStr.optional(),
  tieredMode: z.enum(["PER_ITEM", "POOL_ACROSS_TARGETS"]).optional(),
  tiers: z.array(tierSchema).max(50).optional(),
  scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]).optional(),
  targets: z.array(targetSchema).max(MAX_PROMOTION_TARGETS).optional(),
  allowBelowCost: z.boolean().optional(),
  applyToBaseUnitOnly: z.boolean().optional(),
  minLineAmount: moneyStr.optional(),
  freeShipping: z.boolean().optional(),
});

const PROMO_TYPE_AR_SHORT: Record<z.infer<typeof promoTypeEnum>, string> = {
  PERCENT: "نسبة خصم",
  AMOUNT: "مبلغ ثابت",
  FIXED_PRICE: "سعر موحد",
  BUNDLE_PRICE: "سعر باقة",
  BOGO: "اشترِ واحصل",
  TIERED_QTY: "شرائح كميات",
  FREE_SHIPPING: "توصيل مجاني",
};

export const promotionsV2Router = router({
  list: campaignsReadProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const branchId = ctx.user.role === "admin" ? null : Number(ctx.user.branchId);
      const rows = await db
        .select()
        .from(promotions)
        .where(and(
          input?.includeInactive ? undefined : eq(promotions.isActive, true),
          branchId == null ? undefined : or(isNull(promotions.branchId), eq(promotions.branchId, branchId)),
        ))
        .orderBy(desc(promotions.priority), desc(promotions.id));
      return rows.map((r) => ({
        ...r,
        id: Number(r.id),
        branchId: r.branchId == null ? null : Number(r.branchId),
        createdBy: r.createdBy == null ? null : Number(r.createdBy),
      }));
    }),

  /** مؤشرات ربحية تشغيلية من مستندات البيع المجمّدة، مع عزل الفرع نفسه للقائمة. */
  performance: campaignsReadProcedure.query(async ({ ctx }) => {
    const branchId = ctx.user.role === "admin"
      ? null
      : ctx.user.branchId == null
        ? null
        : Number(ctx.user.branchId);
    if (ctx.user.role !== "admin" && branchId == null) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد" });
    }
    const canViewCost = canSeeCostForUser(ctx.user);
    return withTx((tx) => loadPromotionPerformance(tx, branchId, canViewCost));
  }),

  getById: campaignsReadProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const canViewCost = canSeeCostForUser(ctx.user);
      const result = await withTx(async (tx) => getPromotionWithTargets(tx, input.promotionId, canViewCost));
      if (result?.promotion.branchId != null && ctx.user.role !== "admin" && Number(result.promotion.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص فرعك" });
      }
      return result;
    }),

  searchProducts: campaignsReadProcedure
    .input(
      z.object({
        q: z.string().max(120).optional(),
        categoryId: z.number().int().positive().nullish(),
        codes: z.array(z.string().min(1).max(120)).max(500).optional(),
        limit: z.number().int().positive().max(500).default(20),
        offset: z.number().int().min(0).max(50_000).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const canViewCost = canSeeCostForUser(ctx.user);
      return searchPromotionProducts(db, input, canViewCost);
    }),

  create: campaignsManagerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        primaryRuleLabel: z.string().max(120).nullish(),
        campaignId: z.number().int().positive().nullish(),
        description: z.string().max(2000).nullish(),
        type: promoTypeEnum,
        discountPercent: percentStr.optional(),
        discountAmount: moneyStr.optional(),
        maxDiscountAmount: moneyStr.nullish(),
        minOrderSpend: moneyStr.optional(),
        freeShipping: z.boolean().optional(),
        shippingDiscountAmount: moneyStr.optional(),
        scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]),
        effectiveFrom: ymd,
        effectiveTo: ymd.nullish(),
        customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
        branchId: z.number().int().positive().nullish(),
        minLineAmount: moneyStr.optional(),
        priority: z.number().int().min(0).max(999).optional(),
        applicationMode: z.enum(["AUTO", "COUPON"]).default("AUTO"),
        channel: z.enum(["ALL", "POS_ONLY", "STORE_ONLY", "POS", "STORE"]).default("ALL"),
        allowBelowCost: z.boolean().default(false),
        applyToBaseUnitOnly: z.boolean().default(true),
        activeDays: z.array(z.number().int().min(0).max(6)).nullish(),
        fixedPrice: moneyStr.optional(),
        bundlePrice: moneyStr.optional(),
        bundleMode: z.enum(["ALL_REQUIRED", "PICK_ANY_N"]).optional(),
        bundleQuantity: z.number().int().positive().optional(),
        bogoBuyQuantity: z.number().int().positive().optional(),
        bogoGetQuantity: z.number().int().positive().optional(),
        bogoGetDiscountPercent: percentStr.optional(),
        tieredMode: z.enum(["PER_ITEM", "POOL_ACROSS_TARGETS"]).optional(),
        tiers: z.array(tierSchema).max(50).optional(),
        targets: z.array(targetSchema).max(MAX_PROMOTION_TARGETS).optional(),
        additionalRules: z.array(additionalRuleSchema).max(20).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // gstack B9: non-admin يُقصر على فرعه — لا يستطيع إنشاء عرض عامّ (NULL) ولا لفرع آخر.
      let scopedBranchId: number | null;
      if (ctx.user.role === "admin") {
        scopedBranchId = input.branchId ?? null;
      } else {
        const ownBranch = ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
        if (ownBranch == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد" });
        if (input.branchId != null && Number(input.branchId) !== ownBranch) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يُسمَح لك بإنشاء عرضٍ لفرع غير فرعك" });
        }
        scopedBranchId = ownBranch;
      }
      const { channel, primaryRuleLabel, additionalRules, ...promotionInput } = input;
      const extraRules = additionalRules ?? [];
      const isMultiRule = extraRules.length > 0;
      const baseTitle = promotionInput.name.trim();
      const formatRuleName = (ruleType: z.infer<typeof promoTypeEnum>, customLabel?: string | null) => {
        if (!isMultiRule) return baseTitle;
        const suffix = (customLabel ?? "").trim() || PROMO_TYPE_AR_SHORT[ruleType];
        return `${baseTitle} — ${suffix}`.slice(0, 255);
      };

      const createdIds = await withTx(async (tx) => {
        if (promotionInput.campaignId != null) {
          const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, promotionInput.campaignId)).limit(1))[0];
          if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "الحملة غير موجودة" });
          if (ctx.user.role !== "admin" && Number(campaign.branchId) !== scopedBranchId) {
            throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن ربط عرض بحملة خارج فرعك" });
          }
        }
        const ids: number[] = [];
        const firstId = await createPromotion(
          tx,
          {
            ...promotionInput,
            name: formatRuleName(promotionInput.type, primaryRuleLabel),
            branchId: scopedBranchId,
            channel: channel as any,
            isStoreManaged: channel === "STORE" || channel === "STORE_ONLY",
          },
          ctx.user.id,
        );
        ids.push(firstId);

        for (const extra of extraRules) {
          const nextId = await createPromotion(
            tx,
            {
              campaignId: promotionInput.campaignId,
              name: formatRuleName(extra.type, extra.ruleLabel),
              description: promotionInput.description,
              type: extra.type,
              discountPercent: extra.discountPercent,
              discountAmount: extra.discountAmount,
              maxDiscountAmount: extra.maxDiscountAmount,
              minOrderSpend: promotionInput.minOrderSpend,
              freeShipping:
                extra.type === "FREE_SHIPPING"
                  ? true
                  : (extra.freeShipping ??
                    (promotionInput.type === "FREE_SHIPPING"
                      ? false
                      : promotionInput.freeShipping)),
              shippingDiscountAmount: promotionInput.shippingDiscountAmount,
              scope: extra.scope ?? promotionInput.scope,
              effectiveFrom: promotionInput.effectiveFrom,
              effectiveTo: promotionInput.effectiveTo,
              customerTier: promotionInput.customerTier,
              branchId: scopedBranchId,
              minLineAmount: extra.minLineAmount ?? promotionInput.minLineAmount,
              priority: promotionInput.priority,
              targets: extra.scope ? extra.targets : (extra.targets ?? promotionInput.targets),
              channel: channel as any,
              isStoreManaged: channel === "STORE" || channel === "STORE_ONLY",
              applicationMode: promotionInput.applicationMode,
              allowBelowCost: extra.allowBelowCost ?? promotionInput.allowBelowCost,
              applyToBaseUnitOnly: extra.applyToBaseUnitOnly ?? promotionInput.applyToBaseUnitOnly,
              activeDays: promotionInput.activeDays,
              fixedPrice: extra.fixedPrice,
              bundlePrice: extra.bundlePrice,
              bundleMode: extra.bundleMode,
              bundleQuantity: extra.bundleQuantity,
              bogoBuyQuantity: extra.bogoBuyQuantity,
              bogoGetQuantity: extra.bogoGetQuantity,
              bogoGetDiscountPercent: extra.bogoGetDiscountPercent,
              tieredMode: extra.tieredMode,
              tiers: extra.tiers,
            },
            ctx.user.id,
          );
          ids.push(nextId);
        }
        return ids;
      });

      const promotionId = createdIds[0]!;
      for (let i = 0; i < createdIds.length; i++) {
        const pid = createdIds[i]!;
        const rType = i === 0 ? input.type : extraRules[i - 1]!.type;
        await logAudit(ctx, {
          action: "promotion.create",
          entityType: "promotion",
          entityId: pid,
          newValue: {
            name: formatRuleName(rType, i === 0 ? primaryRuleLabel : extraRules[i - 1]!.ruleLabel),
            type: rType,
            scope: i === 0 ? input.scope : (extraRules[i - 1]!.scope ?? input.scope),
            priority: input.priority ?? 0,
            branchId: scopedBranchId,
            campaignId: input.campaignId ?? null,
            applicationMode: input.applicationMode,
            channel: input.channel,
            multiRuleIndex: isMultiRule ? i + 1 : undefined,
            multiRuleTotal: isMultiRule ? createdIds.length : undefined,
          },
        });
      }
      return { promotionId, promotionIds: createdIds };
    }),

  duplicate: campaignsManagerProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const todayYmd = todayYmdBaghdad();
      const newId = await withTx(async (tx) => {
        return duplicatePromotion(tx, input.promotionId, ctx.user.id, todayYmd, ctx.user);
      });
      await logAudit(ctx, {
        action: "promotion.duplicate",
        entityType: "promotion",
        entityId: newId,
        newValue: { sourcePromotionId: input.promotionId },
      });
      return { promotionId: newId };
    }),

  deactivate: campaignsManagerProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await withTx(async (tx) => {
        const promotion = (await tx.select().from(promotions).where(eq(promotions.id, input.promotionId)).limit(1))[0];
        if (!promotion) throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
        if (ctx.user.role !== "admin" && Number(promotion.branchId) !== Number(ctx.user.branchId)) throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص فرعك" });
        await deactivatePromotion(tx, input.promotionId);
      });
      await logAudit(ctx, {
        action: "promotion.deactivate",
        entityType: "promotion",
        entityId: input.promotionId,
      });
      return { ok: true };
    }),

  /** إعادة تفعيل عرض معطَّل (عكس deactivate) — نفس حراسة عزل الفرع. */
  reactivate: campaignsManagerProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await withTx(async (tx) => {
        const promotion = (await tx.select().from(promotions).where(eq(promotions.id, input.promotionId)).limit(1))[0];
        if (!promotion) throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
        if (ctx.user.role !== "admin" && Number(promotion.branchId) !== Number(ctx.user.branchId)) throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص فرعك" });
        if (promotion.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "العرض نشط أصلاً" });
        await tx.update(promotions).set({ isActive: true }).where(eq(promotions.id, input.promotionId));
      });
      await logAudit(ctx, {
        action: "promotion.reactivate",
        entityType: "promotion",
        entityId: input.promotionId,
      });
      return { ok: true };
    }),

  /**
   * تعديل عرضٍ قائم.
   */
  update: campaignsManagerProcedure
    .input(
      z.object({
        promotionId: z.number().int().positive(),
        campaignId: z.number().int().positive().nullish(),
        isActive: z.boolean().optional(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(2000).nullish(),
        type: promoTypeEnum.optional(),
        discountPercent: percentStr.optional(),
        discountAmount: moneyStr.optional(),
        maxDiscountAmount: moneyStr.nullish(),
        minOrderSpend: moneyStr.optional(),
        freeShipping: z.boolean().optional(),
        shippingDiscountAmount: moneyStr.optional(),
        scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]).optional(),
        effectiveFrom: ymd.optional(),
        effectiveTo: ymd.nullish(),
        customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
        branchId: z.number().int().positive().nullish(),
        minLineAmount: moneyStr.optional(),
        priority: z.number().int().min(0).max(999).optional(),
        applicationMode: z.enum(["AUTO", "COUPON"]).optional(),
        channel: z.enum(["ALL", "POS_ONLY", "STORE_ONLY", "POS", "STORE"]).optional(),
        allowBelowCost: z.boolean().optional(),
        applyToBaseUnitOnly: z.boolean().optional(),
        activeDays: z.array(z.number().int().min(0).max(6)).nullish(),
        fixedPrice: moneyStr.optional(),
        bundlePrice: moneyStr.optional(),
        bundleMode: z.enum(["ALL_REQUIRED", "PICK_ANY_N"]).optional(),
        bundleQuantity: z.number().int().positive().optional(),
        bogoBuyQuantity: z.number().int().positive().optional(),
        bogoGetQuantity: z.number().int().positive().optional(),
        bogoGetDiscountPercent: percentStr.optional(),
        tieredMode: z.enum(["PER_ITEM", "POOL_ACROSS_TARGETS"]).optional(),
        tiers: z.array(tierSchema).max(50).optional(),
        targets: z.array(targetSchema).max(MAX_PROMOTION_TARGETS).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { promotionId, channel, ...patch } = input;
      await withTx(async (tx) => {
        const promotion = (await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for("update").limit(1))[0];
        if (!promotion) throw new TRPCError({ code: "NOT_FOUND", message: "العرض غير موجود" });
        if (ctx.user.role !== "admin" && Number(promotion.branchId) !== Number(ctx.user.branchId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص فرعك" });
        }
        if (patch.branchId !== undefined && ctx.user.role !== "admin") {
          const ownBranch = ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
          if (patch.branchId == null || Number(patch.branchId) !== ownBranch) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: appErrorMessage({
                what: "لا يُسمح بتغيير فرع العرض خارج فرعك",
                why: "صلاحية تخصيص كافة الفروع أو نقل العرض لفرع آخر محصورة بمدير النظام",
                doThis: "أبقِ العرض على فرعك المسند أو راجع مدير النظام",
              }),
            });
          }
        }
        if (patch.campaignId != null) {
          const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, patch.campaignId)).limit(1))[0];
          if (!campaign) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: appErrorMessage({
                what: "الحملة غير موجودة",
                why: `لم يتم العثور على الحملة رقم ${patch.campaignId}`,
                doThis: "اختر حملة صالحة من القائمة أو اترك العرض مستقلاً",
              }),
            });
          }
          if (ctx.user.role !== "admin" && Number(campaign.branchId) !== Number(ctx.user.branchId)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: appErrorMessage({
                what: "لا يمكن ربط العرض بحملة خارج فرعك",
                why: "الحملة المختارة تتبع فرعاً آخر",
                doThis: "اختر حملة تابعة لفرعك أو راجع مدير النظام",
              }),
            });
          }
        }
        if (promotion.type === "PERCENT" && patch.discountAmount != null && !patch.type) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "عرض النسبة لا يقبل تعديل مبلغ ثابت" });
        }
        if (promotion.type === "AMOUNT" && patch.discountPercent != null && !patch.type) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "عرض المبلغ الثابت لا يقبل تعديل نسبة" });
        }
        await updatePromotion(tx, {
          id: promotionId,
          ...patch,
          name: patch.name?.trim(),
          description: patch.description !== undefined ? patch.description?.trim() || null : undefined,
          channel: channel as any,
          isStoreManaged: channel !== undefined ? (channel === "STORE" || channel === "STORE_ONLY") : undefined,
        }, ctx.user.id);
      });
      await logAudit(ctx, {
        action: "promotion.update",
        entityType: "promotion",
        entityId: promotionId,
        newValue: { ...patch, ...(channel !== undefined ? { channel } : {}) },
      });
      return { ok: true };
    }),

});
