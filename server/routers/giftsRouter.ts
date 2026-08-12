import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, like, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isDupEntry } from "@shared/errorMap.ar";
import { canSeeCost } from "@shared/permissions";
import { customers, giftVouchers, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { positiveMoneyString, ymdDate } from "../lib/schemas";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { closeGiftCampaign, createGiftCampaign, listGiftCampaigns } from "../services/gifts/campaigns";
import { receiveInboundGift } from "../services/gifts/inbound";
import { getGiftVoucher } from "../services/gifts/list";
import { approveGift, createOutboundGift } from "../services/gifts/outbound";
import { recordPurchaseBonusGift } from "../services/gifts/purchaseBonus";
import { giftsReport } from "../services/gifts/reports";
import { branchScopedProcedure, reportViewerProcedure, requireModule, router } from "../trpc";

/**
 * وحدة الهدايا/المجانيات — G-م١ الوارد (بضاعة مجّانية من مورّد، صفر تكلفة تُخفِّف WAVG، بلا دين).
 * G-م٢ الصادر (قيد GIFT_OUT + حوكمة SOD) يُضاف لاحقاً في نفس الراوتر.
 * القراءة/الكتابة خلف مفتاح صلاحية `gifts` + عزل الفرع (غير المرتفع يرى/يكتب فرعه فقط).
 */
const giftsRead = branchScopedProcedure.use(requireModule("gifts", "READ"));
const giftsWrite = branchScopedProcedure.use(requireModule("gifts", "FULL"));

const inboundLineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.number().positive(),
  refSalePrice: positiveMoneyString.nullish(),
});

