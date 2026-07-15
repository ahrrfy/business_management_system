// promotions v2 router (٨/٧/٢٦): إدارة العروض بعد gstack-review PR #163.
//
// RBAC:
//   list/getById/create/deactivate — productsManagerProcedure (يكشف حالة/أولوية/تكلفة أثر مُجمَّع).
//   activeToday — productsReadProcedure (POS يحتاج القائمة الحيّة لشارات).
//
// Branch scoping: non-admin manager يُقصر على `ctx.user.branchId` (لا يستطيع إنشاء عرضٍ عامّ NULL
// ولا لفرع آخر). admin يختار بحرية (بما فيه NULL=عامّ).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { crmCampaigns, promotionTargets, promotions } from "../../drizzle/schema";
import { logAudit } from "../services/auditService";
import {
  createPromotion,
  deactivatePromotion,
  getPromotionWithTargets,
} from "../services/salesPromotionService";
import { getDb } from "../db";
import { withTx } from "../services/tx";
import { campaignsManagerProcedure, campaignsReadProcedure, router } from "../trpc";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح");
const percentStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة غير صالحة");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

const targetSchema = z.object({
  categoryId: z.number().int().positive().nullish(),
  productId: z.number().int().positive().nullish(),
  variantId: z.number().int().positive().nullish(),
});

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

  getById: campaignsReadProcedure
    .input(z.object({ promotionId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const result = await withTx(async (tx) => getPromotionWithTargets(tx, input.promotionId));
      if (result?.promotion.branchId != null && ctx.user.role !== "admin" && Number(result.promotion.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص فرعك" });
      }
      return result;
    }),

  create: campaignsManagerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        campaignId: z.number().int().positive().nullish(),
        description: z.string().max(2000).nullish(),
        type: z.enum(["PERCENT", "AMOUNT"]),
        discountPercent: percentStr.optional(),
        discountAmount: moneyStr.optional(),
        scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]),
        effectiveFrom: ymd,
        effectiveTo: ymd.nullish(),
        customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
        branchId: z.number().int().positive().nullish(),
        minLineAmount: moneyStr.optional(),
        priority: z.number().int().min(0).max(999).optional(),
        applicationMode: z.enum(["AUTO", "COUPON"]).default("AUTO"),
        channel: z.enum(["POS", "STORE"]).default("POS"),
        targets: z.array(targetSchema).max(500).optional(),
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
      const { channel, ...promotionInput } = input;
      const promotionId = await withTx(async (tx) => {
        if (promotionInput.campaignId != null) {
          const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, promotionInput.campaignId)).limit(1))[0];
          if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "الحملة غير موجودة" });
          if (ctx.user.role !== "admin" && Number(campaign.branchId) !== scopedBranchId) {
            throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن ربط عرض بحملة خارج فرعك" });
          }
        }
        return createPromotion(tx, {
          ...promotionInput,
          branchId: scopedBranchId,
          isStoreManaged: channel === "STORE",
        }, ctx.user.id);
      });
      await logAudit(ctx, {
        action: "promotion.create",
        entityType: "promotion",
        entityId: promotionId,
        newValue: {
          name: input.name,
          type: input.type,
          scope: input.scope,
          priority: input.priority ?? 0,
          branchId: scopedBranchId,
          campaignId: input.campaignId ?? null,
          applicationMode: input.applicationMode,
          channel: input.channel,
          discountPercent: input.discountPercent,
          discountAmount: input.discountAmount,
        },
      });
      return { promotionId };
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

  /** العروض الساري تاريخها اليوم على فرع/فئة معيّنَين — للـPOS و/offers (badges). */
  activeToday: campaignsReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      if (ctx.user.role !== "admin" && Number(ctx.user.branchId) !== input.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة عروض فرع آخر" });
      }
      // B8: مقارنة حبيبة اليوم (بغداد UTC+3) بدل datetime — «اليوم الأخير» يعمل.
      const now = new Date();
      const bag = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      const todayYmd = bag.toISOString().slice(0, 10);
      const todayDate = new Date(todayYmd + "T00:00:00");
      const rows = await db
        .select()
        .from(promotions)
        .where(
          and(
            eq(promotions.isActive, true),
            eq(promotions.applicationMode, "AUTO"),
            lte(promotions.effectiveFrom, todayDate),
            or(isNull(promotions.effectiveTo), gte(promotions.effectiveTo, todayDate))!,
            or(isNull(promotions.branchId), eq(promotions.branchId, input.branchId))!,
            input.customerTier
              ? or(isNull(promotions.customerTier), eq(promotions.customerTier, input.customerTier))!
              : isNull(promotions.customerTier),
          ),
        )
        .orderBy(desc(promotions.priority));
      const promoIds = rows.map((r) => Number(r.id));
      const targets = promoIds.length
        ? await db.select().from(promotionTargets).where(inArray(promotionTargets.promotionId, promoIds))
        : [];
      const targetsByPromo = new Map<number, typeof targets>();
      for (const t of targets) {
        const pid = Number(t.promotionId);
        const list = targetsByPromo.get(pid) ?? [];
        list.push(t);
        targetsByPromo.set(pid, list);
      }
      return rows.map((r) => ({
        ...r,
        id: Number(r.id),
        branchId: r.branchId == null ? null : Number(r.branchId),
        createdBy: r.createdBy == null ? null : Number(r.createdBy),
        targets: (targetsByPromo.get(Number(r.id)) ?? []).map((t) => ({
          categoryId: t.categoryId == null ? null : Number(t.categoryId),
          productId: t.productId == null ? null : Number(t.productId),
          variantId: t.variantId == null ? null : Number(t.variantId),
        })),
      }));
    }),
});
