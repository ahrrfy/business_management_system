import { randomBytes, createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { appErrorMessage } from "../../shared/errors";
import { formatActiveDays, type PromotionDesignMeta } from "../../shared/promotionScheduling";
import { generateCouponsStandalonePdf, type CouponPdfItem } from "../services/couponPdfService";
import {
  auditLogs,
  couponPrograms,
  couponRedemptions,
  coupons,
  crmCampaigns,
  promotions,
  promotionTargets,
  storeSettings,
  users,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { nonNegMoneyString, percentString } from "../lib/schemas";
import { logAudit, logAuditTx } from "../services/auditService";
import { getProductCategoryIds, resolveCouponPromotionForLine } from "../services/salesPromotionService";
import {
  loadCouponProgramPerformance,
  loadIssuedCouponDetails,
  lockCouponForSale,
} from "../services/couponService";
import { escapeLike } from "../lib/sqlLike";
import { money, toDbMoney } from "../services/money";
import { requireDb, withTx } from "../services/tx";
import { campaignsManagerProcedure, campaignsReadProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون YYYY-MM-DD");
const campaignStatus = z.enum(["DRAFT", "REVIEW", "APPROVED", "SCHEDULED", "ACTIVE", "PAUSED", "ENDED"]);
const programStatus = z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]);

const promotionDesignSchema = z.object({
  title: z.string().max(80).optional(),
  subtitle: z.string().max(140).optional(),
  terms: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  activeDays: z.array(z.number().int().min(0).max(6)).max(7).optional().nullable(),
  isAutoBounceBack: z.boolean().optional(),
  autoBounceBackMinInvoice: nonNegMoneyString.optional().nullable(),
  bounceBackValidityDays: z.number().int().min(1).max(365).optional().nullable(),
  bounceBackPrefix: z.string().trim().max(12).optional().nullable(),
  bounceBackHeadline: z.string().trim().max(100).optional().nullable(),
}).optional();

type UserCtx = { user: { id: number; role: string; branchId?: number | null } };

function ownBranch(ctx: UserCtx, requested?: number | null): number | null {
  if (ctx.user.role === "admin") return requested ?? null;
  const branchId = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
  if (branchId == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد فرع مُسنَد للمستخدم" });
  if (requested != null && Number(requested) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إدارة حملة أو كوبون لفرع آخر" });
  }
  return branchId;
}

function visibleBranch(ctx: UserCtx) {
  if (ctx.user.role === "admin") return undefined;
  const branchId = ownBranch(ctx);
  return or(isNull(crmCampaigns.branchId), eq(crmCampaigns.branchId, branchId!));
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function codeHash(code: string): string {
  return createHash("sha256").update(normalizeCode(code), "utf8").digest("hex");
}

function makeCode(prefix: string): string {
  const safePrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "CRM";
  const token = randomBytes(5).toString("hex").toUpperCase();
  return `${safePrefix}-${token.slice(0, 5)}-${token.slice(5)}`;
}

function campaignTransitionAllowed(from: string, to: string): boolean {
  const allowed: Record<string, string[]> = {
    DRAFT: ["REVIEW", "ENDED"],
    REVIEW: ["DRAFT", "APPROVED", "ENDED"],
    APPROVED: ["SCHEDULED", "ACTIVE", "ENDED"],
    SCHEDULED: ["ACTIVE", "PAUSED", "ENDED"],
    ACTIVE: ["PAUSED", "ENDED"],
    PAUSED: ["ACTIVE", "ENDED"],
    ENDED: [],
  };
  return allowed[from]?.includes(to) ?? false;
}

async function getCampaignForWrite(tx: Tx, id: number, ctx: UserCtx) {
  const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, id)).limit(1))[0];
  if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "الحملة غير موجودة" });
  if (ctx.user.role !== "admin" && Number(campaign.branchId) !== ownBranch(ctx)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الحملة لا تتبع فرعك" });
  }
  return campaign;
}

