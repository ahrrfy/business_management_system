import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { z } from "zod";
import {
  customers,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  receipts,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import { users } from "../../drizzle/schema";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { verifyPassword } from "../auth/password";
import { logAudit } from "../services/auditService";
import { createSale, processPayment } from "../services/saleService";
import { canSeeCostForUser, router, salesCashierProcedure, salesReadProcedure } from "../trpc";
import { invoiceBarcodeSet } from "../services/barcodeService";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { isDupEntry } from "@shared/errorMap.ar";

// تحصين verifyManagerApproval ضدّ تخمين كلمة المرور:
// (١) حدّ معدّل بالبريد المُحاوَل: ≤ ٥ محاولات / ٦٠ ثانية.
// (٢) توقيت ثابت: نُجبر الاستجابة على ≥٣٠٠ms (ولو فشلت سريعاً) لتفادي timing attacks
//     التي تكشف هل البريد موجود (verifyPassword لا يُستدعى لو غاب الحساب).
// (٣) كل محاولة فاشلة تُسجَّل في auditLogs (auth.creditOverride.fail).
// (٤) الـlogger يَلتقطها لاحقاً للتنبيه.
const MGR_APPROVAL_MAX = 5;
const MGR_APPROVAL_WINDOW_MS = 60_000;
const MGR_APPROVAL_MIN_RESPONSE_MS = 300;
const mgrApprovalAttempts = new Map<string, number[]>();

// مكنسة دورية تُجلي المفاتيح التي صارت كل محاولاتها أقدم من النافذة (تمنع تسرّب الذاكرة
// عند تدفّق إيميلات مختلفة). .unref?.() كي لا يَمنع المؤقّت إغلاق العملية.
setInterval(() => {
  const now = Date.now();
  mgrApprovalAttempts.forEach((times, key) => {
    const fresh = times.filter((t) => now - t < MGR_APPROVAL_WINDOW_MS);
    if (fresh.length === 0) mgrApprovalAttempts.delete(key);
    else if (fresh.length !== times.length) mgrApprovalAttempts.set(key, fresh);
  });
}, MGR_APPROVAL_WINDOW_MS).unref?.();

function _trackMgrAttempt(email: string): boolean {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const arr = (mgrApprovalAttempts.get(key) ?? []).filter((t) => now - t < MGR_APPROVAL_WINDOW_MS);
  arr.push(now);
  mgrApprovalAttempts.set(key, arr);
  return arr.length <= MGR_APPROVAL_MAX;
}

/** يتحقّق من هوية مدير (بريد + كلمة مرور) لاعتماد تجاوز حدّ الائتمان. يعيد معرّف المدير.
 *  مُحصَّن: rate limit بالبريد، توقيت ثابت ≥٣٠٠ms، وكل فشل يُسجَّل في auditLogs.
 *  عزل الفرع: admin يَعبر دائماً؛ manager يَجب أن يكون مدير نفس الفرع المُمرَّر (branchId).
 *  (تدقيق ١٥/٦/٢٦): قبل الإصلاح كان أي manager في أي فرع يعتمد بيع فرع آخر — IDOR إداري. */
export async function verifyManagerApproval(
  approval: { email: string; password: string },
  ctx: { user: { id: number; branchId?: number | null } },
  branchId?: number,
): Promise<number> {
  const start = Date.now();
  const email = approval.email.trim().toLowerCase();
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  // rate limit (لا يُلَتقَط في الـcatch — يُرمى مباشرة لإفهام المستخدم بحدّ المعدّل).
  if (!_trackMgrAttempt(email)) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.rateLimited",
      entityType: "user",
      newValue: { email, attempts: mgrApprovalAttempts.get(email)?.length ?? 0 },
    });
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "محاولات كثيرة جداً لاعتماد المدير — جرّب بعد دقيقة.",
    });
  }

  const u = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  const ok = u && u.isActive !== false && verifyPassword(approval.password, u.passwordHash) && (u.role === "manager" || u.role === "admin");

  // ثبّت الحدّ الأدنى للوقت قبل الإرجاع (يَمنع timing attack).
  const elapsed = Date.now() - start;
  if (elapsed < MGR_APPROVAL_MIN_RESPONSE_MS) {
    await new Promise((r) => setTimeout(r, MGR_APPROVAL_MIN_RESPONSE_MS - elapsed));
  }

  if (!ok) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u?.id ?? null,
      newValue: { email, reason: !u ? "no_user" : (u.isActive === false ? "inactive" : "wrong_password_or_role") },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "موافقة المدير غير صالحة (تأكّد من البريد وكلمة المرور وأنّ الحساب مدير)." });
  }
  // SOD-03 (فصل المهام): لا يجوز للمستخدم اعتماد عمليته بنفسه (كاشير بدور مدير يُدخل بيانات نفسه).
  // كان غياب الفحص يُتيح للمدير-الكاشير تجاوز حدّ الائتمان على بيعه ذاتياً بلا حسيب.
  if (Number(u.id) === Number(ctx.user.id)) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u.id,
      newValue: { email, reason: "self_approval" },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد عمليتك بنفسك — يلزم مدير آخر (فصل المهام)." });
  }
  // عزل الفرع: admin يَعبر؛ manager يَجب أن يَخدم فرع الفاتورة نفسه.
  if (u.role === "manager" && branchId != null && Number(u.branchId) !== branchId) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u.id,
      newValue: { email, reason: "cross_branch", approverBranchId: u.branchId, saleBranchId: branchId },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "المعتمد ليس مدير هذا الفرع" });
  }
  // M (تَدقيق ٢٣/٦/٢٦): admin عابر-الفرع يَجتاز بلا تَوثيق صريح ⇒ نَسجّل سطر تَدقيق مُكثَّف
  // عند المرور. لا يَمنع المرور (admin له سلطة عليا بالتَصميم)، لكن يَترك أَثَراً forensic
  // كَشّافاً لإساءة استعمال admin مُخترَق (نافذة تَحقيقات لاحقة كاشفة).
  if (u.role === "admin" && branchId != null && u.branchId != null && Number(u.branchId) !== branchId) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.adminCrossBranch",
      entityType: "user",
      entityId: u.id,
      newValue: { email, approverBranchId: u.branchId, saleBranchId: branchId, saleActorId: ctx.user.id },
    });
  }
  return Number(u.id);
}

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
// تاريخ فلترة YYYY-MM-DD (فلاتر الفترات الخادمية — لا فلترة محلية تُخفي صفحات الخادم).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
// قيمة override/خصم: مالية غير سالبة (٢ منزلتان) — nonNegMoneyString المركزية (سدّ تكرار schemas).
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ثلاث منازل)"),
  unitPriceOverride: nonNegMoneyString.optional(),
  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
  discountAmount: nonNegMoneyString.optional(),
});

