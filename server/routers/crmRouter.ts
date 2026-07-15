import { randomBytes, createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  couponPrograms,
  couponRedemptions,
  coupons,
  crmCampaigns,
  promotions,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { logAudit } from "../services/auditService";
import { getProductCategoryIds, resolveCouponPromotionForLine } from "../services/salesPromotionService";
import { lockCouponForSale } from "../services/couponService";
import { money, toDbMoney } from "../services/money";
import { requireDb, withTx } from "../services/tx";
import { campaignsManagerProcedure, campaignsReadProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون YYYY-MM-DD");
const campaignStatus = z.enum(["DRAFT", "REVIEW", "APPROVED", "SCHEDULED", "ACTIVE", "PAUSED", "ENDED"]);
const programStatus = z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]);

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
        const coupon = await lockCouponForSale(tx, { code: input.code, branchId, customerId: input.customerId ?? null, todayYmd });
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
        if (!lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون لا ينطبق على أصناف السلة" });
        return { code: coupon.code, programName: coupon.programName, lines };
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
        codePrefix: couponPrograms.codePrefix,
        designJson: couponPrograms.designJson,
        createdAt: couponPrograms.createdAt,
        issued: sql<number>`(select count(*) from ${coupons} c where c.programId = ${couponPrograms.id})`,
        redeemed: sql<number>`(select count(*) from ${couponRedemptions} r where r.programId = ${couponPrograms.id})`,
      }).from(couponPrograms)
        .where(branchId == null ? undefined : or(isNull(couponPrograms.branchId), eq(couponPrograms.branchId, branchId)))
        .orderBy(desc(couponPrograms.id));
      return rows.map((row) => ({ ...row, id: Number(row.id), campaignId: row.campaignId == null ? null : Number(row.campaignId), promotionId: Number(row.promotionId), branchId: row.branchId == null ? null : Number(row.branchId), issued: Number(row.issued), redeemed: Number(row.redeemed) }));
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
      codePrefix: z.string().trim().min(1).max(12).default("CRM"),
      design: z.object({ title: z.string().max(80).optional(), subtitle: z.string().max(140).optional(), terms: z.string().max(500).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional(),
    })).mutation(async ({ input, ctx }) => {
      if (input.validTo && input.validTo < input.validFrom) throw new TRPCError({ code: "BAD_REQUEST", message: "نهاية الصلاحية أقدم من البداية" });
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
          codePrefix: input.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "CRM",
          designJson: input.design ?? null,
          createdBy: ctx.user.id,
        }));
      });
      await logAudit(ctx, { action: "crm.couponProgram.create", entityType: "couponProgram", entityId: programId, newValue: { ...input, branchId } });
      return { programId };
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
          if (!promotion?.isActive || promotion.applicationMode !== "COUPON") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التفعيل قبل تفعيل عرض كوبون صالح" });
          if (program.campaignId != null) {
            const campaign = (await tx.select().from(crmCampaigns).where(eq(crmCampaigns.id, program.campaignId)).limit(1))[0];
            if (!campaign || !["APPROVED", "SCHEDULED", "ACTIVE"].includes(campaign.status)) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "اعتمد الحملة أولاً قبل تفعيل برنامج الكوبونات" });
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
      const issued = await withTx(async (tx) => {
        const program = (await tx.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).limit(1))[0];
        if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
        ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
        if (program.status === "ENDED") throw new TRPCError({ code: "BAD_REQUEST", message: "البرنامج منتهٍ" });
        const uniqueCodes = new Set<string>();
        while (uniqueCodes.size < input.count) uniqueCodes.add(makeCode(program.codePrefix));
        const rows = Array.from(uniqueCodes, (code) => {
          return { programId: input.programId, customerId: input.customerId ?? null, code, codeHash: codeHash(code), status: "ACTIVE" as const };
        });
        await tx.insert(coupons).values(rows);
        return rows.map((row) => row.code);
      });
      await logAudit(ctx, { action: "crm.coupon.issue", entityType: "couponProgram", entityId: input.programId, newValue: { count: issued.length, customerId: input.customerId ?? null } });
      return { codes: issued };
    }),

    listIssued: campaignsReadProcedure.input(z.object({ programId: z.number().int().positive() })).query(async ({ input, ctx }) => {
      const db = requireDb();
      const program = (await db.select().from(couponPrograms).where(eq(couponPrograms.id, input.programId)).limit(1))[0];
      if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "برنامج الكوبونات غير موجود" });
      ownBranch(ctx, program.branchId == null ? null : Number(program.branchId));
      const rows = await db.select().from(coupons).where(eq(coupons.programId, input.programId)).orderBy(desc(coupons.id));
      return rows.map((row) => ({ ...row, id: Number(row.id), programId: Number(row.programId), customerId: row.customerId == null ? null : Number(row.customerId) }));
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
  }),
});

export { codeHash, normalizeCode };