export const crmRouter = router({
  dashboard: campaignsReadProcedure.query(async ({ ctx }) => {
    const db = requireDb();
    const branchId = ctx.user.role === "admin" ? null : ownBranch(ctx);
    const campaignWhere = branchId == null ? undefined : or(isNull(crmCampaigns.branchId), eq(crmCampaigns.branchId, branchId));
    const programWhere = branchId == null ? undefined : or(isNull(couponPrograms.branchId), eq(couponPrograms.branchId, branchId));
    const [campaignStats, programStats, redemptionStats] = await Promise.all([
      db.select({ total: sql<number>`count(*)`, active: sql<number>`sum(${crmCampaigns.status} = 'ACTIVE')` }).from(crmCampaigns).where(campaignWhere),
      db.select({ total: sql<number>`count(*)`, active: sql<number>`sum(${couponPrograms.status} = 'ACTIVE')` }).from(couponPrograms).where(programWhere),
      db.select({ total: sql<number>`count(*)`, discount: sql<string>`coalesce(sum(${couponRedemptions.discountAmount}), 0)` }).from(couponRedemptions)
        .where(branchId == null ? undefined : eq(couponRedemptions.branchId, branchId)),
    ]);
    return {
      campaigns: { total: Number(campaignStats[0]?.total ?? 0), active: Number(campaignStats[0]?.active ?? 0) },
      couponPrograms: { total: Number(programStats[0]?.total ?? 0), active: Number(programStats[0]?.active ?? 0) },
      redemptions: { total: Number(redemptionStats[0]?.total ?? 0), discount: String(redemptionStats[0]?.discount ?? "0") },
    };
  }),

  campaigns: router({
    list: campaignsReadProcedure.query(async ({ ctx }) => {
      const rows = await requireDb().select().from(crmCampaigns).where(visibleBranch(ctx)).orderBy(desc(crmCampaigns.id));
      return rows.map((row) => ({ ...row, id: Number(row.id), branchId: row.branchId == null ? null : Number(row.branchId) }));
    }),

    create: campaignsManagerProcedure.input(z.object({
      name: z.string().trim().min(2).max(255),
      objective: z.string().trim().max(4000).nullish(),
      branchId: z.number().int().positive().nullish(),
      startsOn: ymd.nullish(),
      endsOn: ymd.nullish(),
      ownerUserId: z.number().int().positive().nullish(),
    })).mutation(async ({ input, ctx }) => {
      if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ نهاية الحملة أقدم من بدايتها" });
      }
      const branchId = ownBranch(ctx, input.branchId);
      const campaignId = await withTx(async (tx) => extractInsertId(await tx.insert(crmCampaigns).values({
        name: input.name,
        objective: input.objective || null,
        branchId,
        startsOn: input.startsOn ? new Date(input.startsOn) : null,
        endsOn: input.endsOn ? new Date(input.endsOn) : null,
        ownerUserId: input.ownerUserId ?? null,
        createdBy: ctx.user.id,
      })));
      await logAudit(ctx, { action: "crm.campaign.create", entityType: "crmCampaign", entityId: campaignId, newValue: { ...input, branchId } });
      return { campaignId };
    }),

    transition: campaignsManagerProcedure.input(z.object({ id: z.number().int().positive(), status: campaignStatus })).mutation(async ({ input, ctx }) => {
      const previous = await withTx(async (tx) => {
        const campaign = await getCampaignForWrite(tx, input.id, ctx);
        if (campaign.status === input.status) return campaign.status;
        if (!campaignTransitionAllowed(campaign.status, input.status)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `انتقال غير مسموح من ${campaign.status} إلى ${input.status}` });
        }
        await tx.update(crmCampaigns).set({
          status: input.status,
          approvedBy: input.status === "APPROVED" ? ctx.user.id : campaign.approvedBy,
          approvedAt: input.status === "APPROVED" ? new Date() : campaign.approvedAt,
        }).where(eq(crmCampaigns.id, input.id));
        return campaign.status;
      });
      await logAudit(ctx, { action: "crm.campaign.transition", entityType: "crmCampaign", entityId: input.id, oldValue: { status: previous }, newValue: { status: input.status } });
      return { ok: true };
    }),
  }),

  coupons: router({
    /** معاينة الكوبون للـPOS. لا تستهلكه؛ إعادة التحقق والاستهلاك الحاسمان يجريان داخل sales.create. */
    preview: campaignsReadProcedure.input(z.object({
      code: z.string().trim().min(3).max(64),
      branchId: z.number().int().positive(),
      customerId: z.number().int().positive().nullish(),
      customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]),
      lines: z.array(z.object({
        productId: z.number().int().positive(),
        variantId: z.number().int().positive(),
        productUnitId: z.number().int().positive(),
        unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
        quantity: z.number().int().positive().max(100000),
        hasContractPrice: z.boolean().default(false),
      })).min(1).max(200),
    })).mutation(async ({ input, ctx }) => {
      const branchId = ownBranch(ctx, input.branchId)!;
      return withTx(async (tx) => {
        const now = new Date();
        const todayYmd = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const lineSubtotal = input.lines.reduce(
          (sum, line) => sum.add(money(line.unitPrice).mul(line.quantity)),
          money(0),
        );
        const coupon = await lockCouponForSale(
          tx,
          {
            code: input.code,
            branchId,
            customerId: input.customerId ?? null,
            todayYmd,
            subtotal: lineSubtotal,
          },
          { lock: false },
        );
        const categories = await getProductCategoryIds(tx, input.lines.map((line) => line.productId));
        const lines = [];
        for (const line of input.lines) {
          const resolved = await resolveCouponPromotionForLine(tx, coupon.promotionId, {
            branchId,
            customerTier: input.customerTier,
            productId: line.productId,
            variantId: line.variantId,
            categoryId: categories.get(line.productId) ?? null,
            unitPrice: line.unitPrice,
            lineAmount: money(line.unitPrice).mul(line.quantity).toFixed(2),
            hasContractPrice: line.hasContractPrice,
            todayYmd,
          });
          if (!resolved) continue;
          lines.push({
            productUnitId: line.productUnitId,
            promotionId: resolved.promotionId,
            promotionName: resolved.promotionName,
            promotionDiscountForUnit: resolved.discountForUnit,
            promotionEffectivePrice: toDbMoney(money(line.unitPrice).minus(money(resolved.discountForUnit))),
          });
        }
        if (!lines.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذر تطبيق الكوبون",
              why: "الكوبون لا ينطبق على أي صنف من أصناف السلة الحالية أو تعارض مع أسعار تعاقدية",
              doThis: "تحقق من أصناف السلة أو أضف منتجات مشمولة بالعرض",
            }),
          });
        }
        return {
          code: coupon.code,
          programName: coupon.programName,
          lines,
          maxDiscountAmount: coupon.maxDiscountAmount,
          minOrderSpend: coupon.minOrderSpend,
          freeShipping: coupon.freeShipping,
          shippingDiscountAmount: coupon.shippingDiscountAmount,
          affiliateName: coupon.affiliateName,
        };
      });
    }),

    programs: campaignsReadProcedure.query(async ({ ctx }) => {
      const branchId = ctx.user.role === "admin" ? null : ownBranch(ctx);
      const rows = await requireDb().select({
        id: couponPrograms.id,
        campaignId: couponPrograms.campaignId,
        promotionId: couponPrograms.promotionId,
        name: couponPrograms.name,
        status: couponPrograms.status,
        branchId: couponPrograms.branchId,
        validFrom: couponPrograms.validFrom,
        validTo: couponPrograms.validTo,
        perCouponLimit: couponPrograms.perCouponLimit,
        perCustomerLimit: couponPrograms.perCustomerLimit,
        isFirstOrderSelfService: couponPrograms.isFirstOrderSelfService,
        codePrefix: couponPrograms.codePrefix,
        designJson: couponPrograms.designJson,
        affiliateName: couponPrograms.affiliateName,
        affiliatePhone: couponPrograms.affiliatePhone,
        affiliateCommissionRate: couponPrograms.affiliateCommissionRate,
        createdAt: couponPrograms.createdAt,
        minOrderSpend: promotions.minOrderSpend,
        maxDiscountAmount: promotions.maxDiscountAmount,
        freeShipping: promotions.freeShipping,
        shippingDiscountAmount: promotions.shippingDiscountAmount,
      }).from(couponPrograms)
        .leftJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
        .where(branchId == null ? undefined : or(isNull(couponPrograms.branchId), eq(couponPrograms.branchId, branchId)))
        .orderBy(desc(couponPrograms.id));
      const performance = await withTx((tx) => loadCouponProgramPerformance(tx, branchId));
      return rows.map((row) => {
        const p = performance.get(Number(row.id));
        return {
          ...row,
          id: Number(row.id),
          campaignId: row.campaignId == null ? null : Number(row.campaignId),
          promotionId: Number(row.promotionId),
          branchId: row.branchId == null ? null : Number(row.branchId),
          minOrderSpend: row.minOrderSpend ?? "0.00",
          maxDiscountAmount: row.maxDiscountAmount ?? null,
          freeShipping: Boolean(row.freeShipping),
          shippingDiscountAmount: row.shippingDiscountAmount ?? "0.00",
          issued: p?.issuedCoupons ?? 0,
          // الاستخدام الصالح فقط؛ فواتير الإلغاء/الإرجاع الكامل لا تُضخّم معدل الاسترداد.
          redeemed: p?.invoiceCount ?? 0,
          activeCoupons: p?.activeCoupons ?? 0,
          voidedCoupons: p?.voidedCoupons ?? 0,
          invoiceCount: p?.invoiceCount ?? 0,
          redeemedDiscount: p?.redeemedDiscount ?? "0.00",
          linkedNetSales: p?.linkedNetSales ?? "0.00",
          linkedGrossProfit: p?.linkedGrossProfit ?? "0.00",
          lastRedeemedAt: p?.lastRedeemedAt ?? null,
        };
      });
    }),

    createProgram: campaignsManagerProcedure.input(z.object({
      campaignId: z.number().int().positive().nullish(),
      promotionId: z.number().int().positive(),
      name: z.string().trim().min(2).max(255),
      branchId: z.number().int().positive().nullish(),
      validFrom: ymd,
      validTo: ymd.nullish(),
      perCouponLimit: z.number().int().min(1).max(1000).default(1),
      perCustomerLimit: z.number().int().min(1).max(1000).default(1),
      isFirstOrderSelfService: z.boolean().default(false),
      codePrefix: z.string().trim().min(1).max(12).default("CRM"),
      design: promotionDesignSchema,
      affiliateName: z.string().trim().max(255).optional(),
      affiliatePhone: z.string().trim().max(32).optional(),
      affiliateCommissionRate: percentString.default("0.00"),
    })).mutation(async ({ input, ctx }) => {
      if (input.validTo && input.validTo < input.validFrom) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تاريخ انتهاء الصلاحية غير صالح",
            why: "نهاية الصلاحية تسبق تاريخ البدء",
            doThis: "حدد تاريخ انتهاء لاحقاً لتاريخ البداية أو اتركه فارغاً",
          }),
        });
      }
      if (input.isFirstOrderSelfService && (input.perCustomerLimit !== 1 || input.perCouponLimit !== 1)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر إنشاء برنامج كوبون الطلب الأول",
            why: "هذا البرنامج يجب أن يسمح باستخدام واحد وكوبون واحد للعميل",
            doThis: "اضبط حدي الاستخدام لكل كوبون ولكل عميل على 1 ثم احفظ البرنامج",
          }),
        });
      }
      const branchId = ownBranch(ctx, input.branchId);
      const programId = await withTx(async (tx) => {
        const promotion = (await tx.select().from(promotions).where(eq(promotions.id, input.promotionId)).limit(1))[0];
        if (!promotion) throw new TRPCError({ code: "NOT_FOUND", message: "العرض المرتبط غير موجود" });
        if (promotion.applicationMode !== "COUPON") throw new TRPCError({ code: "BAD_REQUEST", message: "يجب أن يكون نمط العرض «كوبون»" });
        if (promotion.branchId != null && Number(promotion.branchId) !== branchId) throw new TRPCError({ code: "BAD_REQUEST", message: "فرع العرض لا يطابق فرع برنامج الكوبونات" });
        if (input.campaignId != null) await getCampaignForWrite(tx, input.campaignId, ctx);
        return extractInsertId(await tx.insert(couponPrograms).values({
          campaignId: input.campaignId ?? promotion.campaignId ?? null,
          promotionId: input.promotionId,
          name: input.name,
          branchId,
          validFrom: new Date(input.validFrom),
          validTo: input.validTo ? new Date(input.validTo) : null,
          perCouponLimit: input.perCouponLimit,
          perCustomerLimit: input.perCustomerLimit,
          isFirstOrderSelfService: input.isFirstOrderSelfService,
          codePrefix: input.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "CRM",
          designJson: input.design ?? null,
          affiliateName: input.affiliateName?.trim() || null,
          affiliatePhone: input.affiliatePhone?.trim() || null,
          affiliateCommissionRate: input.affiliateCommissionRate ?? "0.00",
          createdBy: ctx.user.id,
        }));
      });
      await logAudit(ctx, { action: "crm.couponProgram.create", entityType: "couponProgram", entityId: programId, newValue: { ...input, branchId } });
      return { programId };
    }),

    /** إنشاء موحّد للعرض الترويجي وبرنامج الكوبونات معاً في معاملة ذرية واحدة */
    createUnified: campaignsManagerProcedure.input(z.object({
      archetype: z.enum(["COUPON_BATCH", "AFFILIATE", "BOUNCE_BACK", "FIRST_ORDER", "DIRECT_PROMO"]).default("COUPON_BATCH"),
      applicationMode: z.enum(["COUPON", "AUTO"]).default("COUPON"),
      name: z.string().trim().min(2).max(255),
      description: z.string().trim().max(1000).optional(),
      codePrefix: z.string().trim().max(12).default("CRM"),
      type: z.enum(["PERCENT", "AMOUNT"]),
      status: z.enum(["DRAFT", "ACTIVE"]).default("ACTIVE"),
      discountPercent: percentString.optional(),
      discountAmount: nonNegMoneyString.optional(),
      maxDiscountAmount: nonNegMoneyString.optional(),
      minOrderSpend: nonNegMoneyString.default("0"),
      freeShipping: z.boolean().default(false),
      shippingDiscountAmount: nonNegMoneyString.default("0"),
      scope: z.enum(["ALL", "CATEGORIES", "PRODUCTS"]).default("ALL"),
      targetCategoryIds: z.array(z.number().int().positive()).max(500).optional(),
      targetProductIds: z.array(z.number().int().positive()).max(500).optional(),
      customerTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
      branchId: z.number().int().positive().nullish(),
      validFrom: ymd,
      validTo: ymd.nullish(),
      perCouponLimit: z.number().int().min(1).max(1000).default(1),
      perCustomerLimit: z.number().int().min(1).max(1000).default(1),
      isFirstOrderSelfService: z.boolean().default(false),
      initialBatchCount: z.number().int().min(0).max(500).default(0),
      customCodes: z.array(z.string().trim().min(2).max(32)).max(500).optional(),
      exportPdfOnCreate: z.boolean().default(false),
      affiliateName: z.string().trim().max(255).optional(),
      affiliatePhone: z.string().trim().max(32).optional(),
      affiliateCommissionRate: percentString.default("0.00"),
      design: promotionDesignSchema,
      campaignId: z.number().int().positive().nullish(),
    })).mutation(async ({ input, ctx }) => {
      if (input.validTo && input.validTo < input.validFrom) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تاريخ انتهاء الصلاحية غير صالح",
            why: "نهاية الصلاحية تسبق تاريخ البدء",
            doThis: "حدد تاريخ انتهاء لاحقاً لتاريخ البداية أو اتركه فارغاً",
          }),
        });
      }

      const isDirectPromo = input.archetype === "DIRECT_PROMO" || input.applicationMode === "AUTO";
      const isFirstOrder = input.archetype === "FIRST_ORDER" || input.isFirstOrderSelfService;

      if (input.type === "PERCENT") {
        if (!input.discountPercent || money(input.discountPercent).lte(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "نسبة الخصم غير صالحة",
              why: "يجب تحديد نسبة خصم موجبة أكبر من صفر عند اختيار نوع الخصم بالنسبة المئوية",
              doThis: "أدخل نسبة خصم بين 0.01 و 100",
            }),
          });
        }
        if (!isDirectPromo && (!input.maxDiscountAmount || money(input.maxDiscountAmount).lte(0))) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "سقف الخصم الأقصى مطلوب",
              why: "عروض النسبة المئوية في برامج الكوبونات تتطلب سقفاً مالياً أقصى (بالدينار) لمنع الخسائر غير المتوقعة",
              doThis: "حدد سقف الخصم الأقصى بالدينار العراقي ثم أعد الحفظ",
            }),
          });
        }
      } else {
        if (!input.discountAmount || money(input.discountAmount).lte(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "مبلغ الخصم غير صالح",
              why: "يجب تحديد مبلغ خصم موجب أكبر من صفر عند اختيار نوع الخصم بالمبلغ المقطوع",
              doThis: "أدخل مبلغ الخصم بالدينار العراقي",
            }),
          });
        }
      }

      if (isFirstOrder && !isDirectPromo && (input.perCustomerLimit !== 1 || input.perCouponLimit !== 1)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر إنشاء برنامج كوبون الطلب الأول",
            why: "هذا البرنامج يجب أن يسمح باستخدام واحد وكوبون واحد للعميل",
            doThis: "اضبط حدي الاستخدام لكل كوبون ولكل عميل على 1 ثم احفظ البرنامج",
          }),
        });
      }

      const branchId = ownBranch(ctx, input.branchId);

      const dbResult = await withTx(async (tx) => {
        const targetStatus = input.status;
        if (input.campaignId != null) {
          const campaign = await getCampaignForWrite(tx, input.campaignId, ctx);
          if (targetStatus === "ACTIVE" && !["APPROVED", "SCHEDULED", "ACTIVE"].includes(campaign.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "اعتمد الحملة أولاً قبل تفعيل برنامج الكوبونات",
            });
          }
        }

        const effectiveAppMode = isDirectPromo ? "AUTO" : "COUPON";

        // 1. إنشاء العرض الترويجي المرتبط
        const promoInsertResult = await tx.insert(promotions).values({
          campaignId: input.campaignId ?? null,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          discountPercent: input.type === "PERCENT" ? (input.discountPercent ?? "0") : "0",
          discountAmount: input.type === "AMOUNT" ? (input.discountAmount ?? "0") : "0",
          maxDiscountAmount: input.type === "PERCENT" ? (input.maxDiscountAmount ?? null) : null,
          minOrderSpend: isDirectPromo ? "0" : (input.minOrderSpend ?? "0"),
          freeShipping: isDirectPromo ? false : (input.freeShipping ?? false),
          shippingDiscountAmount: isDirectPromo ? "0" : (input.shippingDiscountAmount ?? "0"),
          scope: input.scope,
          effectiveFrom: new Date(input.validFrom),
          effectiveTo: input.validTo ? new Date(input.validTo) : null,
          customerTier: input.customerTier ?? null,
          branchId,
          minLineAmount: "0",
          priority: 0,
          isActive: targetStatus === "ACTIVE",
          applicationMode: effectiveAppMode,
          isStoreManaged: false,
          createdBy: ctx.user.id,
        });
        const promotionId = extractInsertId(promoInsertResult);

        // 2. إدراج أهداف العرض إن وجدت
        if (input.scope === "CATEGORIES" && input.targetCategoryIds?.length) {
          await tx.insert(promotionTargets).values(
            input.targetCategoryIds.map((categoryId) => ({
              promotionId,
              categoryId,
            })),
          );
        } else if (input.scope === "PRODUCTS" && input.targetProductIds?.length) {
          await tx.insert(promotionTargets).values(
            input.targetProductIds.map((productId) => ({
              promotionId,
              productId,
            })),
          );
        }

        // إذا كان العرض خصماً مباشراً تلقائياً، ينتهي مسار الإنشاء هنا دون الحاجة لبرنامج كوبونات
        if (isDirectPromo) {
          await logAuditTx(tx, ctx, {
            action: "crm.promotion.createDirect",
            entityType: "promotion",
            entityId: promotionId,
            newValue: {
              promotionId,
              name: input.name,
              applicationMode: "AUTO",
              type: input.type,
              discountPercent: input.discountPercent,
              discountAmount: input.discountAmount,
            },
          });
          return {
            promotionId,
            programId: null,
            name: input.name,
            codePrefix: "",
            status: targetStatus,
            applicationMode: "AUTO" as const,
            codes: [] as string[],
            batchReference: null,
          };
        }

        const safePrefix = input.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "CRM";

        // 3. قفل التفعيل الحصري لكوبون أول طلب إن طُلب
        if (targetStatus === "ACTIVE" && isFirstOrder) {
          const activationLock = (await tx.select({ id: storeSettings.id })
            .from(storeSettings)
            .where(eq(storeSettings.id, 1))
            .for("update")
            .limit(1))[0];
          if (!activationLock) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: "تعذر تفعيل برنامج كوبون الطلب الأول",
                why: "لا يوجد صف إعدادات المتجر الذي يحمي التفعيل المتزامن",
                doThis: "أكمل إعدادات المتجر ثم أعد محاولة التفعيل",
              }),
            });
          }
          const anotherFirstOrderProgram = (await tx.select({ id: couponPrograms.id })
            .from(couponPrograms)
            .where(and(
              eq(couponPrograms.status, "ACTIVE"),
              eq(couponPrograms.isFirstOrderSelfService, true),
              branchId == null
                ? undefined
                : or(
                    isNull(couponPrograms.branchId),
                    eq(couponPrograms.branchId, branchId),
                  ),
            ))
            .for("update")
            .limit(1))[0];
          if (anotherFirstOrderProgram) {
            throw new TRPCError({
              code: "CONFLICT",
              message: appErrorMessage({
                what: "تعذر تفعيل برنامج كوبون الطلب الأول",
                why: "يوجد برنامج فعّال آخر يخدم الفرع نفسه أو يغطي كل الفروع",
                doThis: "أوقف البرنامج الحالي أولاً، ثم فعّل هذا البرنامج",
              }),
            });
          }
        }

        // 4. دمج إعدادات التصميم حسب النمط
        const effectiveDesign: PromotionDesignMeta = {
          ...(input.design ?? {}),
          isAutoBounceBack: input.archetype === "BOUNCE_BACK" ? true : input.design?.isAutoBounceBack,
        };

        // 5. إنشاء برنامج الكوبونات فورياً بالحالة المستهدفة
        const progInsertResult = await tx.insert(couponPrograms).values({
          campaignId: input.campaignId ?? null,
          promotionId,
          name: input.name,
          status: targetStatus,
          branchId,
          validFrom: new Date(input.validFrom),
          validTo: input.validTo ? new Date(input.validTo) : null,
          perCouponLimit: isFirstOrder ? 1 : input.perCouponLimit,
          perCustomerLimit: isFirstOrder ? 1 : input.perCustomerLimit,
          isFirstOrderSelfService: isFirstOrder,
          codePrefix: safePrefix,
          designJson: effectiveDesign,
          affiliateName: input.affiliateName?.trim() || null,
          affiliatePhone: input.affiliatePhone?.trim() || null,
          affiliateCommissionRate: input.affiliateCommissionRate ?? "0.00",
          createdBy: ctx.user.id,
        });
        const programId = extractInsertId(progInsertResult);

        if (input.customCodes && input.customCodes.length > 0) {
          const rawCodes = input.customCodes.map((s) => normalizeCode(s)).filter(Boolean);
          const duplicates = rawCodes.filter((code, idx) => rawCodes.indexOf(code) !== idx);
          if (duplicates.length > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "تكرار في الأكواد المخصصة",
                why: `تحتوي القائمة على أكواد مكررة بعد التنسيق: ${Array.from(new Set(duplicates)).slice(0, 3).join(", ")}`,
                doThis: "احذف الأكواد المكررة ثم أعد المحاولة",
              }),
            });
          }
        }

        // 6. إصدار دفعة فورية متعددة إن طُلب (توليد متعدد مباشر)
        let issuedCodes: string[] = [];
        let batchReference: string | null = null;
        const requestedCount = input.customCodes?.length ? input.customCodes.length : input.initialBatchCount;

        if (requestedCount > 0 && !isFirstOrder) {
          const issuedAt = new Date();
          batchReference = `CP-${programId}-${issuedAt.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex").toUpperCase()}`;
          const uniqueCodes = new Set<string>();

          if (input.customCodes && input.customCodes.length > 0) {
            for (const raw of input.customCodes) {
              const norm = normalizeCode(raw);
              if (norm) uniqueCodes.add(norm);
            }
          } else {
            while (uniqueCodes.size < requestedCount) {
              uniqueCodes.add(makeCode(safePrefix));
            }
          }

          const couponRows = Array.from(uniqueCodes, (code) => ({
            programId,
            customerId: null,
            code,
            codeHash: codeHash(code),
            status: "ACTIVE" as const,
            issuedAt,
          }));

          if (couponRows.length > 0) {
            await tx.insert(coupons).values(couponRows);
            await logAuditTx(tx, ctx, {
              action: "crm.coupon.issue",
              entityType: "couponProgram",
              entityId: programId,
              newValue: { batchReference, count: couponRows.length, issuedAt: issuedAt.toISOString() },
            });
            issuedCodes = couponRows.map((r) => r.code);
          }
        }

        // 7. تسجيل التدقيق الإلزامي لإنشاء البرنامج
        await logAuditTx(tx, ctx, {
          action: "crm.couponProgram.createUnified",
          entityType: "couponProgram",
          entityId: programId,
          newValue: {
            programId,
            promotionId,
            name: input.name,
            codePrefix: safePrefix,
            branchId,
            type: input.type,
            discountPercent: input.discountPercent,
            discountAmount: input.discountAmount,
            maxDiscountAmount: input.maxDiscountAmount,
            minOrderSpend: input.minOrderSpend,
            affiliateName: input.affiliateName,
            affiliateCommissionRate: input.affiliateCommissionRate,
            initialIssuedCount: issuedCodes.length,
          },
        });

        return {
          programId,
          promotionId,
          name: input.name,
          codePrefix: safePrefix,
          status: targetStatus,
          applicationMode: "COUPON" as const,
          codes: issuedCodes,
          batchReference,
        };
      });

      // 8. تصدير PDF فوري إن كان مطلوباً ووجدت كوبونات صادرة (محمي ضد الفشل لمنع تكرار الحفظ)
      let pdf: { base64: string; filename: string; pageCount: number } | null = null;
      let pdfWarning: string | null = null;

      if (input.exportPdfOnCreate && dbResult.codes.length > 0 && dbResult.programId != null) {
        try {
          const design = (input.design ?? {}) as PromotionDesignMeta;
          let heroDiscount = "";
          if (input.type === "PERCENT") {
            heroDiscount = `خصم ${Number(input.discountPercent)}%`;
          } else if (input.discountAmount) {
            heroDiscount = `خصم ${Number(input.discountAmount).toLocaleString()} د.ع`;
          }
          const discountCap = input.type === "PERCENT" && input.maxDiscountAmount && money(input.maxDiscountAmount).gt(0)
            ? `سقف الخصم: ${Number(input.maxDiscountAmount).toLocaleString()} د.ع`
            : null;
          const minSpend = input.minOrderSpend && money(input.minOrderSpend).gt(0)
            ? `للطلبات بقيمة ${Number(input.minOrderSpend).toLocaleString()} د.ع فأكثر`
            : null;
          const activeDaysText = design.activeDays && design.activeDays.length > 0 && design.activeDays.length < 7
            ? `متاح: ${formatActiveDays(design.activeDays)}`
            : null;

          const items: CouponPdfItem[] = dbResult.codes.map((code) => ({
            code,
            title: design.title || input.name,
            subtitle: design.subtitle,
            heroDiscount,
            discountCap,
            minSpend,
            terms: design.terms,
            validTo: input.validTo ? new Date(input.validTo) : null,
            activeDaysText,
            color: design.color || "#0D6B52",
          }));

          const pdfDoc = await generateCouponsStandalonePdf({
            programName: input.name,
            coupons: items,
          });

          pdf = {
            base64: Buffer.from(pdfDoc.pdfBytes).toString("base64"),
            filename: `coupons-${dbResult.codePrefix}-${dbResult.codes.length}cards.pdf`,
            pageCount: pdfDoc.pageCount,
          };
        } catch (pdfErr) {
          console.error("[CRM] Failed to generate PDF post-commit:", pdfErr);
          pdfWarning = "تم حفظ البرنامج وإصدار الكوبونات بنجاح، ولكن تعذر توليد ملف PDF تلقائياً. يمكنك تصديرها لاحقاً من قائمة الكوبونات.";
        }
      }

      return {
        ...dbResult,
        pdf,
        pdfWarning,
      };
    }),

    setProgramStatus: campaignsManagerProcedure.input(z.object({ programId: z.number().int().positive(), status: programStatus })).mutation(async ({ input, ctx }) => {
      await withTx(async (tx) => {
        const program = (await tx.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).limit(1))[0];
        if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
        if (program.status === "ENDED") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إعادة فتح برنامج منتهٍ" });
        const transitions: Record<string, string[]> = { DRAFT: ["ACTIVE", "ENDED"], ACTIVE: ["PAUSED", "ENDED"], PAUSED: ["ACTIVE", "ENDED"] };
        if (program.status !== input.status && !transitions[program.status]?.includes(input.status)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `انتقال حالة غير مسموح من ${program.status} إلى ${input.status}` });
        }
        if (input.status === "ACTIVE") {
          const promotion = (await tx.select().from(promotions).where(eq(promotions.id, program.promotionId)).limit(1))[0];
          if (!promotion || promotion.applicationMode !== "COUPON") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التفعيل قبل تفعيل عرض كوبون صالح" });
          if (!promotion.isActive) {
            await tx.update(promotions).set({ isActive: true }).where(eq(promotions.id, program.promotionId));
          }
          if (program.campaignId != null) {
            const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, program.campaignId)).limit(1))[0];
            if (!campaign || !["APPROVED", "SCHEDULED", "ACTIVE"].includes(campaign.status)) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "اعتمد الحملة أولاً قبل تفعيل برنامج الكوبونات" });
            }
          }
          if (program.isFirstOrderSelfService) {
            // لا يوجد قيد فريد جزئي في MySQL. صف الإعدادات الوحيد هو قفل نطاق ثابت
            // لهذه العملية النادرة فقط؛ ينتظر المفعّل الثاني ثم يرى البرنامج الأول ACTIVE.
            const activationLock = (await tx.select({ id: storeSettings.id })
              .from(storeSettings)
              .where(eq(storeSettings.id, 1))
              .for("update")
              .limit(1))[0];
            if (!activationLock) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: appErrorMessage({
                  what: "تعذر تفعيل برنامج كوبون الطلب الأول",
                  why: "لا يوجد صف إعدادات المتجر الذي يحمي التفعيل المتزامن",
                  doThis: "أكمل إعدادات المتجر ثم أعد محاولة التفعيل",
                }),
              });
            }
            const anotherFirstOrderProgram = (await tx.select({ id: couponPrograms.id })
              .from(couponPrograms)
              .where(and(
                eq(couponPrograms.status, "ACTIVE"),
                eq(couponPrograms.isFirstOrderSelfService, true),
                ne(couponPrograms.id, input.programId),
                program.branchId == null
                  ? undefined
                  : or(
                      isNull(couponPrograms.branchId),
                      eq(couponPrograms.branchId, program.branchId),
                    ),
              ))
              .for("update")
              .limit(1))[0];
            if (anotherFirstOrderProgram) {
              throw new TRPCError({
                code: "CONFLICT",
                message: appErrorMessage({
                  what: "تعذر تفعيل برنامج كوبون الطلب الأول",
                  why: "يوجد برنامج فعّال آخر يخدم الفرع نفسه أو يغطي كل الفروع",
                  doThis: "أوقف البرنامج الحالي أولاً، ثم فعّل هذا البرنامج",
                }),
              });
            }
          }
        }
        await tx.update(couponPrograms).set({ status: input.status }).where(eq(couponPrograms.id, input.programId));
      });
      await logAudit(ctx, { action: "crm.couponProgram.status", entityType: "couponProgram", entityId: input.programId, newValue: { status: input.status } });
      return { ok: true };
    }),

    issue: campaignsManagerProcedure.input(z.object({
      programId: z.number().int().positive(),
      count: z.number().int().min(1).max(500),
      customerId: z.number().int().positive().nullish(),
    })).mutation(async ({ input, ctx }) => {
      const issuedAt = new Date();
      const batchReference = `CP-${input.programId}-${issuedAt.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex").toUpperCase()}`;
      const issued = await withTx(async (tx) => {
        const program = (await tx.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).for("update").limit(1))[0];
        if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
        if (program.status === "ENDED") throw new TRPCError({ code: "BAD_REQUEST", message: "البرنامج منتهٍ" });
        if (program.isFirstOrderSelfService) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "لا يمكن إصدار دفعة يدوية لكوبون الطلب الأول",
              why: "هذا البرنامج يصدر رمزاً شخصياً فقط عندما يطلبه العميل قبل أول طلب متجر",
              doThis: "دع العميل يطلب الكوبون من صفحة الولاء، أو أنشئ برنامجاً عادياً للإصدار الإداري",
            }),
          });
        }
        const uniqueCodes = new Set<string>();
        while (uniqueCodes.size < input.count) uniqueCodes.add(makeCode(program.codePrefix));
        const rows = Array.from(uniqueCodes, (code) => {
          return { programId: input.programId, customerId: input.customerId ?? null, code, codeHash: codeHash(code), status: "ACTIVE" as const, issuedAt };
        });
        await tx.insert(coupons).values(rows);
        await logAuditTx(tx, ctx, {
          action: "crm.coupon.issue",
          entityType: "couponProgram",
          entityId: input.programId,
          newValue: { batchReference, count: rows.length, customerId: input.customerId ?? null, issuedAt: issuedAt.toISOString() },
        });
        return rows.map((row) => row.code);
      });
      return { codes: issued, batchReference, issuedAt };
    }),

    /** سجل دفعات الإصدار الذريّ من سجل التدقيق الإلزامي؛ لا يخزن الرموز السرية داخله. */
    batches: campaignsReadProcedure
      .input(
        z.object({
          programId: z.number().int().positive(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        }),
      )
      .query(async ({ input, ctx }) => {
        const db = requireDb();
        const program = (await db.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).limit(1))[0];
        if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
        const rows = await db
          .select({ id: auditLogs.id, newValue: auditLogs.newValue, createdAt: auditLogs.createdAt, userId: auditLogs.userId, userName: users.name })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.userId))
          .where(and(
            eq(auditLogs.action, "crm.coupon.issue"),
            eq(auditLogs.entityType, "couponProgram"),
            eq(auditLogs.entityId, String(input.programId)),
          ))
          .orderBy(desc(auditLogs.id))
          .limit(input.limit)
          .offset(input.offset);
        return rows.map((row) => {
          const value = (row.newValue ?? {}) as Record<string, unknown>;
          return {
            id: Number(row.id),
            batchReference: typeof value.batchReference === "string" ? value.batchReference : `CP-HIST-${row.id}`,
            count: Number(value.count ?? 0),
            customerId: value.customerId == null ? null : Number(value.customerId),
            issuedAt: typeof value.issuedAt === "string" ? new Date(value.issuedAt) : row.createdAt,
            issuedBy: row.userName ?? (row.userId == null ? "مستخدم غير معروف" : `#${row.userId}`),
          };
        });
      }),

    /**
     * كوبونات برنامجٍ ما — **مُرقَّمة**. كانت `SELECT *` بلا LIMIT: برنامجٌ يُصدر كوبوناً لكل
     * عميل (عملاء × حملات) يُعيد كل إصداراته دفعةً واحدة. الحالة/الإجمالي يأتيان من عدٍّ خادميّ
     * لا من طول الصفحة (`status` عمودُه في DB **couponStatus** — §٥: لا تخمين أسماء الأعمدة).
     */
    listIssued: campaignsReadProcedure
      .input(z.object({
        programId: z.number().int().positive(),
        limit: z.number().int().positive().max(500).default(50),
        offset: z.number().int().min(0).default(0),
        q: z.string().trim().max(64).optional(),
        status: z.enum(["ACTIVE", "REDEEMED", "VOID"]).optional(),
      }))
      .query(async ({ input, ctx }) => {
        const db = requireDb();
        const program = (await db.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).limit(1))[0];
        if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
        const baseWhere = eq(coupons.programId, input.programId);
        const q = input.q ? `%${escapeLike(input.q.toUpperCase())}%` : null;
        const where = and(
          baseWhere,
          q == null ? undefined : sql`${coupons.code} LIKE ${q} ESCAPE '!'`,
          input.status == null ? undefined : eq(coupons.status, input.status),
        );
        const rows = await db.select().from(coupons).where(where).orderBy(desc(coupons.id)).limit(input.limit).offset(input.offset);
        const normalizedRows = rows.map((row) => ({ ...row, id: Number(row.id), programId: Number(row.programId), customerId: row.customerId == null ? null : Number(row.customerId) }));
        const details = await withTx((tx) => loadIssuedCouponDetails(tx, normalizedRows.map((row) => ({ id: row.id, customerId: row.customerId }))));
        const agg = (
          await db
            .select({
              total: sql<number>`COUNT(*)`,
              // عدّ النشطة خادمياً: زرّ «طباعة النشطة» كان يعتمد على وجودها في الصفوف المُحمَّلة
              // ⇒ بعد الترقيم يُعطَّل زوراً إن لم تكن نشطةٌ في الصفحة الأولى.
              activeCount: sql<number>`COALESCE(SUM(CASE WHEN ${coupons.status} = 'ACTIVE' THEN 1 ELSE 0 END), 0)`,
            })
            .from(coupons)
            .where(where)
        )[0];
        const activeAgg = (
          await db
            .select({ activeCount: sql<number>`COALESCE(SUM(CASE WHEN ${coupons.status} = 'ACTIVE' THEN 1 ELSE 0 END), 0)` })
            .from(coupons)
            .where(baseWhere)
        )[0];
        return {
          rows: normalizedRows.map((row) => ({ ...row, ...details.get(row.id) })),
          total: Number(agg?.total ?? 0),
          activeCount: Number(activeAgg?.activeCount ?? 0),
        };
      }),

    void: campaignsManagerProcedure.input(z.object({ couponId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      await withTx(async (tx) => {
        const row = (await tx.select({ coupon: coupons, program: couponPrograms }).from(coupons).innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id)).where(eq(coupons.id, input.couponId)).limit(1))[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الكوبون غير موجود" });
        ownBranch(ctx, row.program.branchId == null ? null : Number(row.program.branchId));
        if (row.coupon.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء كوبون مستخدم أو ملغى" });
        await tx.update(coupons).set({ status: "VOID", voidedAt: new Date(), voidedBy: ctx.user.id }).where(and(eq(coupons.id, input.couponId), eq(coupons.status, "ACTIVE")));
      });
      await logAudit(ctx, { action: "crm.coupon.void", entityType: "coupon", entityId: input.couponId });
      return { ok: true };
    }),

    /**
     * تصدير بطاقات الكوبونات كملف PDF مستقل (كل كوبون بصفحة مستقلة بقياس 54×84 مم).
     */
    exportPdf: campaignsReadProcedure
      .input(z.object({
        programId: z.number().int().positive(),
        codes: z.array(z.string().min(1)).max(500).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = requireDb();
        const program = (
          await db
            .select({
              id: couponPrograms.id,
              name: couponPrograms.name,
              branchId: couponPrograms.branchId,
              validTo: couponPrograms.validTo,
              designJson: couponPrograms.designJson,
              promoType: promotions.type,
              promoPercent: promotions.discountPercent,
              promoAmount: promotions.discountAmount,
              promoMaxDiscount: promotions.maxDiscountAmount,
              promoMinSpend: promotions.minOrderSpend,
            })
            .from(couponPrograms)
            .leftJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
            .where(eq(couponPrograms.id, input.programId))
            .limit(1)
        )[0];
        if (!program) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "برنامج الكوبونات غير موجود",
              why: `لم يتم العثور على برنامج الكوبونات برقم التعريف ${input.programId}`,
              doThis: "تأكد من اختيار برنامج كوبونات صالح من القائمة ثم أعد المحاولة",
            }),
          });
        }
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));

        let targetCodes: string[] = [];
        if (input.codes && input.codes.length > 0) {
          const normalized = Array.from(new Set(input.codes.map((c) => normalizeCode(c)).filter(Boolean)));
          if (!normalized.length) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "رموز الكوبونات غير صالحة",
                why: "لم يتم تمرير أي رمز كوبون صالح للتصدير",
                doThis: "تأكد من تحديد رموز كوبونات صحيحة ثم أعد المحاولة",
              }),
            });
          }
          const hashes = normalized.map((c) => codeHash(c));
          const rows = await db
            .select({ code: coupons.code })
            .from(coupons)
            .where(
              and(
                eq(coupons.programId, input.programId),
                eq(coupons.status, "ACTIVE"),
                inArray(coupons.codeHash, hashes),
              ),
            );
          const activeSet = new Set(rows.map((r) => normalizeCode(r.code)));
          const invalidOrInactive = normalized.filter((c) => !activeSet.has(c));
          if (invalidOrInactive.length > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "بعض الكوبونات المطلوبة غير صالحة للتصدير",
                why: `هناك ${invalidOrInactive.length} كوبون غير نشط أو ملغى أو لا يتبع هذا البرنامج (${invalidOrInactive[0]})`,
                doThis: "تأكد من اختيار كوبونات نشطة تابعة للبرنامج المحدد فقط قبل تصدير ملف PDF",
              }),
            });
          }
          targetCodes = rows.map((r) => r.code);
        } else {
          const rows = await db
            .select({ code: coupons.code })
            .from(coupons)
            .where(and(eq(coupons.programId, input.programId), eq(coupons.status, "ACTIVE")))
            .orderBy(desc(coupons.id))
            .limit(500);
          targetCodes = rows.map((r) => r.code);
        }

        if (!targetCodes.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "لا توجد كوبونات صالحة للتصدير",
              why: "البرنامج لا يحوي أي كوبونات فعالة أو أن القائمة المحددة فارغة",
              doThis: "قم بإصدار كوبونات جديدة تابعة لهذا البرنامج أولاً قبل تصدير بطاقات PDF",
            }),
          });
        }

        const design = (program.designJson ?? {}) as PromotionDesignMeta;
        let heroDiscount = "";
        if (program.promoType === "PERCENT") {
          heroDiscount = `خصم ${Number(program.promoPercent)}%`;
        } else if (program.promoAmount) {
          heroDiscount = `خصم ${Number(program.promoAmount).toLocaleString()} د.ع`;
        }

        let discountCap = "";
        if (program.promoMaxDiscount && money(program.promoMaxDiscount).gt(0)) {
          discountCap = `سقف الخصم: ${Number(program.promoMaxDiscount).toLocaleString()} د.ع`;
        }

        let minSpend = "";
        if (program.promoMinSpend && money(program.promoMinSpend).gt(0)) {
          minSpend = `للطلبات بقيمة ${Number(program.promoMinSpend).toLocaleString()} د.ع فأكثر`;
        }

        const activeDaysText = design.activeDays && design.activeDays.length > 0 && design.activeDays.length < 7
          ? `متاح: ${formatActiveDays(design.activeDays)}`
          : null;

        const items: CouponPdfItem[] = targetCodes.map((code) => ({
          code,
          title: design.title || program.name,
          subtitle: design.subtitle,
          heroDiscount,
          discountCap: discountCap || null,
          minSpend: minSpend || null,
          terms: design.terms,
          validTo: program.validTo,
          activeDaysText,
          color: design.color || "#0D6B52",
        }));

        const result = await generateCouponsStandalonePdf({
          programName: program.name,
          coupons: items,
        });

        return {
          base64: result.base64,
          filename: result.filename,
          pageCount: result.pageCount,
        };
      }),
  }),
});

export { codeHash, normalizeCode };