// مخطط فلترة قائمة المبيعات — مشترك بين list و listSummary (نفس الفلاتر حتماً).
// S3 (٣٠/٦): cursor اختياري للترقيم keyset — عمق O(log n) بدل OFFSET الأُسّي.
// إن مُرّر cursor، يُقيَّد `id < cursor` ويُتجاهل offset؛ وإلّا يبقى OFFSET للتوافق.
const salesListInput = z
  .object({
    limit: z.number().default(50),
    offset: z.number().default(0),
    cursor: z.number().int().positive().optional(),
    // فلترة خادمية بالفترة (invoiceDate) والحالة والعميل.
    from: ymd.optional(),
    to: ymd.optional(),
    status: z.enum(["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED", "RETURNED"]).optional(),
    customerId: z.number().int().positive().optional(),
  })
  .optional();

type SalesListInput = z.infer<typeof salesListInput>;

/** يبني شروط WHERE لقائمة المبيعات — مستخدم في list و listSummary معاً
 *  ⇒ يضمن تطابق الفلترة بينهما للأبد (نفس عزل الفرع ونفس الحدّ نصف المفتوح [from, to+يوم)). */
export function buildSalesListConds(input: SalesListInput, scopedBranchId: number | null, scopedOwnerId: number | null = null) {
  const conds = [];
  if (scopedBranchId) conds.push(eq(invoices.branchId, scopedBranchId));
  // عزل الموظف: غير المرتفعين يرون فواتيرهم فقط (createdBy = هم). admin/manager = null = الكل.
  if (scopedOwnerId != null) conds.push(eq(invoices.createdBy, scopedOwnerId));
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
  if (input?.from) conds.push(gte(invoices.invoiceDate, localDayStart(input.from)));
  if (input?.to) conds.push(lt(invoices.invoiceDate, localNextDayStart(input.to)));
  if (input?.status) conds.push(eq(invoices.status, input.status));
  if (input?.customerId) conds.push(eq(invoices.customerId, input.customerId));
  return conds;
}

