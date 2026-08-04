import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { customers, quotations } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  convertQuotation,
  createQuotation,
  getQuotation,
  setQuotationStatus,
  updateQuotation,
} from "../services/quotationService";
import { utcDayStart, utcNextDayStart } from "../services/businessDay";
import { logAudit } from "../services/auditService";
import { canSeeCostForUser, router, salesManagerProcedure, salesReadProcedure } from "../trpc";
import { nonNegMoneyString, percentString, positiveMoneyString, positiveQtyString } from "../lib/schemas";
import { retryOnDup } from "../lib/retryDup";
import { paginateKeyset } from "../lib/paginateKeyset";
import { escLike } from "../lib/sqlLike";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على createdAt).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const quotationRouter = router({
  // عزل الفرع (تدقيق ١٤/٦/٢٦): غير المرتفعين يرون عروض فرعهم فقط (كان protectedProcedure ⇒ IDOR قراءة).
  // ٣/٨: تحويل من limit ثابت (٢٠٠ صامت) إلى cursor/hasMore (نمط inventory.transfersList/purchases.list).
  // الاستعلام مباشر هنا (لا listQuotations من الخدمة، القاصرة عن cursor/hasMore — تبقى بلا مسّ) بنفس
  // شروط الخدمة حرفياً + paginateKeyset المشترك.
  list: salesReadProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(100), // تدقيق ٣/٨: سقف صريح ضدّ DoS الذاكرة.
          offset: z.number().int().min(0).max(1_000_000).optional(),
          // keyset: id < cursor — لزرّ «تحميل المزيد» في الواجهة (نمط inventory.transfersList).
          cursor: z.number().int().positive().nullish(),
          // فلترة خادمية بالفترة (createdAt) والحالة.
          from: ymd.optional(),
          to: ymd.optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "CONVERTED", "EXPIRED"]).optional(),
          q: z.string().trim().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], hasMore: false, nextCursor: null as number | null };
      // admin/manager (scopedBranchId=null) يحترمان input.branchId إن مُرّر، وإلا يرون كل الفروع.
      const branchId = ctx.scopedBranchId != null ? ctx.scopedBranchId : input?.branchId;
      const conds: SQL[] = [];
      // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ UTC — مطابق لِما كانت تبنيه listQuotations (localDayStart).
      if (input?.from) conds.push(gte(quotations.createdAt, utcDayStart(input.from)));
      if (input?.to) conds.push(lt(quotations.createdAt, utcNextDayStart(input.to)));
      if (input?.status) conds.push(eq(quotations.status, input.status));
      if (branchId != null) conds.push(eq(quotations.branchId, branchId));
      // بحث نصّي آمن (escLike + ESCAPE '!'): رقم العرض/اسم العميل/الملاحظات.
      if (input?.q) {
        const pat = `%${escLike(input.q.trim())}%`;
        const cond = or(
          sql`${quotations.quoteNumber} LIKE ${pat} ESCAPE '!'`,
          sql`${customers.name} LIKE ${pat} ESCAPE '!'`,
          sql`${quotations.notes} LIKE ${pat} ESCAPE '!'`,
        );
        if (cond) conds.push(cond);
      }
      const { rows, hasMore, nextCursor } = await paginateKeyset({
        cursor: input?.cursor ?? undefined,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 100,
        idCol: quotations.id,
        baseConds: conds,
        runQuery: (where, lim, off) =>
          db
            .select({
              id: quotations.id,
              quoteNumber: quotations.quoteNumber,
              quoteDate: quotations.quoteDate,
              validUntil: quotations.validUntil,
              total: quotations.total,
              status: quotations.status,
              convertedInvoiceId: quotations.convertedInvoiceId,
              customerName: customers.name,
            })
            .from(quotations)
            .leftJoin(customers, eq(quotations.customerId, customers.id))
            .where(where)
            .orderBy(desc(quotations.id))
            .limit(lim)
            .offset(off),
      });
      return { rows, hasMore, nextCursor };
    }),

  get: salesReadProcedure
    .input(z.object({ quotationId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const q = await getQuotation(input.quotationId);
      // لا يُكشَف وجود عرض فرع آخر للأدوار غير المرتفعة (نمط sales.get / voucher.get).
      if (q && ctx.scopedBranchId != null && Number(q.branchId) !== ctx.scopedBranchId) return null;
      if (!q) return null;
      const showCost = canSeeCostForUser(ctx.user);
      return { ...q, items: q.items.map((item) => ({ ...item, costBase: showCost ? item.costBase : null })) };
    }),

  // §٧ RBAC: عرض السعر التزام تسعيري يربط الشركة بمبلغ مستقبلاً ⇒ مدير فأعلى (كان protected
  // وسمح للكاشير بإصدار عروض، مغيّراً المسؤولية التسعيرية بلا حسيب).
  create: salesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        priceTier: tier.nullish(),
        validUntil: ymd.nullish(),
        invoiceDiscount: nonNegMoneyString.nullish(),
        taxRatePercent: percentString.nullish(),
        notes: z.string().nullish(),
        // idempotency (F3): مفتاح ثابت من الواجهة يمنع إنشاء عرضين عند النقر المزدوج/إعادة الشبكة.
        clientRequestId: z.string().min(1).max(80).optional(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: positiveQtyString,
              unitPriceOverride: nonNegMoneyString.nullish(),
              discountPercent: percentString.nullish(),
              discountAmount: nonNegMoneyString.nullish(),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧): createQuotation كان يستعمل input.branchId مباشرةً في الترقيم والتخزين
      // لا actor.branchId ⇒ مدير على salesManagerProcedure يُنشئ عرضاً على فرعٍ آخر، خلافاً لصرامة
      // convert/setStatus (admin فقط يعبُر). الآن: غير الأدمن يُجبَر على فرعه ويُتجاهَل input.branchId.
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء عرض سعر" });
      }
      const effectiveBranchId = elevated ? input.branchId : Number(ctx.user.branchId);
      // NUMBERING-RACE (تدقيق ٢/٧): ترقيم العرض (QUO) يحرّر GET_LOCK قبل الالتزام ⇒ عرضان متزامنان
      // قد يحسبان نفس الرقم؛ القيد الفريد يرفض الثاني. نعيد المحاولة على التصادم (createQuotation ذرّية).
      const res = await retryOnDup(() =>
        createQuotation({ ...input, branchId: effectiveBranchId }, { userId: ctx.user.id, branchId: effectiveBranchId }),
      );
      // لا نُسجّل تدقيقاً على إعادة idempotent (لا إنشاء فعليّاً حدث).
      if (!(res as { idempotentReplay?: boolean }).idempotentReplay) {
        await logAudit(ctx, { action: "quotation.create", entityType: "quotation", entityId: (res as { quotationId?: number })?.quotationId, newValue: { lines: input.lines.length, customerId: input.customerId } });
      }
      return res;
    }),

  update: salesManagerProcedure
    .input(
      z.object({
        quotationId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        priceTier: tier.nullish(),
        validUntil: ymd.nullish(),
        invoiceDiscount: nonNegMoneyString.nullish(),
        taxRatePercent: percentString.nullish(),
        notes: z.string().nullish(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: positiveQtyString,
              unitPriceOverride: nonNegMoneyString.nullish(),
              discountPercent: percentString.nullish(),
              discountAmount: nonNegMoneyString.nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const before = await getQuotation(input.quotationId);
      const res = await updateQuotation(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "quotation.update",
        entityType: "quotation",
        entityId: input.quotationId,
        oldValue: before
          ? { customerId: before.customerId, total: before.total, taxAmount: before.taxAmount, status: before.status }
          : null,
        newValue: { customerId: input.customerId, total: res.total, lines: input.lines.length },
      });
      return res;
    }),

  // Q1 (تدقيق ١٤/٦/٢٦): عزل فرع صارم — admin فقط يعدّل حالة عرض فرع آخر (manager محصور بفرعه).
  // عرض السعر التزام سعري؛ التعديل في فرع آخر = تجاوز سلطة تسعيرية.
  setStatus: salesManagerProcedure
    .input(z.object({ quotationId: z.number().int().positive(), status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await setQuotationStatus(input.quotationId, input.status, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "quotation.setStatus", entityType: "quotation", entityId: input.quotationId, newValue: { status: input.status } });
      return res;
    }),

  // Q1 (تدقيق ١٤/٦/٢٦): التحويل = إنشاء فاتورة تُلزم الشركة. admin فقط يعبُر الفروع.
  convert: salesManagerProcedure
    .input(
      z.object({
        quotationId: z.number().int().positive(),
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await convertQuotation(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "quotation.convert", entityType: "quotation", entityId: input.quotationId, newValue: { invoiceId: (res as { invoiceId?: number })?.invoiceId } });
      return res;
    }),
});