export const giftsRouter = router({
  /**
   * قائمة سندات الهدايا — عزل الفرع (نمط consignmentRouter المُثبَت): غير المرتفع يرى فرعه فقط
   * (من ctx.user مباشرةً)؛ admin/manager يحترمان branchId المُرسَل (عرض عبر-الفروع).
   *
   * ترقيمٌ حقيقيّ (offset+total عبر paginateKeyset/countIfOffset — نمط auditRouter) بدل الاقتطاع
   * الصامت القديم (`LIMIT 200` بلا مؤشّر/عدّاد). from/to لمدى التاريخ (نفس اتفاقية Z الإلزامية —
   * راجع تعليق `activeToday` في promotionsV2Router.ts). q خادميّ (يبحث في رقم السند/السبب/رقم عرض
   * المورّد) بدل الفلترة العميلية القديمة التي كانت تعمل على صفحة واحدة فقط بعد الترقيم.
   * استعلامٌ مباشر هنا لا عبر `listGifts` (الخدمة لا تدعم from/to ولا offset حقيقياً؛ إبقاؤها كما
   * هي يحفظ اختباراتها القائمة، والاستعلام هنا يطابق أعمدتها وحراستها حرفياً).
   */
  list: giftsRead
    .input(
      z
        .object({
          direction: z.enum(["OUT", "IN"]).optional(),
          status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "DELIVERED", "CANCELLED", "REVERSED"]).optional(),
          branchId: z.number().int().positive().optional(),
          q: z.string().max(120).optional(),
          from: ymdDate.nullish(),
          to: ymdDate.nullish(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().min(0).optional(),
          cursor: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0, hasMore: false, nextCursor: null as number | null };
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const scopedBranchId = elevated ? null : Number(ctx.user.branchId);
      const branch = scopedBranchId ?? (elevated ? input?.branchId : undefined);

      const conds: SQL[] = [];
      if (branch != null) conds.push(eq(giftVouchers.branchId, branch));
      if (input?.direction) conds.push(eq(giftVouchers.direction, input.direction));
      if (input?.status) conds.push(eq(giftVouchers.status, input.status));
      if (input?.q?.trim()) {
        const term = `%${input.q.trim()}%`;
        conds.push(or(like(giftVouchers.giftNumber, term), like(giftVouchers.reason, term), like(giftVouchers.supplierRef, term))!);
      }
      // ⚠️ لاحقة Z إلزامية (تدقيق ١٧/٧ #٧، مطابقٌ لـactiveToday في promotionsV2Router.ts): بلا Z
      // يُفسَّر الحدّ بمنطقة عملية Node فينزاح على أي جهاز بغير TZ=UTC.
      if (input?.from) conds.push(gte(giftVouchers.createdAt, new Date(input.from + "T00:00:00Z")));
      if (input?.to) conds.push(lte(giftVouchers.createdAt, new Date(input.to + "T23:59:59Z")));

      const selectCols = {
        id: giftVouchers.id,
        giftNumber: giftVouchers.giftNumber,
        direction: giftVouchers.direction,
        branchId: giftVouchers.branchId,
        status: giftVouchers.status,
        giftType: giftVouchers.giftType,
        reason: giftVouchers.reason,
        sellable: giftVouchers.sellable,
        supplierId: giftVouchers.supplierId,
        supplierName: suppliers.name,
        customerId: giftVouchers.customerId,
        customerName: customers.name,
        supplierRef: giftVouchers.supplierRef,
        estimatedValue: giftVouchers.estimatedValue,
        totalCost: giftVouchers.totalCost,
        createdAt: giftVouchers.createdAt,
      };

      const { rows, hasMore, nextCursor, usingCursor } = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: giftVouchers.id,
        baseConds: conds,
        runQuery: (where, lim, off) =>
          db
            .select(selectCols)
            .from(giftVouchers)
            .leftJoin(suppliers, eq(giftVouchers.supplierId, suppliers.id))
            .leftJoin(customers, eq(giftVouchers.customerId, customers.id))
            .where(where)
            .orderBy(desc(giftVouchers.id))
            .limit(lim)
            .offset(off),
      });
      const total = await countIfOffset(usingCursor, async () => {
        const baseWhere = conds.length ? and(...conds) : undefined;
        const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(giftVouchers).where(baseWhere))[0];
        return Number(totalRow?.n ?? 0);
      });
      // حجب التكلفة (تدقيق Codex P1) — نفس دلالة listGifts.redactCost.
      const redact = !canSeeCost(ctx.user.role);
      return {
        rows: rows.map((r) => (redact ? { ...r, totalCost: null as string | null } : r)),
        total,
        hasMore,
        nextCursor,
      };
    }),

  // تفاصيل سند هدية للطباعة (رأس + أطراف + أسطر بأسماء المنتجات، بلا تكلفة) — بعزل الفرع (نمط consignments.get).
  get: giftsRead
    .input(z.object({ giftId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const scopedBranchId = elevated ? null : Number(ctx.user.branchId);
      const gift = await getGiftVoucher({ scopedBranchId }, input.giftId);
      if (!gift) throw new TRPCError({ code: "NOT_FOUND", message: "سند الهدية غير موجود" });
      return gift;
    }),

  // تقرير الهدايا (كشف إساءة + أثر ماليّ) — خلف بوّابة التقارير الحمراء (تُظهر التكلفة). عزل الفرع لغير المرتفع.
  report: reportViewerProcedure
    .input(z.object({ from: z.string(), to: z.string(), branchId: z.number().int().positive().optional() }))
    .query(({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const branchId = elevated ? input.branchId ?? null : Number(ctx.user.branchId);
      return giftsReport({ from: input.from, to: input.to, branchId });
    }),

  receiveInbound: giftsWrite
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().nullish(),
        giftType: z.string().max(32).nullish(),
        reason: z.string().max(255).nullish(),
        supplierRef: z.string().max(64).nullish(),
        estimatedValue: positiveMoneyString.nullish(),
        notes: z.string().max(500).nullish(),
        sellable: z.boolean().optional(), // false = استخدام داخليّ/عيّنة (لا يدخل مخزون البيع)
        clientRequestId: z.string().max(64).nullish(),
        lines: z.array(inboundLineSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المرتفع محصور بفرعه؛ المرتفع يحدّد الفرع صراحةً.
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      if (branchId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع لاستلام الهدية" });
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      // إعادة المحاولة على تصادم رقم السند اللحظيّ (uq_gift_number) — نمط consignmentRouter.
      const attempt = () => receiveInboundGift({ ...input, branchId }, actor);
      try {
        return await attempt();
      } catch (e) {
        if (isDupEntry(e)) return await attempt();
        throw e;
      }
    }),

  // G-م٢: منح هدية صادرة للعميل (GIFT_OUT + حوكمة SOD). فوق العتبة أو من غير مدير ⇒ PENDING_APPROVAL.
  createOutbound: giftsWrite
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().nullish(),
        giftType: z.string().max(32).nullish(),
        reason: z.string().max(255).nullish(),
        notes: z.string().max(500).nullish(),
        campaignId: z.number().int().positive().nullish(), // ربط حملة (G-م٧) — ميزانيّتها تُفرَض إن وُجدت
        clientRequestId: z.string().max(64).nullish(),
        lines: z.array(inboundLineSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      if (branchId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع للهدية" });
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      const attempt = () => createOutboundGift({ ...input, branchId }, actor);
      let r;
      try {
        r = await attempt();
      } catch (e) {
        if (isDupEntry(e)) r = await attempt();
        else throw e;
      }
      // حجب التكلفة عمّن لا يراها (تدقيق Codex P1) — المُنشئ غير مرئيّ الكلفة لا يتلقّى totalCost.
      return canSeeCost(ctx.user.role) ? r : { ...r, totalCost: null };
    }),

  // اعتماد هدية صادرة معلَّقة (مدير آخر، SOD-04). الخدمة تفرض دور المدير + عزل الفرع + منع اعتماد الذات.
  approveGift: giftsWrite
    .input(z.object({ giftId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role };
      return approveGift(input.giftId, actor);
    }),

  // بونص «اشترِ واحصل» (G-م٦): تسجيل الكمية المجّانية المرافقة لأمر شراء كسند هدية وارد للمورّد نفسه.
  receivePurchaseBonus: giftsWrite
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        bonusLines: z.array(z.object({ variantId: z.number().int().positive(), freeBaseQuantity: z.number().int().positive() })).min(1),
        clientRequestId: z.string().max(80).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role };
      const attempt = () => recordPurchaseBonusGift(input, actor);
      try {
        return await attempt();
      } catch (e) {
        if (isDupEntry(e)) return await attempt();
        throw e;
      }
    }),

  // حملات الهدايا (G-م٧): تصنيف + ميزانيّة اختياريّة تُفرَض عند الربط في createOutbound.
  campaignCreate: giftsWrite
    .input(
      z.object({
        name: z.string().min(1).max(120),
        reason: z.string().max(255).nullish(),
        startDate: ymdDate.nullish(),
        endDate: ymdDate.nullish(),
        budgetCost: positiveMoneyString.nullish(),
      }),
    )
    .mutation(({ input, ctx }) => createGiftCampaign(input, { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role })),

  campaignList: giftsRead
    .input(z.object({ status: z.enum(["ACTIVE", "CLOSED"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const rows = await listGiftCampaigns(input ?? {});
      // حجب التكلفة عمّن لا يراها (تدقيق Codex P1) — مخزن/مشتريات لهما gifts≥READ لكنّهما ليسا canSeeCost.
      if (canSeeCost(ctx.user.role)) return rows;
      return rows.map((r) => ({ ...r, budgetCost: null, spent: null }));
    }),

  campaignClose: giftsWrite
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      closeGiftCampaign(input.campaignId, { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role }),
    ),
});