export const saleRouter = router({
  create: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: tier.optional(),
        sourceType: z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]).default("POS"),
        lines: z.array(lineSchema).min(1),
        invoiceDiscount: z.string().optional(),
        taxRatePercent: z.string().optional(),
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
        // dueDate للبيع الآجل (YYYY-MM-DD) — يُحفظ على invoices.dueDate ليظهر في AR aging
        // ولينبّه على الفواتير المتأخرة. اختياري؛ إن غاب فلا تاريخ استحقاق محدّد.
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").optional(),
        // تقريب نقدي IQD للبيع النقدي الكامل (يُحسب على الخادم، يُسجَّل ADJUST لفرق التقريب).
        cashRoundIQD: z.boolean().optional(),
        clientRequestId: z.string().optional(),
        notes: z.string().optional(),
        // موافقة مدير لتجاوز حدّ الائتمان (بريد+كلمة مرور، تُتحقَّق خادمياً).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُجبَر على فرعه (لا يُصدَّق branchId القادم من العميل — منع IDOR).
      // G1 (تدقيق ١٤/٦/٢٦): قبل الإصلاح كان `ctx.user.branchId ?? input.branchId` يسمح
      // لكاشير بـbranchId=null أن يحقن أي input.branchId (بيع في فرع آخر — IDOR مالي).
      // الآن: throw FORBIDDEN صريح (نمط F4 expense.create).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let effectiveBranchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      // role إلزامي: خدمة البيع تفحص ملكية الوردية (SHIFT-OWN) وتُعفي admin/manager — بدونه يُحجب الجميع.
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      let approvedBy: number | null = null;
      const { managerApproval, ...saleInput } = input;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      // SALES-01/02: سلطة البيع تحت التكلفة. المدير/الأدمن لهما السلطة ذاتياً (elevated)؛
      // الكاشير يحتاج managerApproval مُتحقَّقاً (approvedBy). الخدمة تَكشف البيع تحت COGS وتَرفضه بلا سلطة.
      const priceOverrideApprovedBy: number | null = approvedBy ?? (elevated ? ctx.user.id : null);
      // B5 (١٩/٦/٢٦): الراوتر لا يمرّر creditApproved منفرداً — يمرّر معه managerOverrideByUserId
      // لتُنشئ saleService approval ذرّياً مرتبطاً بـ(customer, unpaid, single-use, 5min).
      const effectiveInput = {
        ...saleInput,
        branchId: effectiveBranchId,
        creditApproved: approvedBy != null,
        managerOverrideByUserId: approvedBy ?? undefined,
        priceOverrideApproved: priceOverrideApprovedBy != null,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createSale(effectiveInput, actor);
          // AUDIT-REPLAY (تدقيق ٢/٧): إعادة التشغيل الـidempotent لا تُنشئ بيعاً جديداً ⇒ لا نكتب سطر
          // تدقيق مكرَّراً في كل مرة (كان يضخّم السجلّ بأحداث «بيع» وهميّة لعملية واحدة).
          if (!res.idempotentReplay) {
            await logAudit(ctx, { action: "sale.create", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { lines: input.lines.length, creditApprovedBy: approvedBy } });
            if (approvedBy != null) await logAudit(ctx, { action: "sale.creditOverride", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { approvedByManagerId: approvedBy } });
            // SALES-01/02: أثر تدقيقي صريح للبيع تحت التكلفة (لا يُكتفى بعدّ الأسطر).
            if (res.priceOverride) await logAudit(ctx, { action: "sale.priceOverride", entityType: "invoice", entityId: res.invoiceId, newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role } });
          }
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          // لا نبتلع السبب الجذري: نُسجّله كاملاً (رسالة + كود SQL + الاستعلام) قبل
          // إرجاع رسالة عامة للواجهة — وإلا صار تشخيص أعطال الإنتاج تخميناً (درس ١٢/٦:
          // عمود مخطط ناقص ظهر للمستخدم كـ«تعذّر إتمام البيع» بلا أثرٍ يكشف العمود).
          logger.error(
            {
              err: { message: e?.message, code: e?.code, sqlMessage: e?.sqlMessage, sql: e?.sql },
              userId: actor.userId,
              branchId: actor.branchId,
              lines: input.lines.length,
            },
            "sale.create فشل بخطأ غير متوقّع (السبب الجذري أدناه)"
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  pay: salesCashierProcedure
    .input(z.object({
      // SALES-04: المبلغ مُقيّد موجباً بـ٢ منازل (كان z.string() ⇒ يَقبل أُسّاً/أكثر من منزلتين).
      invoiceId: z.number().int().positive(), amount: positiveMoneyString, method, shiftId: z.number().int().positive().optional(),
      // idempotency: نفس المفتاح ⇒ دفعة واحدة (لا إيصال/قيد PAYMENT_IN/خصم AR مزدوج عند النقر المزدوج).
      clientRequestId: z.string().min(1).max(80).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُرفض دفعه على فاتورة فرع آخر (منع IDOR).
      // G1 (تدقيق ١٤/٦/٢٦): استبدل `?? -1` برميٍ صريح. كان -1 يجعل enforceBranchId يطابق
      // عدم وجود فاتورة (silent failure)؛ الآن: FORBIDDEN مباشر لكاشير بلا فرع.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let enforceBranchId: number | null = null;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        enforceBranchId = Number(ctx.user.branchId);
      }
      // G3 (١٩/٦/٢٦): إزالة fallback `|| 1` الصامت. للأدمن بلا فرع نطلب branchId صريحاً
      // (إن غاب نرفع FORBIDDEN — لا نسقط بصمت على فرع ١).
      let actorBranchId: number;
      if (elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد للمستخدم — حدّد فرعك قبل تسجيل دفعات" });
        }
        actorBranchId = Number(ctx.user.branchId);
      } else {
        actorBranchId = enforceBranchId!;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await processPayment({ ...input, enforceBranchId }, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
          await logAudit(ctx, { action: "sale.pay", entityType: "invoice", entityId: input.invoiceId, newValue: { amount: input.amount, method: input.method } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام الدفعة" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام الدفعة (تكرار)" });
    }),

  // عزل الفرع: غير المدير يرى فواتير فرعه فقط (منع IDOR).
  // /simplify ٣٠/٦: list = listPage().rows ⇒ كاتب واحد للاستعلام، صفر تَكرار.
  list: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const baseConds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const page = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: invoices.id,
        baseConds,
        runQuery: (where, lim, off) => db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            sourceType: invoices.sourceType,
            invoiceDate: invoices.invoiceDate,
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            status: invoices.status,
            customerName: customers.name,
          })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .where(where)
          .orderBy(desc(invoices.id))
          .limit(lim)
          .offset(off),
      });
      return page.rows;
    }),

  // S3+S4 (٣٠/٦): listPage — صياغة keyset رسمية تُعيد `{rows, nextCursor, hasMore}`.
  // للواجهات الجَديدة (useInfiniteQuery({getNextPageParam})).
  listPage: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], nextCursor: null as number | null, hasMore: false };
      const baseConds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const { rows, hasMore, nextCursor } = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: invoices.id,
        baseConds,
        runQuery: (where, lim, off) => db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            sourceType: invoices.sourceType,
            invoiceDate: invoices.invoiceDate,
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            status: invoices.status,
            customerName: customers.name,
          })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .where(where)
          .orderBy(desc(invoices.id))
          .limit(lim)
          .offset(off),
      });
      return { rows, nextCursor, hasMore };
    }),

  // مجاميع كل النتائج المطابقة للفلتر (لا الصفحة المعروضة فقط) — نفس شروط list حتماً
  // عبر buildSalesListConds. الأموال نصّية كما تعيدها mysql2 (SUM على decimal) — لا parseFloat.
  listSummary: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { count: 0, totalAmount: "0", paidAmount: "0", dueAmount: "0" };
      const conds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const row = (
        await db
          .select({
            count: sql<number>`COUNT(*)`,
            totalAmount: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
            paidAmount: sql<string>`COALESCE(SUM(${invoices.paidAmount}), 0)`,
            // المتبقي (AR الحقيقي): total − paidAmount − returnedTotal لغير الملغاة
            // (الملغاة لا ذمة عليها؛ المرتجع جزئياً يُخصم منه ما أُرجع).
            dueAmount: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} != 'CANCELLED'
              THEN CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
          })
          .from(invoices)
          .where(conds.length ? and(...conds) : undefined)
      )[0];
      return {
        count: Number(row?.count ?? 0),
        totalAmount: String(row?.totalAmount ?? "0"),
        paidAmount: String(row?.paidAmount ?? "0"),
        dueAmount: String(row?.dueAmount ?? "0"),
      };
    }),

  get: salesReadProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          sourceType: invoices.sourceType,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          customerPhone: customers.phone,
          customerBalance: customers.currentBalance,
          priceTier: invoices.priceTier,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          subtotal: invoices.subtotal,
          taxAmount: invoices.taxAmount,
          discountAmount: invoices.discountAmount,
          total: invoices.total,
          costTotal: invoices.costTotal,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          paymentMethod: invoices.paymentMethod,
          notes: invoices.notes,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;
    // عزل الفرع: لا تكشف وجود فاتورة فرع آخر لغير المدير.
    if (ctx.scopedBranchId && inv.branchId !== ctx.scopedBranchId) return null;
    const items = await db
      .select({
        id: invoiceItems.id,
        variantId: invoiceItems.variantId,
        productUnitId: invoiceItems.productUnitId,
        quantity: invoiceItems.quantity,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        unitCost: invoiceItems.unitCost,
        discountAmount: invoiceItems.discountAmount,
        total: invoiceItems.total,
        productId: products.id,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
      })
      .from(invoiceItems)
      .leftJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));
    const payments = await db
      .select({
        id: receipts.id,
        direction: receipts.direction,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        status: receipts.status,
        createdAt: receipts.createdAt,
      })
      .from(receipts)
      .where(eq(receipts.invoiceId, input.invoiceId))
      .orderBy(asc(receipts.id));

    // توليد qrPayload موقَّعة بـ HMAC من الخادم — الواجهة تعرضها فقط
    const qrPayload = invoiceBarcodeSet({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: String(inv.invoiceDate),
      total: inv.total,
      branchId: inv.branchId,
    }).qrPayload;

    // حجب التكلفة عن غير المدير (منع كشف هامش الربح).
    if (!canSeeCostForUser(ctx.user)) {
      const { costTotal: _c, ...invNoCost } = inv;
      const itemsNoCost = items.map(({ unitCost: _u, ...rest }) => rest);
      return { ...invNoCost, items: itemsNoCost, payments, qrPayload };
    }
    return { ...inv, items, payments, qrPayload };
  }),
});
