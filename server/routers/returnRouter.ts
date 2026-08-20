import { TRPCError } from "@trpc/server";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { accountingEntries, customers, invoiceItems, invoices, productUnits, productVariants, products, users } from "../../drizzle/schema";
import { money } from "../services/money";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { returnSale, returnSaleInTx } from "../services/returnService";
import { withTx } from "../services/tx";
import { loadRefundCaps, SURFACED_REFUND_METHODS } from "../services/returns/refundCaps";
import { getOpenShifts } from "../services/treasury/openShifts";
import { router, salesManagerProcedure, workordersCashierProcedure, workordersExecProcedure } from "../trpc";
import {
  createReturnRequest,
  listReturnRequests,
  loadApprovableRequest,
  loadApprovableRequestTx,
  markRequestApprovedTx,
  rejectReturnRequest,
} from "../services/returns/requests";
import { nonNegMoneyString } from "../lib/schemas";
import { escLike } from "../lib/sqlLike";
import { isDupEntry } from "@shared/errorMap.ar";
import { retryOnDeadlock } from "../lib/retryDeadlock";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على entryDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

// المرتجعات تعكس مخزوناً ونقداً ⇒ مدير فأعلى.
export const returnRouter = router({
  create: salesManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z.array(z.object({ invoiceItemId: z.number().int().positive(), baseQuantity: z.number().int().positive() })).min(1),
        // shiftId اختياري: يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع (resolveBranchCashShiftTx
        // يرمي طالباً التحديد حينها) — يختار المستخدم أيّ درجٍ خرج منه النقد فعلياً.
        refund: z.object({
          amount: nonNegMoneyString,
          method,
          shiftId: z.number().int().positive().optional(),
          // مرجع عملية جهاز الدفع — إلزاميّ للردّ بالبطاقة (تفرضه الخدمة، لا مجرّد تزيين واجهة).
          reference: z.string().trim().min(1).max(100).optional(),
        }).optional(),
        restock: z.boolean().optional(),
        // idempotency: نفس المفتاح ⇒ مرتجع واحد (لا استرداد/إرجاع/خصم AR مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // G3 (١٩/٦/٢٦): استبدال fallback `?? 1` — مرتجع يؤثّر على ذمم وصندوق فرع محدّد، لا فرع افتراضي.
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء مرتجع" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // G8: تمرير role لتمكين فحص ملكية الفرع داخل returnSale (admin يتجاوز).
          // retryOnDeadlock (مراجعة نهائية ١٠/٨): returnSale يقفل فاتورة+مخزوناً+ذمّة عميل بترتيبٍ
          // قد يعاكس إرسال/تسوية توصيلٍ متزامن على نفس الفاتورة (مسار «تعذّر التسليم» يستدعيه) ⇒
          // deadlock عرضيّ من MySQL؛ يمتصّه هنا. سباق المفتاح (ER_DUP) يبقى للحلقة الخارجية.
          const res = await retryOnDeadlock(() => returnSale(input, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role }));
          await logAudit(ctx, { action: "return.create", entityType: "invoice", entityId: input.invoiceId, newValue: { lines: input.lines.length, refund: input.refund?.amount } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue; // سباق نفس المفتاح ⇒ أعد المحاولة فيُرى المرتجع الأول replay
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام المرتجع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام المرتجع (تكرار)" });
    }),

  // ════════ طلبات الإرجاع من المحطة (١٩/٨ — قرار المالك: طلب موظف + اعتماد مدير) ════════
  // البلاغ: رفضُ الزبون وإرجاعُ المندوب حدثٌ يوميّ، والمرتجع محصورٌ بالمدير — فالعمل يتوقّف
  // حتى يحضر، أو يُحفَظ بحسابه فتضيع نسبةُ الفاعل ويسقط فصلُ المهام. الطلب مستند نيّةٍ لا مال.

  /** موظّف المحطة يطلب إرجاعاً — بلا أيّ أثرٍ ماليّ أو مخزنيّ حتى الاعتماد. */
  request: workordersCashierProcedure
    .input(z.object({
      invoiceId: z.number().int().positive(),
      lines: z.array(z.object({
        invoiceItemId: z.number().int().positive(),
        baseQuantity: z.number().int().positive(),
      })).min(1),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await createReturnRequest(input, {
        userId: ctx.user.id, branchId: Number(ctx.user.branchId), role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "return.request", entityType: "invoice", entityId: input.invoiceId,
        newValue: { requestId: res.requestId, reason: input.reason, lines: input.lines.length },
      });
      return res;
    }),

  /** قائمة الطلبات: المدير يرى طلبات فرعه، والموظّف يتابع طلباته وحدها. */
  requests: workordersExecProcedure
    .input(z.object({
      status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional(),
      mine: z.boolean().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      // مَن لا يملك سلطة الاعتماد يرى طلباته وحدها — لا نافذةَ على مرتجعات غيره.
      const canApprove = ctx.user.role === "admin" || ctx.user.role === "manager";
      return listReturnRequests({
        branchId: ctx.user.role === "admin" ? null : Number(ctx.user.branchId ?? 0),
        status: input?.status,
        createdBy: !canApprove || input?.mine ? ctx.user.id : null,
      });
    }),

  /**
   * المدير يعتمد الطلب فيُنفَّذ المرتجع **بالمسار القائم نفسه** — لا نسخةَ منطقٍ ماليّ ثانية.
   * الرافد والدرج والمرجع يقرّرها المدير لحظة الاعتماد كما يفعل في المرتجع المباشر.
   */
  approveRequest: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      refund: z.object({
        amount: nonNegMoneyString,
        method,
        shiftId: z.number().int().positive().optional(),
        reference: z.string().trim().min(1).max(100).optional(),
      }).optional(),
      restock: z.boolean().optional(),
      clientRequestId: z.string().min(1).max(80).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // ٢٠/٨ (تصويب مراجعة Codex): الأدمن **عابرُ فروعٍ بحكم التصميم** وقد يكون
      // `branchId = null`؛ وكان يُرفَض هنا **قبل قراءة الطلب** فيرى الطلبات المعلّقة
      // ولا يستطيع اعتماد أيٍّ منها. الفرعُ يُشتقّ من الطلب نفسه له، ويبقى الإسنادُ
      // شرطاً لغير الأدمن.
      const isAdmin = ctx.user.role === "admin";
      if (ctx.user.branchId == null && !isAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      // ⚛️ **وحدةٌ ذرّية**: قفلُ الطلب ثمّ التنفيذ ثمّ الختم في معاملةٍ واحدة. كانت ثلاثاً
      // منفصلة ⇒ فشلُ الختم يترك مرتجعاً منفَّذاً وطلباً معلَّقاً لا تُعاد محاولته (الحارس
      // التفاؤليّ يرفضه)، ومعتمدان متزامنان يُنفّذان المرتجع مرّتين.
      const res = await retryOnDeadlock(() => withTx(async (tx) => {
        const probe = { userId: ctx.user.id, branchId: ctx.user.branchId ?? null, role: ctx.user.role } as never;
        const { request, lines, invoiceId } = await loadApprovableRequestTx(tx, input.requestId, probe);
        // الفاعلُ الماليّ يحمل فرعَ **الطلب** — لا فرعاً مفقوداً ولا فرعَ المعتمِد.
        const actor = { userId: ctx.user.id, branchId: Number(request.branchId), role: ctx.user.role };
        const out = await returnSaleInTx(tx, {
          invoiceId,
          lines,
          refund: input.refund,
          restock: input.restock,
          clientRequestId: input.clientRequestId ?? `retreq-${input.requestId}`,
        }, actor);
        await markRequestApprovedTx(tx, input.requestId, ctx.user.id, invoiceId);
        return { ...out, invoiceId };
      }));
      const invoiceId = res.invoiceId;
      await logAudit(ctx, {
        action: "return.approveRequest", entityType: "invoice", entityId: invoiceId,
        newValue: { requestId: input.requestId, refund: input.refund?.amount ?? null },
      });
      return { ...res, requestId: input.requestId };
    }),

  /** رفضٌ بسببٍ إلزاميّ — الموظّف يرى لماذا بدل صمتٍ يُعيد الطلب نفسه. */
  rejectRequest: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const res = await rejectReturnRequest(input.requestId, input.reason, {
        userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "return.rejectRequest", entityType: "returnRequest", entityId: input.requestId,
        newValue: { reason: input.reason },
      });
      return res;
    }),

  /** سجلّ مرتجعات البيع (قيود RETURN ذات فاتورة بلا مورد) — فلاتر عميل/فرع/فترة/رقم فاتورة/منفّذ
   *  + ترقيم خادمي. الاستعلام مباشر هنا (لا listSalesReturns من الخدمة، القاصرة عن q/createdBy —
   *  تبقى بلا مسّ — نمط reservations.list/quotations.list) بنفس شروط الخدمة حرفياً + الفلترين الجديدين. */
  list: salesManagerProcedure
    .input(
      z
        .object({
          customerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().nonnegative().optional(),
          // بحث خادمي برقم الفاتورة (كل صفوف هذا السجلّ مرتبطة بفاتورة أصلاً — invoiceId NOT NULL).
          q: z.string().trim().min(1).max(100).optional(),
          // فلتر منفّذ المرتجع (accountingEntries.createdBy) — لا مالك الفاتورة/العميل.
          createdBy: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع: admin يختار الفرع بحرّية؛ غير-admin مُقيَّد بفرعه. مدير بلا فرع مُسنَد ⇒
      // FORBIDDEN لا فلتر مفتوح (وإلّا تسرّبت مرتجعات كل الفروع) — مرآةٌ لفحص create/getInvoice.
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }

      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
      const offset = input?.offset ?? 0;
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        // مرتجع البيع: مرتبط بفاتورة ولا مورد له — عكس مرتجع الشراء (supplierId NOT NULL).
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
        // تصحيحُ الفاتورة يعكسها عبر `returnSaleInTx` فينتج قيد RETURN **بنفس شكل المرتجع
        // الحقيقيّ تماماً** ⇒ كان كلّ تصحيحٍ يُحصى مرتجعَ بيعٍ باسم العميل وبقيمته الكاملة في
        // السجلّ والتصدير وعدّاد المرتجعات: عميلٌ لم يُرجِع شيئاً يظهر بمرتجعٍ كامل.
        // حالةُ الأصل هي الفاصل الحاسم: التصحيح يتركه SUPERSEDED دائماً، والمرتجع الحقيقيّ
        // لا يُنتجها أبداً — ولا تلتبس الحالتان لأنّ `correctSale` يرفض فاتورةً عليها مرتجعٌ
        // سابق، و`returnSale` يرفض المستبدَلة.
        sql`${invoices.status} <> 'SUPERSEDED'`,
      ];
      if (input?.customerId) where.push(eq(accountingEntries.customerId, input.customerId));
      if (branchId) where.push(eq(accountingEntries.branchId, branchId));
      // entryDate عمود DATE ⇒ نقارن بمنتصف ليل UTC (timezone:"Z") ليطابق ما يُخزَّن فعلياً.
      if (input?.from) where.push(gte(accountingEntries.entryDate, new Date(input.from + "T00:00:00.000Z")));
      if (input?.to) where.push(lte(accountingEntries.entryDate, new Date(input.to + "T00:00:00.000Z")));
      if (input?.createdBy) where.push(eq(accountingEntries.createdBy, input.createdBy));
      // بحث آمن (escLike + ESCAPE '!') على رقم الفاتورة — يستلزم الانضمام لـinvoices في العدّ أيضاً.
      if (input?.q) {
        const pat = `%${escLike(input.q)}%`;
        where.push(sql`${invoices.invoiceNumber} LIKE ${pat} ESCAPE '!'`);
      }

      const rows = await db
        .select({
          id: accountingEntries.id,
          entryDate: accountingEntries.entryDate,
          branchId: accountingEntries.branchId,
          invoiceId: accountingEntries.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          customerId: accountingEntries.customerId,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
          amount: accountingEntries.amount,
          notes: accountingEntries.notes,
          createdAt: accountingEntries.createdAt,
          performedBy: accountingEntries.createdBy,
          performedByName: accountingEntries.createdByNameSnapshot,
        })
        .from(accountingEntries)
        .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
        .leftJoin(customers, eq(accountingEntries.customerId, customers.id))
        .where(and(...where))
        .orderBy(sql`${accountingEntries.id} DESC`)
        .limit(limit)
        .offset(offset);

      const totalRow = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(accountingEntries)
        .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
        .where(and(...where));

      return { rows, total: Number(totalRow[0]?.c ?? 0) };
    }),

  /** منفّذو المرتجعات (createdBy مميّز على قيود RETURN المطابقة لنطاق الفرع) — يغذّي فلتر
   *  «منفّذ المرتجع» بلا كشف دليل المستخدمين الكامل (users.list حصريّ لـadminProcedure، والمدير
   *  غير-admin لا يصله — نمط sales.salespeople حرفياً). */
  performers: salesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [] as { id: number; name: string }[];
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        return [];
      }
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
        isNotNull(accountingEntries.createdBy),
      ];
      if (branchId != null) where.push(eq(accountingEntries.branchId, branchId));
      const rows = await db
        .select({
          id: accountingEntries.createdBy,
          // لقطة الاسم وقت المرتجع أولى (يبقى صحيحاً حتى لو تغيّر اسم المستخدم لاحقاً)، والاسم
          // الحيّ احتياطي لصفوف قديمة سابقة على إضافة اللقطة.
          name: sql<string>`COALESCE(MAX(${accountingEntries.createdByNameSnapshot}), MAX(${users.name}), '—')`,
        })
        .from(accountingEntries)
        .leftJoin(users, eq(accountingEntries.createdBy, users.id))
        .where(and(...where))
        .groupBy(accountingEntries.createdBy)
        .orderBy(sql`name ASC`);
      return rows.map((r) => ({ id: Number(r.id), name: r.name }));
    }),

  getInvoice: salesManagerProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          returnedTotal: invoices.returnedTotal,
          paymentMethod: invoices.paymentMethod,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;
    // عزل الفرع (IDOR قراءة): مدير فرعٍ لا يقرأ تفاصيل فاتورة فرعٍ آخر (بنود/عميل/مبالغ).
    // مرآةٌ لفحص ملكية الفرع في returnSale.create؛ admin يتجاوز، وغياب الفرع للمدير ⇒ منع.
    if (ctx.user.role !== "admin" && Number(inv.branchId) !== Number(ctx.user.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك" });
    }

    const rows = await db
      .select({
        invoiceItemId: invoiceItems.id,
        productName: products.name,
        variantName: productVariants.variantName,
        color: productVariants.color,
        size: productVariants.size,
        sku: productVariants.sku,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        total: invoiceItems.total,
      })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));

    const items = rows.map((r) => {
      const variantLabel =
        r.variantName ?? ([r.color, r.size].filter((v): v is string => !!v).join(" / ") || r.sku);
      const remaining = r.baseQuantity - r.returnedBaseQuantity;
      return {
        invoiceItemId: Number(r.invoiceItemId),
        productName: r.productName,
        variantLabel,
        unitName: r.unitName ?? "",
        // معامل تحويل وحدة البيع (درزن=12…) — الشاشة تعرض «١ درزن = ١٢ قطعة» وتَخطو به،
        // فلا يحسب الموظف الوحدة الأساس ذهنياً (كان أكبر مصدر خطأ كميات المرتجع).
        conversionFactor: Number(r.conversionFactor ?? 1) || 1,
        baseQuantity: r.baseQuantity,
        returnedBaseQuantity: r.returnedBaseQuantity,
        remaining,
        unitPrice: r.unitPrice,
        total: r.total,
      };
    });

    // سقوف الاسترداد — **نفس دالّة الخادم التي ستحكم على الطلب** (`loadRefundCaps`) لا نسخةٌ
    // مقارِبة. كانت الشاشة تحسبها بنفسها فتعرض خياراً يرفضه الخادم بعد ملء كل شيء (بلاغ المالك
    // ١٧/٨). الآن: ما تعرضه الشاشة = ما يقبله الخادم، بالتعريف.
    const caps = await loadRefundCaps(db, input.invoiceId);
    const paidByMethod: Array<{ method: string; amount: string }> = [];
    caps.netByMethod.forEach((v, m) => {
      if (v.gt(0)) paidByMethod.push({ method: m, amount: v.toFixed(2) });
    });
    // سقفٌ خامّ لكل طريقة (قبل قصّه بقيمة المرتجع الذي لم تُحدَّد كمّياته بعد) — الشاشة تقصّه
    // لحظياً بقيمة ما اختاره الموظف، فيبقى الطرفان على معادلةٍ واحدة.
    // رافدا الردّ وحدهما (قرار المالك ١٧/٨: نقدٌ أو بطاقة) — لا تُعرَض طريقةٌ لا يريدها العمل.
    const refundOptions = SURFACED_REFUND_METHODS.map((m) => ({
      method: m,
      cap: (caps.capByMethod.get(m) ?? money(0)).toFixed(2),
      /** صافي المقبوض بهذا الرافد (زين مطويٌّ في النقد) — إفصاحٌ يشرح للموظف مصدر المال. */
      paid: (caps.netByMethod.get(m) ?? money(0)).toFixed(2),
      // الحجب يعني «لا يمكن **ردّ نقدٍ** بهذا الرافد» لا «لا يمكن تسجيل مرتجع». النصّ السابق
      // كان يُقرأ منعاً للمرتجع كلّه على فاتورةٍ لم تُقبض (بلاغ المالك ١٨/٨) — والمرتجع بلا ردّ
      // مقبولٌ خادمياً أصلاً: يُخصَم من المتبقّي ومن ذمّة العميل.
      blockedReason: (caps.capByMethod.get(m) ?? money(0)).lte(0)
        ? "لا يوجد متبقٍّ من المقبوض على هذه الفاتورة — يبقى المرتجع بلا ردّ نقديّ متاحاً (يُخصَم من المتبقّي/الذمّة)"
        : null,
    }));

    // أدراج الفرع المفتوحة — تُجلب هنا مع التفاصيل لا بطلبٍ ثانٍ مشروط، كي لا تُبنى الشاشة
    // على حالةٍ ناقصة («جارٍ فحص الورديات…» ثمّ رفضٌ عند الحفظ). قرار المالك (١٧/٨): الاسترداد
    // من **وردية منفّذ المرتجع المفتوحة** افتراضاً، أو يختار وردية أخرى مفتوحة صراحةً.
    // النطاق = فرع الفاتورة دائماً (لا فرع الفاعل) — الدرج مورد فرعٍ لا مستخدم.
    const openShifts = await getOpenShifts(
      {},
      { scopedBranchId: Number(inv.branchId), role: ctx.user.role, userId: ctx.user.id },
    );
    const refundShifts = openShifts.map((s) => ({
      shiftId: s.shiftId,
      userId: s.userId,
      userName: s.userName,
      shiftType: s.shiftType,
      expectedCash: s.expectedCash,
      /** درج المنفّذ نفسه — تختاره الشاشة افتراضاً فلا يقرّر الموظف ما لا يعرفه. */
      isMine: Number(s.userId) === Number(ctx.user.id),
    }));

    return {
      /** الوعاء المتبقّي من المقبوض على الفاتورة بكل الطرق — سقف الردّ الأقصى بأيّ رافد. */
      refundPool: caps.pool.toFixed(2),
      refundOptions,
      refundShifts,
      id: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      branchId: Number(inv.branchId),
      customerId: inv.customerId === null ? null : Number(inv.customerId),
      customerName: inv.customerName ?? null,
      subtotal: inv.subtotal,
      discountAmount: inv.discountAmount,
      taxAmount: inv.taxAmount,
      total: inv.total,
      paidAmount: inv.paidAmount,
      /** ما أُرجِع سابقاً — تحتاجه الشاشة لتحسب «المستحقّ للزبون» فلا تُعبّئ ردّاً لمدين. */
      returnedTotal: inv.returnedTotal ?? "0",
      paymentMethod: inv.paymentMethod,
      paidByMethod,
      items,
    };
  }),
});
